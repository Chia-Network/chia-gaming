import bech32_module from 'bech32-buffer';
import * as bech32_buffer from 'bech32-buffer';
import { Subscription } from 'rxjs';

import { rpc } from '../hooks/JsonRpcContext';
import {
  SelectionMessage,
  BlockchainInboundAddressResult,
} from '../types/ChiaGaming';
import { WalletBalance } from '../types/WalletBalance';
import { WalletType } from '../types/WalletType';
import { CoinRecord } from '../types/rpc/CoinRecord';
import { toHexString } from '../util';

import {
  blockchainConnector,
  BlockchainOutboundRequest,
} from './BlockchainConnector';
import { blockchainDataEmitter } from './BlockchainInfo';
import { CoinStateMonitor, CoinStateBackend } from './CoinStateMonitor';

type Bech32Module = {
  encode: (prefix: string, data: Uint8Array, encoding: string) => string;
  decode: (str: string) => { data: Uint8Array };
};
const bech32: Bech32Module = (bech32_module ? bech32_module : bech32_buffer) as Bech32Module;
const PUSH_TX_RETRY_DELAY = 30000;
const POLL_INTERVAL = 10000;

function isRetryablePushTxError(errStr: string): boolean {
  return errStr.includes('UNKNOWN_UNSPENT') || errStr.includes('NO_TRANSACTIONS_WHILE_SYNCING');
}

function encodeClvmInt(n: number): Uint8Array {
  if (n === 0) return new Uint8Array(0);
  const bytes: number[] = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  if (bytes[0] & 0x80) {
    bytes.unshift(0);
  }
  return new Uint8Array(bytes);
}

function convertConditionArgs(c: { opcode: number; args: string[] }): { opcode: number; args: any } {
  switch (c.opcode) {
    case 60:
    case 62:
      return { opcode: c.opcode, args: { msg: c.args[0] } };
    case 61:
    case 63:
      return { opcode: c.opcode, args: { msg: c.args[0] } };
    case 64:
      return { opcode: c.opcode, args: { coin_id: c.args[0] } };
    case 51:
      return { opcode: c.opcode, args: { puzzle_hash: c.args[0], amount: c.args[1] ? parseInt(c.args[1], 16) : 0 } };
    default:
      return { opcode: c.opcode, args: c.args };
  }
}

class WalletConnectPoller {
  private pollingTimer: ReturnType<typeof setTimeout> | undefined;
  private remoteWalletReady = false;

  constructor(
    private monitor: CoinStateMonitor,
    private ensureRemoteWallet: () => void,
    private isRemoteWalletReady: () => boolean,
    private pollIntervalMs: number,
  ) {}

  start() {
    if (this.pollingTimer) return;
    this.tick();
  }

  stop() {
    if (this.pollingTimer) {
      clearTimeout(this.pollingTimer);
      this.pollingTimer = undefined;
    }
  }

  private async tick() {
    this.ensureRemoteWallet();
    try {
      const height = await rpc.getHeightInfo({});
      const names = this.monitor.getRegisteredCoinNames();
      let records: CoinRecord[] = [];
      for (const name of names) {
        try {
          const r = await rpc.getCoinRecordsByNames({
            names: [name],
            includeSpentCoins: true,
          });
          records.push(...r);
        } catch {
          // Coin not on-chain yet — skip.
        }
      }
      await this.monitor.receiveCoinStates(height, records);
    } catch (e) {
      console.error('[wc-poller] poll failed', e);
    }
    this.pollingTimer = setTimeout(() => this.tick(), this.pollIntervalMs);
  }
}

export class RealBlockchainInterface {
  addressData: BlockchainInboundAddressResult;
  monitor: CoinStateMonitor;

  private poller: WalletConnectPoller;
  private remoteWalletId: number | undefined;
  private remoteWalletPending = false;

  constructor() {
    this.addressData = { address: '', puzzleHash: '' };

    const self = this;
    const backend: CoinStateBackend = {
      async registerCoins(names: string[]) {
        await self.waitForRemoteWallet();
        await rpc.registerRemoteCoins({
          walletId: self.remoteWalletId!,
          coinIds: names,
        });
      },
      async getCoinRecords(names: string[]) {
        return rpc.getCoinRecordsByNames({
          names,
          includeSpentCoins: true,
        });
      },
    };
    this.monitor = new CoinStateMonitor(backend);

    this.poller = new WalletConnectPoller(
      this.monitor,
      () => this.ensureRemoteWallet(),
      () => this.remoteWalletId !== undefined,
      POLL_INTERVAL,
    );
  }

  registerCoin(coinName: string, coinString: string) {
    void this.monitor.registerCoin(coinName, coinString);
  }

  async getAddress() {
    return this.addressData;
  }

  async startMonitoring() {
    this.poller.start();
  }

  stopMonitoring() {
    this.poller.stop();
  }

  getObservable() {
    return this.monitor.getObservable();
  }

  async spend(spend: unknown): Promise<string> {
    console.log('[wc-blockchain] >>> walletPushTx');
    try {
      const result = await rpc.walletPushTx({ spendBundle: spend as object });
      console.log('[wc-blockchain] <<< walletPushTx', result.status);
      return result as unknown as string;
    } catch (e: unknown) {
      const errStr = typeof e === 'string' ? e : ((e as any)?.message || JSON.stringify(e));
      if (isRetryablePushTxError(errStr)) {
        console.warn(`[wc-blockchain] walletPushTx retryable error, retry in ${PUSH_TX_RETRY_DELAY / 1000}s:`, errStr);
        return new Promise((resolve, reject) => {
          setTimeout(() => {
            this.spend(spend).then(resolve).catch(reject);
          }, PUSH_TX_RETRY_DELAY);
        });
      }
      console.error('[wc-blockchain] walletPushTx error', e);
      throw e;
    }
  }

  // --- Private ---

  private ensureRemoteWallet() {
    if (this.remoteWalletPending || this.remoteWalletId !== undefined) return;
    this.remoteWalletPending = true;
    console.log('[wc-blockchain] ensuring remote wallet exists...');
    rpc.getWallets({ includeData: true })
      .then((wallets) => {
        const remote = wallets.find((w: any) => w.type === WalletType.Remote);
        if (remote) {
          this.remoteWalletId = remote.id;
          this.remoteWalletPending = false;
          console.log(`[wc-blockchain] found existing remote wallet id=${remote.id}`);
        } else {
          console.log('[wc-blockchain] no remote wallet found, creating...');
          rpc.createNewRemoteWallet({})
            .then((created) => {
              this.remoteWalletId = created.id;
              this.remoteWalletPending = false;
              console.log(`[wc-blockchain] created remote wallet id=${created.id}`);
            })
            .catch((e) => {
              this.remoteWalletPending = false;
              console.warn('[wc-blockchain] createNewRemoteWallet failed, will retry', e);
            });
        }
      })
      .catch((e) => {
        this.remoteWalletPending = false;
        console.warn('[wc-blockchain] getWallets failed, will retry', e);
      });
  }

  private waitForRemoteWallet(): Promise<void> {
    if (this.remoteWalletId !== undefined) return Promise.resolve();
    this.ensureRemoteWallet();
    return new Promise((resolve) => {
      const check = () => {
        if (this.remoteWalletId !== undefined) {
          resolve();
        } else {
          setTimeout(check, 500);
        }
      };
      check();
    });
  }

}

export const realBlockchainInfo: RealBlockchainInterface =
  new RealBlockchainInterface();

export const REAL_BLOCKCHAIN_ID = blockchainDataEmitter.addUpstream(
  realBlockchainInfo.getObservable(),
);

let lastRecvAddress = "";
let realOutboundSubscription: Subscription | undefined;

export function connectRealBlockchain() {
  if (realOutboundSubscription) return;

  realOutboundSubscription = blockchainConnector.getOutbound().subscribe({
    next: async (evt: BlockchainOutboundRequest) => {
      let transaction = evt.transaction;
      let getAddress = evt.getAddress;
      let getBalance = evt.getBalance;
      if (transaction) {
        while (true) {
          try {
            console.log(`[wc-blockchain] >>> walletPushTx (transaction req #${evt.requestId})`);
            const result = await rpc.walletPushTx({
              spendBundle: transaction.spendObject as object,
            });
            console.log(`[wc-blockchain] <<< walletPushTx (transaction req #${evt.requestId})`, result.status);
            blockchainConnector.replyEmitter({
              responseId: evt.requestId,
              transaction: result as any,
            });
            return;
          } catch (e: any) {
            const errStr = typeof e === 'string' ? e : (e?.message || JSON.stringify(e));
            if (!isRetryablePushTxError(errStr)) {
              console.error(`[wc-blockchain] walletPushTx error`, e);
              blockchainConnector.replyEmitter({
                responseId: evt.requestId,
                transaction: { error: errStr } as any,
              });
              return;
            }
            console.warn(`[wc-blockchain] walletPushTx retryable error, retry in ${PUSH_TX_RETRY_DELAY / 1000}s:`, errStr);
            await new Promise((resolve) => {
              setTimeout(resolve, PUSH_TX_RETRY_DELAY);
            });
          }
        }
      } else if (getAddress) {
        rpc
          .getCurrentAddress({
            walletId: 1,
          })
          .then((address) => {
            if (address !== lastRecvAddress) {
              lastRecvAddress = address;
            }
            const puzzleHash = toHexString(bech32.decode(address).data);
            const addressData = { address, puzzleHash };

          blockchainConnector.replyEmitter({
            responseId: evt.requestId,
	    getAddress: addressData
	  });
        })
          .catch((e: any) => {
            console.warn('[wc-blockchain] getCurrentAddress failed, will retry', e);
            blockchainConnector.replyEmitter({
              responseId: evt.requestId,
              getAddress: undefined,
            });
          });
      } else if (getBalance) {
        rpc.getWalletBalance({
          walletId: 1
        }).then((balanceResult: WalletBalance) => {
          blockchainConnector.replyEmitter({
            responseId: evt.requestId,
	    getBalance: balanceResult.spendableBalance
	  });
        })
          .catch((e: any) => {
            console.warn('[wc-blockchain] getWalletBalance failed, will retry', e);
            blockchainConnector.replyEmitter({
              responseId: evt.requestId,
              getBalance: undefined,
            });
          });
      } else if (evt.selectCoins) {
        rpc.selectCoins({ walletId: 1, amount: evt.selectCoins.amount })
          .then((result: any) => {
            const coins = Array.isArray(result) ? result : result?.coins;
            if (!coins || coins.length === 0) {
              blockchainConnector.replyEmitter({ responseId: evt.requestId, selectCoins: null });
              return;
            }
            const c = coins[0];
            const parent = c.parentCoinInfo.replace(/^0x/, '');
            const puzzle = c.puzzleHash.replace(/^0x/, '');
            const amtHex = toHexString(Array.from(encodeClvmInt(c.amount)));
            blockchainConnector.replyEmitter({
              responseId: evt.requestId,
              selectCoins: parent + puzzle + amtHex,
            });
          })
          .catch((e: any) => {
            blockchainConnector.replyEmitter({
              responseId: evt.requestId,
              error: e?.message ?? String(e),
            });
          });
      } else if (evt.getHeightInfo) {
        rpc.getHeightInfo({}).then((height) => {
          blockchainConnector.replyEmitter({ responseId: evt.requestId, getHeightInfo: height });
        }).catch((e: any) => {
          blockchainConnector.replyEmitter({ responseId: evt.requestId, error: JSON.stringify(e) });
        });
      } else if (evt.createOfferForIds) {
        rpc.createOfferForIds({
          offer: evt.createOfferForIds.offer,
          driverDict: {},
          extraConditions: (evt.createOfferForIds.extraConditions || []).map(convertConditionArgs),
          coinIds: evt.createOfferForIds.coinIds,
        } as any).then((result) => {
          blockchainConnector.replyEmitter({ responseId: evt.requestId, createOfferForIds: result.offer });
        }).catch((e: any) => {
          blockchainConnector.replyEmitter({
            responseId: evt.requestId,
            error: e?.message ?? String(e),
          });
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
}

export function disconnectRealBlockchain() {
  realBlockchainInfo.stopMonitoring();
  if (realOutboundSubscription) {
    realOutboundSubscription.unsubscribe();
    realOutboundSubscription = undefined;
  }
}

blockchainDataEmitter.getSelectionObservable().subscribe({
  next: (e: SelectionMessage) => {
    if (e.selection == REAL_BLOCKCHAIN_ID) {
      realBlockchainInfo.startMonitoring();
      connectRealBlockchain();
    } else {
      disconnectRealBlockchain();
    }
  },
});
