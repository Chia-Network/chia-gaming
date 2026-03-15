import { Subject, NextObserver } from 'rxjs';
import { Program } from 'clvm-lib';

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

function clvmToBytes(value: Program | null): Uint8Array {
  if (value === null || value === undefined) return new Uint8Array([0x80]);
  return value.serialize();
}

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
      try {
        const result = this.cradle?.deliver_message(m);
        this.processResult(result);
      } catch (e) {
        console.error('[wasm] deliver_message failed:', e,
          'msg length:', m.length, 'is_odd:', m.length % 2 !== 0, 'msg:', m);
      }
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
    this.blockchain.spend(cvt, blob).catch(e => console.error('[wasm] submitTransaction failed:', e));
  }

  processResult(result: any): void {
    if (!result || this.finished) return;

    const msgs = result.outbound_messages || [];
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
      this.rxjsEmitter?.next({ type: 'error', error: err });
    }
    for (const n of result.notifications || []) {
      const tag = typeof n === 'object' && n !== null ? Object.keys(n)[0] : String(n);
      if (tag === 'ChannelCreated' && !this.channelReady) {
        this.channelReady = true;
      }
      this.rxjsEmitter?.next({ type: 'notification', data: n });
    }
    for (const coin of result.coin_solution_requests || []) {
      this.fulfillPuzzleSolutionRequest(coin);
    }
  }

  private async fulfillPuzzleSolutionRequest(coinHex: string) {
    try {
      const ps = await this.blockchain.getPuzzleAndSolution(coinHex);
      if (this.cradle) {
        const result = ps
          ? this.cradle.report_puzzle_and_solution(coinHex, ps[0], ps[1])
          : this.cradle.report_puzzle_and_solution(coinHex, undefined, undefined);
        this.processResult(result);
      }
    } catch (e) {
      console.error('[wasm] puzzle/solution fetch failed:', e);
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
    try {
      const result = this.cradle?.block_data(peak, block_report);
      this.processResult(result);
    } catch (e) {
      console.error('[wasm] block_data failed:', e,
        '\ncradle:', this.cradle !== undefined ? 'defined' : 'undefined',
        '\npeak:', peak,
        '\nreport:', JSON.stringify(block_report),
      );
    }
  }

  // --- Game actions (called by higher layer) ---

  proposeGame(params: any): string[] {
    if (!this.cradle) throw new Error('no cradle');
    const paramBytes = clvmToBytes(params.parameters);
    const { parameters: _drop, ...wasmParams } = params;
    const result = this.cradle.propose_game(wasmParams, paramBytes);
    this.processResult(result);
    return result?.ids || [];
  }

  acceptProposal(gameId: string): void {
    if (!this.cradle) throw new Error('no cradle');
    const result = this.cradle.accept_proposal(gameId);
    this.processResult(result);
  }

  makeMove(gameId: string, readable: Program | null): void {
    if (!this.cradle) throw new Error('no cradle');
    const bytes = clvmToBytes(readable);
    const result = this.cradle.make_move(gameId, bytes);
    this.processResult(result);
  }

  acceptTimeout(gameId: string): void {
    if (!this.cradle) throw new Error('no cradle');
    const result = this.cradle.accept(gameId);
    this.processResult(result);
  }

  cheat(gameId: string, moverShare: number): void {
    if (!this.cradle) throw new Error('no cradle');
    const result = this.cradle.cheat(gameId, moverShare);
    this.processResult(result);
  }

  cleanShutdown(): void {
    if (!this.cradle) return;
    this.cleanShutdownCalled = true;
    try {
      const result = this.cradle.shut_down();
      this.processResult(result);
    } catch (e) {
      const msg = e instanceof Error ? e.message
        : typeof e === 'object' && e !== null && 'error' in e ? (e as any).error
        : String(e);
      console.error('[wasm] cleanShutdown failed:', msg);
      this.rxjsEmitter?.next({ type: 'error', error: msg });
    }
  }

  goOnChain(): void {
    if (!this.cradle) throw new Error('no cradle');
    try {
      const result = this.cradle.go_on_chain();
      this.processResult(result);
    } catch (e) {
      const msg = e instanceof Error ? e.message
        : typeof e === 'object' && e !== null && 'error' in e ? (e as any).error
        : String(e);
      console.error('[wasm] goOnChain failed:', msg);
      this.rxjsEmitter?.next({ type: 'error', error: msg });
    }
  }
}
