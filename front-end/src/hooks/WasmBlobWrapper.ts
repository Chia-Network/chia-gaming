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
  BlockchainInboundAddressResult,
  WasmEvent,
} from '../types/ChiaGaming';
import { BlockchainPoller } from './BlockchainPoller';
import {
  spend_bundle_to_clvm,
} from '../util';
import { log } from '../services/log';
import { saveSession, SessionSave, CalpokerHandState } from './save';
import type { ChannelStatusPayload } from '../types/ChiaGaming';

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
const KEEPALIVE_INTERVAL_MS = 15_000;

function extractErrorMessage(e: unknown): string {
  if (e instanceof Error) {
    try {
      const parsed = JSON.parse(e.message);
      if (parsed?.data?.error) return parsed.data.error;
      if (parsed?.data?.structuredError?.message) return parsed.data.structuredError.message;
    } catch { /* not JSON */ }
    return e.stack || e.message;
  }
  if (e && typeof e === 'object') {
    if ('message' in e && typeof (e as any).message === 'string') return (e as any).message;
    if (e instanceof Event) return e.type || 'unknown event';
    try { return JSON.stringify(e); } catch { /* fall through */ }
  }
  return String(e);
}

export class WasmBlobWrapper {
  amount: bigint;
  perGameAmount: bigint;
  wc: WasmConnection | undefined;
  sendMessage: (msgno: number, msg: string) => void;
  sendAck: (ackMsgno: number) => void;
  private peerSendKeepalive: (() => void) | null = null;
  private transactionPublishNerfed = false;
  private lastPeerMessageTime: number = Date.now();
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  messageNumber: number;
  remoteNumber: number;
  cradle: ChiaGame | undefined;
  uniqueId: string;
  pairingToken: string;
  channelReady: boolean;
  iStarted: boolean;
  storedMessages: Array<{ msgno: number; msg: string }>;
  cleanShutdownCalled: boolean;
  reloading: boolean;
  qualifyingEvents: number;
  blockchain: BlockchainPoller;
  rxjsMessageSingleton: Subject<WasmEvent>;
  rxjsEmitter: NextObserver<WasmEvent> | undefined;
  private eventQueue: CradleEvent[] = [];
  private drainScheduled = false;
  private pendingBlockNotification: { peak: number; report: WatchReport } | null = null;
  launcherProvided: boolean;
  private lastSelectCoinsValue: string | null = null;
  private lastLauncherCoinId: string | null = null;

  unackedMessages: Array<{ msgno: number; msg: string }> = [];
  pendingTransactions: string[] = [];
  history: string[] = [];
  logHistory: string[] = [];
  private reorderQueue: Map<number, string> = new Map();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private restoredSession = false;
  private beforeUnloadHandler: (() => void) | null = null;
  activeGameId: string | null = null;
  handState: CalpokerHandState | null = null;
  lastChannelStatus: ChannelStatusPayload | null = null;
  myAlias: string | undefined = undefined;
  opponentAlias: string | undefined = undefined;
  lastOutcomeWin: 'win' | 'lose' | 'tie' | undefined = undefined;
  chatMessages: Array<{ text: string; fromAlias: string; timestamp: number; isMine: boolean }> = [];
  gameCoinHex: string | null = null;
  gameTurnState: string = 'my-turn';
  gameTerminalType: string = 'none';
  gameTerminalLabel: string | null = null;
  gameTerminalReward: string | null = null;
  gameTerminalRewardCoin: string | null = null;
  myRunningBalance: string = '0';
  channelAttentionActive = false;
  gameTerminalAttentionActive = false;
  betweenHandMode: string | null = null;
  betweenHandComposePerHand: string | null = null;
  betweenHandLastTerms: { my_contribution: string; their_contribution: string } | null = null;
  betweenHandRejectedOnceTerms: { my_contribution: string; their_contribution: string } | null = null;
  betweenHandCachedPeerProposal: { id: string; my_contribution: string; their_contribution: string } | null = null;
  betweenHandReviewPeerProposal: { id: string; my_contribution: string; their_contribution: string } | null = null;
  getFee: () => number = () => 0;

  constructor(
    blockchain: BlockchainPoller,
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
    this.beforeUnloadHandler = () => {
      const hadPending = !!this.saveTimer;
      this.flushPendingSave();
      if (hadPending) {
        console.log('[wasm] beforeunload: flushed pending save');
      }
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', this.beforeUnloadHandler);
    }
  }

  setReloading() { this.reloading = true; }

  setPeerKeepalive(sendKeepalive: () => void) {
    this.peerSendKeepalive = sendKeepalive;
    this.startKeepaliveTimer();
  }

  cleanup() {
    this.cleanShutdownCalled = true;
    this.storedMessages = [];
    this.rxjsMessageSingleton.complete();
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.stopKeepaliveTimer();
    if (this.beforeUnloadHandler && typeof window !== 'undefined') {
      window.removeEventListener('beforeunload', this.beforeUnloadHandler);
      this.beforeUnloadHandler = null;
    }
  }

  notePeerActivity() {
    this.lastPeerMessageTime = Date.now();
  }

  receiveKeepalive() {
    this.notePeerActivity();
  }

  startKeepaliveTimer() {
    if (this.keepaliveTimer) {
      throw new Error('ASSERT_FAIL: keepalive timer already running');
    }
    const timer = setInterval(() => {
      this.peerSendKeepalive?.();
    }, KEEPALIVE_INTERVAL_MS);
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();
    this.keepaliveTimer = timer;
  }

  private stopKeepaliveTimer() {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  systemState(): number { return this.qualifyingEvents; }

  getWasmConnection(): WasmConnection | undefined { return this.wc; }

  isChannelReady(): boolean { return this.channelReady; }

  getObservable() {
    return this.rxjsMessageSingleton;
  }

  spillStoredMessages() {
    if (this.qualifyingEvents != 7 || !this.cradle || this.reloading) {
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

  activateSpend() {
    if (!this.wc) { throw new Error("this.wc is falsey") }
    const result = this.cradle?.start_handshake();
    this.processResult(result);
    if (this.pendingBlockNotification) {
      const { peak, report } = this.pendingBlockNotification;
      this.pendingBlockNotification = null;
      this.deliverBlockData(peak, report);
    }
    this.spillStoredMessages();
  }

  getChannelPuzzleHash(): string | null {
    return this.cradle?.get_channel_puzzle_hash() ?? null;
  }

  private async handleNeedLauncherCoin() {
    if (this.launcherProvided) return;
    this.launcherProvided = true;

    try {
      const coin = await this.blockchain.rpc.selectCoins(this.uniqueId, Number(this.amount));
      if (!coin) {
        throw new Error('ASSERT_FAIL: selectCoins returned null for launcher parent coin');
      }
      this.lastSelectCoinsValue = coin;
      const { computeLauncherCoin } = await import('../util/launcher');
      const { launcherCoinHex, launcherCoinId } = await computeLauncherCoin(coin);
      this.lastLauncherCoinId = launcherCoinId;
      log(`[wasm] provide_launcher_coin id=${launcherCoinId}`);
      const result = this.cradle?.provide_launcher_coin(launcherCoinHex);
      this.processResult(result);
    } catch (e) {
      this.launcherProvided = false;
      console.error('[wasm] handleNeedLauncherCoin error:', e);
      log(`[wasm] handleNeedLauncherCoin error: ${String(e)}`);
      this.rxjsEmitter?.next({ type: 'error', error: extractErrorMessage(e) });
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
      const maxHeight = request.max_height as number | undefined;

      const bundle = await this.blockchain.rpc.createOfferForIds(
        this.uniqueId,
        { '1': offerAmount },
        extraConditions,
        coinIds,
        maxHeight,
      );
      if (!bundle) {
        console.error('[wasm] createOfferForIds returned null');
        return;
      }

      let result;
      if (typeof bundle === 'string' && bundle.startsWith('offer')) {
        console.warn('[wasm] createOfferForIds returned offer string; decoding via bech32 WASM path');
        result = this.cradle?.provide_offer_bech32(bundle);
      } else {
        const bundleJson = typeof bundle === 'string' ? bundle : JSON.stringify(bundle);
        result = this.cradle?.provide_coin_spend_bundle(bundleJson);
      }
      this.processResult(result);
    } catch (e) {
      console.error('[wasm] handleNeedCoinSpend error:', e);
      log(`[wasm] handleNeedCoinSpend error: ${String(e)}`);
      let msg = extractErrorMessage(e);
      if (/insufficient funds/i.test(msg)) {
        msg = 'Wallet reports insufficient funds. It may be that your wallet has enough balance but some coins are locked. Free up locked coins in your wallet and try again.';
      }
      this.rxjsEmitter?.next({ type: 'error', error: msg });
    }
  }

  setBlockchainAddress(a: BlockchainInboundAddressResult) {
    this.rxjsEmitter?.next({ type: 'address', data: a });
  }

  kickSystem(flags: number) {
    this.qualifyingEvents |= flags;
    if (this.qualifyingEvents == 3) {
      this.qualifyingEvents |= 4;
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
    if (this.transactionPublishNerfed) return;
    const spendBundle = this.wc?.convert_spend_to_coinset_org(blob);
    const fee = this.getFee();
    log(`[wasm] submitTransaction blobLen=${blob.length}`);
    this.blockchain.rpc.spend(blob, spendBundle, 'submitTransaction', fee || undefined).then(() => {
      const idx = this.pendingTransactions.indexOf(blob);
      if (idx !== -1) {
        this.pendingTransactions.splice(idx, 1);
        this.scheduleSave();
      }
    }).catch(e => {
      console.error('[wasm] submitTransaction failed:', e);
      log(`[wasm] submitTransaction failed: ${String(e)}`);
      this.rxjsEmitter?.next({ type: 'error', error: extractErrorMessage(e) });
      const idx = this.pendingTransactions.indexOf(blob);
      if (idx !== -1) {
        this.pendingTransactions.splice(idx, 1);
        this.scheduleSave();
      }
    });
  }

  private resubmitPendingTransactions() {
    if (this.pendingTransactions.length === 0) return;
    log(`[wasm] resubmitting ${this.pendingTransactions.length} pending transactions`);
    const blobs = [...this.pendingTransactions];
    for (const blob of blobs) {
      if (this.transactionPublishNerfed) return;
      const spendBundle = this.wc?.convert_spend_to_coinset_org(blob);
      const fee = this.getFee();
      this.blockchain.rpc.spend(blob, spendBundle, 'resubmitPendingTransactions', fee || undefined).then(() => {
        const idx = this.pendingTransactions.indexOf(blob);
        if (idx !== -1) {
          this.pendingTransactions.splice(idx, 1);
          this.scheduleSave();
        }
      }).catch(e => {
        console.error('[wasm] resubmitPendingTransactions failed:', e);
        log(`[wasm] resubmitPendingTransactions failed: ${String(e)}`);
        this.rxjsEmitter?.next({ type: 'error', error: extractErrorMessage(e) });
        const idx = this.pendingTransactions.indexOf(blob);
        if (idx !== -1) {
          this.pendingTransactions.splice(idx, 1);
          this.scheduleSave();
        }
      });
    }
  }

  processResult(result: WasmResult | undefined): void {
    if (!result) return;

    for (const event of result.events || []) {
      this.eventQueue.push(event);
    }

    this.scheduleDrain();
  }

  private scheduleDrain(): void {
    if (this.drainScheduled || this.eventQueue.length === 0) return;
    this.drainScheduled = true;
    setTimeout(() => {
      this.drainScheduled = false;
      const event = this.eventQueue.shift();
      if (event) {
        this.dispatchEvent(event);
        this.scheduleSave();
      }
      this.scheduleDrain();
    }, 0);
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
      if (tag === 'ChannelStatus') {
        const cs = (n as Record<string, Record<string, unknown>>).ChannelStatus;
        if (cs) {
          this.lastChannelStatus = cs as unknown as ChannelStatusPayload;
          if (!this.channelReady && cs.state === 'Active') {
            log('[wasm] channel confirmed on-chain');
            this.channelReady = true;
          }
        }
      }
      if (tag === 'ProposalAccepted' && n.ProposalAccepted) {
        this.activeGameId = String(n.ProposalAccepted.id);
      }
      if (tag === 'GameStatus') {
        const gs = (n as Record<string, Record<string, unknown>>).GameStatus;
        if (gs && typeof gs.status === 'string' && gs.status.startsWith('ended-')) {
          this.activeGameId = null;
        }
      }
      this.history.push(JSON.stringify(n));
      this.rxjsEmitter?.next({ type: 'notification', data: n });
    } else if ('ReceiveError' in event) {
      this.rxjsEmitter?.next({ type: 'error', error: event.ReceiveError });
    } else if ('CoinSolutionRequest' in event) {
      this.fulfillPuzzleSolutionRequest(event.CoinSolutionRequest);
    } else if ('Log' in event) {
      this.logHistory.push(event.Log);
      this.rxjsEmitter?.next({ type: 'log', message: event.Log });
    } else if ('NeedLauncherCoin' in event) {
      this.handleNeedLauncherCoin();
    } else if ('NeedCoinSpend' in event) {
      this.handleNeedCoinSpend(event.NeedCoinSpend);
    } else if ('WatchCoin' in event) {
      const { coin_name, coin_string } = event.WatchCoin;
      log(`[wasm] WatchCoin name=${coin_name}`);
      this.blockchain.registerCoin(coin_name, coin_string);
    }
  }

  private async fulfillPuzzleSolutionRequest(coinHex: string) {
    try {
      const ps = await this.blockchain.rpc.getPuzzleAndSolution(coinHex);
      if (this.cradle) {
        const result = ps
          ? this.cradle.report_puzzle_and_solution(coinHex, ps[0], ps[1])
          : this.cradle.report_puzzle_and_solution(coinHex, undefined, undefined);
        this.processResult(result);
      }
    } catch (e) {
      console.error('[wasm] puzzle/solution fetch failed:', e);
      log(`[wasm] puzzle/solution fetch failed: ${String(e)}`);
      this.rxjsEmitter?.next({ type: 'error', error: extractErrorMessage(e) });
    }
  }

  // --- Inbound events ---

  deliverMessage(msgno: number, msg: string) {
    this.notePeerActivity();
    if (!this.wc || !this.cradle || this.qualifyingEvents != 7 || this.reloading) {
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
    log(`[wasm] block height=${peak} created=${block_report.created_watched.length} deleted=${block_report.deleted_watched.length} timed_out=${block_report.timed_out.length}`);
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
      console.error('[wasm] block_data failed:', e);
      log(`[wasm] block_data failed: ${String(e)}`);
    }
  }

  // --- Persistence ---

  scheduleSave() {
    if (!this.cradle) return;
    if (this.saveTimer) return;
    const timer = setTimeout(() => {
      this.saveTimer = null;
      this.persistSession();
    }, SAVE_DEBOUNCE_MS);
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();
    this.saveTimer = timer;
  }

  flushPendingSave() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      this.persistSession();
    }
  }

  private persistSession() {
    if (!this.cradle) return;
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
        pendingTransactions: [...this.pendingTransactions],
        unackedMessages: [...this.unackedMessages],
        history: [...this.history],
        log: [...this.logHistory],
        activeGameId: this.activeGameId,
        handState: this.handState,
        channelStatus: this.lastChannelStatus,
        myAlias: this.myAlias,
        opponentAlias: this.opponentAlias,
        lastOutcomeWin: this.lastOutcomeWin,
        chatMessages: this.chatMessages.length > 0 ? [...this.chatMessages] : undefined,
        gameCoinHex: this.gameCoinHex,
        gameTurnState: this.gameTurnState,
        gameTerminalType: this.gameTerminalType !== 'none' ? this.gameTerminalType : undefined,
        gameTerminalLabel: this.gameTerminalLabel,
        gameTerminalReward: this.gameTerminalReward,
        gameTerminalRewardCoin: this.gameTerminalRewardCoin,
        myRunningBalance: this.myRunningBalance !== '0' ? this.myRunningBalance : undefined,
        channelAttentionActive: this.channelAttentionActive || undefined,
        gameTerminalAttentionActive: this.gameTerminalAttentionActive || undefined,
        betweenHandMode: this.betweenHandMode ?? undefined,
        betweenHandComposePerHand: this.betweenHandComposePerHand ?? undefined,
        betweenHandLastTerms: this.betweenHandLastTerms ?? undefined,
        betweenHandRejectedOnceTerms: this.betweenHandRejectedOnceTerms ?? undefined,
        betweenHandCachedPeerProposal: this.betweenHandCachedPeerProposal ?? undefined,
        betweenHandReviewPeerProposal: this.betweenHandReviewPeerProposal ?? undefined,
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

  cancel_proposal(gameId: string): void {
    if (!this.cradle) throw new Error('no cradle');
    const result = this.cradle.cancel_proposal(gameId);
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
      const msg = e instanceof Error ? (e.stack || e.message)
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
      const msg = e instanceof Error ? (e.stack || e.message)
        : typeof e === 'object' && e !== null && 'error' in e ? (e as { error: string }).error
        : String(e);
      console.error('[wasm] goOnChain failed:', msg);
      this.rxjsEmitter?.next({ type: 'error', error: msg });
    }
  }

  nerf(): void {
    this.transactionPublishNerfed = true;
    log('[wasm] transaction publish nerfed');
  }
}
