import { Subscription } from 'rxjs';
// @ts-ignore
import bech32_module from 'bech32-buffer';
// @ts-ignore
import * as bech32_buffer from 'bech32-buffer';
import { toUint8 } from '../util';
import { CoinRecord } from '../types/rpc/CoinRecord';

import { BLOCKCHAIN_WS_URL } from '../settings';
import {
  InternalBlockchainInterface,
  BlockchainInboundAddressResult,
  SelectionMessage,
} from '../types/ChiaGaming';

import {
  blockchainConnector,
  BlockchainOutboundRequest,
} from './BlockchainConnector';
import { blockchainDataEmitter } from './BlockchainInfo';
import { CoinStateMonitor, CoinStateBackend } from './CoinStateMonitor';

type Bech32Module = { encode: (prefix: string, data: Uint8Array, encoding?: 'bech32' | 'bech32m') => string };
const bech32: Bech32Module = (bech32_module ? bech32_module : bech32_buffer);

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

  constructor(wsUrl: string) {
    this.wsUrl = wsUrl;
    this.addressData = { address: '', puzzleHash: '' };
    this.deleted = false;

    const self = this;
    const backend: CoinStateBackend = {
      async registerCoins(names: string[]) {
        await self.sendRequest('register_remote_coins', { coinIds: names });
      },
      async getCoinRecords(names: string[]) {
        const raw = await self.sendRequest('get_coin_records_by_names', { names });
        return Array.isArray(raw) ? (raw as CoinRecord[]) : [];
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
        this.connectPromise = null;
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
    const result = await this.sendRequest('register', { name: uniqueId });
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
  }

  getObservable() {
    return this.monitor.getObservable();
  }

  async do_initial_spend(uniqueId: string, target: string, amt: bigint) {
    const fromPuzzleHash = await this.getOrRequestToken(uniqueId);
    const coin = await this.sendRequest('create_spendable', {
      who: this.token,
      target,
      amount: Number(amt),
    });
    if (!coin) throw new Error('no coin returned.');
    return { coin, fromPuzzleHash };
  }

  async spend(_convert: (blob: string) => unknown, spendBlob: string): Promise<string> {
    const status_array = await this.sendRequest('spend', { blob: spendBlob });
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
    return this.sendRequest('select_coins', { who: uniqueId, amount });
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
    return this.sendRequest('create_offer_for_ids', params);
  }

  async registerUser(name: string): Promise<string> {
    return this.sendRequest('register', { name });
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
export const FAKE_BLOCKCHAIN_ID = blockchainDataEmitter.addUpstream(
  fakeBlockchainInfo.getObservable(),
);

let outboundSubscription: Subscription | undefined;

export function connectSimulatorBlockchain() {
  if (outboundSubscription) {
    return outboundSubscription;
  }
  outboundSubscription = blockchainConnector.getOutbound().subscribe({
    next: (evt: BlockchainOutboundRequest) => {
      let initialSpend = evt.initialSpend;
      let transaction = evt.transaction;
      let getAddress = evt.getAddress;
      let getBalance = evt.getBalance;
      if (initialSpend) {
        return fakeBlockchainInfo
          .do_initial_spend(
            initialSpend.uniqueId,
            initialSpend.target,
            initialSpend.amount,
          )
          .then((result) => {
            blockchainConnector.replyEmitter({
              responseId: evt.requestId,
              initialSpend: result,
            });
          })
          .catch((e: unknown) => {
            blockchainConnector.replyEmitter({
              responseId: evt.requestId,
              error: String(e),
            });
          });
      } else if (transaction) {
        fakeBlockchainInfo
          .spend((_blob: string) => transaction.spendObject, transaction.blob)
          .then((response) => {
            blockchainConnector.replyEmitter({
              responseId: evt.requestId,
              transaction: response,
            });
          })
          .catch((e: unknown) => {
            blockchainConnector.replyEmitter({
              responseId: evt.requestId,
              error: String(e),
            });
          });
      } else if (getAddress) {
        fakeBlockchainInfo.getAddress().then((address) => {
          blockchainConnector.replyEmitter({
            responseId: evt.requestId,
            getAddress: address,
          });
        });
      } else if (getBalance) {
        fakeBlockchainInfo.getBalance().then((balance) => {
          blockchainConnector.replyEmitter({ responseId: evt.requestId, getBalance: balance });
        });
      } else if (evt.getPuzzleAndSolution) {
        fakeBlockchainInfo
          .getPuzzleAndSolution(evt.getPuzzleAndSolution.coin)
          .then((result) => {
            blockchainConnector.replyEmitter({
              responseId: evt.requestId,
              getPuzzleAndSolution: result,
            });
          });
      } else if (evt.selectCoins) {
        fakeBlockchainInfo.selectCoins(evt.selectCoins.uniqueId, evt.selectCoins.amount).then((coin) => {
          blockchainConnector.replyEmitter({ responseId: evt.requestId, selectCoins: coin });
        }).catch((e: unknown) => {
          blockchainConnector.replyEmitter({ responseId: evt.requestId, error: String(e) });
        });
      } else if (evt.getHeightInfo) {
        fakeBlockchainInfo.getHeightInfo().then((height) => {
          blockchainConnector.replyEmitter({ responseId: evt.requestId, getHeightInfo: height });
        }).catch((e: unknown) => {
          blockchainConnector.replyEmitter({ responseId: evt.requestId, error: String(e) });
        });
      } else if (evt.createOfferForIds) {
        fakeBlockchainInfo.createOfferForIds(
          evt.createOfferForIds.uniqueId,
          evt.createOfferForIds.offer,
          evt.createOfferForIds.extraConditions,
          evt.createOfferForIds.coinIds,
        ).then((result) => {
          blockchainConnector.replyEmitter({ responseId: evt.requestId, createOfferForIds: result });
        }).catch((e: unknown) => {
          blockchainConnector.replyEmitter({ responseId: evt.requestId, error: String(e) });
        });
      } else {
        console.error(`unknown blockchain request type ${JSON.stringify(evt)}`);
        blockchainConnector.replyEmitter({
          responseId: evt.requestId,
          error: `unknown blockchain request type ${JSON.stringify(evt)}`,
        });
      }
    },
  });
  return outboundSubscription;
}

export function disconnectSimulatorBlockchain() {
  if (outboundSubscription) {
    outboundSubscription.unsubscribe();
    outboundSubscription = undefined;
  }
  fakeBlockchainInfo.close();
}

// Set up to receive information about which blockchain system to use.
// The signal from the blockchainDataEmitter will let the downstream system
// choose and also inform us heore of the choice.
blockchainDataEmitter.getSelectionObservable().subscribe({
  next: (e: SelectionMessage) => {
    if (e.selection == FAKE_BLOCKCHAIN_ID) {
      fakeBlockchainInfo.startMonitoring(e.uniqueId).catch((err: unknown) => {
        console.warn('[blockchain] startMonitoring failed', err);
      });
      connectSimulatorBlockchain();
    } else {
      disconnectSimulatorBlockchain();
    }
  },
});
