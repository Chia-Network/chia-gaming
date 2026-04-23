import { normalizeCoinStringHex } from '../util';
import { CoinRecord } from '../types/rpc/CoinRecord';

import { BLOCKCHAIN_WS_URL } from '../settings';
import {
  InternalBlockchainInterface,
  BlockchainInboundAddressResult,
  ConnectionSetup,
} from '../types/ChiaGaming';

import { log } from '../services/log';

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getWebSocketClass(): any {
  if (typeof globalThis.WebSocket !== 'undefined') return globalThis.WebSocket;
  // Node.js < 22 doesn't have a built-in WebSocket global; fall back to the ws package.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  try { return require('ws'); } catch { /* not available */ }
  throw new Error('No WebSocket implementation available');
}

export class FakeBlockchainInterface implements InternalBlockchainInterface {
  blockchainAddressData: BlockchainInboundAddressResult;
  deleted: boolean;

  private ws: any | null = null;
  private wsUrl: string;
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private token = '';
  private uniqueId = '';
  private initialBalance: number | undefined;
  private connectionListeners = new Set<(connected: boolean) => void>();
  private lastConnectedState = false;
  private autoReconnect = false;
  private static readonly RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 15000, 30000, 60000];
  private reconnectAttempt = 0;
  private connectLoopPromise: Promise<void> | null = null;

  constructor(wsUrl: string) {
    this.wsUrl = wsUrl;
    this.blockchainAddressData = { puzzleHash: '' };
    this.deleted = false;
  }

  private connect(): Promise<void> {
    if (this.ws && this.ws.readyState === 1) {
      return Promise.resolve();
    }
    const t0 = performance.now();
    log(`[sim-blockchain] connect: opening WebSocket to ${this.wsUrl}`);
    return new Promise<void>((resolve, reject) => {
      const WS = getWebSocketClass();
      const ws = new WS(this.wsUrl);
      let settled = false;
      const connectTimeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        log(`[sim-blockchain] connect: timeout (${Math.round(performance.now() - t0)}ms)`);
        try { ws.close(); } catch { /* ignore */ }
        reject(new Error(`WebSocket connection to ${this.wsUrl} timed out`));
      }, 10_000);
      ws.onopen = () => {
        if (settled) { try { ws.close(); } catch { /* ignore */ } return; }
        settled = true;
        clearTimeout(connectTimeout);
        log(`[sim-blockchain] connect: connected (${Math.round(performance.now() - t0)}ms)`);
        this.ws = ws;
        this.fireConnectionChange(true);
        resolve();
      };
      ws.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimeout);
        log(`[sim-blockchain] connect: error (${Math.round(performance.now() - t0)}ms)`);
        try { ws.close(); } catch { /* ignore */ }
        reject(new Error(`WebSocket connection to ${this.wsUrl} failed`));
      };
      ws.onclose = () => {
        if (this.ws !== ws) return;
        this.ws = null;
        this.fireConnectionChange(false);
        for (const [, p] of this.pending) {
          p.reject(new Error('WebSocket closed'));
        }
        this.pending.clear();
        this.startConnectLoop();
      };
      ws.onmessage = (evt: any) => {
        if (this.ws !== ws) return;
        const raw = typeof evt === 'string' ? evt : evt.data;
        let data: any;
        try { data = JSON.parse(raw); } catch { return; }

        if (data.event === 'block') {
          return;
        }

        if (data.id !== undefined) {
          const p = this.pending.get(data.id);
          if (p) {
            this.pending.delete(data.id);
            if (data.error) {
              p.reject(new Error(data.error));
            } else {
              p.resolve(data.result);
            }
          }
        }
      };
    });
  }

  private startConnectLoop(): Promise<void> {
    if (!this.autoReconnect || this.deleted) return Promise.resolve();
    if (this.connectLoopPromise) return this.connectLoopPromise;
    this.connectLoopPromise = this.runConnectLoop();
    return this.connectLoopPromise;
  }

  private async runConnectLoop(): Promise<void> {
    try {
      while (!this.deleted) {
        try {
          await this.connect();
          const regParams: any = { name: this.uniqueId };
          if (this.initialBalance !== undefined) regParams.balance = this.initialBalance;
          const token = await this.sendRequest('register', regParams);
          this.token = token;
          this.blockchainAddressData = { puzzleHash: token };
          await this.sendRequest('get_peak');
          this.reconnectAttempt = 0;
          log('[sim-blockchain] connected and setup complete');
          return;
        } catch (err) {
          if (this.deleted) break;
          if (this.ws) {
            try { this.ws.close(); } catch { /* ignore */ }
            this.ws = null;
          }
          this.fireConnectionChange(false);
          const base = FakeBlockchainInterface.RECONNECT_DELAYS[
            Math.min(this.reconnectAttempt, FakeBlockchainInterface.RECONNECT_DELAYS.length - 1)
          ];
          const jitter = Math.round(base * (0.75 + Math.random() * 0.5));
          this.reconnectAttempt++;
          log(`[sim-blockchain] connect failed: ${err}, backoff ${jitter}ms (attempt ${this.reconnectAttempt})`);
          await sleepMs(jitter);
        }
      }
      throw new Error('connection aborted');
    } finally {
      this.connectLoopPromise = null;
    }
  }

  private sendRequest(method: string, params?: any): Promise<any> {
    if (!this.ws || this.ws.readyState !== 1) {
      return Promise.reject(new Error('not connected'));
    }
    const id = this.nextId++;
    const msg = JSON.stringify({ id, method, params: params ?? {} });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws!.send(msg);
    });
  }

  async getAddress() {
    return this.blockchainAddressData;
  }

  async startMonitoring() {
    log('[sim-blockchain] startMonitoring');
    this.deleted = false;
    this.autoReconnect = true;
    this.reconnectAttempt = 0;
  }

  async spend(blob: string, _spendBundle: unknown, _source?: string, _fee?: number): Promise<string> {
    const status_array = await this.sendRequest('spend', { blob });
    if (!Array.isArray(status_array) || status_array.length < 1) {
      throw new Error('status result array was empty');
    }
    if (status_array[0] != 1) {
      const detail = status_array[1] ?? '?';
      const diagnostic = status_array[2] ?? '';
      const msg = `spend rejected: status=[${status_array[0]},${detail}]${diagnostic ? ' ' + diagnostic : ''}`;
      console.warn('[blockchain]', msg);
      throw new Error(msg);
    }
    return '';
  }

  async getBalance(): Promise<number> {
    return this.sendRequest('get_balance', { user: this.token });
  }

  async getPuzzleAndSolution(coin: string): Promise<string[] | null> {
    return this.sendRequest('get_puzzle_and_solution', { coin });
  }

  async selectCoins(uniqueId: string, amount: number): Promise<string | null> {
    if (!this.token) throw new Error('not set up');
    const response = await this.sendRequest('select_coins', { who: uniqueId, amount });
    if (typeof response !== 'string') return response ?? null;
    return normalizeCoinStringHex(response);
  }

  async getHeightInfo(): Promise<number> {
    return this.sendRequest('get_peak');
  }

  async createOfferForIds(
    uniqueId: string,
    offer: { [walletId: string]: number },
    extraConditions?: Array<{ opcode: number; args: string[] }>,
    coinIds?: string[],
    _maxHeight?: number,
  ): Promise<any | null> {
    const params: any = { who: uniqueId, offer };
    if (extraConditions) params.extraConditions = extraConditions;
    if (coinIds) params.coinIds = coinIds;
    const raw = await this.sendRequest('create_offer_for_ids', params);
    if (!raw) return null;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  }

  async getCoinRecordsByNames(names: string[]): Promise<CoinRecord[]> {
    const result = await this.sendRequest('get_coin_records_by_names', { names });
    return Array.isArray(result) ? result : [];
  }

  async registerCoins(names: string[]): Promise<void> {
    await this.sendRequest('register_remote_coins', { coinIds: names });
  }

  async registerUser(name: string, balance?: number): Promise<string> {
    log(`[sim-blockchain] registerUser: name=${name} balance=${balance ?? 'default'}`);
    this.uniqueId = name;
    const params: any = { name };
    if (balance !== undefined) params.balance = balance;
    const result = await this.sendRequest('register', params);
    this.token = result;
    log('[sim-blockchain] registerUser: complete');
    return result;
  }

  close() {
    this.deleted = true;
    this.autoReconnect = false;
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.fireConnectionChange(false);
    for (const [, p] of this.pending) {
      p.reject(new Error('closed'));
    }
    this.pending.clear();
  }

  private fireConnectionChange(connected: boolean) {
    if (connected === this.lastConnectedState) return;
    this.lastConnectedState = connected;
    for (const cb of this.connectionListeners) {
      try { cb(connected); } catch { /* ignore */ }
    }
  }

  async beginConnect(uniqueId: string): Promise<ConnectionSetup> {
    return {
      qrUri: `sim://${this.wsUrl.replace('ws://', '')}/${uniqueId}`,
      fields: {
        balance: { label: 'Starting balance (mojos)', default: 1_000_000 },
      },
      finalize: async (values?: { balance?: number }) => {
        log('[sim-blockchain] finalize: start');
        this.uniqueId = uniqueId;
        this.initialBalance = values?.balance;
        this.deleted = false;
        this.autoReconnect = true;
        this.reconnectAttempt = 0;
        await this.startConnectLoop();
        log('[sim-blockchain] finalize: complete');
      },
    };
  }

  async disconnect(): Promise<void> {
    this.autoReconnect = false;
    this.close();
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === 1;
  }

  onConnectionChange(cb: (connected: boolean) => void): () => void {
    this.connectionListeners.add(cb);
    return () => { this.connectionListeners.delete(cb); };
  }
}

export const fakeBlockchainInfo = new FakeBlockchainInterface(
  BLOCKCHAIN_WS_URL,
);
