import bech32_module from 'bech32-buffer';
import * as bech32_buffer from 'bech32-buffer';
import { Subject, Subscription } from 'rxjs';

import { rpc } from '../hooks/JsonRpcContext';
import {
  BlockchainReport,
  SelectionMessage,
  BlockchainInboundAddressResult,
} from '../types/ChiaGaming';
import { WalletBalance } from '../types/WalletBalance';
import { WalletType } from '../types/WalletType';
import { CoinRecord } from '../types/rpc/CoinRecord';
import { toHexString, toUint8 } from '../util';

import {
  blockchainConnector,
  BlockchainOutboundRequest,
} from './BlockchainConnector';
import { blockchainDataEmitter } from './BlockchainInfo';

type Bech32Module = {
  encode: (prefix: string, data: Uint8Array, encoding: string) => string;
  decode: (str: string) => { data: Uint8Array };
};
const bech32: Bech32Module = (bech32_module ? bech32_module : bech32_buffer) as Bech32Module;
const PUSH_TX_RETRY_DELAY = 30000;
const POLL_INTERVAL = 5000;

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

// Convert condition args from generic array format [{opcode, args: string[]}]
// to the named-dict format the Chia wallet's conditions_from_json_dicts expects.
// Without this, the wallet's UnknownCondition fallback tries Program(raw_bytes)
// on non-CLVM data, producing "bad encoding".
function convertConditionArgs(c: { opcode: number; args: string[] }): { opcode: number; args: any } {
  switch (c.opcode) {
    case 60: // CREATE_COIN_ANNOUNCEMENT
    case 62: // CREATE_PUZZLE_ANNOUNCEMENT
      return { opcode: c.opcode, args: { msg: c.args[0] } };
    case 61: // ASSERT_COIN_ANNOUNCEMENT
    case 63: // ASSERT_PUZZLE_ANNOUNCEMENT
      return { opcode: c.opcode, args: { msg: c.args[0] } };
    case 64: // ASSERT_CONCURRENT_SPEND
      return { opcode: c.opcode, args: { coin_id: c.args[0] } };
    case 51: // CREATE_COIN
      return { opcode: c.opcode, args: { puzzle_hash: c.args[0], amount: c.args[1] ? parseInt(c.args[1], 16) : 0 } };
    default:
      return { opcode: c.opcode, args: c.args };
  }
}

async function coinRecordToName(rec: CoinRecord): Promise<string | undefined> {
  try {
    const parentBytes = toUint8(rec.coin.parentCoinInfo.replace(/^0x/, ''));
    const puzzleBytes = toUint8(rec.coin.puzzleHash.replace(/^0x/, ''));
    const amountBytes = encodeClvmInt(rec.coin.amount);

    const data = new Uint8Array(parentBytes.length + puzzleBytes.length + amountBytes.length);
    data.set(parentBytes, 0);
    data.set(puzzleBytes, parentBytes.length);
    data.set(amountBytes, parentBytes.length + puzzleBytes.length);

    const hash = await crypto.subtle.digest('SHA-256', data);
    return toHexString(Array.from(new Uint8Array(hash)));
  } catch {
    return undefined;
  }
}

interface PendingRequest {
  complete: (v: unknown) => void;
  reject: (e: unknown) => void;
  requestId: number;
}

export class RealBlockchainInterface {
  addressData: BlockchainInboundAddressResult;
  fingerprint?: string;
  walletId: number;
  requestId: number;
  requests: Record<number, PendingRequest>;
  peak: number;
  at_block: number;
  publicKey?: string;
  observable: Subject<BlockchainReport>;

  private pollingTimer: ReturnType<typeof setTimeout> | undefined;
  private remoteWalletId: number | undefined;
  private remoteWalletPending = false;
  private registerCoinsPending = false;
  private registeredCoinNames: Set<string> = new Set();
  private previousCoinStates: Map<string, boolean> = new Map();
  private watchingCoins: { coin_name: string; coin_string: string }[] = [];

  constructor() {
    this.addressData = { address: '', puzzleHash: '' };
    this.walletId = 1;
    this.requestId = 1;
    this.requests = {};
    this.peak = 0;
    this.at_block = 0;
    this.observable = new Subject();
  }

  setWatchingCoins(coins: { coin_name: string; coin_string: string }[]) {
    this.watchingCoins = coins;
  }

  async getAddress() {
    return this.addressData;
  }

  async startMonitoring() {
    if (this.pollingTimer) return;
    this.poll();
  }

  stopMonitoring() {
    if (this.pollingTimer) {
      clearTimeout(this.pollingTimer);
      this.pollingTimer = undefined;
    }
  }

  getObservable() {
    return this.observable;
  }

  does_initial_spend() {
    return (target: string, amt: bigint) => {
      const targetXch = bech32.encode('xch', toUint8(target), 'bech32m');
      return this.push_request({
        method: 'create_spendable',
        target,
        targetXch,
        amt,
      });
    };
  }

  set_puzzle_hash(_puzzleHash: string) {
    // TODO: Implement puzzle hash setting
  }

  async spend(spend: unknown): Promise<string> {
    console.log('[wc-blockchain] >>> pushTx');
    try {
      const result = await rpc.pushTx({ spendBundle: spend as object });
      console.log('[wc-blockchain] <<< pushTx', result.status);
      return result as unknown as string;
    } catch (e: unknown) {
      const errStr = typeof e === 'string' ? e : JSON.stringify(e);
      if (errStr.indexOf('UNKNOWN_UNSPENT') !== -1) {
        console.warn('[wc-blockchain] pushTx UNKNOWN_UNSPENT, retry in 60s');
        return new Promise((resolve, reject) => {
          setTimeout(() => {
            this.spend(spend).then(resolve).catch(reject);
          }, 60000);
        });
      }
      console.error('[wc-blockchain] pushTx error', e);
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

  private async poll() {
    this.ensureRemoteWallet();

    try {
      const height = await rpc.getHeightInfo({});
      if (height > this.peak) {
        console.log(`[wc-blockchain] new peak height=${height} (was ${this.peak})`);
        this.peak = height;
        if (this.at_block === 0) {
          this.at_block = height;
        }
        await this.checkCoinStates();
      }
    } catch (e) {
      console.error('[wc-blockchain] height poll failed', e);
    }
    this.pollingTimer = setTimeout(() => this.poll(), POLL_INTERVAL);
  }

  private async checkCoinStates() {
    const coinNameToString = new Map<string, string>();
    for (const entry of this.watchingCoins) {
      coinNameToString.set(entry.coin_name, entry.coin_string);
    }

    const allNames = Array.from(coinNameToString.keys());

    if (this.remoteWalletId !== undefined && !this.registerCoinsPending) {
      const newNames = allNames.filter((n) => !this.registeredCoinNames.has(n));
      if (newNames.length > 0) {
        this.registerCoinsPending = true;
        console.log(`[wc-blockchain] registering ${newNames.length} new coin(s)`);
        rpc.registerRemoteCoins({
          walletId: this.remoteWalletId,
          coinIds: newNames,
        })
          .then(() => {
            for (const n of newNames) {
              this.registeredCoinNames.add(n);
            }
            this.registerCoinsPending = false;
          })
          .catch((e) => {
            this.registerCoinsPending = false;
            console.error('[wc-blockchain] registerRemoteCoins failed', e);
          });
      }
    }

    const registeredNames = allNames.filter((n) => this.registeredCoinNames.has(n));

    if (registeredNames.length === 0) {
      this.observable.next({
        peak: this.peak,
        block: undefined,
        report: { created_watched: [], deleted_watched: [], timed_out: [] },
      });
      return;
    }

    let records: CoinRecord[];
    try {
      records = await rpc.getCoinRecordsByNames({
        names: registeredNames,
        includeSpentCoins: true,
      });
    } catch (e) {
      console.error('[wc-blockchain] getCoinRecordsByNames failed', e);
      this.observable.next({
        peak: this.peak,
        block: undefined,
        report: { created_watched: [], deleted_watched: [], timed_out: [] },
      });
      return;
    }

    const created_watched: string[] = [];
    const deleted_watched: string[] = [];
    const timed_out: string[] = [];

    for (const rec of records) {
      const coinName = await coinRecordToName(rec);
      if (!coinName) continue;

      const coinString = coinNameToString.get(coinName);
      if (!coinString) continue;

      const wasSpent = this.previousCoinStates.get(coinName);
      const wasSeen = wasSpent !== undefined;

      if (!wasSeen) {
        created_watched.push(coinString);
        this.previousCoinStates.set(coinName, rec.spent);
      }

      if (rec.spent && !wasSpent) {
        deleted_watched.push(coinString);
        this.previousCoinStates.set(coinName, true);
      }
    }

    const report = { created_watched, deleted_watched, timed_out };
    const hasChanges =
      created_watched.length > 0 ||
      deleted_watched.length > 0 ||
      timed_out.length > 0;

    if (hasChanges) {
      console.log(
        `[wc-blockchain] coin state changes: created=${created_watched.length} deleted=${deleted_watched.length} timed_out=${timed_out.length}`,
      );
    }

    this.observable.next({
      peak: this.peak,
      block: undefined,
      report,
    });
  }

  private async push_request(req: Record<string, unknown>): Promise<unknown> {
    const requestId = this.requestId++;
    const tagged = { ...req, requestId };
    window.parent.postMessage(tagged, '*');
    return new Promise((resolve, reject) => {
      this.requests[requestId] = {
        complete: resolve,
        reject,
        requestId,
      };
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
      let initialSpend = evt.initialSpend;
      let transaction = evt.transaction;
      let getAddress = evt.getAddress;
      let getBalance = evt.getBalance;
      if (initialSpend) {
        try {
          const currentAddress = await rpc.getCurrentAddress({
            walletId: 1,
          });
          if (currentAddress !== lastRecvAddress) {
            lastRecvAddress = currentAddress;
          }
          const fromPuzzleHash = toHexString(
            bech32.decode(currentAddress).data,
          );
          const result = await rpc.sendTransaction({
            walletId: 1,
            amount: Number(initialSpend.amount),
            fee: 0,
            address: bech32.encode(
              'xch',
              toUint8(initialSpend.target),
              'bech32m',
            ),
            waitForConfirmation: false,
          });

          let resultCoin: { parentCoinInfo: string; puzzleHash: string; amount: number | bigint } | undefined;
          if (result.transaction) {
            result.transaction.additions.forEach((c) => {
              if (
                c.puzzleHash == '0x' + initialSpend.target &&
                c.amount.toString() == initialSpend.amount.toString()
              ) {
                resultCoin = c;
              }
            });
          } else {
            const r = result as unknown as Record<string, unknown>;
            if (r.coin && typeof r.coin === 'object') {
              resultCoin = r.coin as { parentCoinInfo: string; puzzleHash: string; amount: number | bigint };
            }
          }

          if (!resultCoin) {
            blockchainConnector.replyEmitter({
              responseId: evt.requestId,
              error: `no corresponding coin created in ${JSON.stringify(result)}`,
            });
            return;
          }

          blockchainConnector.replyEmitter({
            responseId: evt.requestId,
            initialSpend: { coin: resultCoin, fromPuzzleHash },
          });
        } catch (e: unknown) {
          console.error('rpc error', evt, ':', e);
          blockchainConnector.replyEmitter({
            responseId: evt.requestId,
            error: JSON.stringify(e),
          });
        }
      } else if (transaction) {
        while (true) {
          try {
            console.log(`[wc-blockchain] >>> pushTx (transaction req #${evt.requestId})`);
            const result = await rpc.pushTx({
              spendBundle: transaction.spendObject as object,
            });
            console.log(`[wc-blockchain] <<< pushTx (transaction req #${evt.requestId})`, result.status);
            blockchainConnector.replyEmitter({
              responseId: evt.requestId,
              transaction: result as any,
            });
            return;
          } catch (e: any) {
            const errStr = typeof e === 'string' ? e : JSON.stringify(e);
            if (errStr.indexOf('UNKNOWN_UNSPENT') === -1) {
              console.error(`[wc-blockchain] pushTx error`, e);
              blockchainConnector.replyEmitter({
                responseId: evt.requestId,
                transaction: { error: errStr } as any,
              });
              return;
            }
            console.warn(`[wc-blockchain] pushTx UNKNOWN_UNSPENT, retry in ${PUSH_TX_RETRY_DELAY / 1000}s`);
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
