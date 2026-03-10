import bech32_module from 'bech32-buffer';
import * as bech32_buffer from 'bech32-buffer';
import ReconnectingWebSocket from 'reconnecting-websocket';
import { Subject } from 'rxjs';

import { rpc } from '../hooks/JsonRpcContext';
import {
  BlockchainReport,
  SelectionMessage,
  BlockchainInboundAddressResult,
} from '../types/ChiaGaming';
import { WalletBalance } from '../types/WalletBalance';
import { toHexString, toUint8 } from '../util';

import {
  blockchainConnector,
  BlockchainOutboundRequest,
} from './BlockchainConnector';
import { blockchainDataEmitter } from './BlockchainInfo';

function wsUrl(baseurl: string) {
  const url_with_new_method = baseurl.replace('http', 'ws');
  return `${url_with_new_method}/ws`;
}

const bech32: any = (bech32_module ? bech32_module : bech32_buffer);
const PUSH_TX_RETRY_TO_LET_UNCOFIRMED_TRANSACTIONS_BE_CONFIRMED = 30000;

export class RealBlockchainInterface {
  baseUrl: string;
  addressData: BlockchainInboundAddressResult;
  fingerprint?: string;
  walletId: number;
  requestId: number;
  requests: any;
  peak: number;
  at_block: number;
  handlingEvent: boolean;
  incomingEvents: any[];
  publicKey?: string;
  observable: Subject<BlockchainReport>;
  ws: any | undefined;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
    this.addressData = { address: '', puzzleHash: '' };
    this.walletId = 1;
    this.requestId = 1;
    this.requests = {};
    this.handlingEvent = false;
    this.peak = 0;
    this.at_block = 0;
    this.incomingEvents = [];
    this.observable = new Subject();
  }

  async getAddress() {
    return this.addressData;
  }

  startMonitoring() {
    if (this.ws) {
      return;
    }

    this.ws = new ReconnectingWebSocket(wsUrl(this.baseUrl));
    this.ws?.addEventListener('message', (m: any) => {
      const json = JSON.parse(m.data);
      if (json.type === 'peak') {
        this.peak = json.data.height;
        this.pushEvent({ checkPeak: true });
      }
    });
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

  async internalRetrieveBlock(height: number) {
    const br_height = await fetch(
      `${this.baseUrl}/get_block_record_by_height`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ height }),
      },
    ).then((r) => r.json());
    this.at_block = br_height.block_record.height + 1;
    const header_hash = br_height.block_record.header_hash;
    const br_spends = await fetch(`${this.baseUrl}/get_block_spends`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        header_hash: header_hash,
      }),
    }).then((r) => r.json());
    this.observable.next({
      peak: this.at_block,
      block: br_spends.block_spends,
      report: undefined,
    });
  }

  async internalCheckPeak() {
    if (this.at_block === 0) {
      this.at_block = this.peak;
    }
    if (this.at_block < this.peak) {
      this.pushEvent({ retrieveBlock: this.at_block });
    }
  }

  async handleEvent(evt: any) {
    if (evt.checkPeak) {
      await this.internalCheckPeak();
      return;
    } else if (evt.retrieveBlock) {
      await this.internalRetrieveBlock(evt.retrieveBlock);
      return;
    }

    console.error('useFullNode: unhandled event', evt);
  }

  async kickEvent() {
    while (this.incomingEvents.length) {
      this.handlingEvent = true;
      try {
        const event = this.incomingEvents.shift();
        await this.handleEvent(event);
      } catch (e) {
        console.error('incoming event failed', e);
      } finally {
        this.handlingEvent = false;
      }
    }
  }

  async pushEvent(evt: any) {
    this.incomingEvents.push(evt);
    if (!this.handlingEvent) {
      await this.kickEvent();
    }
  }

  async push_request(req: any): Promise<any> {
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

  async spend(spend: any): Promise<string> {
    return await fetch(`${this.baseUrl}/push_tx`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ spend_bundle: spend }),
    })
      .then((r) => r.json())
      .then((r) => {
        if (r.error && r.error.indexOf('UNKNOWN_UNSPENT') != -1) {
          console.warn('unknown unspent, retry in 60 seconds');
          return new Promise((resolve, reject) => {
            setTimeout(() => {
              this.spend(spend)
                .then((r) => resolve(r))
                .catch(reject);
            }, 60000);
          });
        }

        return r;
      });
  }
}

export const realBlockchainInfo: RealBlockchainInterface =
  new RealBlockchainInterface('https://api.coinset.org');

export const REAL_BLOCKCHAIN_ID = blockchainDataEmitter.addUpstream(
  realBlockchainInfo.getObservable(),
);

let lastRecvAddress = "";
let logRecvAddress = true;

export function connectRealBlockchain(baseUrl: string) {
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
          const r = await fetch(`${baseUrl}/push_tx`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            body: JSON.stringify({ spend_bundle: transaction.spendObject }),
          });
          const j = await r.json();

          // Return if the result was not unknown unspent, in which case we
          // retry.
          if (!j.error || j.error.indexOf('UNKNOWN_UNSPENT') === -1) {
            const result = {
              responseId: evt.requestId,
              transaction: Object.assign({}, j),
            };
            blockchainConnector.replyEmitter(result);
            return;
          }

          // Wait a while to try the request again.
          await new Promise((resolve, _reject) => {
            setTimeout(
              resolve,
              PUSH_TX_RETRY_TO_LET_UNCOFIRMED_TRANSACTIONS_BE_CONFIRMED,
            );
          });
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
