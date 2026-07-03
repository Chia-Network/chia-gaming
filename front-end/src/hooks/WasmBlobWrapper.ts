import { Subject, NextObserver } from 'rxjs';
import { Program } from 'clvm-lib';

import {
  CradleEvent,
  PeerConnectionResult,
  WasmConnection,
  ChiaGame,
  CoinOfInterestEntry,
  CoinStateRecord,
  WasmResult,
  SpendBundle,
  ProposeGameParams,
  BlockchainInboundAddressResult,
  WasmEvent,
} from '../types/ChiaGaming';
import { BlockchainPoller, PollingCradle } from './BlockchainPoller';
import {
  spend_bundle_to_clvm,
  coerceToBytes,
} from '../util';
import { log, diagStack } from '../services/log';
import { jsonStringify } from '../util/jsonSafe';
import { flushSessionState } from './save';
import type { PersistedGameState } from './save';
import type { ChannelStatusPayload } from '../types/ChiaGaming';

export interface WasmFields {
  serializedCradle: Uint8Array;
  pairingToken: string;
  messageNumber: bigint;
  remoteNumber: bigint;
  channelReady: boolean;
  iStarted: boolean;
  amount: string;
  perGameAmount: string;
  unackedMessages: Array<{ msgno: bigint; msg: Uint8Array }>;
  history: string[];
  log: string[];
  activeGameId: string | null;
  handState: PersistedGameState | null;
  channelStatus: ChannelStatusPayload | null;
  myAlias: string | undefined;
  opponentAlias: string | undefined;
  lastOutcomeWin: 'win' | 'lose' | 'tie' | undefined;
  chatMessages: Array<{ text: string; fromAlias: string; timestamp: bigint; isMine: boolean }>;
}

function clvmToBytes(value: Program | null): Uint8Array {
  if (value === null || value === undefined) return new Uint8Array([0x80]);
  return value.serialize();
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
    return e.message || e.name || 'Unknown error';
  }
  if (e && typeof e === 'object') {
    if ('message' in e && typeof (e as any).message === 'string') return (e as any).message;
    if (e instanceof Event) return e.type || 'unknown event';
    try { return JSON.stringify(e); } catch { /* fall through */ }
  }
  return String(e);
}

export function isBenignTransactionSubmitError(message: string): boolean {
  return /spend rejected: status=\[3,9\].*Conflicting transaction/i.test(message)
    || /spend rejected: status=\[3,5\].*Coin not found/i.test(message);
}

export type RestoreStatus = 'idle' | 'restoring' | 'restored' | 'failed';

export class WasmBlobWrapper implements PollingCradle {
  amount: bigint;
  perGameAmount: bigint;
  wc: WasmConnection | undefined;
  sendMessage: (msgno: bigint, msg: Uint8Array) => void;
  sendAck: (ackMsgno: bigint) => void;
  private peerSendKeepalive: (() => void) | null = null;
  private transactionPublishNerfed = false;
  private lastPeerMessageTime: number = Date.now();
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  messageNumber: bigint;
  remoteNumber: bigint;
  cradle: ChiaGame | undefined;
  uniqueId: string;
  pairingToken: string;
  channelReady: boolean;
  iStarted: boolean;
  storedMessages: Array<{ msgno: bigint; msg: Uint8Array }>;
  cleanShutdownCalled: boolean;
  onChain: boolean;
  reloading: boolean;
  qualifyingEvents: number;
  blockchain: BlockchainPoller | null;
  private blockchainAttached = false;
  rxjsMessageSingleton: Subject<WasmEvent>;
  rxjsEmitter: NextObserver<WasmEvent> | undefined;
  private eventQueue: CradleEvent[] = [];
  private drainScheduled = false;
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingCoinStates: { peak: bigint; records: CoinStateRecord[] } | null = null;
  launcherProvided: boolean;
  private lastSelectCoinsValue: string | null = null;
  private lastLauncherCoinId: string | null = null;

  unackedMessages: Array<{ msgno: bigint; msg: Uint8Array }> = [];
  history: string[] = [];
  logHistory: string[] = [];
  private reorderQueue: Map<bigint, Uint8Array> = new Map();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private restoredSession = false;
  private restoreStatus: RestoreStatus = 'idle';
  private restoreError: string | null = null;
  private restorePromise: Promise<void> | null = null;
  private restoreListeners = new Set<(status: RestoreStatus, error: string | null) => void>();
  private transactionSubmitQueue: Promise<void> = Promise.resolve();
  private beforeUnloadHandler: (() => void) | null = null;
  private durabilityFlushScheduled = false;
  private durabilityFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private needsImmediateDurability = false;
  private pendingOutboundSends: Array<{ msgno: bigint; msg: Uint8Array }> = [];
  private pendingAcks: bigint[] = [];
  private pendingEffects = new Set<Promise<void>>();
  activeGameId: string | null = null;
  private _handState!: PersistedGameState | null;
  lastChannelStatus: ChannelStatusPayload | null = null;
  myAlias: string | undefined = undefined;
  opponentAlias: string | undefined = undefined;
  lastOutcomeWin: 'win' | 'lose' | 'tie' | undefined = undefined;
  chatMessages: Array<{ text: string; fromAlias: string; timestamp: bigint; isMine: boolean }> = [];
  onSaveNeeded: (() => void) | null = null;
  getFee: () => bigint = () => 0n;

  get handState(): PersistedGameState | null {
    return this._handState;
  }

  set handState(state: PersistedGameState | null) {
    this._handState = state;
  }

  constructor(
    blockchain: BlockchainPoller | null,
    uniqueId: string,
    amount: bigint,
    peer_conn: PeerConnectionResult,
  ) {
    Object.defineProperty(this, '_handState', {
      value: null,
      enumerable: false,
      configurable: true,
      writable: true,
    });
    const { sendMessage, sendAck } = peer_conn;
    this.uniqueId = uniqueId;
    this.pairingToken = '';
    this.messageNumber = 1n;
    this.remoteNumber = 0n;
    this.sendMessage = (msgno, msg) => sendMessage(Number(msgno), msg);
    this.sendAck = (ackMsgno) => sendAck(Number(ackMsgno));
    this.amount = amount;
    this.perGameAmount = 0n;
    this.iStarted = false;
    this.channelReady = false;
    this.storedMessages = [];
    this.cleanShutdownCalled = false;
    this.onChain = false;
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

  attachBlockchain(blockchain: BlockchainPoller) {
    if (this.blockchain && this.blockchain !== blockchain) {
      this.blockchain.detachCradle(this);
      this.blockchainAttached = false;
    }
    const alreadyAttached = this.blockchain === blockchain && this.blockchainAttached;
    this.blockchain = blockchain;
    if (alreadyAttached) {
      blockchain.snapshotCradleCoinInterest(this);
    } else {
      blockchain.attachCradle(this);
      this.blockchainAttached = true;
    }
    this.flushPendingCoinStates();
    this.cradle?.resubmit_submitted();
    this.drainAndSubmitTransactions();
  }

  detachBlockchain(blockchain: BlockchainPoller) {
    if (this.blockchain !== blockchain) return;
    blockchain.detachCradle(this);
    this.blockchainAttached = false;
    this.blockchain = null;
  }

  setPeerKeepalive(sendKeepalive: () => void) {
    this.peerSendKeepalive = sendKeepalive;
    this.startKeepaliveTimer();
  }

  cleanup() {
    this.cleanShutdownCalled = true;
    this.storedMessages = [];
    this.rxjsMessageSingleton.complete();
    this.blockchain?.detachCradle(this);
    this.blockchainAttached = false;
    this.blockchain = null;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
    if (this.durabilityFlushTimer) {
      clearTimeout(this.durabilityFlushTimer);
      this.durabilityFlushTimer = null;
    }
    this.drainScheduled = false;
    this.flushDurabilityAndSend();
    this.durabilityFlushScheduled = false;
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

  getRestoreStatus(): RestoreStatus {
    return this.restoreStatus;
  }

  getRestoreError(): string | null {
    return this.restoreError;
  }

  onRestoreStatusChange(listener: (status: RestoreStatus, error: string | null) => void): () => void {
    this.restoreListeners.add(listener);
    listener(this.restoreStatus, this.restoreError);
    return () => {
      this.restoreListeners.delete(listener);
    };
  }

  beginRestore(promise: Promise<void>): Promise<void> {
    if (this.restoreStatus === 'restoring' && this.restorePromise) {
      return this.restorePromise;
    }

    this.setRestoreStatus('restoring', null);
    this.restorePromise = promise.then(() => {
      this.setRestoreStatus('restored', null);
    }).catch((e) => {
      const msg = extractErrorMessage(e);
      this.setRestoreStatus('failed', msg);
      this.rxjsEmitter?.next({ type: 'error', error: msg });
      throw e;
    });
    return this.restorePromise;
  }

  private setRestoreStatus(status: RestoreStatus, error: string | null) {
    this.restoreStatus = status;
    this.restoreError = error;
    for (const listener of this.restoreListeners) {
      listener(status, error);
    }
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
    }
  }

  setGameCradle(cradle: ChiaGame) {
    this.cradle = cradle;
    this.blockchain?.snapshotCradleCoinInterest(this);
    this.flushPendingCoinStates();
    this.spillStoredMessages();
  }

  activateSpend() {
    if (!this.wc) { throw new Error("this.wc is falsey") }
    const result = this.cradle?.start_handshake();
    this.processResult(result);
    this.flushPendingCoinStates();
    this.spillStoredMessages();
  }

  private flushPendingCoinStates() {
    if (this.pendingCoinStates) {
      const { peak, records } = this.pendingCoinStates;
      this.pendingCoinStates = null;
      this.deliverCoinStates(peak, records);
    }
  }

  getChannelPuzzleHash(): string | null {
    return this.cradle?.get_channel_puzzle_hash() ?? null;
  }

  private async handleNeedLauncherCoin() {
    if (this.launcherProvided) return;
    const blockchain = this.blockchain;
    if (!blockchain) {
      this.rxjsEmitter?.next({ type: 'error', error: 'Blockchain is not connected' });
      return;
    }
    this.launcherProvided = true;

    try {
      const coin = await blockchain.rpc.selectCoins(this.uniqueId, this.amount);
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
      diagStack('handleNeedLauncherCoin error', e);
      log(`[wasm] handleNeedLauncherCoin error: ${String(e)}`);
      this.rxjsEmitter?.next({ type: 'error', error: extractErrorMessage(e) });
    }
  }

  private async handleNeedCoinSpend(request: any) {
    const blockchain = this.blockchain;
    if (!blockchain) {
      this.rxjsEmitter?.next({ type: 'error', error: 'Blockchain is not connected' });
      return;
    }
    try {
      const offerAmount = -BigInt(request.amount);
      const extraConditions = (request.conditions || []).map((c: any) => ({
        opcode: BigInt(c.opcode),
        args: c.args,
      }));
      const coinIds = request.coin_id ? [request.coin_id] : undefined;
      const maxHeight = request.max_height != null ? BigInt(request.max_height) : undefined;

      const bundle = await blockchain.rpc.createOfferForIds(
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
        const localSpendBundle = this.wc?.convert_offer_to_coinset_org(bundle);
        await blockchain.rpc.rememberLocalRemovals?.(localSpendBundle);
        result = this.cradle?.provide_offer_bech32(bundle);
      } else {
        await blockchain.rpc.rememberLocalRemovals?.(bundle);
        const bundleJson = typeof bundle === 'string' ? bundle : jsonStringify(bundle);
        result = this.cradle?.provide_coin_spend_bundle(bundleJson);
      }
      this.processResult(result);
    } catch (e) {
      diagStack('handleNeedCoinSpend error', e);
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

  private async submitTransactionNow(tx: SpendBundle) {
    const blockchain = this.blockchain;
    if (!blockchain) return;
    try {
      // The blob/conversion/fee work used to run before the try, so a throw
      // here (e.g. from the wasm connection) rejected the submit queue
      // unhandled.  Keep it inside the try so every failure path is captured.
      const blob = spend_bundle_to_clvm(tx);
      const spendBundle = this.wc?.convert_spend_to_coinset_org(blob);
      const fee = this.getFee();
      log(`[wasm] submitTransaction blobLen=${blob.length}`);
      await blockchain.rpc.spend(blob, spendBundle, 'submitTransaction', fee || undefined);
    } catch (e) {
      const message = extractErrorMessage(e);
      if (isBenignTransactionSubmitError(message)) {
        log(`[wasm] submitTransaction ignored benign rejection: ${message}`);
        return;
      }
      diagStack('submitTransaction failed', e);
      log(`[wasm] submitTransaction failed: ${message}`);
      this.rxjsEmitter?.next({ type: 'error', error: message });
    }
  }

  private submitTransaction(tx: SpendBundle) {
    if (this.transactionPublishNerfed) return;
    // Guard the chain with a diagnostic catch: an unhandled rejection escaping
    // this promise is invisible in CI except as a bare empty-message test
    // failure, which is exactly the symptom we are chasing.
    this.transactionSubmitQueue = this.transactionSubmitQueue
      .then(() => this.submitTransactionNow(tx))
      .catch((e) => { diagStack('transactionSubmitQueue rejected', e); });
  }

  /**
   * Drain the transactions the transaction manager captured (intercepted from
   * the cradle) and submit each to the wallet/network.  Called after every
   * action that drains the cradle.
   */
  private drainAndSubmitTransactions() {
    if (!this.cradle || !this.blockchain) return;
    let bundles: SpendBundle[];
    try {
      bundles = this.cradle.drain_submissions();
    } catch (e) {
      diagStack('drain_submissions failed', e);
      log(`[wasm] drain_submissions failed: ${String(e)}`);
      return;
    }
    for (const tx of bundles) {
      this.submitTransaction(tx);
    }
  }

  processResult(result: WasmResult | undefined): void {
    if (!result) return;

    const blockchain = this.blockchain;
    for (const coin of result.watchCoins || []) {
      blockchain?.watchCoin(this, coin);
    }
    for (const event of result.events || []) {
      this.eventQueue.push(event);
    }

    this.drainAndSubmitTransactions();
    this.scheduleDrain();

    if (result.terminal) {
      this.blockchain?.stop();
      this.stopKeepaliveTimer();
      this.rxjsEmitter?.next({ type: 'terminal' });
    }
  }

  private scheduleDrain(): void {
    if (this.drainScheduled || this.eventQueue.length === 0) return;
    this.drainScheduled = true;
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      this.drainScheduled = false;
      this.drainOneEvent();
      this.scheduleDrain();
    }, 0);
  }

  private drainOneEvent(): void {
    const event = this.eventQueue.shift();
    if (!event) return;
    try {
      this.dispatchEvent(event);
    } catch (e) {
      diagStack('dispatchEvent error', e);
      this.rxjsEmitter?.next({ type: 'error', error: extractErrorMessage(e) });
    }
    this.scheduleSave();
  }

  flushDeferredWork(): void {
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
    this.drainScheduled = false;
    while (this.eventQueue.length > 0) {
      this.drainOneEvent();
    }

    if (this.durabilityFlushTimer) {
      clearTimeout(this.durabilityFlushTimer);
      this.durabilityFlushTimer = null;
    }
    this.durabilityFlushScheduled = false;
    this.flushDurabilityAndSend();
  }

  async flushPendingWork(): Promise<void> {
    for (let i = 0; i < 100; i += 1) {
      this.flushDeferredWork();
      const effects = [...this.pendingEffects];
      await Promise.allSettled(effects);
      await this.transactionSubmitQueue;
      this.flushDeferredWork();
      if (this.pendingEffects.size === 0
          && this.eventQueue.length === 0
          && !this.drainScheduled
          && !this.durabilityFlushScheduled) {
        return;
      }
    }
    throw new Error('WasmBlobWrapper pending work did not settle');
  }

  private dispatchEvent(event: CradleEvent): void {
    if ('OutboundMessage' in event) {
      if (this.onChain) return;
      const msgno = this.messageNumber++;
      this.unackedMessages.push({ msgno, msg: event.OutboundMessage });
      this.pendingOutboundSends.push({ msgno, msg: event.OutboundMessage });
      this.markNeedsImmediateDurability();
    } else if ('Notification' in event) {
      const n = event.Notification;
      const tag = typeof n === 'object' && n !== null ? Object.keys(n)[0] : String(n);
      if (tag === 'ChannelStatus') {
        const cs = (n as Record<string, Record<string, unknown>>).ChannelStatus;
        if (cs) {
          // The `coin` field is a serialized CoinString (a byte blob). Normalize
          // it to a Uint8Array so the persisted SessionState carries a typed
          // array (exempt from the save-time number check, stored losslessly as
          // $bytes) rather than a degraded plain array/object of numbers.
          this.lastChannelStatus = { ...cs, coin: coerceToBytes(cs.coin) } as unknown as ChannelStatusPayload;
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
      this.history.push(jsonStringify(n));
      this.rxjsEmitter?.next({ type: 'notification', data: n });
    } else if ('ReceiveError' in event) {
      this.rxjsEmitter?.next({ type: 'error', error: event.ReceiveError });
    } else if ('CoinSolutionRequest' in event) {
      this.trackEffect(this.fulfillPuzzleSolutionRequest(event.CoinSolutionRequest));
    } else if ('Log' in event) {
      this.logHistory.push(event.Log);
      this.rxjsEmitter?.next({ type: 'log', message: event.Log });
    } else if ('NeedLauncherCoin' in event) {
      this.trackEffect(this.handleNeedLauncherCoin());
    } else if ('NeedCoinSpend' in event) {
      this.trackEffect(this.handleNeedCoinSpend(event.NeedCoinSpend));
    }
  }

  private trackEffect(effect: Promise<void>): void {
    const tracked = effect.finally(() => {
      this.pendingEffects.delete(tracked);
    });
    this.pendingEffects.add(tracked);
  }

  private async fulfillPuzzleSolutionRequest(coinHex: string) {
    const blockchain = this.blockchain;
    if (!blockchain) {
      this.rxjsEmitter?.next({ type: 'error', error: 'Blockchain is not connected' });
      return;
    }
    try {
      const ps = await blockchain.rpc.getPuzzleAndSolution(coinHex);
      if (this.cradle) {
        const result = ps
          ? this.cradle.report_puzzle_and_solution(coinHex, ps[0], ps[1])
          : this.cradle.report_puzzle_and_solution(coinHex, undefined, undefined);
        this.processResult(result);
      }
    } catch (e) {
      diagStack('puzzle/solution fetch failed', e);
      log(`[wasm] puzzle/solution fetch failed: ${String(e)}`);
      this.rxjsEmitter?.next({ type: 'error', error: extractErrorMessage(e) });
    }
  }

  // --- Inbound events ---

  deliverMessage(msgno: bigint, msg: Uint8Array) {
    this.notePeerActivity();
    if (this.onChain) {
      this.sendAck(msgno);
      return;
    }
    if (!this.wc || !this.cradle || this.qualifyingEvents != 7 || this.reloading) {
      this.storedMessages.push({ msgno, msg });
      return;
    }
    if (msgno <= this.remoteNumber) {
      if (this.needsImmediateDurability) {
        this.pendingAcks.push(msgno);
        this.scheduleDurabilityFlush();
      } else {
        this.sendAck(msgno);
      }
      return;
    }
    if (msgno > this.remoteNumber + 1n) {
      this.reorderQueue.set(msgno, msg);
      return;
    }

    this.deliverSingleMessage(msgno, msg);
    this.flushReorderQueue();
  }

  private deliverSingleMessage(msgno: bigint, msg: Uint8Array) {
    try {
      const result = this.cradle!.deliver_message(msg);
      this.remoteNumber = msgno;
      this.processResult(result);
    } catch (e) {
      const errMsg = extractErrorMessage(e);
      diagStack('deliver_message failed', e);
      this.rxjsEmitter?.next({ type: 'error', error: errMsg });
      const state = this.lastChannelStatus?.state;
      const resolved = state === 'ResolvedClean' || state === 'ResolvedUnrolled'
        || state === 'ResolvedStale' || state === 'Failed';
      if (!this.onChain && !resolved) {
        this.goOnChain();
      }
      return;
    }
    this.pendingAcks.push(msgno);
    this.markNeedsImmediateDurability();
  }

  private flushReorderQueue() {
    while (!this.onChain && this.reorderQueue.has(this.remoteNumber + 1n)) {
      const nextMsgno = this.remoteNumber + 1n;
      const msg = this.reorderQueue.get(nextMsgno)!;
      this.reorderQueue.delete(nextMsgno);
      this.deliverSingleMessage(nextMsgno, msg);
    }
  }

  receiveAck(ackMsgno: bigint) {
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

  // --- PollingCradle: driven by the BlockchainPoller ---

  snapshotWatchedCoins(): Array<{ coin_name: string; coin_string: string }> {
    if (!this.cradle) return [];
    try {
      return this.cradle.snapshot_watched_coins();
    } catch (e) {
      diagStack('snapshot_watched_coins failed', e);
      return [];
    }
  }

  reportCoinStates(peak: bigint, records: CoinStateRecord[]) {
    if (!this.cradle) {
      this.pendingCoinStates = { peak, records };
      return;
    }
    this.deliverCoinStates(peak, records);
  }

  // Deliver a height tick with no coin-state change (empty delta).  Drives the
  // handshake's new_block(height) immediately, decoupled from the full
  // coin-records snapshot in reportCoinStates.  When the cradle isn't ready yet
  // there is nothing to advance; the pending coin-state path delivers once it is.
  reportNewBlock(peak: bigint) {
    if (!this.cradle) return;
    try {
      const result = this.cradle.new_block(peak);
      this.processResult(result);
    } catch (e) {
      diagStack('new_block failed', e);
    }
  }

  private deliverCoinStates(peak: bigint, records: CoinStateRecord[]) {
    log(`[wasm] coin states height=${peak} coins=${records.length}`);
    try {
      const result = this.cradle?.report_coin_states(peak, records);
      this.processResult(result);
    } catch (e) {
      diagStack('report_coin_states failed', e);
      log(`[wasm] report_coin_states failed: ${String(e)}`);
    }
  }

  // --- Persistence ---

  scheduleSave() {
    if (!this.cradle) return;
    if (this.saveTimer) return;
    const timer = setTimeout(() => {
      this.saveTimer = null;
      this.onSaveNeeded?.();
    }, SAVE_DEBOUNCE_MS);
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();
    this.saveTimer = timer;
  }

  flushPendingSave() {
    this.flushDurabilityAndSend();
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      this.onSaveNeeded?.();
      flushSessionState();
    }
  }

  private markNeedsImmediateDurability() {
    this.needsImmediateDurability = true;
    this.scheduleDurabilityFlush();
  }

  private scheduleDurabilityFlush() {
    if (this.durabilityFlushScheduled) return;
    this.durabilityFlushScheduled = true;
    const timer = setTimeout(() => {
      this.durabilityFlushTimer = null;
      this.durabilityFlushScheduled = false;
      if (this.drainScheduled || this.eventQueue.length > 0) {
        this.scheduleDurabilityFlush();
        return;
      }
      this.flushDurabilityAndSend();
    }, 0);
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();
    this.durabilityFlushTimer = timer;
  }

  private flushDurabilityAndSend() {
    if (!this.needsImmediateDurability && this.pendingOutboundSends.length === 0 && this.pendingAcks.length === 0) {
      return;
    }
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.needsImmediateDurability) {
      this.onSaveNeeded?.();
      flushSessionState();
      this.needsImmediateDurability = false;
    }

    const outbound = this.pendingOutboundSends.splice(0, this.pendingOutboundSends.length);
    const acks = this.pendingAcks.splice(0, this.pendingAcks.length);
    for (const { msgno, msg } of outbound) {
      this.sendMessage(msgno, msg);
    }
    for (const ack of acks) {
      this.sendAck(ack);
    }
  }

  getWasmFields(): WasmFields | null {
    if (!this.cradle) return null;
    try {
      return {
        serializedCradle: this.cradle.serialize(),
        pairingToken: this.pairingToken,
        messageNumber: this.messageNumber,
        remoteNumber: this.remoteNumber,
        channelReady: this.channelReady,
        iStarted: this.iStarted,
        amount: this.amount.toString(),
        perGameAmount: this.perGameAmount.toString(),
        unackedMessages: [...this.unackedMessages],
        history: [...this.history],
        log: [...this.logHistory],
        activeGameId: this.activeGameId,
        handState: this.handState,
        channelStatus: this.lastChannelStatus,
        myAlias: this.myAlias,
        opponentAlias: this.opponentAlias,
        lastOutcomeWin: this.lastOutcomeWin,
        chatMessages: [...this.chatMessages],
      };
    } catch (e) {
      console.error('[wasm] getWasmFields failed:', e);
      return null;
    }
  }

  getProtocolStatePretty(): string | null {
    if (!this.cradle) return null;
    try {
      return this.cradle.protocol_state_pretty();
    } catch (e) {
      console.error('[wasm] getProtocolStatePretty failed:', e);
      return null;
    }
  }

  getCoinsOfInterest(): CoinOfInterestEntry[] {
    if (!this.cradle) return [];
    try {
      return this.cradle.coins_of_interest();
    } catch (e) {
      console.error('[wasm] getCoinsOfInterest failed:', e);
      return [];
    }
  }

  setHandState(state: PersistedGameState | null) {
    this.handState = state;
    this.scheduleSave();
  }

  markRestored() {
    this.restoredSession = true;
  }

  // --- Game actions (called by higher layer) ---

  proposeGame(params: ProposeGameParams): string[] {
    if (!this.cradle) throw new Error('no cradle');
    try {
      const paramBytes = clvmToBytes(params.parameters);
      const { parameters: _drop, ...wasmParams } = params;
      const result = this.cradle.propose_game(wasmParams, paramBytes);
      this.processResult(result);
      return result?.ids || [];
    } catch (e) {
      const msg = extractErrorMessage(e);
      console.error('[wasm] proposeGame failed:', msg);
      this.rxjsEmitter?.next({ type: 'error', error: msg });
      return [];
    }
  }

  acceptProposal(gameId: string): void {
    if (!this.cradle) throw new Error('no cradle');
    try {
      const result = this.cradle.accept_proposal(gameId);
      this.processResult(result);
    } catch (e) {
      const msg = extractErrorMessage(e);
      console.error('[wasm] acceptProposal failed:', msg);
      this.rxjsEmitter?.next({ type: 'error', error: msg });
    }
  }

  cancel_proposal(gameId: string): void {
    if (!this.cradle) throw new Error('no cradle');
    try {
      const result = this.cradle.cancel_proposal(gameId);
      this.processResult(result);
    } catch (e) {
      const msg = extractErrorMessage(e);
      console.error('[wasm] cancel_proposal failed:', msg);
      this.rxjsEmitter?.next({ type: 'error', error: msg });
    }
  }

  makeMove(gameId: string, readable: Program | null): void {
    if (!this.cradle) throw new Error('no cradle');
    try {
      const bytes = clvmToBytes(readable);
      const result = this.cradle.make_move(gameId, bytes);
      this.processResult(result);
    } catch (e) {
      const msg = extractErrorMessage(e);
      console.error('[wasm] makeMove failed:', msg);
      this.rxjsEmitter?.next({ type: 'error', error: msg });
    }
  }

  acceptTimeout(gameId: string): void {
    if (!this.cradle) throw new Error('no cradle');
    try {
      const result = this.cradle.accept(gameId);
      this.processResult(result);
    } catch (e) {
      const msg = extractErrorMessage(e);
      console.error('[wasm] acceptTimeout failed:', msg);
      this.rxjsEmitter?.next({ type: 'error', error: msg });
    }
  }

  cheat(gameId: string, moverShare: bigint): void {
    if (!this.cradle) throw new Error('no cradle');
    try {
      const result = this.cradle.cheat(gameId, moverShare);
      this.processResult(result);
    } catch (e) {
      const msg = extractErrorMessage(e);
      console.error('[wasm] cheat failed:', msg);
      this.rxjsEmitter?.next({ type: 'error', error: msg });
    }
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
    this.onChain = true;
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
