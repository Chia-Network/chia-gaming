import { Observable } from 'rxjs';
import { WatchReport, ExternalBlockchainInterface, ToggleEmitter, BlockchainReport, InternalBlockchainInterface, DoInitialSpendResult, SelectionMessage } from '../types/ChiaGaming';
import { generateOrRetrieveUniqueId } from '../util';

function requestBlockData(forWho: any, block_number: number): Promise<any> {
  console.log('requestBlockData', block_number);
  return fetch(`${forWho.baseUrl}/get_block_data?block=${block_number}`, {
    method: 'POST'
  }).then((res) => res.json()).then((res) => {
    if (res === null) {
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          requestBlockData(forWho, block_number);
        }, 100);
      });
    }
    console.log('requestBlockData, got', res);
    const converted_res: WatchReport = {
      created_watched: res.created,
      deleted_watched: res.deleted,
      timed_out: res.timed_out
    };
    forWho.deliverBlock(block_number, converted_res);
  });
}

export class FakeBlockchainInterface implements InternalBlockchainInterface {
  baseUrl: string;
  deleted: boolean;
  at_block: number;
  max_block: number;
  handlingEvent: boolean;
  incomingEvents: any[];
  blockEmitter: (b: BlockchainReport) => void;
  observable: Observable<BlockchainReport>;
  upstream: ExternalBlockchainInterface;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
    this.deleted = false;
    this.max_block = 0;
    this.at_block = 0;
    this.handlingEvent = false;
    this.incomingEvents = [];
    this.upstream = new ExternalBlockchainInterface(baseUrl);
    this.blockEmitter = (b) => {};
    this.observable = new Observable((emitter) => {
      this.blockEmitter = (b) => emitter.next(b);
    });
  }

  startMonitoring(uniqueId: string) {
    this.upstream.getOrRequestToken(uniqueId).then(() => {
      fetch(`${this.baseUrl}/get_peak`, {method: "POST"}).then(res => res.json()).then(peak => {
        this.setNewPeak(peak);
      });
    });
  }

  getObservable() { return this.observable; }

  do_initial_spend(uniqueId: string, target: string, amt: number) {
    return this.upstream.getOrRequestToken(uniqueId).then((fromPuzzleHash) => {
      return this.upstream.createSpendable(target, amt).then((coin) => {
        if (!coin) {
          throw new Error("no coin returned.");
        }

        // Returns the coin string
        console.log('set opening coin', coin);
        return { coin, fromPuzzleHash };
      });
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
      return fetch(`${this.baseUrl}/wait_block`, {
        method: 'POST'
      }).then((res) => res.json()).then((res) => {
        // console.log('wait_block returned', res);
        this.setNewPeak(res);
      });
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

    console.log('FakeBlockchainInterface, peaks', this.at_block, '/', this.max_block);
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
    this.blockEmitter({
      peak: block_number,
      block: [],
      report: block_data
    });

    return this.internalNextBlock();
  }

  spend(convert: (blob: string) => any, spendBlob: string): Promise<string> {
    return this.upstream.spend(spendBlob).then((status_array) => {
      if (status_array.length < 1) {
        throw new Error("status result array was empty");
      }

      if (status_array[0] != 1) {
        if (status_array.length != 2) {
          throw new Error(`spend status ${status_array[0]} with no detail`);
        }
        // Could make additional choices on status_array[1]
        throw new Error(`spend error status ${status_array}`);
      }

      // What to return?
      return "";
    });
  }
}

const fakeBlockchainInfo = new FakeBlockchainInterface("http://localhost:5800");
export const blockchainDataEmitter = new ToggleEmitter<BlockchainReport>([fakeBlockchainInfo.getObservable()]);

export class ChildFrameBlockchainInterface {
  externalBlockchainInterface: FakeBlockchainInterface;

  constructor() {
    this.externalBlockchainInterface = new FakeBlockchainInterface("http://localhost:5800");
  }

  do_initial_spend(uniqueId: string, target: string, amt: number): Promise<DoInitialSpendResult> {
    return this.externalBlockchainInterface.do_initial_spend(uniqueId, target, amt);
  }

  spend(cvt: (blob: string) => any, spend: string): Promise<string> {
    return this.externalBlockchainInterface.spend(cvt, spend);
  }

  getObservable() {
    return blockchainDataEmitter.getObservable();
  }
}
// Set up to receive information about which blockchain system to use.
// The signal from the blockchainDataEmitter will let the downstream system
// choose and also inform us here of the choice.
blockchainDataEmitter.getSelectionObservable().subscribe({
  next: (e: SelectionMessage) => {
    if (e.selection == 0) {
      // Simulator selected
      console.log("simulator blockchain selected");
      fakeBlockchainInfo.startMonitoring(e.uniqueId);
    }
  }
});
