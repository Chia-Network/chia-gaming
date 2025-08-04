import ReconnectingWebSocket from 'reconnecting-websocket';
import { CoinOutput } from '../types/ChiaGaming';
import { generateOrRetrieveUniqueId, empty } from '../util';
function wsUrl(baseurl: string) {
  const url_with_new_method = baseurl.replace('http', 'ws');
  return `${url_with_new_method}/ws`;
}

type blockNotifyType = (peak: number, block: any[]) => void;
let blockNotifyId = 0;
let blockNotify: { [id: string]: blockNotifyType } = {};
let simulatorIsActive = false;

export function simulatorActive() { return simulatorIsActive; }

export function registerBlockchainNotifier(notifier: blockNotifyType): number {
  blockNotifyId += 1;
  const currentNumber = blockNotifyId;
  blockNotify[currentNumber.toString()] = notifier;
  return currentNumber;
}

export function unregisterBlockchainNotifier(id: number) {
  delete blockNotify[id.toString()];
}

function doBlockNotifications(peak: number, block: any[]) {
  const keys = Object.keys(blockNotify);
  keys.forEach((k) => {
    blockNotify[k](peak, block);
  });
}

export interface InternalBlockchainInterface {
  select_coins(amount: number): Promise<any>;
  sign_transaction(inputs: any[], outputs: CoinOutput[]): Promise<any>;
  spend(spend: any): Promise<string>;
  withdraw(): void;
}

export class RealBlockchainInterface implements InternalBlockchainInterface {
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

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
    this.walletId = 1;
    this.requestId = 1;
    this.requests = {};
    this.handlingEvent = false;
    this.peak = 0;
    this.at_block = 0;
    this.incomingEvents = [];
    this.ws = new ReconnectingWebSocket(wsUrl(this.baseUrl));

    this.ws.addEventListener('message', (m: any) => {
      const json = JSON.parse(m.data);
      console.log('coinset json', json);
      if (json.type === 'peak') {
        this.peak = json.data.height;
        this.pushEvent({checkPeak: true});
      }
    });

    window.addEventListener('message', (e: any) => {
      const messageKey = e.message ? 'message' : 'data';
      const messageData = e[messageKey];
      console.warn('inner frame received message', messageData);
      const messageName = messageData.name;
      if (messageName !== 'blockchain_reply') {
        return;
      }
      const requestId = messageData.requestId;
      console.log('blockchain_reply', messageData);
      if (this.requests[requestId]) {
        this.requests[requestId].complete(messageData.result);
      } else {
        console.error('no such request id', requestId);
      }
    });
  }

  withdraw() {
    this.ws.close();
  }

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
    doBlockNotifications(this.at_block, br_spends.block_spends);
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

  async getFingerprints(): Promise<string[]> {
    throw 'no';
  }

  async setFingerprint(fp: string): Promise<never[]> {
    throw 'no';
  }

  async getBalance(): Promise<string> {
    throw 'no';
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

  async select_coins(amount: number): Promise<any> {
    return this.push_request({
      name: 'blockchain',
      method: 'select_coins',
      amount
    });
  }

  async sign_transaction(inputs: any[], outputs: CoinOutput[]): Promise<any> {
    return this.push_request({
      name: 'blockchain',
      method: 'sign_transaction',
      inputs,
      outputs
    });
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

function startSimulatorMonitoring(forWho: any): Promise<any> {
  if (forWho.deleted) {
    return empty();
  }

  return fetch(`${forWho.baseUrl}/wait_block`, {
    method: 'POST'
  }).then((res) => res.json()).then((res) => {
    forWho.setNewPeak(res);
    return startSimulatorMonitoring(forWho);
  });
}

function requestBlockData(forWho: any, block_number: number): Promise<any> {
  return fetch(`${forWho.baseUrl}/get_block_data?block=${block_number}`, {
    method: 'POST'
  }).then((res) => res.json()).then((res) => {
    return forWho.deliverBlock(block_number, res);
  });
}

export class FakeBlockchainInterface implements InternalBlockchainInterface {
  baseUrl: string;
  deleted: boolean;
  at_block: number;
  max_block: number;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
    this.deleted = false;
    this.max_block = 0;
    this.at_block = 0;
  }

  setNewPeak(peak: number) {
    if (this.max_block === 0) {
      this.max_block = peak;
      this.at_block = peak;
    } else {
      this.max_block = peak;
    }

    if (this.at_block <= this.max_block) {
      return requestBlockData(this, this.at_block);
    }

    return empty();
  }

  deliverBlock(block_number: number, block_data: any[]) {
    if (this.at_block === block_number) {
      this.at_block += 1;
      doBlockNotifications(block_number, block_data);
      return this.setNewPeak(this.max_block);
    }

    return empty();
  }

  withdraw() {
    this.deleted = true;
  }

  select_coins(amount: number): Promise<any> {
    throw 'no-fake-select-coins';
  }
  sign_transaction(inputs: any[], outputs: CoinOutput[]): Promise<any> {
    throw 'no-fake-sign-transaction';
  }
  spend(spend: any): Promise<string> {
    throw 'no-fake-spend';
  }
}

let blockchainInterfaceSingleton: InternalBlockchainInterface | null = null;

export function connectRealBlockchain() {
  blockchainInterfaceSingleton = new RealBlockchainInterface(
    "https://api.coinset.org"
  );
}

export function getBlockchainInterfaceSingleton() {
  if (blockchainInterfaceSingleton) {
    return blockchainInterfaceSingleton;
  }

  simulatorIsActive = true;
  blockchainInterfaceSingleton = new FakeBlockchainInterface(
    "https://localhost:5800"
  );

  return blockchainInterfaceSingleton;
}
