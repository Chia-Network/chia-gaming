import { Subject } from 'rxjs';
// @ts-ignore
import bech32_module from 'bech32-buffer';
// @ts-ignore
import * as bech32_buffer from 'bech32-buffer';
import { toUint8 } from '../util';

import { BLOCKCHAIN_SERVICE_URL } from '../settings';
import {
  ExternalBlockchainInterface,
  InternalBlockchainInterface,
  BlockchainInboundAddressResult,
  BlockchainReport,
  WatchReport,
  SelectionMessage,
} from '../types/ChiaGaming';

import {
  blockchainConnector,
  BlockchainOutboundRequest,
} from './BlockchainConnector';
import { blockchainDataEmitter } from './BlockchainInfo';

const bech32: any = (bech32_module ? bech32_module : bech32_buffer);

function requestBlockData(forWho: any, block_number: number): Promise<any> {
  return fetch(`${forWho.baseUrl}/get_block_data?block=${block_number}`, {
    method: 'POST',
  })
    .then((res) => res.json())
    .then((res) => {
      if (res === null) {
        return new Promise((_resolve, _reject) => {
          setTimeout(() => {
            requestBlockData(forWho, block_number);
          }, 100);
        });
      }
      const converted_res: WatchReport = {
        created_watched: res.created,
        deleted_watched: res.deleted,
        timed_out: res.timed_out,
      };
      forWho.deliverBlock(block_number, converted_res);
    });
}

export class FakeBlockchainInterface implements InternalBlockchainInterface {
  baseUrl: string;
  addressData: BlockchainInboundAddressResult;
  deleted: boolean;
  at_block: number;
  max_block: number;
  handlingEvent: boolean;
  incomingEvents: any[];
  blockEmitter: (b: BlockchainReport) => void;
  observable: Subject<BlockchainReport>;
  upstream: ExternalBlockchainInterface;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
    this.addressData = { address: '', puzzleHash: '' };
    this.deleted = false;
    this.max_block = 0;
    this.at_block = 0;
    this.handlingEvent = false;
    this.incomingEvents = [];
    this.upstream = new ExternalBlockchainInterface(baseUrl);
    this.observable = new Subject();
    this.blockEmitter = (b) => this.observable.next(b);
  }

  async getAddress() {
    return this.addressData;
  }

  startMonitoring(uniqueId: string) {
    console.log('startMonitoring', uniqueId);

    return this.upstream.getOrRequestToken(uniqueId).then((puzzleHash) => {
      const address = bech32.encode('xch', toUint8(puzzleHash), 'bech32m');
      this.addressData = { address, puzzleHash };

      fetch(`${this.baseUrl}/get_peak`, { method: 'POST' })
        .then((res) => res.json())
        .then((peak) => {
          this.setNewPeak(peak);
        });
    });
  }

  getObservable() {
    return this.observable;
  }

  do_initial_spend(uniqueId: string, target: string, amt: number) {
    return this.upstream.getOrRequestToken(uniqueId).then((fromPuzzleHash) => {
      return this.upstream.createSpendable(target, amt).then((coin) => {
        if (!coin) {
          throw new Error('no coin returned.');
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
      this.internalDeliverBlock(
        event.deliverBlock.block_number,
        event.deliverBlock.block_data,
      );
    }
  }

  async internalNextBlock() {
    if (this.at_block > this.max_block) {
      return fetch(`${this.baseUrl}/wait_block`, {
        method: 'POST',
      })
        .then((res) => res.json())
        .then((res) => {
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
      report: block_data,
    });

    return this.internalNextBlock();
  }

  spend(_convert: (blob: string) => any, spendBlob: string): Promise<string> {
    return this.upstream.spend(spendBlob).then((status_array) => {
      if (status_array.length < 1) {
        throw new Error('status result array was empty');
      }

      if (status_array[0] != 1) {
        if (status_array.length != 2) {
          throw new Error(`spend status ${status_array[0]} with no detail`);
        }
        // Could make additional choices on status_array[1]
        throw new Error(`spend error status ${status_array}`);
      }

      // What to return?
      return '';
    });
  }
}

export const fakeBlockchainInfo = new FakeBlockchainInterface(
  BLOCKCHAIN_SERVICE_URL,
);
export const FAKE_BLOCKCHAIN_ID = blockchainDataEmitter.addUpstream(
  fakeBlockchainInfo.getObservable(),
);

export function connectSimulatorBlockchain() {
  blockchainConnector.getOutbound().subscribe({
    next: (evt: BlockchainOutboundRequest) => {
      let initialSpend = evt.initialSpend;
      let transaction = evt.transaction;
      let getAddress = evt.getAddress;
      if (initialSpend) {
        return fakeBlockchainInfo
          .do_initial_spend(
            initialSpend.uniqueId,
            initialSpend.target,
            initialSpend.amount,
          )
          .then((result: any) => {
            blockchainConnector.replyEmitter({
              responseId: evt.requestId,
              initialSpend: result,
            });
          })
          .catch((e: any) => {
            blockchainConnector.replyEmitter({
              responseId: evt.requestId,
              error: e.toString(),
            });
          });
      } else if (transaction) {
        fakeBlockchainInfo
          .spend((_blob: string) => transaction.spendObject, transaction.blob)
          .then((response: any) => {
            blockchainConnector.replyEmitter({
              responseId: evt.requestId,
              transaction: response,
            });
          })
          .catch((e: any) => {
            blockchainConnector.replyEmitter({
              responseId: evt.requestId,
              error: e.toString(),
            });
          });
      } else if (getAddress) {
        fakeBlockchainInfo.getAddress().then((address) => {
          blockchainConnector.replyEmitter({
            responseId: evt.requestId,
            getAddress: address,
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

// Set up to receive information about which blockchain system to use.
// The signal from the blockchainDataEmitter will let the downstream system
// choose and also inform us heore of the choice.
blockchainDataEmitter.getSelectionObservable().subscribe({
  next: (e: SelectionMessage) => {
    if (e.selection == FAKE_BLOCKCHAIN_ID) {
      // Simulator selected
      console.log('simulator blockchain selected');
      fakeBlockchainInfo.startMonitoring(e.uniqueId);
      connectSimulatorBlockchain();
    }
  },
});
