import ReconnectingWebSocket from 'reconnecting-websocket';

function wsUrl(baseurl: string) {
  const url_with_new_method = baseurl.replace('http', 'ws');
  return `${url_with_new_method}/ws`;
}

export class BlockchainInterface {
  baseUrl: string;
  fingerprint?: string;
  walletId: number;
  requestId: number;
  requests: any;
  peak: number;
  at_block: number;
  handlingEvent: boolean;
  incomingEvents: any[];
  ws: any;
  notify_block: (peak: number, block: any[]) => void;

  constructor(notify_block: (peak: number, block: any[]) => void, baseUrl: string) {
    this.baseUrl = baseUrl;
    this.walletId = 1;
    this.requestId = 1;
    this.requests = {};
    this.handlingEvent = false;
    this.peak = 0;
    this.at_block = 0;
    this.incomingEvents = [];
    this.ws = new ReconnectingWebSocket(wsUrl(this.baseUrl));
    this.notify_block = notify_block;

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
    this.notify_block(this.at_block, br_spends.block_spends);
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

  async create_spendable(target: string, amt: number): Promise<any> {
    return this.push_request({
      name: 'blockchain',
      method: 'create_spendable',
      target: target,
      amt: amt
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

let blockchainInterfaceSingleton: any = null;

export function getBlockchainInterfaceSingleton(notify_block: (peak: number, block: any[]) => void) {
  if (blockchainInterfaceSingleton) {
    return blockchainInterfaceSingleton;
  }

  blockchainInterfaceSingleton = new BlockchainInterface(
    notify_block,
    "https://api.coinset.org"
  );
  return blockchainInterfaceSingleton;
}
