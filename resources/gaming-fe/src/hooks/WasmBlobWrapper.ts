import { Subject, NextObserver } from 'rxjs';
import { Program } from 'clvm-lib';

import {
  CradleEvent,
  PeerConnectionResult,
  WasmConnection,
  ChiaGame,
  WatchReport,
  WasmResult,
  SpendBundle,
  CoinsetOrgBlockSpend,
  ProposeGameParams,
  InternalBlockchainInterface,
  BlockchainInboundAddressResult,
  WasmEvent,
} from '../types/ChiaGaming';
import {
  spend_bundle_to_clvm,
} from '../util';
import { debugLog } from '../services/debugLog';
import { saveSession, clearSession, SessionSave, CalpokerHandState, BlockchainType } from './save';

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

const SAVE_DEBOUNCE_MS = 500;
const PING_INTERVAL_MS = 15_000;
const PEER_TIMEOUT_MS = 60_000;

export class WasmBlobWrapper {
  amount: bigint;
  perGameAmount: bigint;
  wc: WasmConnection | undefined;
  sendMessage: (msgno: number, msg: string) => void;
  sendAck: (ackMsgno: number) => void;
  private peerSendPing: (() => void) | null = null;
  private peerClose: (() => void) | null = null;
  private lastPeerMessageTime: number = Date.now();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  messageNumber: number;
  remoteNumber: number;
  cradle: ChiaGame | undefined;
  uniqueId: string;
  pairingToken: string;
  channelReady: boolean;
  iStarted: boolean;
  storedMessages: Array<{ msgno: number; msg: string }>;
  cleanShutdownCalled: boolean;
  finished: boolean;
  reloading: boolean;
  qualifyingEvents: number;
  blockchain: InternalBlockchainInterface;
  rxjsMessageSingleton: Subject<WasmEvent>;
  rxjsEmitter: NextObserver<WasmEvent> | undefined;
  private eventQueue: CradleEvent[] = [];
  private draining = false;
  private firstBlockLogged = false;
  private pendingBlockNotification: { peak: number; report: WatchReport } | null = null;
  launcherProvided: boolean;

  unackedMessages: Array<{ msgno: number; msg: string }> = [];
  pendingTransactions: string[] = [];
  gameLog: string[] = [];
  debugLogHistory: string[] = [];
  private reorderQueue: Map<number, string> = new Map();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private restoredSession = false;
  blockchainType: BlockchainType = 'simulator';
  activeGameId: string | null = null;
  handState: CalpokerHandState | null = null;

  constructor(
    blockchain: InternalBlockchainInterface,
    uniqueId: string,
    amount: bigint,
    peer_conn: PeerConnectionResult,
  ) {
    const { sendMessage, sendAck } = peer_conn;
    this.uniqueId = uniqueId;
    this.pairingToken = '';
    this.messageNumber = 1;
    this.remoteNumber = 0;
    this.sendMessage = sendMessage;
    this.sendAck = sendAck;
    this.amount = amount;
    this.perGameAmount = 0n;
    this.iStarted = false;
    this.channelReady = false;
    this.storedMessages = [];
    this.cleanShutdownCalled = false;
    this.finished = false;
    this.reloading = false;
    this.qualifyingEvents = 0;
    this.blockchain = blockchain;
    this.launcherProvided = false;
    this.rxjsMessageSingleton = new Subject<WasmEvent>();
    this.rxjsEmitter = {
      next: (evt: WasmEvent) => {
        this.rxjsMessageSingleton.next(evt);
      }
    };
  }

  setReloading() { this.reloading = true; }

  setPeerPingAndClose(sendPing: () => void, close: () => void) {
    this.peerSendPing = sendPing;
    this.peerClose = close;
  }

  cleanup() {
    this.finished = true;
    this.cleanShutdownCalled = true;
    this.storedMessages = [];
    this.rxjsMessageSingleton.complete();
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.stopPingTimer();
  }

  notePeerActivity() {
    this.lastPeerMessageTime = Date.now();
  }

  receivePing() {
    this.notePeerActivity();
  }

  startPingTimer() {
    this.stopPingTimer();
    this.lastPeerMessageTime = Date.now();
    this.pingTimer = setInterval(() => {
      this.peerSendPing?.();
      if (
        Date.now() - this.lastPeerMessageTime > PEER_TIMEOUT_MS &&
        this.channelReady && !this.finished && !this.cleanShutdownCalled
      ) {
        debugLog('[wasm] peer liveness timeout, going on-chain');
        this.goOnChain();
        this.peerClose?.();
        this.stopPingTimer();
      }
    }, PING_INTERVAL_MS);
  }

  private stopPingTimer() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
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
    for (const { msgno, msg } of storedMessages) {
      this.deliverMessage(msgno, msg);
    }

    if (this.restoredSession) {
      this.restoredSession = false;
      this.resendUnacked();
      this.resubmitPendingTransactions();
      if (this.channelReady) {
        this.startPingTimer();
      }
    }
  }

  setGameCradle(cradle: ChiaGame) {
    this.cradle = cradle;
    if (this.pendingBlockNotification) {
      const { peak, report } = this.pendingBlockNotification;
      this.pendingBlockNotification = null;
      this.deliverBlockData(peak, report);
    }
    this.spillStoredMessages();
  }

  activateSpend(coin: string) {
    if (!this.wc) { throw new Error("this.wc is falsey") }
    const result = this.cradle?.opening_coin(coin);
    this.processResult(result);
    if (this.pendingBlockNotification) {
      const { peak, report } = this.pendingBlockNotification;
      this.pendingBlockNotification = null;
      this.deliverBlockData(peak, report);
    }
    this.spillStoredMessages();
    this.sendWatchingCoins();
  }

  getChannelPuzzleHash(): string | null {
    return this.cradle?.get_channel_puzzle_hash() ?? null;
  }

  private async handleNeedLauncherCoin() {
    if (this.launcherProvided) return;
    this.launcherProvided = true;

    try {
      let coin: string | null = null;
      try {
        coin = await this.blockchain.selectCoins(this.uniqueId, Number(this.amount));
      } catch (_e) {
        // Simulator path may not expose select_coins; fall back below.
      }
      if (!coin) {
        const addr = await this.blockchain.getAddress();
        const minted = await this.blockchain.do_initial_spend(
          this.uniqueId,
          addr.puzzleHash,
          this.amount,
        );
        coin = typeof minted.coin === 'string' ? minted.coin : null;
      }
      if (!coin) {
        console.error('[wasm] unable to source launcher parent coin');
        this.launcherProvided = false;
        return;
      }
      const { computeLauncherCoin } = await import('../util/launcher');
      const { launcherCoinHex } = await computeLauncherCoin(coin);
      const result = this.cradle?.provide_launcher_coin(launcherCoinHex);
      this.processResult(result);
    } catch (e) {
      this.launcherProvided = false;
      console.error('[wasm] handleNeedLauncherCoin error:', e);
    }
  }

  private async handleNeedCoinSpend(request: any) {
    try {
      const offerAmount = -request.amount;
      const extraConditions = (request.conditions || []).map((c: any) => ({
        opcode: c.opcode,
        args: c.args,
      }));
      const coinIds = request.coin_id ? [request.coin_id] : undefined;

      const bundle = await this.blockchain.createOfferForIds(
        this.uniqueId,
        { '1': offerAmount },
        extraConditions,
        coinIds,
      );
      if (!bundle) {
        console.error('[wasm] createOfferForIds returned null');
        return;
      }

      const bundleJson = typeof bundle === 'string' ? bundle : JSON.stringify(bundle);
      const result = this.cradle?.provide_coin_spend_bundle(bundleJson);
      this.processResult(result);
    } catch (e) {
      console.error('[wasm] handleNeedCoinSpend error:', e);
    }
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

  private submitTransaction(tx: SpendBundle) {
    const blob = spend_bundle_to_clvm(tx);
    this.pendingTransactions.push(blob);
    this.scheduleSave();
    const cvt = (blob: string) => {
      return this.wc?.convert_spend_to_coinset_org(blob);
    };
    this.blockchain.spend(cvt, blob).then(() => {
      const idx = this.pendingTransactions.indexOf(blob);
      if (idx !== -1) {
        this.pendingTransactions.splice(idx, 1);
        this.scheduleSave();
      }
    }).catch(e => {
      console.error('[wasm] submitTransaction failed:', e);
    });
  }

  private resubmitPendingTransactions() {
    if (this.pendingTransactions.length === 0) return;
    debugLog(`[wasm] resubmitting ${this.pendingTransactions.length} pending transactions`);
    const blobs = [...this.pendingTransactions];
    for (const blob of blobs) {
      const cvt = (b: string) => this.wc?.convert_spend_to_coinset_org(b);
      this.blockchain.spend(cvt, blob).then(() => {
        const idx = this.pendingTransactions.indexOf(blob);
        if (idx !== -1) {
          this.pendingTransactions.splice(idx, 1);
          this.scheduleSave();
        }
      }).catch(e => {
        console.error('[wasm] resubmitPendingTransactions failed:', e);
      });
    }
  }

  processResult(result: WasmResult | undefined): void {
    if (!result || this.finished) return;

    if (result.finished && !this.finished) {
      this.finished = true;
      clearSession();
      this.rxjsEmitter?.next({ type: 'finished' });
    }

    for (const event of result.events || []) {
      this.eventQueue.push(event);
    }

    if (this.draining) return;

    this.draining = true;
    while (this.eventQueue.length > 0) {
      const event = this.eventQueue.shift()!;
      this.dispatchEvent(event);
    }
    this.draining = false;

    if (result.need_launcher_coin) {
      this.handleNeedLauncherCoin();
    }
    if (result.need_coin_spend) {
      this.handleNeedCoinSpend(result.need_coin_spend);
    }

    this.scheduleSave();
  }

  private dispatchEvent(event: CradleEvent): void {
    if ('OutboundMessage' in event) {
      const msgno = this.messageNumber++;
      this.unackedMessages.push({ msgno, msg: event.OutboundMessage });
      this.sendMessage(msgno, event.OutboundMessage);
    } else if ('OutboundTransaction' in event) {
      this.submitTransaction(event.OutboundTransaction);
    } else if ('Notification' in event) {
      const n = event.Notification;
      const tag = typeof n === 'object' && n !== null ? Object.keys(n)[0] : String(n);
      if (tag === 'ChannelCreated' && !this.channelReady) {
        this.channelReady = true;
        this.startPingTimer();
      }
      if (tag === 'GameProposalAccepted' && n.GameProposalAccepted) {
        this.activeGameId = String(n.GameProposalAccepted.id);
      }
      const TERMINAL_TAGS = [
        'WeTimedOut', 'OpponentTimedOut', 'WeSlashedOpponent',
        'OpponentSlashedUs', 'OpponentSuccessfullyCheated',
        'GameCancelled', 'GameError',
      ];
      if (TERMINAL_TAGS.includes(tag)) {
        this.activeGameId = null;
        this.handState = null;
      }
      this.gameLog.push(JSON.stringify(n));
      this.rxjsEmitter?.next({ type: 'notification', data: n });
    } else if ('ReceiveError' in event) {
      this.rxjsEmitter?.next({ type: 'error', error: event.ReceiveError });
    } else if ('CoinSolutionRequest' in event) {
      this.fulfillPuzzleSolutionRequest(event.CoinSolutionRequest);
    } else if ('DebugLog' in event) {
      this.debugLogHistory.push(event.DebugLog);
      this.rxjsEmitter?.next({ type: 'debug_log', message: event.DebugLog });
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
    this.notePeerActivity();
    if (!this.wc || !this.cradle || this.qualifyingEvents != 15 || this.reloading) {
      this.storedMessages.push({ msgno, msg });
      return;
    }
    if (msgno <= this.remoteNumber) {
      this.sendAck(msgno);
      return;
    }
    if (msgno > this.remoteNumber + 1) {
      this.reorderQueue.set(msgno, msg);
      return;
    }

    this.deliverSingleMessage(msgno, msg);
    this.flushReorderQueue();
  }

  private deliverSingleMessage(msgno: number, msg: string) {
    this.remoteNumber = msgno;
    const result = this.cradle!.deliver_message(msg);
    this.processResult(result);
    this.sendAck(msgno);
  }

  private flushReorderQueue() {
    while (this.reorderQueue.has(this.remoteNumber + 1)) {
      const nextMsgno = this.remoteNumber + 1;
      const msg = this.reorderQueue.get(nextMsgno)!;
      this.reorderQueue.delete(nextMsgno);
      this.deliverSingleMessage(nextMsgno, msg);
    }
  }

  receiveAck(ackMsgno: number) {
    this.notePeerActivity();
    const before = this.unackedMessages.length;
    this.unackedMessages = this.unackedMessages.filter(m => m.msgno > ackMsgno);
    if (this.unackedMessages.length !== before) {
      this.scheduleSave();
    }
  }

  resendUnacked() {
    if (this.unackedMessages.length === 0) return;
    for (const { msgno, msg } of this.unackedMessages) {
      this.sendMessage(msgno, msg);
    }
  }

  blockNotification(peak: number, blocks: CoinsetOrgBlockSpend[], reportOrUndefined: WatchReport | undefined) {
    let block_report = reportOrUndefined;
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
    if (!this.firstBlockLogged) {
      this.firstBlockLogged = true;
      debugLog(`[wasm] first block notification height=${peak} cradle=${this.cradle ? 'yes' : 'no'}`);
    }
    this.kickSystem(4);
    if (!this.cradle) {
      this.pendingBlockNotification = { peak, report: block_report };
      return;
    }
    this.deliverBlockData(peak, block_report);
  }

  private deliverBlockData(peak: number, block_report: WatchReport) {
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
    this.sendWatchingCoins();
  }

  private sendWatchingCoins() {
    if (!this.wc || !this.cradle || typeof window === 'undefined' || window.parent === window) return;
    try {
      const coins = this.wc.get_watching_coins(this.cradle.cradle);
      window.parent.postMessage({ watching_coins: coins }, window.location.origin);
    } catch (e) {
      console.warn('[wasm] sendWatchingCoins failed:', e);
    }
  }

  // --- Persistence ---

  private scheduleSave() {
    if (this.finished || !this.cradle) return;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.persistSession();
    }, SAVE_DEBOUNCE_MS);
  }

  private persistSession() {
    if (this.finished || !this.cradle) return;
    try {
      const serializedCradle = this.cradle.serialize();
      const save: SessionSave = {
        serializedCradle,
        pairingToken: this.pairingToken,
        messageNumber: this.messageNumber,
        remoteNumber: this.remoteNumber,
        channelReady: this.channelReady,
        iStarted: this.iStarted,
        amount: this.amount.toString(),
        perGameAmount: this.perGameAmount.toString(),
        uniqueId: this.uniqueId,
        pendingTransactions: [...this.pendingTransactions],
        unackedMessages: [...this.unackedMessages],
        gameLog: [...this.gameLog],
        debugLog: [...this.debugLogHistory],
        blockchainType: this.blockchainType,
        activeGameId: this.activeGameId,
        handState: this.handState,
      };
      saveSession(save);
    } catch (e) {
      console.error('[wasm] persistSession failed:', e);
    }
  }

  setHandState(state: CalpokerHandState | null) {
    this.handState = state;
    this.scheduleSave();
  }

  markRestored() {
    this.restoredSession = true;
  }

  // --- Game actions (called by higher layer) ---

  proposeGame(params: ProposeGameParams): string[] {
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
        : typeof e === 'object' && e !== null && 'error' in e ? (e as { error: string }).error
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
        : typeof e === 'object' && e !== null && 'error' in e ? (e as { error: string }).error
        : String(e);
      console.error('[wasm] goOnChain failed:', msg);
      this.rxjsEmitter?.next({ type: 'error', error: msg });
    }
  }
}
