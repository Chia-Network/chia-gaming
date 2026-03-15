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

import { BLOCKCHAIN_DATA_URL } from '../settings';
import {
  blockchainConnector,
  BlockchainOutboundRequest,
} from './BlockchainConnector';
import { blockchainDataEmitter } from './BlockchainInfo';

function wsUrl(baseurl: string) {
  const url_with_new_method = baseurl.replace('http', 'ws');
  return `${url_with_new_method}/ws`;
}

type Bech32Module = {
  encode: (prefix: string, data: Uint8Array, encoding: string) => string;
  decode: (str: string) => { data: Uint8Array };
};
const bech32: Bech32Module = (bech32_module ? bech32_module : bech32_buffer) as Bech32Module;
const PUSH_TX_RETRY_TO_LET_UNCOFIRMED_TRANSACTIONS_BE_CONFIRMED = 30000;

type RealBlockchainEvent =
  | { checkPeak: true }
  | { retrieveBlock: number };

interface PendingRequest {
  complete: (v: unknown) => void;
  reject: (e: unknown) => void;
  requestId: number;
}

export class RealBlockchainInterface {
  baseUrl: string;
  addressData: BlockchainInboundAddressResult;
  fingerprint?: string;
  walletId: number;
  requestId: number;
  requests: Record<number, PendingRequest>;
  peak: number;
  at_block: number;
  handlingEvent: boolean;
  incomingEvents: RealBlockchainEvent[];
  publicKey?: string;
  observable: Subject<BlockchainReport>;
  ws: ReconnectingWebSocket | undefined;

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

    const url = wsUrl(this.baseUrl);
    console.log(`[coinset] ws connecting to ${url}`);
    this.ws = new ReconnectingWebSocket(url);
    this.ws?.addEventListener('open', () => {
      console.log('[coinset] ws connected');
    });
    this.ws?.addEventListener('message', (m: MessageEvent) => {
      const raw = JSON.parse(m.data);
      const json = raw.message ?? raw;
      if (json.type === 'peak') {
        console.log(`[coinset] ws peak height=${json.data.height}`);
        this.peak = json.data.height;
        this.pushEvent({ checkPeak: true });
      }
    });
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

  async internalRetrieveBlock(height: number) {
    console.log(`[coinset] >>> get_block_record_by_height height=${height}`);
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
    console.log(`[coinset] <<< get_block_record_by_height header_hash=${header_hash}`);

    console.log(`[coinset] >>> get_block_spends header_hash=${header_hash}`);
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
    const spendCount = br_spends.block_spends?.length ?? 0;
    console.log(`[coinset] <<< get_block_spends spends=${spendCount}`);

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

  async handleEvent(evt: RealBlockchainEvent) {
    if ('checkPeak' in evt) {
      await this.internalCheckPeak();
      return;
    } else if ('retrieveBlock' in evt) {
      await this.internalRetrieveBlock(evt.retrieveBlock);
      return;
    }
    const _exhaustive: never = evt;
    console.error('useFullNode: unhandled event', _exhaustive);
  }

  async kickEvent() {
    while (this.incomingEvents.length) {
      this.handlingEvent = true;
      try {
        const event = this.incomingEvents.shift();
        if (!event) continue;
        await this.handleEvent(event);
      } catch (e) {
        console.error('incoming event failed', e);
      } finally {
        this.handlingEvent = false;
      }
    }
  }

  async pushEvent(evt: RealBlockchainEvent) {
    this.incomingEvents.push(evt);
    if (!this.handlingEvent) {
      await this.kickEvent();
    }
  }

  async push_request(req: Record<string, unknown>): Promise<unknown> {
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

  async spend(spend: unknown): Promise<string> {
    console.log('[coinset] >>> push_tx (spend)');
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
          console.warn('[coinset] <<< push_tx UNKNOWN_UNSPENT, retry in 60s');
          return new Promise((resolve, reject) => {
            setTimeout(() => {
              this.spend(spend)
                .then((r) => resolve(r))
                .catch(reject);
            }, 60000);
          });
        }

        console.log('[coinset] <<< push_tx', r.error ? `error: ${r.error}` : 'ok');
        return r;
      });
  }
}

export const realBlockchainInfo: RealBlockchainInterface =
  new RealBlockchainInterface(BLOCKCHAIN_DATA_URL);

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
          console.log(`[coinset] >>> push_tx (transaction req #${evt.requestId})`);
          const r = await fetch(`${baseUrl}/push_tx`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            body: JSON.stringify({ spend_bundle: transaction.spendObject }),
          });
          const j = await r.json();

          if (!j.error || j.error.indexOf('UNKNOWN_UNSPENT') === -1) {
            console.log(`[coinset] <<< push_tx (transaction req #${evt.requestId})`, j.error ? `error: ${j.error}` : 'ok');
            const result = {
              responseId: evt.requestId,
              transaction: Object.assign({}, j),
            };
            blockchainConnector.replyEmitter(result);
            return;
          }

          console.warn(`[coinset] <<< push_tx UNKNOWN_UNSPENT, retry in ${PUSH_TX_RETRY_TO_LET_UNCOFIRMED_TRANSACTIONS_BE_CONFIRMED / 1000}s`);
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
            const puzzleHash = toHexString(bech32.decode(address).data);
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
