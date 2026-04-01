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
import { saveSession, SessionSave, CalpokerHandState, BlockchainType } from './save';
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
const PING_INTERVAL_MS = 15_000;
const PEER_TIMEOUT_MS = 60_000;

function toSafeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function strip0xDeep(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.startsWith('0x') ? value.slice(2) : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => strip0xDeep(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, strip0xDeep(v)]),
    );
  }
  return value;
}

function summarizeEvents(result: WasmResult | undefined) {
  const events = result?.events ?? [];
  const tags = events.map((event) => (typeof event === 'object' && event !== null ? Object.keys(event)[0] : 'unknown'));
  const outboundTransactions = tags.filter((tag) => tag === 'OutboundTransaction').length;
  const outboundMessages = tags.filter((tag) => tag === 'OutboundMessage').length;
  return { tags, outboundTransactions, outboundMessages };
}

export class WasmBlobWrapper {
  amount: bigint;
  perGameAmount: bigint;
  wc: WasmConnection | undefined;
  sendMessage: (msgno: number, msg: string) => void;
  sendAck: (ackMsgno: number) => void;
  private peerSendPing: (() => void) | null = null;
  private peerClose: (() => void) | null = null;
  private transactionPublishNerfed = false;
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
  reloading: boolean;
  qualifyingEvents: number;
  blockchain: InternalBlockchainInterface;
  rxjsMessageSingleton: Subject<WasmEvent>;
  rxjsEmitter: NextObserver<WasmEvent> | undefined;
  private eventQueue: CradleEvent[] = [];
  private draining = false;
  private pendingBlockNotification: { peak: number; report: WatchReport } | null = null;
  launcherProvided: boolean;
  private lastSelectCoinsValue: string | null = null;
  private lastLauncherCoinId: string | null = null;

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
  lastChannelStatus: ChannelStatusPayload | null = null;
  myAlias: string | undefined = undefined;
  opponentAlias: string | undefined = undefined;

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
        this.channelReady && !this.cleanShutdownCalled
      ) {
        debugLog('[wasm] peer liveness timeout, going on-chain');
        this.goOnChain();
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
      const coin = await this.blockchain.selectCoins(this.uniqueId, Number(this.amount));
      if (!coin) {
        throw new Error('ASSERT_FAIL: selectCoins returned null for launcher parent coin');
      }
      this.lastSelectCoinsValue = coin;
      console.log('[wasm diag] selectCoins returned value', {
        value: coin,
        hexLength: coin.length,
      });
      debugLog(`[wasm diag] selectCoins value len=${coin.length} value=${coin}`);
      const { computeLauncherCoin } = await import('../util/launcher');
      const { launcherCoinHex, launcherCoinId } = await computeLauncherCoin(coin);
      this.lastLauncherCoinId = launcherCoinId;
      console.log('[wasm diag] computed launcher coin', {
        launcherCoinHexLength: launcherCoinHex.length,
        launcherCoinId,
      });
      debugLog(`[wasm diag] launcherCoinId=${launcherCoinId} launcherCoinHexLen=${launcherCoinHex.length}`);
      const result = this.cradle?.provide_launcher_coin(launcherCoinHex);
      this.processResult(result);
    } catch (e) {
      this.launcherProvided = false;
      console.error('[wasm] handleNeedLauncherCoin error:', e);
      debugLog(`[wasm] handleNeedLauncherCoin error: ${String(e)}`);
    }
  }

  private async handleNeedCoinSpend(request: any) {
    try {
      console.log('[wasm diag] NeedCoinSpend request', {
        coin_id: request.coin_id,
        amount: request.amount,
        max_height: request.max_height,
        lastSelectCoinsValue: this.lastSelectCoinsValue,
        lastLauncherCoinId: this.lastLauncherCoinId,
      });
      debugLog(
        `[wasm diag] NeedCoinSpend coin_id=${String(request.coin_id)} lastSelect=${String(this.lastSelectCoinsValue)} lastLauncherId=${String(this.lastLauncherCoinId)}`,
      );
      const offerAmount = -request.amount;
      const extraConditions = (request.conditions || []).map((c: any) => ({
        opcode: c.opcode,
        args: c.args,
      }));
      const coinIds = request.coin_id ? [request.coin_id] : undefined;
      const maxHeight = request.max_height as number | undefined;

      const bundle = await this.blockchain.createOfferForIds(
        this.uniqueId,
        { '1': offerAmount },
        extraConditions,
        coinIds,
        maxHeight,
      );
      debugLog(
        `[wasm diag] NeedCoinSpend createOfferForIds done coin_id=${String(request.coin_id)} bundleType=${typeof bundle} offerLike=${typeof bundle === 'string' && bundle.startsWith('offer')}`,
      );
      if (!bundle) {
        console.error('[wasm] createOfferForIds returned null');
        return;
      }

      let result;
      if (typeof bundle === 'string' && bundle.startsWith('offer')) {
        debugLog('[wasm diag] NeedCoinSpend using provide_offer_bech32');
        result = this.cradle?.provide_offer_bech32(bundle);
      } else {
        const bundleJson = typeof bundle === 'string' ? bundle : JSON.stringify(bundle);
        debugLog(`[wasm diag] NeedCoinSpend using provide_coin_spend_bundle jsonLen=${bundleJson.length}`);
        result = this.cradle?.provide_coin_spend_bundle(bundleJson);
      }
      const summary = summarizeEvents(result);
      debugLog(
        `[wasm diag] NeedCoinSpend result events=${summary.tags.join(',') || 'none'} outboundTx=${summary.outboundTransactions} outboundMsg=${summary.outboundMessages}`,
      );
      if (summary.outboundTransactions === 0) {
        debugLog('[wasm diag] NeedCoinSpend produced no OutboundTransaction');
      }
      this.processResult(result);
    } catch (e) {
      console.error('[wasm] handleNeedCoinSpend error:', e);
      debugLog(`[wasm] handleNeedCoinSpend error: ${String(e)}`);
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
    if (this.transactionPublishNerfed) {
      debugLog('[wasm] submitTransaction blackholed (nerf enabled)');
      return;
    }
    const spendBundle = this.wc?.convert_spend_to_coinset_org(blob);
    const spendBundleNo0xJson = toSafeJson(strip0xDeep(spendBundle));
    debugLog(`[wasm tx] formed blobLen=${blob.length}`);
    debugLog(`[TX_COINSET_JSON_NO0X] ${spendBundleNo0xJson}`);
    this.blockchain.spend(blob, spendBundle).then((result) => {
      if (result) {
        debugLog(`[wasm] submitTransaction: ${result}`);
      }
      const idx = this.pendingTransactions.indexOf(blob);
      if (idx !== -1) {
        this.pendingTransactions.splice(idx, 1);
        this.scheduleSave();
      }
    }).catch(e => {
      console.error('[wasm] submitTransaction failed:', e);
      debugLog(`[wasm] submitTransaction failed: ${String(e)}`);
      const idx = this.pendingTransactions.indexOf(blob);
      if (idx !== -1) {
        this.pendingTransactions.splice(idx, 1);
        this.scheduleSave();
      }
    });
  }

  private resubmitPendingTransactions() {
    if (this.pendingTransactions.length === 0) return;
    debugLog(`[wasm] resubmitting ${this.pendingTransactions.length} pending transactions`);
    const blobs = [...this.pendingTransactions];
    for (const blob of blobs) {
      if (this.transactionPublishNerfed) {
        debugLog('[wasm] resubmitPendingTransactions blackholed (nerf enabled)');
        return;
      }
      const spendBundle = this.wc?.convert_spend_to_coinset_org(blob);
      this.blockchain.spend(blob, spendBundle).then((result) => {
        if (result) {
          debugLog(`[wasm] resubmitTransaction: ${result}`);
        }
        const idx = this.pendingTransactions.indexOf(blob);
        if (idx !== -1) {
          this.pendingTransactions.splice(idx, 1);
          this.scheduleSave();
        }
      }).catch(e => {
        console.error('[wasm] resubmitPendingTransactions failed:', e);
        debugLog(`[wasm] resubmitPendingTransactions failed: ${String(e)}`);
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

    if (this.draining) return;

    this.draining = true;
    while (this.eventQueue.length > 0) {
      const event = this.eventQueue.shift()!;
      this.dispatchEvent(event);
    }
    this.draining = false;

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
      if (tag === 'ChannelStatus') {
        const cs = (n as Record<string, Record<string, unknown>>).ChannelStatus;
        if (cs) {
          this.lastChannelStatus = cs as unknown as ChannelStatusPayload;
          if (!this.channelReady && cs.state === 'Active') {
            this.channelReady = true;
            this.startPingTimer();
          }
        }
      }
      if (tag === 'GameProposalAccepted' && n.GameProposalAccepted) {
        this.activeGameId = String(n.GameProposalAccepted.id);
      }
      if (tag === 'GameStatus') {
        const gs = (n as Record<string, Record<string, unknown>>).GameStatus;
        if (gs && typeof gs.status === 'string' && gs.status.startsWith('ended-')) {
          this.activeGameId = null;
          this.handState = null;
        }
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
    } else if ('NeedLauncherCoin' in event) {
      this.handleNeedLauncherCoin();
    } else if ('NeedCoinSpend' in event) {
      this.handleNeedCoinSpend(event.NeedCoinSpend);
    } else if ('WatchCoin' in event) {
      const { coin_name, coin_string } = event.WatchCoin;
      this.blockchain.registerCoin(coin_name, coin_string);
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
      debugLog(`[wasm] puzzle/solution fetch failed: ${String(e)}`);
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
    const summary = summarizeEvents(result);
    debugLog(
      `[wasm diag] deliver_message msgno=${msgno} events=${summary.tags.join(',') || 'none'} outboundTx=${summary.outboundTransactions} outboundMsg=${summary.outboundMessages}`,
    );
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
    debugLog(`[wasm] block height=${peak} cradle=${this.cradle ? 'yes' : 'no'} created=${block_report.created_watched.length} deleted=${block_report.deleted_watched.length} timed_out=${block_report.timed_out.length}`);
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
      debugLog(`[wasm] block_data failed: ${String(e)}`);
    }
  }

  // --- Persistence ---

  private scheduleSave() {
    if (this.cleanShutdownCalled || !this.cradle) return;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.persistSession();
    }, SAVE_DEBOUNCE_MS);
  }

  private persistSession() {
    if (this.cleanShutdownCalled || !this.cradle) return;
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
        gameLog: [...this.gameLog],
        debugLog: [...this.debugLogHistory],
        activeGameId: this.activeGameId,
        handState: this.handState,
        channelStatus: this.lastChannelStatus,
        myAlias: this.myAlias,
        opponentAlias: this.opponentAlias,
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

  private coinPayloadToHex(coin: unknown): string | null {
    if (!Array.isArray(coin) || coin.length === 0) return null;
    if (!coin.every((b) => typeof b === 'number')) return null;
    try {
      const bytes = Uint8Array.from(coin as number[]);
      return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    } catch {
      return null;
    }
  }

  private async coinStringHexToName(coinStringHex: string): Promise<string> {
    const normalized = coinStringHex.startsWith('0x') ? coinStringHex.slice(2) : coinStringHex;
    if (normalized.length % 2 !== 0) {
      throw new Error(`invalid coin string hex length=${normalized.length}`);
    }
    const bytes = new Uint8Array(normalized.length / 2);
    for (let i = 0; i < normalized.length; i += 2) {
      bytes[i / 2] = Number.parseInt(normalized.slice(i, i + 2), 16);
    }
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    const out = new Uint8Array(hash);
    return Array.from(out, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  restoreSavedWatchCoins(channelStatus: ChannelStatusPayload | null | undefined): void {
    if (!channelStatus) return;
    const coinStringHex = this.coinPayloadToHex(channelStatus.coin);
    if (!coinStringHex) return;
    void this.coinStringHexToName(coinStringHex)
      .then((coinName) => {
        this.blockchain.registerCoin(coinName, coinStringHex);
      })
      .catch((e) => {
        console.warn('[restore] re-register watch coin failed:', e);
      });
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

  cutPeerConnection(): void {
    debugLog('[wasm] cutting peer connection');
    try {
      this.peerClose?.();
    } catch (e) {
      console.error('[wasm] cutPeerConnection failed:', e);
      debugLog(`[wasm] cutPeerConnection failed: ${String(e)}`);
    }
  }

  setTransactionPublishNerfed(enabled: boolean): void {
    this.transactionPublishNerfed = enabled;
    debugLog(`[wasm] transaction publish nerf ${enabled ? 'enabled' : 'disabled'}`);
    if (!enabled) {
      this.resubmitPendingTransactions();
    }
  }

  isTransactionPublishNerfed(): boolean {
    return this.transactionPublishNerfed;
  }
}
