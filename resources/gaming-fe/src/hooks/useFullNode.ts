// @ts-ignore
import { bech32m } from 'bech32m-chia';
import ReconnectingWebSocket from 'reconnecting-websocket';
import { CoinOutput, WatchReport } from '../types/ChiaGaming';
import { generateOrRetrieveUniqueId, empty } from '../util';
function wsUrl(baseurl: string) {
  const url_with_new_method = baseurl.replace('http', 'ws');
  return `${url_with_new_method}/ws`;
}

type blockNotifyType = (peak: number, block: any[], report: any) => void;
let blockNotifyId = 0;
let blockNotify: { [id: string]: blockNotifyType } = {};
export let simulatorIsActive = false;

export function registerBlockchainNotifier(notifier: blockNotifyType): number {
  blockNotifyId += 1;
  const currentNumber = blockNotifyId;
  blockNotify[currentNumber.toString()] = notifier;
  return currentNumber;
}

export function unregisterBlockchainNotifier(id: number) {
  delete blockNotify[id.toString()];
}

function doBlockNotifications(peak: number, block: any[], block_report: any) {
  const keys = Object.keys(blockNotify);
  keys.forEach((k) => {
    blockNotify[k](peak, block, block_report);
  });
}

export interface InternalBlockchainInterface {
  do_initial_spend(target: string, amt: number): Promise<string>;
  spend(convert: (blob: string) => any, spend: string): Promise<string>;
}

export interface WalletBlockchainInterface {
  do_initial_spend(target: string, amt: number): Promise<any>;
  spend(spendBlob: string, spend: any): Promise<any>;
  withdraw(): void;
}

export class RealBlockchainInterface implements WalletBlockchainInterface {
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
  ws: any;
  initialSpend: (target: string, amt: number) => Promise<any>;

  constructor(baseUrl: string, initialSpend: (target: string, amt: number) => Promise<any>) {
    this.baseUrl = baseUrl;
    this.walletId = 1;
    this.requestId = 1;
    this.requests = {};
    this.handlingEvent = false;
    this.peak = 0;
    this.at_block = 0;
    this.incomingEvents = [];
    this.initialSpend = initialSpend;
    this.ws = new ReconnectingWebSocket(wsUrl(this.baseUrl));

    this.ws.addEventListener('message', (m: any) => {
      const json = JSON.parse(m.data);
      // console.log('coinset json', json);
      if (json.type === 'peak') {
        this.peak = json.data.height;
        this.pushEvent({checkPeak: true});
      }
    });
  }

  do_initial_spend(target: string, amt: number) {
    return this.initialSpend(target, amt);
  }

  withdraw() {
    this.ws.close();
  }

  async internalRetrieveBlock(height: number) {
    // console.log('full node: retrieve block', height);
    const br_height = await fetch(`${this.baseUrl}/get_block_record_by_height`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({ height })
    }).then(r => r.json());
    // console.log('br_height', br_height);
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
    // console.log('br_spends', br_spends.block_spends);
    doBlockNotifications(this.at_block, br_spends.block_spends, undefined);
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
    // console.log('full node: kickEvent');
    while (this.incomingEvents.length) {
      // console.log('incoming events', this.incomingEvents.length);
      this.handlingEvent = true;
      try {
        const event = this.incomingEvents.shift();
        // console.log('full node: do event', event);
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
    // console.log('blockchain: push message to parent', req);
    let requestId = this.requestId++;
    req.requestId = requestId;
    window.postMessage(req, '*');
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

  async spend(spendBlob: string, spend: string): Promise<string> {
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
        // console.log('unknown unspent, retry in 60 seconds');
        return new Promise((resolve, reject) => {
          setTimeout(() => {
            this.spend(spendBlob, spend).then(r => resolve(r)).catch(reject);
          }, 60000);
        });
      }

      return r;
    });
  }
}

function startSimulatorMonitoring(forWho: any): Promise<any> {
  if (forWho.deleted) {
    return empty();
  }

  // console.log('startSimulatorMonitoring');
  return fetch(`${forWho.baseUrl}/wait_block`, {
    method: 'POST'
  }).then((res) => res.json()).then((res) => {
    // console.log('wait_block returned', res);
    forWho.setNewPeak(res);
  });
}

function requestBlockData(forWho: any, block_number: number): Promise<any> {
  // console.log('requestBlockData', block_number);
  return fetch(`${forWho.baseUrl}/get_block_data?block=${block_number}`, {
    method: 'POST'
  }).then((res) => res.json()).then((res) => {
    // console.log('requestBlockData, got', res);
    const converted_res: WatchReport = {
      created_watched: res.created,
      deleted_watched: res.deleted,
      timed_out: res.timed_out
    };
    forWho.deliverBlock(block_number, converted_res);
  });
}

export class FakeBlockchainInterface implements WalletBlockchainInterface {
  baseUrl: string;
  deleted: boolean;
  at_block: number;
  max_block: number;
  puzzleHash: string;
  openingCoin: string;
  handlingEvent: boolean;
  incomingEvents: any[];

  constructor(baseUrl: string, myPuzzleHash: string) {
    this.baseUrl = baseUrl;
    this.deleted = false;
    this.max_block = 0;
    this.at_block = 0;
    this.puzzleHash = myPuzzleHash;
    this.openingCoin = '';
    this.handlingEvent = false;
    this.incomingEvents = [];

    window.postMessage({
      name: 'lobby',
    }, '*');
  }

  do_initial_spend(target: string, amt: number) {
    return fetch(`${this.baseUrl}/create_spendable?who=${generateOrRetrieveUniqueId()}&target=${target}&amount=${amt}`, {
      method: "POST"
    }).then((res) => res.json()).then((res) => {
      // Returns the coin string
      console.log('set opening coin', res);
      this.openingCoin = res;
      return {
        coin: res,
        fromPuzzleHash: this.puzzleHash
      };
    });
  }

  async kickEvent() {
    // console.log('full node: kickEvent');
    while (this.incomingEvents.length) {
      // console.log('incoming events', this.incomingEvents.length);
      this.handlingEvent = true;
      try {
        const event = this.incomingEvents.shift();
        // console.log('full node: do event', event);
        await this.handleEvent(event);
      } catch (e) {
        // console.log('incoming event failed', e);
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

  async handleEvent(event: any) {
    if (event.setNewPeak) {
      this.internalSetNewPeak(event.setNewPeak);
    } else if (event.deliverBlock) {
      this.internalDeliverBlock(event.deliverBlock.block_number, event.deliverBlock.block_data);
    }
  }

  async internalNextBlock() {
    if (this.at_block > this.max_block) {
      return startSimulatorMonitoring(this);
    } else {
      return requestBlockData(this, this.at_block);
    }
  }

  async internalSetNewPeak(peak: number) {
    if (this.max_block === 0) {
      this.max_block = peak;
      this.at_block = peak;
    } else if (peak > this.max_block) {
      this.max_block = peak;
    }

    // console.log('FakeBlockchainInterface, peaks', this.at_block, '/', this.max_block);

    return this.internalNextBlock();
  }

  setNewPeak(peak: number) {
    this.pushEvent({ setNewPeak: peak });
  }

  deliverBlock(block_number: number, block_data: any[]) {
    this.pushEvent({ deliverBlock: { block_number, block_data } });
  }

  internalDeliverBlock(block_number: number, block_data: any[]) {
    // console.log('fake::internalDeliverBlock', block_number, block_data);
    this.at_block += 1;
    doBlockNotifications(block_number, [], block_data);

    return this.internalNextBlock();
  }

  withdraw() {
    this.deleted = true;
  }

  spend(spendBlob: string, spend: any): Promise<string> {
    return fetch(`${this.baseUrl}/spend?blob=${spend}`, {
      method: "POST"
    }).then((res) => res.json()).then((res) => {
      // console.log('fake spend returned', res);
      return res;
    });
  }
}

export function connectRealBlockchain(initialSpend: (target: string, amt: number) => Promise<any>): WalletBlockchainInterface {
  console.log('connectRealBlockchain');
  return new RealBlockchainInterface(
    "https://api.coinset.org",
    initialSpend
  );
}

export function connectSimulator(myPuzzleHash: string): FakeBlockchainInterface {
  console.warn("simulator active");

  let result = new FakeBlockchainInterface(
    "http://localhost:5800",
    myPuzzleHash
  );
  startSimulatorMonitoring(result);

  return result;
}

const outboundRequests: Record<string, any> = {};
let outboundRequestId = 1;
let outboundRequestsInitialized = false;

function nextOutboundRequestId() {
  return outboundRequestId++;
}

export class ChildFrameBlockchainInterface implements InternalBlockchainInterface {
  constructor() {
    if (!outboundRequestsInitialized) {
      outboundRequestsInitialized = true;
      window.addEventListener("message", (evt: any) => {
        let key = evt.data ? 'data' : 'message';
        let evtData = evt[key];

        if (evtData.name === 'blockchain_peak') {
          doBlockNotifications(evtData.peak, evtData.block, evtData.block_report);
          return;
        }

        if (evtData.name !== 'blockchain_reply' || !evtData.requestId) {
          return;
        }

        let request = outboundRequests[evtData.requestId];
        if (!request) {
          return;
        }

        delete outboundRequests[evtData.requestId];
        if (evtData.error) {
          request.reject(evtData.error);
          return;
        }

        request.resolve(evtData.result);
      });
    }
  }

  do_initial_spend(target: string, amt: number): Promise<string> {
    const requestId = nextOutboundRequestId();
    console.log('requestId', requestId, 'do_initial_spend', target, amt);
    return new Promise((resolve, reject) => {
      let request: any = {
        requestId: requestId,
        method: 'create_spendable',
        target,
        amt
      };
      window.parent.postMessage(request, "*");
      request.resolve = resolve;
      request.reject = reject;
      outboundRequests[requestId] = request;
    });
  }
  spend(cvt: (blob: string) => any, spend: string): Promise<string> {
    const requestId = nextOutboundRequestId();
    return new Promise((resolve, reject) => {
      let request: any = {
        requestId: requestId,
        method: 'spend',
        spend,
        convertedSpend: cvt(spend)
      };
      window.parent.postMessage(request, "*");
      request.resolve = resolve;
      request.reject = reject;
      outboundRequests[requestId] = request;
    });
  }

  withdraw(): void {
  }
}
