import { Subject, Subscription } from 'rxjs';
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

type Bech32Module = { encode: (prefix: string, data: Uint8Array, encoding?: 'bech32' | 'bech32m') => string };
const bech32: Bech32Module = (bech32_module ? bech32_module : bech32_buffer);

type FakeBlockchainEvent =
  | { setNewPeak: number }
  | { deliverBlock: { block_number: number; block_data: WatchReport } };

function requestBlockData(forWho: FakeBlockchainInterface, block_number: number): Promise<void> {
  if (forWho.deleted) {
    return Promise.resolve();
  }
  return fetch(`${forWho.baseUrl}/get_block_data?block=${block_number}`, {
    method: 'POST',
  })
    .then((res) => res.json())
    .then((res: { created?: string[]; deleted?: string[]; timed_out?: string[] } | null) => {
      if (forWho.deleted) {
        return;
      }
      if (res === null) {
        return new Promise<void>((resolve) => {
          const handle = setTimeout(() => {
            forWho.timeoutHandles.delete(handle);
            if (forWho.deleted) {
              resolve(undefined);
              return;
            }
            requestBlockData(forWho, block_number).then(resolve);
          }, 100);
          forWho.timeoutHandles.add(handle);
        });
      }
      const converted_res: WatchReport = {
        created_watched: Array.isArray(res.created) ? res.created : [],
        deleted_watched: Array.isArray(res.deleted) ? res.deleted : [],
        timed_out: Array.isArray(res.timed_out) ? res.timed_out : [],
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
  incomingEvents: FakeBlockchainEvent[];
  blockEmitter: (b: BlockchainReport) => void;
  observable: Subject<BlockchainReport>;
  upstream: ExternalBlockchainInterface;
  timeoutHandles: Set<ReturnType<typeof setTimeout>>;

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
    this.timeoutHandles = new Set();
  }

  async getAddress() {
    return this.addressData;
  }

  startMonitoring(uniqueId: string) {
    this.deleted = false;
    return this.upstream.getOrRequestToken(uniqueId).then((puzzleHash) => {
      if (this.deleted) {
        return;
      }
      const address = bech32.encode('xch', toUint8(puzzleHash), 'bech32m');
      this.addressData = { address, puzzleHash };

      fetch(`${this.baseUrl}/get_peak`, { method: 'POST' })
        .then((res) => res.json())
        .then((peak) => {
          if (this.deleted) {
            return;
          }
          this.setNewPeak(peak);
        })
        .catch(e => console.error('[FakeBlockchain] failed to fetch peak:', e));
    });
  }

  getObservable() {
    return this.observable;
  }

  do_initial_spend(uniqueId: string, target: string, amt: bigint) {
    return this.upstream.getOrRequestToken(uniqueId).then((fromPuzzleHash) => {
      return this.upstream.createSpendable(target, amt).then((coin) => {
        if (!coin) {
          throw new Error('no coin returned.');
        }

        // Returns the coin string
        return { coin, fromPuzzleHash };
      });
    });
  }

  async kickEvent() {
    while (!this.deleted && this.incomingEvents.length) {
      this.handlingEvent = true;
      try {
        const event = this.incomingEvents.shift();
        if (!event) continue;
        await this.handleEvent(event);
      } catch (_) {
        // event processing failure; next event will be tried
      } finally {
        this.handlingEvent = false;
      }
    }
  }

  async pushEvent(evt: FakeBlockchainEvent) {
    if (this.deleted) {
      return;
    }
    this.incomingEvents.push(evt);
    if (!this.handlingEvent) {
      await this.kickEvent();
    }
  }

  async handleEvent(event: FakeBlockchainEvent) {
    if (this.deleted) {
      return;
    }
    if ('setNewPeak' in event) {
      this.internalSetNewPeak(event.setNewPeak);
    } else if ('deliverBlock' in event) {
      this.internalDeliverBlock(
        event.deliverBlock.block_number,
        event.deliverBlock.block_data,
      );
    }
  }

  async internalNextBlock() {
    if (this.deleted) {
      return;
    }
    if (this.at_block > this.max_block) {
      return fetch(`${this.baseUrl}/wait_block`, {
        method: 'POST',
      })
        .then((res) => res.json())
        .then((res) => {
          if (this.deleted) {
            return;
          }
          this.setNewPeak(res);
        });
    } else {
      return requestBlockData(this, this.at_block);
    }
  }

  async internalSetNewPeak(peak: number) {
    if (this.deleted) {
      return;
    }
    if (this.max_block === 0) {
      this.max_block = peak;
      this.at_block = peak;
    } else if (peak > this.max_block) {
      this.max_block = peak;
    }

    return this.internalNextBlock();
  }

  setNewPeak(peak: number) {
    if (this.deleted) {
      return;
    }
    this.pushEvent({ setNewPeak: peak });
  }

  deliverBlock(block_number: number, block_data: WatchReport) {
    if (this.deleted) {
      return;
    }
    this.pushEvent({ deliverBlock: { block_number, block_data } });
  }

  internalDeliverBlock(block_number: number, block_data: WatchReport) {
    if (this.deleted) {
      return;
    }
    this.at_block += 1;
    this.blockEmitter({
      peak: block_number,
      block: [],
      report: block_data,
    });

    return this.internalNextBlock();
  }

  spend(_convert: (blob: string) => unknown, spendBlob: string): Promise<string> {
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

  getBalance(): Promise<number> {
    return this.upstream.getBalance();
  }

  getPuzzleAndSolution(coin: string): Promise<string[] | null> {
    return this.upstream.getPuzzleAndSolution(coin);
  }

  selectCoins(uniqueId: string, amount: number): Promise<string | null> {
    return this.upstream.getOrRequestToken(uniqueId).then(() => {
      return this.upstream.selectCoins(amount);
    });
  }

  getHeightInfo(): Promise<number> {
    return this.upstream.getPeak();
  }

  createOfferForIds(
    uniqueId: string,
    offer: { [walletId: string]: number },
    extraConditions?: Array<{ opcode: number; args: string[] }>,
    coinIds?: string[],
  ): Promise<any | null> {
    const params: any = { offer };
    if (extraConditions) params.extraConditions = extraConditions;
    if (coinIds) params.coinIds = coinIds;
    return fetch(
      `${this.baseUrl}/create_offer_for_ids?who=${uniqueId}`,
      {
        body: JSON.stringify(params),
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
    ).then((f) => f.json());
  }

  close() {
    this.deleted = true;
    this.incomingEvents = [];
    this.timeoutHandles.forEach((handle) => clearTimeout(handle));
    this.timeoutHandles.clear();
  }
}

export const fakeBlockchainInfo = new FakeBlockchainInterface(
  BLOCKCHAIN_SERVICE_URL,
);
export const FAKE_BLOCKCHAIN_ID = blockchainDataEmitter.addUpstream(
  fakeBlockchainInfo.getObservable(),
);

let outboundSubscription: Subscription | undefined;

export function connectSimulatorBlockchain() {
  if (outboundSubscription) {
    return outboundSubscription;
  }
  outboundSubscription = blockchainConnector.getOutbound().subscribe({
    next: (evt: BlockchainOutboundRequest) => {
      let initialSpend = evt.initialSpend;
      let transaction = evt.transaction;
      let getAddress = evt.getAddress;
      let getBalance = evt.getBalance;
      if (initialSpend) {
        return fakeBlockchainInfo
          .do_initial_spend(
            initialSpend.uniqueId,
            initialSpend.target,
            initialSpend.amount,
          )
          .then((result) => {
            blockchainConnector.replyEmitter({
              responseId: evt.requestId,
              initialSpend: result,
            });
          })
          .catch((e: unknown) => {
            blockchainConnector.replyEmitter({
              responseId: evt.requestId,
              error: String(e),
            });
          });
      } else if (transaction) {
        fakeBlockchainInfo
          .spend((_blob: string) => transaction.spendObject, transaction.blob)
          .then((response) => {
            blockchainConnector.replyEmitter({
              responseId: evt.requestId,
              transaction: response,
            });
          })
          .catch((e: unknown) => {
            blockchainConnector.replyEmitter({
              responseId: evt.requestId,
              error: String(e),
            });
          });
      } else if (getAddress) {
        fakeBlockchainInfo.getAddress().then((address) => {
          blockchainConnector.replyEmitter({
            responseId: evt.requestId,
            getAddress: address,
          });
        });
      } else if (getBalance) {
        fakeBlockchainInfo.getBalance().then((balance) => {
          blockchainConnector.replyEmitter({ responseId: evt.requestId, getBalance: balance });
        });
      } else if (evt.getPuzzleAndSolution) {
        fakeBlockchainInfo.upstream
          .getPuzzleAndSolution(evt.getPuzzleAndSolution.coin)
          .then((result) => {
            blockchainConnector.replyEmitter({
              responseId: evt.requestId,
              getPuzzleAndSolution: result,
            });
          });
      } else if (evt.selectCoins) {
        fakeBlockchainInfo.selectCoins(evt.selectCoins.uniqueId, evt.selectCoins.amount).then((coin) => {
          blockchainConnector.replyEmitter({ responseId: evt.requestId, selectCoins: coin });
        }).catch((e: unknown) => {
          blockchainConnector.replyEmitter({ responseId: evt.requestId, error: String(e) });
        });
      } else if (evt.getHeightInfo) {
        fakeBlockchainInfo.getHeightInfo().then((height) => {
          blockchainConnector.replyEmitter({ responseId: evt.requestId, getHeightInfo: height });
        }).catch((e: unknown) => {
          blockchainConnector.replyEmitter({ responseId: evt.requestId, error: String(e) });
        });
      } else if (evt.createOfferForIds) {
        fakeBlockchainInfo.createOfferForIds(
          evt.createOfferForIds.uniqueId,
          evt.createOfferForIds.offer,
          evt.createOfferForIds.extraConditions,
          evt.createOfferForIds.coinIds,
        ).then((result) => {
          blockchainConnector.replyEmitter({ responseId: evt.requestId, createOfferForIds: result });
        }).catch((e: unknown) => {
          blockchainConnector.replyEmitter({ responseId: evt.requestId, error: String(e) });
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
  return outboundSubscription;
}

export function disconnectSimulatorBlockchain() {
  if (outboundSubscription) {
    outboundSubscription.unsubscribe();
    outboundSubscription = undefined;
  }
  fakeBlockchainInfo.close();
}

// Set up to receive information about which blockchain system to use.
// The signal from the blockchainDataEmitter will let the downstream system
// choose and also inform us heore of the choice.
blockchainDataEmitter.getSelectionObservable().subscribe({
  next: (e: SelectionMessage) => {
    if (e.selection == FAKE_BLOCKCHAIN_ID) {
      fakeBlockchainInfo.startMonitoring(e.uniqueId);
      connectSimulatorBlockchain();
    } else {
      disconnectSimulatorBlockchain();
    }
  },
});
