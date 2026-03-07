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
  handshakeDone: boolean;
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
    this.handshakeDone = false;
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

  isHandshakeDone(): boolean { return this.handshakeDone; }

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
      this.cradle?.deliver_message(m);
    });
  }

  setGameCradle(cradle: ChiaGame) {
    this.cradle = cradle;
    this.spillStoredMessages();
  }

  activateSpend(coin: string) {
    if (!this.wc) { throw new Error("this.wc is falsey") }
    this.cradle?.opening_coin(coin);
    this.drainAll();
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

  drainAll(): void {
    if (!this.cradle || this.finished) return;

    const notifications: any[] = [];
    while (true) {
      const result = this.cradle.idle({
        notification: (json: string) => {
          try {
            notifications.push(JSON.parse(json));
          } catch (e) {
            console.warn('failed to parse notification', e);
          }
        }
      });
      if (!result) break;

      for (const msg of result.outbound_messages) {
        this.sendMessage(this.messageNumber++, msg);
      }
      for (const tx of result.outbound_transactions) {
        this.submitTransaction(tx);
      }

      if (result.handshake_done && !this.handshakeDone) {
        this.handshakeDone = true;
        this.rxjsEmitter?.next({ type: 'handshake_done' });
      }
      if (result.finished && !this.finished) {
        this.finished = true;
        this.rxjsEmitter?.next({ type: 'finished' });
      }
      if (result.receive_error) {
        this.rxjsEmitter?.next({ type: 'error', error: result.receive_error });
      }
      if (!result.continue_on) break;
    }

    for (const n of notifications) {
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
    this.cradle.deliver_message(msg);
    this.drainAll();
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
    this.cradle?.block_data(peak, block_report);
    this.drainAll();
  }

  // --- Game actions (called by higher layer) ---

  proposeGame(params: any): string[] {
    if (!this.cradle) throw new Error('no cradle');
    const ids = this.cradle.propose_game(params);
    this.drainAll();
    return ids;
  }

  acceptProposal(gameId: string): void {
    if (!this.cradle) throw new Error('no cradle');
    this.cradle.accept_proposal(gameId);
    this.drainAll();
  }

  makeMove(gameId: string, readable: string, entropy?: string): void {
    if (!this.cradle) throw new Error('no cradle');
    if (entropy) {
      this.cradle.make_move_entropy(gameId, readable, entropy);
    } else {
      this.cradle.make_move_entropy(gameId, readable, this.generateEntropy());
    }
    this.drainAll();
  }

  acceptTimeout(gameId: string): void {
    if (!this.cradle) throw new Error('no cradle');
    this.cradle.accept(gameId);
    this.drainAll();
  }

  cleanShutdown(): void {
    if (!this.cradle) return;
    this.cleanShutdownCalled = true;
    this.cradle.shut_down();
    this.drainAll();
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
