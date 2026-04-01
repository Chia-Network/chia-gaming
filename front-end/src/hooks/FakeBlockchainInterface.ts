// @ts-ignore
import bech32_module from 'bech32-buffer';
// @ts-ignore
import * as bech32_buffer from 'bech32-buffer';
import { toUint8, normalizeCoinStringHex } from '../util';
import { CoinRecord } from '../types/rpc/CoinRecord';

import { BLOCKCHAIN_WS_URL } from '../settings';
import {
  InternalBlockchainInterface,
  BlockchainInboundAddressResult,
} from '../types/ChiaGaming';

import { CoinStateMonitor, CoinStateBackend } from './CoinStateMonitor';
import { debugLog } from '../services/debugLog';

type Bech32Module = { encode: (prefix: string, data: Uint8Array, encoding?: 'bech32' | 'bech32m') => string };
const bech32: Bech32Module = (bech32_module ? bech32_module : bech32_buffer);

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
  try { return require('ws'); } catch { throw new Error('No WebSocket implementation available'); }
}

export class FakeBlockchainInterface implements InternalBlockchainInterface {
  addressData: BlockchainInboundAddressResult;
  deleted: boolean;
  monitor: CoinStateMonitor;

  private ws: any | null = null;
  private wsUrl: string;
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private token = '';
  private connectPromise: Promise<void> | null = null;
  private readonly retryBackoffMs = [0, 100, 250, 500, 1000];

  constructor(wsUrl: string) {
    this.wsUrl = wsUrl;
    this.addressData = { address: '', puzzleHash: '' };
    this.deleted = false;

    const self = this;
    const backend: CoinStateBackend = {
      async registerCoins(names: string[]) {
        await self.sendRequest('register_remote_coins', { coinIds: names });
      },
    };
    this.monitor = new CoinStateMonitor(backend);
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
      ws.onerror = (e: any) => {
        this.ws = null;
        this.connectPromise = null;
        try { ws.close(); } catch { /* ignore */ }
        reject(e);
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
          if (!this.deleted && typeof data.peak === 'number') {
            const records: CoinRecord[] = Array.isArray(data.records)
              ? data.records
              : [];
            void this.monitor.receiveCoinStates(data.peak, records);
          }
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

  private async getOrRequestToken(uniqueId: string): Promise<string> {
    if (this.token) return this.token;
    const result = await this.withTransientRetry(
      'register',
      () => this.sendRequest('register', { name: uniqueId }),
    );
    this.token = result;
    return this.token;
  }

  async getAddress() {
    return this.addressData;
  }

  registerCoin(coinName: string, coinString: string) {
    void this.monitor.registerCoin(coinName, coinString);
  }

  async startMonitoring(uniqueId: string) {
    this.deleted = false;
    const puzzleHash = await this.getOrRequestToken(uniqueId);
    if (this.deleted) return;
    const address = bech32.encode('xch', toUint8(puzzleHash), 'bech32m');
    this.addressData = { address, puzzleHash };
    await this.withTransientRetry('get_peak', () => this.getHeightInfo());
    debugLog('[sim-blockchain] simulator probe succeeded');
  }

  getObservable() {
    return this.monitor.getObservable();
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
    await this.getOrRequestToken(uniqueId);
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

  async registerUser(name: string): Promise<string> {
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
