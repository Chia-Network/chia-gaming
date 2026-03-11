import bech32_module from 'bech32-buffer';
import * as bech32_buffer from 'bech32-buffer';
import { Subject } from 'rxjs';

import { rpc } from '../hooks/JsonRpcContext';
import {
  BlockchainReport,
  SelectionMessage,
  BlockchainInboundAddressResult,
  WasmConnection,
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

const bech32: any = (bech32_module ? bech32_module : bech32_buffer);
const PUSH_TX_RETRY_DELAY = 30000;
const POLL_INTERVAL = 5000;

export class RealBlockchainInterface {
  addressData: BlockchainInboundAddressResult;
  fingerprint?: string;
  walletId: number;
  requestId: number;
  requests: any;
  peak: number;
  at_block: number;
  publicKey?: string;
  observable: Subject<BlockchainReport>;

  private pollingTimer: ReturnType<typeof setTimeout> | undefined;
  private remoteWalletId: number | undefined;
  private registeredCoinNames: Set<string> = new Set();
  private previousCoinStates: Map<string, boolean> = new Map();
  private wc: WasmConnection | undefined;
  private cradleId: number | undefined;

  constructor() {
    this.addressData = { address: '', puzzleHash: '' };
    this.walletId = 1;
    this.requestId = 1;
    this.requests = {};
    this.peak = 0;
    this.at_block = 0;
    this.observable = new Subject();
  }

  setWasmConnection(wc: WasmConnection) {
    this.wc = wc;
  }

  setCradleId(cid: number) {
    this.cradleId = cid;
  }

  async getAddress() {
    return this.addressData;
  }

  async startMonitoring() {
    if (this.pollingTimer) return;
    this.poll();
  }

  getObservable() {
    return this.observable;
  }

  does_initial_spend() {
    return (target: string, amt: number) => {
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

  async spend(spend: any): Promise<string> {
    console.log('[wc-blockchain] >>> pushTx');
    try {
      const result = await rpc.pushTx({ spendBundle: spend });
      console.log('[wc-blockchain] <<< pushTx', result.status);
      return result as any;
    } catch (e: any) {
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

  private async ensureRemoteWallet() {
    console.log('[wc-blockchain] ensuring remote wallet exists...');
    const wallets = await rpc.getWallets({ includeData: true });
    const remote = wallets.find(
      (w: any) => w.type === WalletType.Remote,
    );
    if (remote) {
      this.remoteWalletId = remote.id;
      console.log(`[wc-blockchain] found existing remote wallet id=${remote.id}`);
    } else {
      console.log('[wc-blockchain] no remote wallet found, creating...');
      const created = await rpc.createNewRemoteWallet({});
      this.remoteWalletId = created.id;
      console.log(`[wc-blockchain] created remote wallet id=${created.id}`);
    }
  }

  private async poll() {
    if (this.remoteWalletId === undefined) {
      try {
        await this.ensureRemoteWallet();
      } catch (e) {
        console.warn('[wc-blockchain] remote wallet not ready, will retry next poll', e);
      }
    }

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
    if (!this.wc || this.cradleId === undefined) {
      this.observable.next({
        peak: this.peak,
        block: undefined,
        report: { created_watched: [], deleted_watched: [], timed_out: [] },
      });
      return;
    }

    const watchingCoins = this.wc.get_watching_coins(this.cradleId);

    const coinNameToString = new Map<string, string>();
    for (const entry of watchingCoins) {
      coinNameToString.set(entry.coin_name, entry.coin_string);
    }

    const allNames = Array.from(coinNameToString.keys());

    if (this.remoteWalletId !== undefined) {
      const newNames = allNames.filter((n) => !this.registeredCoinNames.has(n));
      if (newNames.length > 0) {
        try {
          console.log(`[wc-blockchain] registering ${newNames.length} new coin(s)`);
          await rpc.registerRemoteCoins({
            walletId: this.remoteWalletId,
            coins: newNames,
          });
          for (const n of newNames) {
            this.registeredCoinNames.add(n);
          }
        } catch (e) {
          console.error('[wc-blockchain] registerRemoteCoins failed', e);
        }
      }
    }

    if (allNames.length === 0) {
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
        names: allNames,
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
      const coinName = this.coinRecordToName(rec);
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

  private coinRecordToName(rec: CoinRecord): string | undefined {
    if (!this.wc) return undefined;
    try {
      const coinString = this.wc.convert_coinset_to_coin_string(
        rec.coin.parentCoinInfo,
        rec.coin.puzzleHash,
        rec.coin.amount,
      );
      return this.wc.coin_string_to_name(coinString);
    } catch {
      return undefined;
    }
  }

  private async push_request(req: any): Promise<any> {
    const requestId = this.requestId++;
    req.requestId = requestId;
    window.parent.postMessage(req, '*');
    let promise_complete, promise_reject;
    const p = new Promise((comp, rej) => {
      promise_complete = comp;
      promise_reject = rej;
    });
    this.requests[requestId] = {
      complete: promise_complete,
      reject: promise_reject,
      requestId: requestId,
    };
    return p;
  }
}

export const realBlockchainInfo: RealBlockchainInterface =
  new RealBlockchainInterface();

export const REAL_BLOCKCHAIN_ID = blockchainDataEmitter.addUpstream(
  realBlockchainInfo.getObservable(),
);

let lastRecvAddress = "";

export function connectRealBlockchain() {
  blockchainConnector.getOutbound().subscribe({
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
            bech32.decode(currentAddress).data as any,
          );
          const result = await rpc.sendTransaction({
            walletId: 1,
            amount: initialSpend.amount,
            fee: 0,
            address: bech32.encode(
              'xch',
              toUint8(initialSpend.target),
              'bech32m',
            ),
            waitForConfirmation: false,
          });

          let resultCoin = undefined;
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
            resultCoin = (result as any).coin;
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
            initialSpend: { coin: resultCoin as any, fromPuzzleHash },
          });
        } catch (e: any) {
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
              spendBundle: transaction.spendObject,
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
            const puzzleHash = toHexString(bech32.decode(address).data as any);
            const addressData = { address, puzzleHash };

          blockchainConnector.replyEmitter({
            responseId: evt.requestId,
	    getAddress: addressData
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

blockchainDataEmitter.getSelectionObservable().subscribe({
  next: (e: SelectionMessage) => {
    if (e.selection == REAL_BLOCKCHAIN_ID) {
      realBlockchainInfo.startMonitoring();
    }
  },
});
