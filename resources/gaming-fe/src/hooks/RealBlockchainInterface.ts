import { Subject } from 'rxjs';
// @ts-ignore
import { bech32m } from 'bech32m-chia';
import ReconnectingWebSocket from 'reconnecting-websocket';
import { CoinOutput, WatchReport, BlockchainReport, SelectionMessage } from '../types/ChiaGaming';
import { blockchainDataEmitter } from './BlockchainInfo';
import { blockchainConnector, BlockchainOutboundRequest } from './BlockchainConnector';
import { generateOrRetrieveUniqueId, empty } from '../util';
function wsUrl(baseurl: string) {
  const url_with_new_method = baseurl.replace('http', 'ws');
  return `${url_with_new_method}/ws`;
}

export class RealBlockchainInterface {
  baseUrl: string;
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
    this.walletId = 1;
    this.requestId = 1;
    this.requests = {};
    this.handlingEvent = false;
    this.peak = 0;
    this.at_block = 0;
    this.incomingEvents = [];
    this.observable = new Subject();
  }

  startMonitoring() {
    if (this.ws) {
      return;
    }

    this.ws = new ReconnectingWebSocket(wsUrl(this.baseUrl));
    this.ws?.addEventListener('message', (m: any) => {
      const json = JSON.parse(m.data);
      console.log('coinset json', json);
      if (json.type === 'peak') {
        this.peak = json.data.height;
        this.pushEvent({checkPeak: true});
      }
    });
  }

  getObservable() { return this.observable; }

  does_initial_spend() {
    return (target: string, amt: number) => {
      const targetXch = bech32m.encode(target, 'xch');
      return this.push_request({
        method: 'create_spendable',
        target,
        targetXch,
        amt
      })
    };
  }

  set_puzzle_hash(puzzleHash: string) { }

  async internalRetrieveBlock(height: number) {
    console.log('full node: retrieve block', height);
    const br_height = await fetch(`${this.baseUrl}/get_block_record_by_height`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({ height })
    }).then(r => r.json());
    console.log('br_height', br_height);
    this.at_block = br_height.block_record.height + 1;
    const header_hash = br_height.block_record.header_hash;
    const br_spends = await fetch(`${this.baseUrl}/get_block_spends`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        header_hash: header_hash
      })
    }).then(r => r.json());
    console.log('br_spends', br_spends.block_spends);
    this.observable.next({
      peak: this.at_block,
      block: br_spends.block_spends,
      report: undefined
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
    console.log('full node: kickEvent');
    while (this.incomingEvents.length) {
      console.log('incoming events', this.incomingEvents.length);
      this.handlingEvent = true;
      try {
        const event = this.incomingEvents.shift();
        console.log('full node: do event', event);
        await this.handleEvent(event);
      } catch (e) {
        console.log('incoming event failed', e);
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
    console.log('blockchain: push message to parent', req);
    let requestId = this.requestId++;
    req.requestId = requestId;
    window.parent.postMessage(req, '*');
    let promise_complete, promise_reject;
    let p = new Promise((comp, rej) => {
      promise_complete = comp;
      promise_reject = rej;
    });
    this.requests[requestId] = {
      complete: promise_complete,
      reject: promise_reject,
      requestId: requestId
    };
    return p;
  }

  async spend(spend: any): Promise<string> {
    console.log('push_tx', spend);
    return await fetch(`${this.baseUrl}/push_tx`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({ spend_bundle: spend })
    }).then(r => r.json()).then(r => {
      if (r.error && r.error.indexOf("UNKNOWN_UNSPENT") != -1) {
        console.log('unknown unspent, retry in 60 seconds');
        return new Promise((resolve, reject) => {
          setTimeout(() => {
            this.spend(spend).then(r => resolve(r)).catch(reject);
          }, 60000);
        });
      }

      return r;
    });
  }
}

function requestBlockData(forWho: any, block_number: number): Promise<any> {
  console.log('requestBlockData', block_number);
  return fetch(`${forWho.baseUrl}/get_block_data?block=${block_number}`, {
    method: 'POST'
  }).then((res) => res.json()).then((res) => {
    console.log('requestBlockData, got', res);
    const converted_res: WatchReport = {
      created_watched: res.created,
      deleted_watched: res.deleted,
      timed_out: res.timed_out
    };
    forWho.deliverBlock(block_number, converted_res);
  });
}

export const realBlockchainInfo: RealBlockchainInterface = new RealBlockchainInterface("https://api.coinset.org");

export const REAL_BLOCKCHAIN_ID = blockchainDataEmitter.addUpstream(realBlockchainInfo.getObservable());

export function connectRealBlockchain(baseUrl: string, rpc: any) {
  blockchainConnector.getOutbound().subscribe({
    next: async (evt: BlockchainOutboundRequest) => {
      let initialSpend = evt.initialSpend;
      let transaction = evt.transaction;
      if (initialSpend) {
        try {
          const currentAddress = await rpc.getCurrentAddress({});
          const fromPuzzleHash = bech32m.decode(currentAddress.targetXch);
          const result = await rpc.sendTransaction({
            walletId: 1, // XXX
            amount: initialSpend.amount,
            fee: 0,
            address: currentAddress.targetXch,
            waitForConfirmation: false
          });
          blockchainConnector.replyEmitter({
            responseId: evt.requestId,
            initialSpend: { coin: result, fromPuzzleHash }
          });
        } catch (e: any) {
          blockchainConnector.replyEmitter({
            responseId: evt.requestId,
            error: e.toString()
          });
        }
      } else if (transaction) {
        while (true) {
          let r = await fetch(`${baseUrl}/push_tx`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'application/json'
            },
            body: JSON.stringify({ spend_bundle: transaction.spendObject })
          });
          let j = await r.json();

          // Return if the result was not unknown unspent, in which case we
          // retry.
          if (!j.error || j.error.indexOf("UNKNOWN_UNSPENT") === -1) {
            let result = Object.assign({}, j);
            result.responseId = evt.requestId;
            blockchainConnector.replyEmitter(result);
            return;
          }

          // Wait a while to try the request again.
          await new Promise((resolve, reject) => {
            setTimeout(resolve, 30000);
          });
        }
      } else {
        console.error(`unknown blockchain request type ${JSON.stringify(evt)}`);
        blockchainConnector.replyEmitter({
          responseId: evt.requestId,
          error: `unknown blockchain request type ${JSON.stringify(evt)}`
        });
      }
    }
  });
}

blockchainDataEmitter.getSelectionObservable().subscribe({
  next: (e: SelectionMessage) => {
    if (e.selection == REAL_BLOCKCHAIN_ID) {
      console.log("real blockchain selected");
      realBlockchainInfo.startMonitoring();
    }
  }
});
