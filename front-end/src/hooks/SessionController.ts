import { Subject, NextObserver } from 'rxjs';
import { Program } from 'clvm-lib';

import {
  GameSessionEvent,
  PeerConnectionResult,
  WasmConnection,
  ChiaGame,
  CoinOfInterestEntry,
  CoinStateRecord,
  WasmResult,
  SpendBundle,
  ProposeGameParams,
  WasmEvent,
  NeedCoinSpendRequest,
} from '../types/ChiaGaming';
import { BlockchainPoller, PollingGameSession } from './BlockchainPoller';
import { spend_bundle_to_clvm, coerceToBytes } from '../util';
import { log, diagStack } from '../services/log';
import { jsonStringify } from '../util/jsonSafe';
import { flushSessionSave } from './save';
import type { PersistedGameState } from './save';
import type { RegisteredGameType } from '../lib/session/types';
import type { LocalGameActionRequest } from '../lib/session/sessionMachineTypes';
import type { ChannelStatusPayload } from '../types/ChiaGaming';
import {
  appendRecent,
  DIAGNOSTIC_LOG_LIMIT,
  recentEntries,
  WASM_NOTIFICATION_HISTORY_LIMIT,
} from '../lib/session/historyLimits';
import { decodeChannelStatusPayload } from '../lib/session/persistence';

export interface WasmFields {
  serializedGameSession: Uint8Array;
  gameSessionSchemaVersion: bigint;
  pairingToken: string;
  messageNumber: bigint;
  remoteNumber: bigint;
  iStarted: boolean;
  myContribution: string;
  theirContribution: string;
  perGameAmount: string;
  rewardPuzzleHash: string | null;
  unackedMessages: Array<{ msgno: bigint; msg: Uint8Array }>;
  wasmNotificationHistory: string[];
  diagnosticLog: string[];
  durabilityWarning: string | undefined;
  activeGameIds: string[];
  channelStatus: ChannelStatusPayload | null;
  myAlias: string | undefined;
  opponentAlias: string | undefined;
  lastOutcomeWin: 'win' | 'lose' | 'tie' | undefined;
}

function clvmToBytes(value: Program | null): Uint8Array {
  if (value === null || value === undefined) return new Uint8Array([0x80]);
  return value.serialize();
}

const SAVE_DEBOUNCE_MS = 500;
const KEEPALIVE_INTERVAL_MS = 15_000;
/** Avoid amplifying a burst of duplicate frames into a burst of retransmits. */
const UNACKED_RESEND_MIN_INTERVAL_MS = 1_000;
/** Yield before an unexpectedly self-replenishing active FIFO monopolizes JS. */
const ACTIVE_DRAIN_EVENT_BUDGET = 100;

function isActivatedChannelStatus(status: ChannelStatusPayload['state']): boolean {
  return (
    status === 'Active' ||
    status === 'ShuttingDown' ||
    status === 'ShutdownTransactionPending' ||
    status === 'GoingOnChain' ||
    status === 'Unrolling' ||
    status === 'ResolvedClean' ||
    status === 'ResolvedUnrolled' ||
    status === 'ResolvedStale'
  );
}

function extractErrorMessage(e: unknown): string {
  if (e instanceof Error) {
    try {
      const parsed = JSON.parse(e.message);
      if (parsed?.data?.error) return parsed.data.error;
      if (parsed?.data?.structuredError?.message) return parsed.data.structuredError.message;
    } catch {
      /* not JSON */
    }
    return e.message || e.name || 'Unknown error';
  }
  if (e && typeof e === 'object') {
    if ('message' in e && typeof (e as any).message === 'string') return (e as any).message;
    if (e instanceof Event) return e.type || 'unknown event';
    try {
      return JSON.stringify(e);
    } catch {
      /* fall through */
    }
  }
  return String(e);
}

export function isBenignTransactionSubmitError(message: string): boolean {
  return (
    /spend rejected: status=\[3,9\].*Conflicting transaction/i.test(message) ||
    /spend rejected: status=\[3,5\].*Coin not found/i.test(message)
  );
}

export type RestoreStatus = 'idle' | 'restoring' | 'restored' | 'failed';

export class SessionController implements PollingGameSession {
  myContribution: bigint;
  theirContribution: bigint;
  perGameAmount: bigint;
  rewardPuzzleHash: string | null;
  wc: WasmConnection | undefined;
  sendMessage: (msgno: bigint, msg: Uint8Array) => boolean;
  sendAck: (ackMsgno: bigint) => boolean;
  private peerSendKeepalive: (() => void) | null = null;
  private transactionPublishNerfed = false;
  private transactionPublishNerfPolicy:
    | ((nerfed: boolean, apply: (nerfed: boolean) => void) => void)
    | null = null;
  private lastPeerMessageTime: number = Date.now();
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private lastUnackedResendAt = 0;
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
  private eventQueue: GameSessionEvent[] = [];
  private drainScheduled = false;
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingChainObservations: Array<
    | { kind: 'coin-states'; peak: bigint; records: CoinStateRecord[] }
    | { kind: 'height'; peak: bigint }
  > = [];
  private resubmitAfterChainSync = false;
  // Null means blockchain attachment preceded asynchronous cradle restore, so
  // the restored manager has not yet told us whether a coin snapshot is needed.
  private resubmitNeedsCoinSnapshot: boolean | null = null;
  launcherProvided: boolean;
  private lastSelectCoinsValue: string | null = null;
  private lastLauncherCoinId: string | null = null;

  unackedMessages: Array<{ msgno: bigint; msg: Uint8Array }> = [];
  wasmNotificationHistory: string[] = [];
  diagnosticLog: string[] = [];
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
  private durabilityFlushPromise: Promise<void> = Promise.resolve();
  private pendingEffects = new Set<Promise<void>>();
  private protocolStopped = false;
  private retired = false;
  private terminalHandoff: {
    id: string;
    msgno: bigint;
    sent: boolean;
    acknowledged: boolean;
  } | null = null;
  activeGameIds: string[] = [];
  private handStateProjection: (() => PersistedGameState | null) | null = null;
  lastChannelStatus: ChannelStatusPayload | null = null;
  myAlias: string | undefined = undefined;
  opponentAlias: string | undefined = undefined;
  lastOutcomeWin: 'win' | 'lose' | 'tie' | undefined = undefined;
  durabilityWarning: string | undefined = undefined;
  onSaveNeeded: (() => void | Promise<void>) | null = null;
  onFeatureStateTransition:
    | ((gameType: RegisteredGameType, gameId: string, state: unknown) => boolean)
    | null = null;
  onFeatureStateWithLocalTurnTransition:
    | ((gameType: RegisteredGameType, gameId: string, state: unknown, isMyTurn: boolean) => boolean)
    | null = null;
  onLocalGameAction: ((request: LocalGameActionRequest) => void) | null = null;
  getFee: () => bigint = () => 0n;

  get handState(): PersistedGameState | null {
    return this.handStateProjection?.() ?? null;
  }

  constructor(
    blockchain: BlockchainPoller | null,
    uniqueId: string,
    myContribution: bigint,
    theirContribution: bigint,
    peer_conn: PeerConnectionResult,
  ) {
    const { sendMessage, sendAck } = peer_conn;
    this.uniqueId = uniqueId;
    this.pairingToken = '';
    this.messageNumber = 1n;
    this.remoteNumber = 0n;
    this.sendMessage = (msgno, msg) => sendMessage(Number(msgno), msg);
    this.sendAck = (ackMsgno) => sendAck(Number(ackMsgno));
    this.myContribution = myContribution;
    this.theirContribution = theirContribution;
    this.perGameAmount = 0n;
    this.rewardPuzzleHash = null;
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
      },
    };
    this.beforeUnloadHandler = () => {
      void this.flushPendingSave().catch((error) => this.reportBackgroundSaveError(error));
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', this.beforeUnloadHandler);
    }
  }

  setReloading() {
    this.reloading = true;
  }

  attachBlockchain(blockchain: BlockchainPoller) {
    if (this.blockchain && this.blockchain !== blockchain) {
      this.blockchain.detachGameSession(this);
      this.blockchainAttached = false;
    }
    const alreadyAttached = this.blockchain === blockchain && this.blockchainAttached;
    this.blockchain = blockchain;
    if (alreadyAttached) {
      blockchain.snapshotGameSessionCoinInterest(this);
    } else {
      blockchain.attachGameSession(this);
      this.blockchainAttached = true;
    }
    this.resubmitAfterChainSync = true;
    this.resubmitNeedsCoinSnapshot = this.cradle ? this.snapshotWatchedCoins().length > 0 : null;
    this.flushPendingCoinStates();
  }

  detachBlockchain(blockchain: BlockchainPoller) {
    if (this.blockchain !== blockchain) return;
    blockchain.detachGameSession(this);
    this.blockchainAttached = false;
    this.blockchain = null;
  }

  setPeerKeepalive(sendKeepalive: () => void) {
    this.peerSendKeepalive = sendKeepalive;
    this.startKeepaliveTimer();
  }

  cleanup() {
    this.cleanupInternal(true);
  }

  /**
   * Release a terminal controller after its durability boundary was awaited.
   * Unlike ordinary abandonment/navigation cleanup, this cannot start another
   * unawaited durability operation.
   */
  cleanupAfterTerminalFlush() {
    this.cleanupInternal(false);
  }

  private cleanupInternal(flushDurability: boolean) {
    this.retired = true;
    this.cleanShutdownCalled = true;
    // Retirement is not a manager terminal disposition: detach this session
    // without stopping a shared poller, but make any in-flight active drain
    // inert immediately.
    this.protocolStopped = true;
    this.terminalHandoff = null;
    this.eventQueue = [];
    this.pendingOutboundSends = [];
    this.pendingAcks = [];
    this.unackedMessages = [];
    this.reorderQueue.clear();
    this.needsImmediateDurability = false;
    this.storedMessages = [];
    this.rxjsMessageSingleton.complete();
    this.blockchain?.detachGameSession(this);
    this.blockchainAttached = false;
    this.blockchain = null;
    this.onSaveNeeded = null;
    this.handStateProjection = null;
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
    if (flushDurability) {
      void this.flushDurabilityAndSend();
    }
    this.durabilityFlushScheduled = false;
    this.stopKeepaliveTimer();
    if (this.beforeUnloadHandler && typeof window !== 'undefined') {
      window.removeEventListener('beforeunload', this.beforeUnloadHandler);
      this.beforeUnloadHandler = null;
    }
  }

  reportDurabilityError(error: unknown): void {
    const detail = extractErrorMessage(error);
    const warning = `Session storage failed: ${detail}. Terminal session remains live so saving can be retried.`;
    this.durabilityWarning = warning;
    this.rxjsEmitter?.next({ type: 'durability-error', error: warning });
  }

  private reportBackgroundSaveError(error: unknown): void {
    const warning = `Session storage failed: ${extractErrorMessage(error)}.`;
    this.durabilityWarning = warning;
    this.rxjsEmitter?.next({ type: 'durability-error', error: warning });
  }

  notePeerActivity() {
    this.lastPeerMessageTime = Date.now();
  }

  receiveKeepalive() {
    this.notePeerActivity();
    // Peer is alive but may have missed our outbound frames (e.g. they reloaded
    // mid-handshake). Retransmit anything still awaiting ack.
    this.resendUnacked();
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

  systemState(): number {
    return this.qualifyingEvents;
  }

  getWasmConnection(): WasmConnection | undefined {
    return this.wc;
  }

  isChannelReady(): boolean {
    return this.channelReady;
  }

  isOffChainActive(): boolean {
    return this.lastChannelStatus?.state === 'Active';
  }

  restoreChannelStatus(status: ChannelStatusPayload | null): void {
    this.lastChannelStatus = status;
    this.channelReady = status !== null && isActivatedChannelStatus(status.state);
  }

  getObservable() {
    return this.rxjsMessageSingleton;
  }

  getRestoreStatus(): RestoreStatus {
    return this.restoreStatus;
  }

  getRestoreError(): string | null {
    return this.restoreError;
  }

  onRestoreStatusChange(
    listener: (status: RestoreStatus, error: string | null) => void,
  ): () => void {
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
    this.restorePromise = promise
      .then(() => {
        this.setRestoreStatus('restored', null);
      })
      .catch((e) => {
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

  setGameSession(cradle: ChiaGame) {
    this.cradle = cradle;
    const command = cradle.pendingTerminalHandoff();
    if (command) this.queueTerminalHandoff(command);
    // A blockchain attach may have happened while asynchronous restore had no
    // cradle. The restored transaction manager's watch snapshot—not that empty
    // pre-restore state—decides whether height-only sync can resubmit.
    if (this.resubmitAfterChainSync) {
      const watchedCoins = this.snapshotWatchedCoins();
      this.resubmitNeedsCoinSnapshot = watchedCoins.length > 0;
      this.blockchain?.snapshotGameSessionCoinInterest(this, watchedCoins);
    } else {
      this.blockchain?.snapshotGameSessionCoinInterest(this);
    }
    this.flushPendingCoinStates();
    this.spillStoredMessages();
  }

  activateSpend() {
    if (!this.wc) {
      throw new Error('this.wc is falsey');
    }
    if (!this.cradle) {
      throw new Error('activateSpend called without cradle');
    }
    const result = this.cradle.start_handshake();
    this.processResult(result);
    this.flushPendingCoinStates();
    this.spillStoredMessages();
  }

  private flushPendingCoinStates() {
    // Poller attachment can precede asynchronous WASM restore. Retain raw
    // observations until setGameSession installs the cradle that consumes them.
    if (!this.cradle) return;
    const observations = this.pendingChainObservations;
    this.pendingChainObservations = [];
    for (const observation of observations) {
      if (observation.kind === 'coin-states') {
        this.deliverCoinStates(observation.peak, observation.records);
      } else {
        this.deliverHeight(observation.peak);
      }
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
      const coin = await blockchain.rpc.selectCoins(this.uniqueId, this.myContribution);
      if (!coin) {
        throw new Error('ASSERT_FAIL: selectCoins returned null for launcher parent coin');
      }
      this.lastSelectCoinsValue = coin;
      const { computeLauncherCoin } = await import('../util/launcher');
      const { launcherCoinHex, launcherCoinId } = await computeLauncherCoin(coin);
      this.lastLauncherCoinId = launcherCoinId;
      log(`[wasm] provide_launcher_coin id=${launcherCoinId}`);
      if (!this.cradle) {
        throw new Error('provide_launcher_coin called without cradle');
      }
      const result = this.cradle.provide_launcher_coin(launcherCoinHex);
      this.processResult(result);
    } catch (e) {
      this.launcherProvided = false;
      diagStack('handleNeedLauncherCoin error', e);
      const msg = extractErrorMessage(e);
      log(`[wasm] handleNeedLauncherCoin error: ${msg}`);
      this.rxjsEmitter?.next({ type: 'error', error: msg });
      if (this.cradle) {
        this.processResult(this.cradle.wallet_callback_failed(msg));
      }
    }
  }

  private async handleNeedCoinSpend(request: NeedCoinSpendRequest) {
    const blockchain = this.blockchain;
    if (!blockchain) {
      this.rxjsEmitter?.next({ type: 'error', error: 'Blockchain is not connected' });
      return;
    }
    try {
      const offerAmount = -BigInt(request.amount);
      const extraConditions = request.conditions.map(({ opcode, args }) => ({
        opcode: BigInt(opcode),
        args,
      }));
      const coinIds = request.coin_id ? [request.coin_id] : undefined;
      const maxHeight = request.max_height === undefined ? undefined : BigInt(request.max_height);

      const bundle = await blockchain.rpc.createOfferForIds(
        this.uniqueId,
        { '1': offerAmount },
        extraConditions,
        coinIds,
        maxHeight,
      );
      if (!bundle) {
        const msg = 'Wallet createOfferForIds failed (returned null)';
        log(`[wasm] ${msg}`);
        this.rxjsEmitter?.next({ type: 'error', error: msg });
        if (this.cradle) {
          this.processResult(this.cradle.wallet_callback_failed(msg));
        }
        return;
      }

      if (typeof bundle === 'string' && bundle.startsWith('offer')) {
        console.warn(
          '[wasm] createOfferForIds returned offer string; decoding via bech32 WASM path',
        );
        const localSpendBundle = this.wc?.convert_offer_to_coinset_org(bundle);
        await blockchain.rpc.rememberLocalRemovals?.(localSpendBundle);
        if (!this.cradle) {
          log('[wasm] handleNeedCoinSpend: cradle gone after wallet RPC; dropping');
          return;
        }
        this.processResult(this.cradle.provide_offer_bech32(bundle));
      } else {
        await blockchain.rpc.rememberLocalRemovals?.(bundle);
        if (!this.cradle) {
          log('[wasm] handleNeedCoinSpend: cradle gone after wallet RPC; dropping');
          return;
        }
        const bundleJson = typeof bundle === 'string' ? bundle : jsonStringify(bundle);
        this.processResult(this.cradle.provide_coin_spend_bundle(bundleJson));
      }
    } catch (e) {
      diagStack('handleNeedCoinSpend error', e);
      log(`[wasm] handleNeedCoinSpend error: ${String(e)}`);
      let msg = extractErrorMessage(e);
      if (/insufficient funds/i.test(msg)) {
        msg =
          'Wallet reports insufficient funds. It may be that your wallet has enough balance but some coins are locked. Free up locked coins in your wallet and try again.';
      }
      this.rxjsEmitter?.next({ type: 'error', error: msg });
      if (this.cradle) {
        this.processResult(this.cradle.wallet_callback_failed(msg));
      }
    }
  }

  emitRewardAddress() {
    if (!this.rewardPuzzleHash) {
      throw new Error('emitRewardAddress: rewardPuzzleHash is not set');
    }
    this.rxjsEmitter?.next({ type: 'address', data: { puzzleHash: this.rewardPuzzleHash } });
  }

  kickSystem(flags: number) {
    this.qualifyingEvents |= flags;
    if (this.qualifyingEvents == 3) {
      this.qualifyingEvents |= 4;
      this.spillStoredMessages();
    }
  }

  loadWasm(wasmConnection: WasmConnection) {
    if (this.wc !== undefined) {
      throw new Error('wc already set');
    }
    if (!wasmConnection) {
      throw new Error('wasmConnection is falsey');
    }
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
      if (!this.rewardPuzzleHash) {
        throw new Error('submitTransactionNow: rewardPuzzleHash is not set');
      }
      await blockchain.rpc.spend(
        blob,
        spendBundle,
        this.rewardPuzzleHash,
        'submitTransaction',
        fee || undefined,
      );
    } catch (e) {
      const message = extractErrorMessage(e);
      if (isBenignTransactionSubmitError(message)) {
        log(`[wasm] submitTransaction ignored benign rejection: ${message}`);
        return;
      }
      const coinDescs = (tx.spends ?? [])
        .map((cs: any) => {
          const coinHex = typeof cs.coin === 'string' ? cs.coin : '';
          return coinHex.length >= 64 ? coinHex.slice(0, 64) : coinHex || 'unknown';
        })
        .join(', ');
      diagStack('submitTransaction failed', e);
      log(`[wasm] submitTransaction failed: ${message} coins=[${coinDescs}]`);
      this.rxjsEmitter?.next({ type: 'error', error: message });
    }
  }

  private submitTransaction(tx: SpendBundle) {
    if (this.transactionPublishNerfed) return;
    // Guard the chain with a diagnostic catch: an unhandled rejection escaping
    // this promise is invisible in CI except as a bare empty-message test
    // failure, which is exactly the symptom we are chasing.
    this.transactionSubmitQueue = this.transactionSubmitQueue
      .then(() => {
        if (this.retired) {
          log('[wasm] submitTransaction dropped because controller is retired');
          return;
        }
        if (this.transactionPublishNerfed) {
          log('[wasm] submitTransaction dropped because publishing is nerfed');
          return;
        }
        return this.submitTransactionNow(tx);
      })
      .catch((e) => {
        diagStack('transactionSubmitQueue rejected', e);
      });
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
    if (result === undefined) {
      throw new Error('cradle returned no WasmResult');
    }
    if (this.protocolStopped) {
      return;
    }

    const disposition = result.disposition ?? { kind: 'active' as const };
    const terminal = disposition.kind === 'terminal';
    if (terminal) {
      this.stopProtocolWork();
    }

    const blockchain = this.blockchain;
    if (!terminal) {
      for (const coin of result.watchCoins || []) {
        blockchain?.watchCoin(this, coin);
      }
      for (const coin of result.unwatchCoins || []) {
        blockchain?.unwatchCoin(this, coin);
      }
    }
    for (const event of result.events || []) {
      if (!terminal || this.isTerminalPresentationEvent(event)) {
        this.eventQueue.push(event);
      }
    }
    if (disposition.kind === 'await-outbound-terminal') {
      this.queueTerminalHandoff(disposition.command);
    }

    // A terminal manager drain can still contain already-queued on-chain
    // submissions (for example a mature timeout claim). Actual abandonment
    // clears that queue in Rust before it reaches this boundary.
    this.drainAndSubmitTransactions();
    if (terminal) {
      this.flushDeferredWork();
      return;
    }
    this.scheduleDrain();
  }

  private assertActionSucceeded(result: WasmResult | undefined, action: string): void {
    if (result?.actionSucceeded !== false) return;
    const failed = result.events?.find(
      (event) =>
        'Notification' in event &&
        event.Notification.ActionFailed &&
        typeof event.Notification.ActionFailed.reason === 'string',
    );
    const reason =
      failed && 'Notification' in failed ? failed.Notification.ActionFailed?.reason : undefined;
    throw new Error(reason ? `${action} failed: ${reason}` : `${action} failed`);
  }

  private processCommandResult(result: WasmResult | undefined, action: string): void {
    const processed =
      result?.actionSucceeded === false
        ? {
            ...result,
            events: result.events?.filter(
              (event) => !('Notification' in event && event.Notification.ActionFailed),
            ),
          }
        : result;
    this.processResult(processed);
    this.assertActionSucceeded(result, action);
  }

  private isTerminalPresentationEvent(event: GameSessionEvent): boolean {
    return 'Notification' in event || 'Log' in event || 'ReceiveError' in event;
  }

  private isQueuedGameTerminalEvent(event: GameSessionEvent): boolean {
    if (!('Notification' in event)) return false;
    const notification = event.Notification;
    if (notification.GameSettled || notification.InsufficientBalance) return true;
    const status = notification.GameStatus;
    return typeof status?.status === 'string' && status.status.startsWith('ended-');
  }

  private stopProtocolWork(): void {
    this.protocolStopped = true;
    this.blockchain?.stop();
    this.stopKeepaliveTimer();
    this.terminalHandoff = null;
    // A terminal drain is a replacement boundary, not an append-only update:
    // stale status/protocol work must not render after it. Per-game terminal
    // facts from an earlier manager drain remain authoritative, however, and
    // may be the only terminal notification emitted for that accepted game.
    this.eventQueue = this.eventQueue.filter((event) => this.isQueuedGameTerminalEvent(event));
    this.pendingOutboundSends = [];
    this.pendingAcks = [];
    this.unackedMessages = [];
    this.storedMessages = [];
    this.reorderQueue.clear();
    this.needsImmediateDurability = false;
    if (this.durabilityFlushTimer) {
      clearTimeout(this.durabilityFlushTimer);
      this.durabilityFlushTimer = null;
    }
    this.durabilityFlushScheduled = false;
  }

  private scheduleDrain(): void {
    if (this.drainScheduled || this.eventQueue.length === 0) return;
    this.drainScheduled = true;
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      this.drainActiveEventsToQuiescence();
    }, 0);
  }

  /**
   * Preserve the macrotask boundary before a normal drain, then consume every
   * synchronously appended active event in that same task. Keeping
   * `drainScheduled` set while dispatching makes re-entrant active
   * `processResult()` calls append to this FIFO rather than schedule a second
   * task. Terminal results retain their separate queue-clearing flush path.
   */
  private drainActiveEventsToQuiescence(): void {
    try {
      let drained = 0;
      while (
        this.eventQueue.length > 0 &&
        !this.protocolStopped &&
        !this.retired &&
        drained < ACTIVE_DRAIN_EVENT_BUDGET
      ) {
        this.drainOneEvent();
        drained += 1;
      }
    } finally {
      this.drainScheduled = false;
    }
    if (this.eventQueue.length > 0 && !this.protocolStopped && !this.retired) {
      this.scheduleDrain();
    }
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
    if (!this.retired) {
      this.scheduleSave();
    }
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
    void this.flushDurabilityAndSend();
  }

  async flushPendingWork(): Promise<void> {
    for (let i = 0; i < 100; i += 1) {
      this.flushDeferredWork();
      const effects = [...this.pendingEffects];
      await Promise.allSettled(effects);
      await this.transactionSubmitQueue;
      await this.durabilityFlushPromise;
      this.flushDeferredWork();
      if (
        this.pendingEffects.size === 0 &&
        this.eventQueue.length === 0 &&
        !this.drainScheduled &&
        !this.durabilityFlushScheduled &&
        this.pendingOutboundSends.length === 0 &&
        this.pendingAcks.length === 0
      ) {
        return;
      }
      // A durability pass may have deferred itself while the event queue was
      // non-empty. Ensure another pass is scheduled before yielding.
      if (
        (this.pendingOutboundSends.length > 0 || this.pendingAcks.length > 0) &&
        !this.durabilityFlushScheduled
      ) {
        this.scheduleDurabilityFlush();
      }
    }
    throw new Error('SessionController pending work did not settle');
  }

  private queueTerminalHandoff(command: { id: string; message: Uint8Array }): void {
    if (this.terminalHandoff?.id === command.id) return;
    const existing = this.unackedMessages.find(
      ({ msg }) =>
        msg.length === command.message.length &&
        msg.every((byte, index) => byte === command.message[index]),
    );
    const msgno = existing?.msgno ?? this.messageNumber++;
    if (!existing) {
      this.unackedMessages.push({ msgno, msg: command.message });
      this.pendingOutboundSends.push({ msgno, msg: command.message });
      this.markNeedsImmediateDurability();
      this.scheduleDurabilityFlush();
    }
    this.terminalHandoff = { id: command.id, msgno, sent: false, acknowledged: false };
  }

  private dispatchEvent(event: GameSessionEvent): void {
    if ('OutboundMessage' in event) {
      if (this.protocolStopped || this.onChain) return;
      const msgno = this.messageNumber++;
      this.unackedMessages.push({ msgno, msg: event.OutboundMessage });
      this.pendingOutboundSends.push({ msgno, msg: event.OutboundMessage });
      this.markNeedsImmediateDurability();
    } else if ('Notification' in event) {
      const n = event.Notification;
      let notification = n;
      const tag = typeof n === 'object' && n !== null ? Object.keys(n)[0] : String(n);
      if (tag === 'ChannelStatus') {
        const cs = (n as Record<string, Record<string, unknown>>).ChannelStatus;
        if (cs) {
          const channelStatus = decodeChannelStatusPayload({
            ...cs,
            coin: coerceToBytes(cs.coin),
          });
          if (channelStatus === null) {
            throw new Error('ChannelStatus notification payload is null');
          }
          this.lastChannelStatus = channelStatus;
          notification = { ...n, ChannelStatus: channelStatus };
          if (channelStatus.state === 'Active') {
            this.channelReady = true;
          }
        }
      }
      if (tag === 'ProposalAccepted' && n.ProposalAccepted) {
        const acceptedId = String(n.ProposalAccepted.id);
        if (!this.activeGameIds.includes(acceptedId)) {
          this.activeGameIds.push(acceptedId);
        }
      }
      if (tag === 'GameStatus') {
        const gs = (n as Record<string, Record<string, unknown>>).GameStatus;
        if (gs && typeof gs.status === 'string' && gs.status.startsWith('ended-')) {
          const endedId = gs.id != null ? String(gs.id) : null;
          this.activeGameIds = this.activeGameIds.filter((id) => id !== endedId);
        }
      }
      if (tag === 'GameSettled' && n.GameSettled) {
        const settledId = String(n.GameSettled.id);
        this.activeGameIds = this.activeGameIds.filter((id) => id !== settledId);
      }
      this.wasmNotificationHistory = appendRecent(
        this.wasmNotificationHistory,
        jsonStringify(notification),
        WASM_NOTIFICATION_HISTORY_LIMIT,
      );
      this.rxjsEmitter?.next({ type: 'notification', data: notification });
    } else if ('ReceiveError' in event) {
      this.rxjsEmitter?.next({ type: 'error', error: event.ReceiveError });
    } else if ('CoinSolutionRequest' in event) {
      this.trackEffect(this.fulfillPuzzleSolutionRequest(event.CoinSolutionRequest));
    } else if ('Log' in event) {
      this.diagnosticLog = appendRecent(this.diagnosticLog, event.Log, DIAGNOSTIC_LOG_LIMIT);
      this.rxjsEmitter?.next({ type: 'log', message: event.Log });
    } else if ('NeedLauncherCoin' in event) {
      this.trackEffect(this.handleNeedLauncherCoin());
    } else if ('NeedCoinSpend' in event) {
      this.trackEffect(this.handleNeedCoinSpend(event.NeedCoinSpend));
    } else if ('OutboundTransaction' in event) {
      throw new Error('unexpected OutboundTransaction GameSessionEvent (use drain_submissions)');
    } else {
      const keys = Object.keys(event as object);
      throw new Error(`unknown GameSessionEvent: ${keys.join(',') || '(empty)'}`);
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
      let ps = await blockchain.rpc.getPuzzleAndSolution(coinHex);
      if (!ps) {
        log(`[wasm] getPuzzleAndSolution returned null, retrying after 5s`);
        await new Promise((r) => setTimeout(r, 5000));
        ps = await blockchain.rpc.getPuzzleAndSolution(coinHex);
      }
      if (!this.protocolStopped && this.cradle) {
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
    if (this.retired) return;
    // Terminal Rust state must not consume peer protocol messages, but the host
    // still acknowledges their transport delivery so the peer can retire them.
    if (this.protocolStopped) {
      this.sendAck(msgno);
      return;
    }
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
      // Duplicate inbound usually means the peer retransmitted after a reload or
      // lost our reply. Re-ack alone is not enough — also replay our unacked
      // outbound (e.g. OfferSent payload) so handshake can finish.
      this.resendUnacked();
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
      // Rust owns the outcome of a transport failure: its Go On-Chain path may
      // begin resolution or convert a zero-payout shutdown into abandonment.
      this.goOnChain();
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
    if (this.retired) return;
    this.notePeerActivity();
    const terminalCommand = this.terminalHandoff;
    const terminalAcknowledged =
      terminalCommand && terminalCommand.sent && ackMsgno >= terminalCommand.msgno;
    const before = this.unackedMessages.length;
    this.unackedMessages = this.unackedMessages.filter(
      (m) => m.msgno > ackMsgno || (terminalCommand?.msgno === m.msgno && !terminalCommand.sent),
    );
    if (this.unackedMessages.length !== before) {
      this.scheduleSave();
    }
    if (terminalAcknowledged) {
      this.terminalHandoff = { ...terminalCommand, acknowledged: true };
      this.completeOutboundTerminalHandoffAfterAck(terminalCommand.id);
    }
  }

  resendUnacked(): boolean {
    if (this.protocolStopped) return false;
    // Hub reconnect / peer keepalive: also retry acks and outbound that failed
    // while the WS was closed (those sit in pending* with needsImmediateDurability,
    // not in unackedMessages).
    if (
      this.needsImmediateDurability ||
      this.pendingAcks.length > 0 ||
      this.pendingOutboundSends.length > 0
    ) {
      this.scheduleDurabilityFlush();
    }
    if (this.unackedMessages.length === 0) return true;
    const now = Date.now();
    if (now - this.lastUnackedResendAt < UNACKED_RESEND_MIN_INTERVAL_MS) return false;
    this.lastUnackedResendAt = now;
    for (const { msgno, msg } of this.unackedMessages) {
      if (!this.sendMessage(msgno, msg)) {
        log(`[wasm] resendUnacked: hub send failed for msgno=${msgno}`);
        return false;
      }
      this.noteTerminalHandoffSent(msgno);
    }
    return true;
  }

  // --- PollingGameSession: driven by the BlockchainPoller ---

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
      this.pendingChainObservations.push({ kind: 'coin-states', peak, records });
      return;
    }
    this.deliverCoinStates(peak, records);
  }

  reportNewBlock(peak: bigint) {
    if (!this.cradle) {
      this.pendingChainObservations.push({ kind: 'height', peak });
      return;
    }
    this.deliverHeight(peak);
  }

  private deliverHeight(peak: bigint) {
    log(`[wasm] height-only observation height=${peak}`);
    if (!this.cradle) {
      throw new Error('deliverHeight called without cradle');
    }
    try {
      this.processResult(this.cradle.report_height(peak));
      if (this.resubmitNeedsCoinSnapshot === false) this.resubmitAfterFreshChainSync();
    } catch (e) {
      diagStack('report_height failed', e);
      log(`[wasm] report_height failed: ${String(e)}`);
    }
  }

  private deliverCoinStates(peak: bigint, records: CoinStateRecord[]) {
    log(`[wasm] coin states height=${peak} coins=${records.length}`);
    if (!this.cradle) {
      throw new Error('deliverCoinStates called without cradle');
    }
    try {
      const result = this.cradle.report_coin_states(peak, records);
      this.processResult(result);
      this.resubmitNeedsCoinSnapshot = false;
      this.resubmitAfterFreshChainSync();
    } catch (e) {
      diagStack('report_coin_states failed', e);
      log(`[wasm] report_coin_states failed: ${String(e)}`);
    }
  }

  private resubmitAfterFreshChainSync() {
    if (!this.resubmitAfterChainSync || this.protocolStopped || !this.cradle) return;
    this.resubmitAfterChainSync = false;
    this.cradle.resubmit_submitted();
    this.drainAndSubmitTransactions();
  }

  // --- Persistence ---

  scheduleSave() {
    if (!this.cradle) return;
    if (this.saveTimer) return;
    const timer = setTimeout(() => {
      this.saveTimer = null;
      try {
        void Promise.resolve(this.onSaveNeeded?.()).catch((error) =>
          this.reportBackgroundSaveError(error),
        );
      } catch (error) {
        this.reportBackgroundSaveError(error);
      }
    }, SAVE_DEBOUNCE_MS);
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();
    this.saveTimer = timer;
  }

  flushPendingSave(): Promise<void> {
    // Rust intentionally omits transient cradle events from serialization.
    // Move every event into its durable JS representation (message counters,
    // unacked messages, notifications) before taking the lifecycle snapshot.
    this.flushDeferredWork();

    let saveRequest: Promise<void> = Promise.resolve();
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      saveRequest = Promise.resolve(this.onSaveNeeded?.());
      void saveRequest.catch(() => {});
    }

    // Always flush the outer persistence debounce as well: React may have
    // queued a full-session save without SessionController's timer being set.
    // onSaveNeeded is required to update `cached` synchronously before returning
    // its Promise so this flush snapshots the new cradle, not a pre-save state.
    const persistence = flushSessionSave();
    const durability = this.flushDurabilityAndSend();
    return Promise.all([saveRequest, persistence, durability]).then(() => {});
  }

  private markNeedsImmediateDurability() {
    if (this.protocolStopped) return;
    this.needsImmediateDurability = true;
    this.scheduleDurabilityFlush();
  }

  private scheduleDurabilityFlush() {
    if (this.protocolStopped) return;
    if (this.durabilityFlushScheduled) return;
    this.durabilityFlushScheduled = true;
    const timer = setTimeout(() => {
      this.durabilityFlushTimer = null;
      this.durabilityFlushScheduled = false;
      if (this.drainScheduled || this.eventQueue.length > 0) {
        this.scheduleDurabilityFlush();
        return;
      }
      void this.flushDurabilityAndSend();
    }, 0);
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();
    this.durabilityFlushTimer = timer;
  }

  private flushDurabilityAndSend(): Promise<void> {
    this.durabilityFlushPromise = this.durabilityFlushPromise.then(
      () => this.performDurabilityFlushAndSend(),
      () => this.performDurabilityFlushAndSend(),
    );
    void this.durabilityFlushPromise.catch(() => {});
    return this.durabilityFlushPromise;
  }

  private async performDurabilityFlushAndSend(): Promise<void> {
    if (this.protocolStopped) return;
    if (
      !this.needsImmediateDurability &&
      this.pendingOutboundSends.length === 0 &&
      this.pendingAcks.length === 0
    ) {
      return;
    }
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.needsImmediateDurability) {
      const outboundCount = this.pendingOutboundSends.length;
      const ackCount = this.pendingAcks.length;
      if (!this.onSaveNeeded) {
        throw new Error(
          'Session persistence callback is unavailable at a protocol delivery boundary',
        );
      }
      try {
        const saveRequest = Promise.resolve(this.onSaveNeeded());
        void saveRequest.catch(() => {});
        // onSaveNeeded must update the in-memory session synchronously before
        // returning its Promise (see flushPendingSave). Flushing first then
        // persists that snapshot; awaiting the Promise only waits for the
        // outer debounce settlement.
        await flushSessionSave();
        await saveRequest;
      } catch (error) {
        const detail = extractErrorMessage(error);
        const warning = `Session storage failed: ${detail}. Protocol messages remain queued until storage succeeds.`;
        if (this.durabilityWarning !== warning) {
          this.durabilityWarning = warning;
          this.rxjsEmitter?.next({ type: 'durability-error', error: warning });
        }
        throw error;
      }

      if (this.protocolStopped) return;
      const outbound = this.pendingOutboundSends.splice(0, outboundCount);
      const acks = this.pendingAcks.splice(0, ackCount);
      const failedOutbound: Array<{ msgno: bigint; msg: Uint8Array }> = [];
      const failedAcks: bigint[] = [];
      for (const item of outbound) {
        if (!this.sendMessage(item.msgno, item.msg)) {
          failedOutbound.push(item);
        } else {
          this.noteTerminalHandoffSent(item.msgno);
        }
      }
      for (const ack of acks) {
        if (!this.sendAck(ack)) {
          failedAcks.push(ack);
        }
      }
      if (failedOutbound.length > 0 || failedAcks.length > 0) {
        log(
          `[wasm] hub send failed after durability: outbound=${failedOutbound.length} acks=${failedAcks.length}; left queued`,
        );
        this.pendingOutboundSends = [...failedOutbound, ...this.pendingOutboundSends];
        this.pendingAcks = [...failedAcks, ...this.pendingAcks];
        // Leave needsImmediateDurability set but do not reschedule: WS is likely
        // closed; retry on the next natural flush trigger.
        this.needsImmediateDurability = true;
      } else {
        this.needsImmediateDurability =
          this.pendingOutboundSends.length > 0 || this.pendingAcks.length > 0;
        if (this.needsImmediateDurability) {
          this.scheduleDurabilityFlush();
        }
      }
      return;
    }

    if (this.protocolStopped) return;
    const outbound = this.pendingOutboundSends.splice(0, this.pendingOutboundSends.length);
    const acks = this.pendingAcks.splice(0, this.pendingAcks.length);
    const failedOutbound: Array<{ msgno: bigint; msg: Uint8Array }> = [];
    const failedAcks: bigint[] = [];
    for (const item of outbound) {
      if (!this.sendMessage(item.msgno, item.msg)) {
        failedOutbound.push(item);
      } else {
        this.noteTerminalHandoffSent(item.msgno);
      }
    }
    for (const ack of acks) {
      if (!this.sendAck(ack)) {
        failedAcks.push(ack);
      }
    }
    if (failedOutbound.length > 0 || failedAcks.length > 0) {
      log(
        `[wasm] hub send failed: outbound=${failedOutbound.length} acks=${failedAcks.length}; left queued`,
      );
      this.pendingOutboundSends = [...failedOutbound, ...this.pendingOutboundSends];
      this.pendingAcks = [...failedAcks, ...this.pendingAcks];
      this.needsImmediateDurability = true;
    }
  }

  private completeOutboundTerminalHandoffAfterAck(commandId: string): void {
    if (this.terminalHandoff?.id !== commandId) return;
    if (!this.cradle) {
      throw new Error('WASM cradle is unavailable for cooperative terminal handoff');
    }
    try {
      const result = this.cradle.completeOutboundTerminalHandoff();
      if ((result?.disposition?.kind ?? 'active') !== 'terminal') {
        throw new Error('cooperative terminal handoff did not produce a terminal result');
      }
      this.terminalHandoff = null;
      this.processResult(result);
    } catch (error) {
      const message = extractErrorMessage(error);
      diagStack('complete terminal handoff failed', error);
      this.rxjsEmitter?.next({ type: 'error', error: message });
    }
  }

  private noteTerminalHandoffSent(msgno: bigint): void {
    if (this.terminalHandoff?.msgno === msgno) {
      this.terminalHandoff = { ...this.terminalHandoff, sent: true };
    }
  }

  getWasmFields(): WasmFields | null {
    // Null means the cradle is not loaded yet (e.g. mid-restore). Serialize
    // failures must throw so callers like durability flush do not treat a
    // failed snapshot as a successful no-op.
    if (!this.cradle || !this.wc) return null;
    const serializedGameSession = this.cradle.serialize();
    return {
      serializedGameSession,
      gameSessionSchemaVersion: BigInt(this.wc.game_session_serialization_schema()),
      pairingToken: this.pairingToken,
      messageNumber: this.messageNumber,
      remoteNumber: this.remoteNumber,
      iStarted: this.iStarted,
      myContribution: this.myContribution.toString(),
      theirContribution: this.theirContribution.toString(),
      perGameAmount: this.perGameAmount.toString(),
      rewardPuzzleHash: this.rewardPuzzleHash,
      unackedMessages: [...this.unackedMessages],
      wasmNotificationHistory: recentEntries(
        this.wasmNotificationHistory,
        WASM_NOTIFICATION_HISTORY_LIMIT,
      ),
      diagnosticLog: recentEntries(this.diagnosticLog, DIAGNOSTIC_LOG_LIMIT),
      durabilityWarning: this.durabilityWarning,
      activeGameIds: [...this.activeGameIds],
      channelStatus: this.lastChannelStatus,
      myAlias: this.myAlias,
      opponentAlias: this.opponentAlias,
      lastOutcomeWin: this.lastOutcomeWin,
    };
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

  projectHandState(read: () => PersistedGameState | null): () => void {
    this.handStateProjection = read;
    return () => {
      if (this.handStateProjection === read) this.handStateProjection = null;
    };
  }

  transitionFeatureState(gameType: RegisteredGameType, gameId: string, state: unknown): boolean {
    try {
      if (!this.onFeatureStateTransition) {
        throw new Error('Feature state transition callback is unavailable');
      }
      return this.onFeatureStateTransition(gameType, gameId, state);
    } catch (error) {
      const message = extractErrorMessage(error);
      console.error('[session] feature state transition failed:', message);
      this.rxjsEmitter?.next({
        type: 'game-action-error',
        gameId,
        action: 'feature-state',
        error: message,
      });
      return false;
    }
  }

  commitLocalGameAction(request: LocalGameActionRequest): void {
    if (!this.onLocalGameAction) {
      throw new Error('Local game action callback is unavailable');
    }
    this.onLocalGameAction(request);
  }

  transitionFeatureStateWithLocalTurn(
    gameType: RegisteredGameType,
    gameId: string,
    state: unknown,
    isMyTurn: boolean,
  ): boolean {
    if (!this.onFeatureStateWithLocalTurnTransition) {
      throw new Error('Feature state with local turn transition callback is unavailable');
    }
    return this.onFeatureStateWithLocalTurnTransition(gameType, gameId, state, isMyTurn);
  }

  /**
   * Game IDs and hand state are host-side presentation state. An abandoned
   * session has no per-game terminal events to retire them individually.
   */
  clearDerivedGamePresentation(): void {
    this.activeGameIds = [];
    this.scheduleSave();
  }

  markRestored() {
    this.restoredSession = true;
  }

  // --- Game actions (called by higher layer) ---

  proposeGame(params: ProposeGameParams): string[] {
    return this.proposeGames([params]);
  }

  proposeGames(paramsList: ProposeGameParams[]): string[] {
    if (!this.cradle) throw new Error('no cradle');
    if (paramsList.length !== 1) {
      throw new Error(`proposeGames expects one atomic group request, got ${paramsList.length}`);
    }
    const games = paramsList.map(({ parameters: _p, ...wasmParams }) => wasmParams);
    const parametersList = paramsList.map(({ parameters }) => clvmToBytes(parameters));
    const result = this.cradle.propose_games(games, parametersList);
    this.processCommandResult(result, 'propose game');
    if (!result?.ids) {
      throw new Error('proposeGames returned no ids');
    }
    return result.ids;
  }

  acceptProposal(gameId: string): void {
    if (!this.cradle) throw new Error('no cradle');
    try {
      const result = this.cradle.accept_proposal(gameId);
      this.processCommandResult(result, 'accept proposal');
    } catch (e) {
      const msg = extractErrorMessage(e);
      console.error('[wasm] acceptProposal failed:', msg);
      this.rxjsEmitter?.next({ type: 'error', error: msg });
      throw e;
    }
  }

  cancel_proposal(gameId: string): void {
    if (!this.cradle) throw new Error('no cradle');
    try {
      const result = this.cradle.cancel_proposal(gameId);
      this.processCommandResult(result, 'cancel proposal');
    } catch (e) {
      const msg = extractErrorMessage(e);
      console.error('[wasm] cancel_proposal failed:', msg);
      this.rxjsEmitter?.next({ type: 'error', error: msg });
      throw e;
    }
  }

  makeMove(gameId: string, readable: Program | null): void {
    if (!this.cradle) throw new Error('no cradle');
    try {
      const bytes = clvmToBytes(readable);
      const result = this.cradle.make_move(gameId, bytes);
      this.processCommandResult(result, 'make move');
    } catch (e) {
      const msg = extractErrorMessage(e);
      console.error('[wasm] makeMove failed:', msg);
      this.rxjsEmitter?.next({
        type: 'game-action-error',
        gameId,
        action: 'make-move',
        error: msg,
      });
      throw e;
    }
  }

  acceptSettlement(gameId: string): void {
    if (!this.cradle) throw new Error('no cradle');
    try {
      const result = this.cradle.acceptSettlement(gameId);
      this.processCommandResult(result, 'accept settlement');
    } catch (e) {
      const msg = extractErrorMessage(e);
      console.error('[wasm] acceptSettlement failed:', msg);
      this.rxjsEmitter?.next({
        type: 'game-action-error',
        gameId,
        action: 'accept-settlement',
        error: msg,
      });
      throw e;
    }
  }

  cheat(gameId: string, moverShare: bigint): void {
    if (!this.cradle) throw new Error('no cradle');
    try {
      const result = this.cradle.cheat(gameId, moverShare);
      this.processCommandResult(result, 'cheat');
    } catch (e) {
      const msg = extractErrorMessage(e);
      console.error('[wasm] cheat failed:', msg);
      this.rxjsEmitter?.next({ type: 'error', error: msg });
      throw e;
    }
  }

  cleanShutdown(): void {
    if (!this.cradle) throw new Error('no cradle');
    try {
      const result = this.cradle.shut_down();
      this.processCommandResult(result, 'clean shutdown');
      this.cleanShutdownCalled = true;
    } catch (e) {
      const msg =
        e instanceof Error
          ? e.stack || e.message
          : typeof e === 'object' && e !== null && 'error' in e
            ? (e as { error: string }).error
            : String(e);
      console.error('[wasm] cleanShutdown failed:', msg);
      this.rxjsEmitter?.next({ type: 'error', error: msg });
      throw e;
    }
  }

  abandon(): void {
    if (!this.cradle) return;
    try {
      this.processResult(this.cradle.abandon());
    } catch (e) {
      const msg =
        e instanceof Error
          ? e.stack || e.message
          : typeof e === 'object' && e !== null && 'error' in e
            ? (e as { error: string }).error
            : String(e);
      console.error('[wasm] abandon failed:', msg);
      this.rxjsEmitter?.next({ type: 'error', error: msg });
    }
  }

  goOnChain(): boolean {
    if (!this.cradle) throw new Error('no cradle');
    try {
      const result = this.cradle.go_on_chain();
      const startedOnChain =
        result?.actionSucceeded === true && result.disposition?.kind === 'active';
      this.onChain = startedOnChain;
      this.processCommandResult(result, 'go on chain');
      return startedOnChain;
    } catch (e) {
      this.onChain = false;
      const msg =
        e instanceof Error
          ? e.stack || e.message
          : typeof e === 'object' && e !== null && 'error' in e
            ? (e as { error: string }).error
            : String(e);
      console.error('[wasm] goOnChain failed:', msg);
      this.rxjsEmitter?.next({ type: 'error', error: msg });
      return false;
    }
  }

  isTransactionPublishNerfed(): boolean {
    return this.transactionPublishNerfed;
  }

  setTransactionPublishNerfPolicy(
    policy: (nerfed: boolean, apply: (nerfed: boolean) => void) => void,
  ): void {
    this.transactionPublishNerfPolicy = policy;
  }

  setTransactionPublishNerfed(nerfed: boolean): void {
    if (this.transactionPublishNerfPolicy) {
      this.transactionPublishNerfPolicy(nerfed, (value) =>
        this.applyTransactionPublishNerfed(value),
      );
      return;
    }
    this.applyTransactionPublishNerfed(nerfed);
  }

  private applyTransactionPublishNerfed(nerfed: boolean): void {
    this.transactionPublishNerfed = nerfed;
    log(`[wasm] transaction publish ${nerfed ? 'nerfed' : 'enabled'}`);
  }

  nerf(): void {
    this.setTransactionPublishNerfed(true);
  }
}
