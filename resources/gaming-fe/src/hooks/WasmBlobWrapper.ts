import { Subject, NextObserver } from 'rxjs';

import {
  PeerConnectionResult,
  WasmConnection,
  ChiaGame,
  WatchReport,
  InternalBlockchainInterface,
  BlockchainInboundAddressResult,
  WasmEvent,
} from '../types/ChiaGaming';
import {
  spend_bundle_to_clvm,
} from '../util';

function combine_reports(old_report: WatchReport, new_report: WatchReport) {
  for (const item of new_report.created_watched) {
    old_report.created_watched.push(item);
  }
  for (const item of new_report.deleted_watched) {
    old_report.deleted_watched.push(item);
  }
  for (const item of new_report.timed_out) {
    old_report.timed_out.push(item);
  }
}

export class WasmBlobWrapper {
  amount: number;
  wc: WasmConnection | undefined;
  sendMessage: (msgno: number, msg: string) => void;
  messageNumber: number;
  remoteNumber: number;
  cradle: ChiaGame | undefined;
  uniqueId: string;
  channelReady: boolean;
  storedMessages: string[];
  cleanShutdownCalled: boolean;
  finished: boolean;
  reloading: boolean;
  qualifyingEvents: number;
  iStarted: boolean;
  blockchain: InternalBlockchainInterface;
  rxjsMessageSingleton: Subject<WasmEvent>;
  rxjsEmitter: NextObserver<WasmEvent> | undefined;

  constructor(
    blockchain: InternalBlockchainInterface,
    uniqueId: string,
    amount: number,
    iStarted: boolean,
    peer_conn: PeerConnectionResult,
  ) {
    const { sendMessage } = peer_conn;
    this.uniqueId = uniqueId;
    this.messageNumber = 1;
    this.remoteNumber = 0;
    this.sendMessage = sendMessage;
    this.amount = amount;
    this.channelReady = false;
    this.iStarted = iStarted;
    this.storedMessages = [];
    this.cleanShutdownCalled = false;
    this.finished = false;
    this.reloading = false;
    this.qualifyingEvents = 0;
    this.blockchain = blockchain;
    this.rxjsMessageSingleton = new Subject<WasmEvent>();
    this.rxjsEmitter = {
      next: (evt: WasmEvent) => {
        this.rxjsMessageSingleton.next(evt);
      }
    };
  }

  setReloading() { this.reloading = true; }

  cleanup() {
    this.finished = true;
    this.cleanShutdownCalled = true;
    this.storedMessages = [];
    this.rxjsMessageSingleton.complete();
  }

  systemState(): number { return this.qualifyingEvents; }

  getWasmConnection(): WasmConnection | undefined { return this.wc; }

  isChannelReady(): boolean { return this.channelReady; }

  getObservable() {
    return this.rxjsMessageSingleton;
  }

  spillStoredMessages() {
    if (this.qualifyingEvents != 15 || !this.cradle || this.reloading) {
      return;
    }
    const storedMessages = this.storedMessages;
    this.storedMessages = [];
    storedMessages.forEach((m) => {
      const result = this.cradle?.deliver_message(m);
      this.processResult(result);
    });
  }

  setGameCradle(cradle: ChiaGame) {
    this.cradle = cradle;
    this.spillStoredMessages();
  }

  activateSpend(coin: string) {
    if (!this.wc) { throw new Error("this.wc is falsey") }
    const result = this.cradle?.opening_coin(coin);
    this.processResult(result);
  }

  setBlockchainAddress(a: BlockchainInboundAddressResult) {
    this.rxjsEmitter?.next({ type: 'address', data: a });
  }

  kickSystem(flags: number) {
    this.qualifyingEvents |= flags;
    if (this.qualifyingEvents == 7) {
      this.qualifyingEvents |= 8;
      this.spillStoredMessages();
    }
  }

  loadWasm(wasmConnection: WasmConnection) {
    if (this.wc !== undefined) { throw new Error("wc already set") }
    if (!wasmConnection) { throw new Error("wasmConnection is falsey") }
    this.wc = wasmConnection;
    this.kickSystem(1);
  }

  private submitTransaction(tx: any) {
    const blob = spend_bundle_to_clvm(tx);
    const cvt = (blob: string) => {
      return this.wc?.convert_spend_to_coinset_org(blob);
    };
    this.blockchain.spend(cvt, blob).then(() => {});
  }

  processResult(result: any): void {
    if (!result || this.finished) return;

    const msgs = result.outbound_messages || [];
    if (msgs.length > 0) {
      console.log(`[wasm] sending ${msgs.length} outbound message(s)`);
    }
    for (const msg of msgs) {
      this.sendMessage(this.messageNumber++, msg);
    }
    for (const tx of result.outbound_transactions || []) {
      this.submitTransaction(tx);
    }
    if (result.finished && !this.finished) {
      this.finished = true;
      this.rxjsEmitter?.next({ type: 'finished' });
    }
    for (const err of result.receive_errors || []) {
      console.error('[wasm] receive error:', err);
      this.rxjsEmitter?.next({ type: 'error', error: err });
    }
    for (const n of result.notifications || []) {
      const tag = typeof n === 'object' && n !== null ? Object.keys(n)[0] : String(n);
      console.log('[wasm] notification:', tag);
      if (tag === 'ChannelCreated' && !this.channelReady) {
        this.channelReady = true;
      }
      this.rxjsEmitter?.next({ type: 'notification', data: n });
    }
  }

  // --- Inbound events ---

  deliverMessage(msgno: number, msg: string) {
    if (!this.wc || !this.cradle || this.qualifyingEvents != 15 || this.reloading) {
      this.storedMessages.push(msg);
      return;
    }
    if (this.remoteNumber >= msgno) {
      return;
    }
    this.remoteNumber = msgno;
    const result = this.cradle.deliver_message(msg);
    console.log(`[wasm] deliverMessage #${msgno} DELIVERED`);
    this.processResult(result);
  }

  blockNotification(peak: number, blocks: any[], block_report: any) {
    if (block_report === undefined) {
      block_report = {
        created_watched: [],
        deleted_watched: [],
        timed_out: [],
      };
      for (const block of blocks) {
        const one_report =
          this.wc?.convert_coinset_org_block_spend_to_watch_report(
            block.coin.parent_coin_info,
            block.coin.puzzle_hash,
            block.coin.amount.toString(),
            block.puzzle_reveal,
            block.solution,
          );
        if (one_report) {
          combine_reports(block_report, one_report);
        }
      }
    }
    this.kickSystem(4);
    const result = this.cradle?.block_data(peak, block_report);
    this.processResult(result);
  }

  // --- Game actions (called by higher layer) ---

  proposeGame(params: any): string[] {
    if (!this.cradle) throw new Error('no cradle');
    const result = this.cradle.propose_game(params);
    this.processResult(result);
    return result?.ids || [];
  }

  acceptProposal(gameId: string): void {
    if (!this.cradle) throw new Error('no cradle');
    const result = this.cradle.accept_proposal(gameId);
    this.processResult(result);
  }

  makeMove(gameId: string, readable: string, entropy?: string): void {
    if (!this.cradle) throw new Error('no cradle');
    let result;
    if (entropy) {
      result = this.cradle.make_move_entropy(gameId, readable, entropy);
    } else {
      result = this.cradle.make_move_entropy(gameId, readable, this.generateEntropy());
    }
    this.processResult(result);
  }

  acceptTimeout(gameId: string): void {
    if (!this.cradle) throw new Error('no cradle');
    const result = this.cradle.accept(gameId);
    this.processResult(result);
  }

  cleanShutdown(): void {
    if (!this.cradle) return;
    this.cleanShutdownCalled = true;
    const result = this.cradle.shut_down();
    this.processResult(result);
  }

  generateEntropy(): string {
    const hexDigits = [];
    for (let i = 0; i < 16; i++) {
      hexDigits.push(Math.floor(Math.random() * 16).toString(16));
    }
    const entropy = this.wc?.sha256bytes(hexDigits.join(''));
    if (!entropy) {
      throw new Error('tried to make entropy without a wasm connection');
    }
    return entropy;
  }
}
