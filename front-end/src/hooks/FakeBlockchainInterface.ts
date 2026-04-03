import { normalizeCoinStringHex } from '../util';
import { CoinRecord } from '../types/rpc/CoinRecord';

import { BLOCKCHAIN_WS_URL } from '../settings';
import {
  InternalBlockchainInterface,
  BlockchainInboundAddressResult,
} from '../types/ChiaGaming';

import { debugLog } from '../services/debugLog';

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientWsError(err: any): boolean {
  const msg = String(
    err?.message ??
    err?.error?.message ??
    err?.type ??
    err ??
    ''
  ).toLowerCase();
  return (
    msg.includes('websocket') ||
    msg.includes('handshake') ||
    msg.includes('wouldblock') ||
    msg.includes('econnrefused') ||
    msg.includes('closed') ||
    msg.includes('network')
  );
}

function getWebSocketClass(): any {
  if (typeof globalThis.WebSocket !== 'undefined') return globalThis.WebSocket;
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
  private connectPromise: Promise<void> | null = null;
  private readonly retryBackoffMs = [0, 100, 250, 500, 1000];

  constructor(wsUrl: string) {
    this.wsUrl = wsUrl;
    this.blockchainAddressData = { puzzleHash: '' };
    this.deleted = false;
  }

  private ensureConnected(): Promise<void> {
    if (this.ws && this.ws.readyState === 1) {
      return Promise.resolve();
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }
    this.connectPromise = new Promise<void>((resolve, reject) => {
      const WS = getWebSocketClass();
      const ws = new WS(this.wsUrl);
      ws.onopen = () => {
        this.ws = ws;
        this.connectPromise = null;
        resolve();
      };
      ws.onerror = () => {
        this.ws = null;
        this.connectPromise = null;
        try { ws.close(); } catch { /* ignore */ }
        reject(new Error(`WebSocket connection to ${this.wsUrl} failed`));
      };
      ws.onclose = () => {
        this.ws = null;
        this.connectPromise = null;
        for (const [, p] of this.pending) {
          p.reject(new Error('WebSocket closed'));
        }
        this.pending.clear();
      };
      ws.onmessage = (evt: any) => {
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
    return this.connectPromise;
  }

  private async withTransientRetry<T>(label: string, op: () => Promise<T>): Promise<T> {
    let lastErr: any;
    for (const delay of this.retryBackoffMs) {
      if (delay > 0) {
        await sleepMs(delay);
      }
      try {
        return await op();
      } catch (e) {
        lastErr = e;
        if (!isTransientWsError(e)) {
          throw e;
        }
        this.close();
      }
    }
    throw new Error(`${label} failed after retries: ${String(lastErr)}`);
  }

  private async sendRequest(method: string, params?: any): Promise<any> {
    await this.ensureConnected();
    const id = this.nextId++;
    const msg = JSON.stringify({ id, method, params: params ?? {} });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws!.send(msg);
    });
  }

  private async getOrRequestToken(): Promise<string> {
    if (this.token) return this.token;
    if (!this.uniqueId) throw new Error('registerUser must be called before startMonitoring');
    const result = await this.withTransientRetry(
      'register',
      () => this.sendRequest('register', { name: this.uniqueId }),
    );
    this.token = result;
    return this.token;
  }

  async getAddress() {
    return this.blockchainAddressData;
  }

  async startMonitoring() {
    this.deleted = false;
    const puzzleHash = await this.getOrRequestToken();
    if (this.deleted) return;
    this.blockchainAddressData = { puzzleHash };
    await this.withTransientRetry('get_peak', () => this.getHeightInfo());
    debugLog('[sim-blockchain] simulator probe succeeded');
  }

  async spend(blob: string, _spendBundle: unknown): Promise<string> {
    const status_array = await this.sendRequest('spend', { blob });
    if (!Array.isArray(status_array) || status_array.length < 1) {
      throw new Error('status result array was empty');
    }
    if (status_array[0] != 1) {
      const detail = status_array[1] ?? '?';
      const diagnostic = status_array[2] ?? '';
      const msg = `spend rejected: status=[${status_array[0]},${detail}]${diagnostic ? ' ' + diagnostic : ''}`;
      console.warn('[blockchain]', msg);
      return msg;
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
    await this.getOrRequestToken();
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

  async registerUser(name: string): Promise<string> {
    this.uniqueId = name;
    return this.withTransientRetry(
      'registerUser',
      () => this.sendRequest('register', { name }),
    );
  }

  close() {
    this.deleted = true;
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.connectPromise = null;
    for (const [, p] of this.pending) {
      p.reject(new Error('closed'));
    }
    this.pending.clear();
  }
}

export const fakeBlockchainInfo = new FakeBlockchainInterface(
  BLOCKCHAIN_WS_URL,
);
