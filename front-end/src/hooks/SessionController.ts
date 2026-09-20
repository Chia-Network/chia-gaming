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
  TransactionSubmission,
  SubmissionDrainFailure,
  FinalizedSubmission,
  ProposeGameParams,
  WasmEvent,
  WasmNotification,
  NeedCoinSpendRequest,
  requireWasmResult,
} from '../types/ChiaGaming';
import { BlockchainPoller, PollingGameSession } from './BlockchainPoller';
import { spend_bundle_to_clvm, coerceToBytes } from '../util';
import { log, diagStack } from '../services/log';
import { MIN_NONZERO_FEE_MOJOS } from '../constants/fees';
import { jsonStringify } from '../util/jsonSafe';
import { clearSession } from './save';
import type { ChannelStatusPayload } from '../types/ChiaGaming';
import {
  appendRecent,
  DIAGNOSTIC_LOG_LIMIT,
  recentEntries,
  WASM_NOTIFICATION_HISTORY_LIMIT,
} from '../lib/session/historyLimits';
import { decodeChannelStatusPayload } from '../lib/session/persistence';
import { completeRegisteredGames } from '../lib/gameIdentities';
import { catalogGameTypeFromWire } from '../lib/gameIdentities';
import { markClientErrorReported } from '../lib/clientError';
import {
  DEFAULT_SESSION_RECEIVE_POLICY,
  type ReadonlySessionReceivePolicy,
} from '../lib/session/receivePolicy';
import {
  canonicalizeFundingRequest,
  decodeCanonicalFundingRequest,
  fundingRequestKey,
  type CanonicalFundingRequest,
} from '../lib/session/fundingRequest';
import {
  decodePeerAppMessage,
  ReliablePeerTransport,
  type PreparedReliableCommit,
  type ReliableCommitCoordinator,
  type ReliableMessageConsumer,
} from '../services/PeerSession';
import type { SessionRuntimeLease } from '../lib/session/sessionRuntimeLease';
import type { SessionModel } from '../lib/session/types';
import {
  SessionRuntimeRetiredError,
  type SessionMachineRuntime,
} from '../lib/session/sessionMachineRuntime';
import {
  type WalletReservationLedgerEntry,
  type WalletReservationOwner,
  type WalletReservationPurpose,
} from '../lib/session/walletReservationLedgerSchema';
import { walletReservationLedger } from '../lib/session/walletReservationLedger';
import type { SessionTerminalHandoffSave, SessionTransportSave } from '../lib/session/saveEnvelope';

export type GameCommandDisposition = 'rejected' | 'queued' | 'applied';

export class WalletOfferCleanupPendingError extends Error {
  readonly code = 'WALLET_OFFER_CLEANUP_PENDING';

  constructor(readonly entries: readonly WalletReservationLedgerEntry[]) {
    super(
      `Cannot finish session while ${entries.length} wallet offer reservation${
        entries.length === 1 ? '' : 's'
      } remain. Reconnect the wallet and retry cleanup.`,
    );
    this.name = 'WalletOfferCleanupPendingError';
  }
}

export interface TerminalQuiescentSnapshot {
  model: SessionModel;
  coinsOfInterest: CoinOfInterestEntry[];
}

class TransactionSubmitQueue {
  private tail: Promise<void> = Promise.resolve();
  private readonly jobs = new Set<{
    settle(): void;
    reject(error: unknown): void;
  }>();
  private retired = false;

  enqueue(run: () => Promise<void>): Promise<void> {
    let resolvePromise!: () => void;
    let rejectPromise!: (error: unknown) => void;
    let settled = false;
    const completion = new Promise<void>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const job = {
      settle: () => {
        if (settled) return;
        settled = true;
        this.jobs.delete(job);
        resolvePromise();
      },
      reject: (error: unknown) => {
        if (settled) return;
        settled = true;
        this.jobs.delete(job);
        rejectPromise(error);
      },
    };
    this.jobs.add(job);
    const submission = this.tail.then(async () => {
      if (this.retired) return;
      await run();
    });
    this.tail = submission.catch(() => {});
    void submission.then(job.settle, job.reject);
    return completion;
  }

  flush(): Promise<void> {
    return this.tail;
  }

  retire(): void {
    if (this.retired) return;
    this.retired = true;
    for (const job of [...this.jobs]) job.settle();
    this.tail = Promise.resolve();
  }
}

export interface WasmFields {
  serializedGameSession: Uint8Array;
  gameSessionSchemaVersion: bigint;
  pairingToken: string;
  gameSessionId: string;
  messageNumber: bigint;
  remoteNumber: bigint;
  iStarted: boolean;
  myContribution: string;
  theirContribution: string;
  perGameAmount: string;
  rewardPuzzleHash: string | null;
  unackedMessages: Array<{ msgno: bigint; msg: Uint8Array }>;
  terminalHandoff: SessionTerminalHandoffSave | null;
  wasmNotificationHistory: string[];
  diagnosticLog: string[];
  durabilityWarning: string | undefined;
  fundingOutbox: Array<{ key: string; request: CanonicalFundingRequest }>;
  transportDisposition: 'active' | 'proposal-received' | 'outbound-reject' | 'inbound-reject';
  activeGameIds: string[];
  channelStatus: ChannelStatusPayload | null;
  myAlias: string | undefined;
  opponentAlias: string | undefined;
  waitingStateEnteredAt: bigint | null;
  cleanShutdownGraceStartedAt: bigint | null;
}

function clvmToBytes(value: Program | null): Uint8Array {
  if (value === null || value === undefined) return new Uint8Array([0x80]);
  return value.serialize();
}

const KEEPALIVE_INTERVAL_MS = 15_000;
/** Avoid amplifying a burst of duplicate frames into a burst of retransmits. */
/** Yield before an unexpectedly self-replenishing active FIFO monopolizes JS. */
const ACTIVE_DRAIN_EVENT_BUDGET = 100;
const SUBMISSION_DRAIN_JS_STACK_LIMIT = 8_192;

function proposalMadeAdmitted(notification: WasmNotification): boolean {
  const payload = (notification as { ProposalMade?: { game_type?: unknown } }).ProposalMade;
  if (payload === undefined) return true;
  const raw = payload.game_type;
  if (typeof raw !== 'string') return true;
  return catalogGameTypeFromWire(raw) !== null;
}

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

/**
 * Chia's mempool treats a fee below 5 mojos per cost unit as zero and, on a full
 * mempool, rejects the bundle outright rather than admitting it as free. This
 * rewrites the node's terse fee-rate codes into an actionable message. The fee
 * rejection is fatal (unlike the benign cases above), so callers must still
 * surface it loudly.
 */
export function rewriteFeeRateRejection(message: string): string {
  if (/INVALID_FEE_TOO_CLOSE_TO_ZERO|INVALID_FEE_LOW_FEE|fee.*too close to zero/i.test(message)) {
    return (
      `The network rejected the transaction because its fee is effectively zero ` +
      `(below ${MIN_NONZERO_FEE_MOJOS.toLocaleString()} mojos, the 5 mojo/cost floor). ` +
      `Set the transaction fee to 0 (a free transaction) or to at least ` +
      `${MIN_NONZERO_FEE_MOJOS.toLocaleString()} mojos and try again. (${message})`
    );
  }
  return message;
}

export type RestoreStatus = 'idle' | 'restoring' | 'restored' | 'failed';

type FundingAttemptLaunchState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'scheduled'; readonly coordinator: ReliableCommitCoordinator }
  | { readonly kind: 'launched' };

interface ActiveFundingAttempt {
  readonly key: string;
  readonly request: CanonicalFundingRequest;
  launchState: FundingAttemptLaunchState;
}

type SubmissionDeliveryState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'scheduled-with-lease'; readonly lease: SessionRuntimeLease }
  | { readonly kind: 'launched' };

interface PendingSubmissionDelivery {
  readonly submission: TransactionSubmission;
  readonly completion: Promise<void>;
  readonly complete: () => void;
  state: SubmissionDeliveryState;
}

type CoinSolutionDeliveryState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'scheduled-with-lease'; readonly lease: SessionRuntimeLease }
  | { readonly kind: 'launched' }
  | { readonly kind: 'blocked' };

interface PendingCoinSolutionDelivery {
  readonly coin: string;
  readonly completion: Promise<void>;
  readonly complete: () => void;
  state: CoinSolutionDeliveryState;
}

class CoinSolutionCallbackRejectedError extends Error {
  constructor(reason?: string) {
    super(
      reason ? `puzzle/solution callback failed: ${reason}` : 'puzzle/solution callback failed',
    );
    this.name = 'CoinSolutionCallbackRejectedError';
  }
}

export class SessionController implements PollingGameSession {
  myContribution: bigint;
  theirContribution: bigint;
  perGameAmount: bigint;
  rewardPuzzleHash: string | null;
  wc: WasmConnection | undefined;
  private peerSendKeepalive: (() => void) | null = null;
  private transactionPublishNerfed = false;
  private transactionPublishNerfPolicy:
    | ((nerfed: boolean, apply: (nerfed: boolean) => void) => void)
    | null = null;
  private lastPeerMessageTime: number = Date.now();
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private reliableState: NonNullable<PeerConnectionResult['reliableState']>;
  private reliableTransport: ReliablePeerTransport;
  private readonly reliableConsumer: ReliableMessageConsumer;
  private inboundSessionRejected = false;
  private inboundSessionRejectCommitted = false;
  private persistInboundSessionReject:
    | ((sessionId: string, remoteNumber: bigint) => Promise<void>)
    | null = null;
  private inboundSessionRejectHandler: ((sessionId: string, remoteNumber: bigint) => void) | null =
    null;
  cradle: ChiaGame | undefined;
  uniqueId: string;
  pairingToken: string;
  channelReady: boolean;
  iStarted: boolean;
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

  wasmNotificationHistory: string[] = [];
  diagnosticLog: string[] = [];
  private readonly receivePolicy: ReadonlySessionReceivePolicy;
  private pendingPeerFailure: string | null = null;
  private transactionCoordinator: SessionRuntimeLease | null = null;
  private committedSessionRuntime: SessionMachineRuntime | null = null;
  private restoreStatus: RestoreStatus = 'idle';
  private restoreError: string | null = null;
  private restorePromise: Promise<void> | null = null;
  private restoreListeners = new Set<(status: RestoreStatus, error: string | null) => void>();
  private terminalFinalizationRetryListeners = new Set<() => void>();
  private readonly transactionSubmitQueue = new TransactionSubmitQueue();
  private readonly pendingSubmissionDeliveries = new Map<string, PendingSubmissionDelivery>();
  private readonly pendingCoinSolutionDeliveries = new Map<string, PendingCoinSolutionDelivery>();
  private puzzleSolutionReadinessUnsubscribe: (() => void) | null = null;
  private goOnChainSequence = 0;
  private beforeUnloadHandler: (() => void) | null = null;
  private pendingEffects = new Set<Promise<void>>();
  private activeFundingAttempt: ActiveFundingAttempt | null = null;
  private readonly walletLedgerUnsubscribe: () => void;
  private protocolStopped = false;
  private retired = false;
  private terminalHandoff: SessionTerminalHandoffSave | null = null;
  private transportCheckpointRestored = false;
  activeGameIds: string[] = [];
  lastChannelStatus: ChannelStatusPayload | null = null;
  myAlias: string | undefined = undefined;
  opponentAlias: string | undefined = undefined;
  durabilityWarning: string | undefined = undefined;
  private waitingStateEnteredAt: bigint | null = null;
  private cleanShutdownGraceStartedAt: bigint | null = null;
  private feeProvider: () => bigint = () => 0n;

  get getFee(): () => bigint {
    return this.feeProvider;
  }

  set getFee(provider: () => bigint) {
    this.feeProvider = provider;
    this.syncFeeConfiguration();
  }

  constructor(
    blockchain: BlockchainPoller | null,
    uniqueId: string,
    myContribution: bigint,
    theirContribution: bigint,
    peer_conn: PeerConnectionResult,
  ) {
    const { sendMessage, sendAck } = peer_conn;
    this.receivePolicy = peer_conn.receivePolicy ?? DEFAULT_SESSION_RECEIVE_POLICY;
    this.reliableState =
      peer_conn.reliableState ??
      ({
        sessionId: uniqueId,
        messageNumber: 1n,
        remoteNumber: 0n,
        unackedMessages: [],
        disposition: 'active',
      } satisfies NonNullable<PeerConnectionResult['reliableState']>);
    this.reliableTransport =
      peer_conn.reliableTransport instanceof ReliablePeerTransport
        ? peer_conn.reliableTransport
        : new ReliablePeerTransport(
            this.reliableState,
            this.receivePolicy,
            (msgno, body) => sendMessage(Number(msgno), body),
            (msgno) => sendAck(Number(msgno)),
          );
    this.persistInboundSessionReject = peer_conn.persistInboundSessionReject ?? null;
    this.inboundSessionRejectHandler = peer_conn.onSessionReject ?? null;
    this.reliableConsumer = {
      isReady: () =>
        !!this.wc &&
        !!this.cradle &&
        this.qualifyingEvents === 7 &&
        !this.reloading &&
        !this.pendingPeerFailure &&
        !this.inboundSessionRejected &&
        !this.retired,
      deliver: (msgno, body) => this.deliverOrderedMessage(msgno, body),
      persist: () =>
        Promise.reject(
          new Error('Active-session persistence requires SessionMachineRuntime coordination'),
        ),
      failure: (reason) => this.failPeerProcessing(reason),
      acknowledged: (ack) => this.handleReliableAcknowledgement(ack),
      sent: (msgno) => this.noteTerminalHandoffSent(msgno),
      keepalive: () => this.notePeerActivity(),
      committed: () => this.notifyInboundSessionRejectCommitted(),
    };
    this.reliableTransport.attachConsumer(this.reliableConsumer);
    this.uniqueId = uniqueId;
    this.pairingToken = '';
    this.myContribution = myContribution;
    this.theirContribution = theirContribution;
    this.perGameAmount = 0n;
    this.rewardPuzzleHash = null;
    this.iStarted = false;
    this.channelReady = false;
    this.cleanShutdownCalled = false;
    this.onChain = false;
    this.reloading = false;
    this.qualifyingEvents = 0;
    this.blockchain = blockchain;
    this.rxjsMessageSingleton = new Subject<WasmEvent>();
    this.rxjsEmitter = {
      next: (evt: WasmEvent) => {
        this.rxjsMessageSingleton.next(evt);
      },
    };
    this.walletLedgerUnsubscribe = walletReservationLedger.subscribe(() => {
      if (this.activeFundingAttempt) this.scheduleFundingRequest(this.activeFundingAttempt);
      this.requestCommit();
      this.notifyTerminalFinalizationRetry();
    });
    this.beforeUnloadHandler = () => {
      void this.flushPendingSave().catch((error) => this.reportBackgroundSaveError(error));
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', this.beforeUnloadHandler);
    }
  }

  attachReliableTransport(transport: ReliablePeerTransport): void {
    if (this.reliableTransport === transport) return;
    this.reliableTransport.detachConsumer(this.reliableConsumer);
    this.reliableTransport = transport;
    this.reliableState = transport.state;
    this.reliableTransport.attachConsumer(this.reliableConsumer);
    if (this.transactionCoordinator) {
      this.reliableTransport.attachCommitCoordinator(this.transactionCoordinator);
    }
  }

  attachTransactionCoordinator(lease: SessionRuntimeLease): void {
    if (this.retired) {
      lease.retire();
      return;
    }
    if (this.transactionCoordinator && this.transactionCoordinator !== lease) {
      this.transactionCoordinator.retire();
    }
    this.transactionCoordinator = lease;
    this.reliableTransport.attachCommitCoordinator(lease);
    if (this.activeFundingAttempt) this.scheduleFundingRequest(this.activeFundingAttempt);
    for (const delivery of this.pendingSubmissionDeliveries.values()) {
      this.scheduleSubmissionDelivery(delivery);
    }
    for (const delivery of this.pendingCoinSolutionDeliveries.values()) {
      this.scheduleCoinSolutionDelivery(delivery);
    }
    this.scheduleCancelRequiredEntries();
    this.flushPendingCoinStates();
    if (this.eventQueue.length > 0) lease.requestCommit();
  }

  getCommittedSessionRuntime(): SessionMachineRuntime | null {
    return this.committedSessionRuntime;
  }

  commitSessionRuntime(runtime: SessionMachineRuntime, lease: SessionRuntimeLease): void {
    if (this.retired) {
      runtime.retire();
      return;
    }
    if (this.committedSessionRuntime === runtime) return;
    this.committedSessionRuntime = runtime;
    this.attachTransactionCoordinator(lease);
  }

  detachTransactionCoordinator(lease: SessionRuntimeLease): void {
    if (this.transactionCoordinator !== lease) return;
    this.reliableTransport.detachCommitCoordinator(lease);
    this.transactionCoordinator = null;
  }

  prepareReliableCommit(): PreparedReliableCommit {
    return this.reliableTransport.prepareCommit();
  }

  completeReliableCommit(commit: PreparedReliableCommit, persistenceSucceeded: boolean): void {
    this.reliableTransport.completeCommit(commit, persistenceSucceeded);
  }

  setInboundSessionRejectHandler(
    handler: ((sessionId: string, remoteNumber: bigint) => void) | null,
  ): void {
    this.inboundSessionRejectHandler = handler;
  }

  setInboundSessionRejectPersistence(
    persist: ((sessionId: string, remoteNumber: bigint) => Promise<void>) | null,
  ): void {
    this.persistInboundSessionReject = persist;
  }

  get messageNumber(): bigint {
    return this.reliableState.messageNumber;
  }

  set messageNumber(value: bigint) {
    this.reliableState.messageNumber = value;
  }

  get remoteNumber(): bigint {
    return this.reliableState.remoteNumber;
  }

  set remoteNumber(value: bigint) {
    this.reliableState.remoteNumber = value;
  }

  get unackedMessages(): Array<{ msgno: bigint; msg: Uint8Array }> {
    return this.reliableState.unackedMessages;
  }

  set unackedMessages(value: Array<{ msgno: bigint; msg: Uint8Array }>) {
    this.reliableState.unackedMessages = value;
  }

  private get reorderQueue(): Map<bigint, Uint8Array> {
    return this.reliableTransport.runtime.reorderQueue;
  }

  setReloading() {
    this.reloading = true;
  }

  attachBlockchain(blockchain: BlockchainPoller) {
    if (this.blockchain && this.blockchain !== blockchain) {
      this.blockchain.detachGameSession(this);
      this.blockchainAttached = false;
    }
    this.puzzleSolutionReadinessUnsubscribe?.();
    const readinessUnsubscribe = blockchain.rpc.onPlayReadinessChange((ready) => {
      if (ready) {
        this.syncPendingCoinSolutionRequests();
        this.retryPendingCoinSolutionDeliveries();
      }
    });
    this.puzzleSolutionReadinessUnsubscribe =
      typeof readinessUnsubscribe === 'function' ? readinessUnsubscribe : null;
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
    this.syncPendingCoinSolutionRequests();
    this.retryPendingCoinSolutionDeliveries();
    this.flushPendingCoinStates();
    if (this.transactionCoordinator) {
      this.scheduleCancelRequiredEntries();
    } else {
      walletReservationLedger.retryCancelRequired(this.walletReservationOwner());
    }
    this.notifyTerminalFinalizationRetry();
  }

  detachBlockchain(blockchain: BlockchainPoller) {
    if (this.blockchain !== blockchain) return;
    blockchain.detachGameSession(this);
    this.blockchainAttached = false;
    this.puzzleSolutionReadinessUnsubscribe?.();
    this.puzzleSolutionReadinessUnsubscribe = null;
    this.blockchain = null;
  }

  setPeerKeepalive(sendKeepalive: () => void) {
    this.peerSendKeepalive = sendKeepalive;
    this.startKeepaliveTimer();
  }

  cleanup() {
    this.cleanupInternal();
  }

  cleanupAfterTerminalFlush() {
    this.cleanupInternal();
  }

  private cleanupInternal() {
    if (this.retired) return;
    const retainRejectedTransport = this.reliableState.disposition === 'outbound-reject';
    walletReservationLedger.promoteReservedForOwner(
      this.walletReservationOwner(),
      'session-controller-retired',
    );
    this.retired = true;
    this.activeFundingAttempt = null;
    this.walletLedgerUnsubscribe();
    this.terminalFinalizationRetryListeners.clear();
    this.transactionSubmitQueue.retire();
    for (const delivery of [...this.pendingSubmissionDeliveries.values()]) {
      this.completeSubmissionDelivery(delivery);
    }
    for (const delivery of [...this.pendingCoinSolutionDeliveries.values()]) {
      this.completeCoinSolutionDelivery(delivery);
    }
    this.pendingEffects.clear();
    const runtime = this.committedSessionRuntime;
    this.committedSessionRuntime = null;
    const coordinator = this.transactionCoordinator;
    this.transactionCoordinator = null;
    if (coordinator) this.reliableTransport.detachCommitCoordinator(coordinator);
    runtime?.retire();
    if (!runtime) coordinator?.retire();
    this.cleanShutdownCalled = true;
    // Retirement is not a manager terminal disposition: detach this session
    // without stopping a shared poller, but make any in-flight active drain
    // inert immediately.
    this.protocolStopped = true;
    this.terminalHandoff = null;
    this.eventQueue = [];
    if (!retainRejectedTransport) this.unackedMessages = [];
    this.reorderQueue.clear();
    if (!retainRejectedTransport) this.reliableTransport.clearRuntime();
    this.rxjsMessageSingleton.complete();
    this.blockchain?.detachGameSession(this);
    this.blockchainAttached = false;
    this.puzzleSolutionReadinessUnsubscribe?.();
    this.puzzleSolutionReadinessUnsubscribe = null;
    this.blockchain = null;
    this.persistInboundSessionReject = null;
    this.inboundSessionRejectHandler = null;
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
    this.stopKeepaliveTimer();
    if (this.beforeUnloadHandler && typeof window !== 'undefined') {
      window.removeEventListener('beforeunload', this.beforeUnloadHandler);
      this.beforeUnloadHandler = null;
    }
    const cradle = this.cradle;
    this.cradle = undefined;
    cradle?.dropGameSession?.();
  }

  reportDurabilityError(error: unknown): void {
    const detail = extractErrorMessage(error);
    const warning = `Session storage failed: ${detail}. The session is continuing without a durable checkpoint; progress may be lost if this page closes before storage succeeds.`;
    if (this.durabilityWarning === warning) return;
    this.durabilityWarning = warning;
    this.rxjsEmitter?.next({ type: 'durability-error', error: warning });
  }

  clearDurabilityError(): void {
    this.durabilityWarning = undefined;
    this.notifyTerminalFinalizationRetry();
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

  getGameSessionId(): string {
    return this.reliableState.sessionId;
  }

  isChannelReady(): boolean {
    return this.channelReady;
  }

  private ensureProtocolIdentities(): void {
    if (!this.wc) return;
    try {
      completeRegisteredGames(this.wc);
    } catch (e) {
      const message = extractErrorMessage(e);
      diagStack('completeRegisteredGames failed', e);
      log(`[wasm] completeRegisteredGames failed: ${message}`);
      this.rxjsEmitter?.next({ type: 'error', error: message });
    }
  }

  isOffChainActive(): boolean {
    return this.lastChannelStatus?.state === 'Active';
  }

  restoreChannelStatus(status: ChannelStatusPayload | null): void {
    this.lastChannelStatus = status;
    this.channelReady = status !== null && isActivatedChannelStatus(status.state);
    if (this.channelReady && this.wc) {
      this.ensureProtocolIdentities();
    }
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

  onTerminalFinalizationRetry(listener: () => void): () => void {
    this.terminalFinalizationRetryListeners.add(listener);
    return () => {
      this.terminalFinalizationRetryListeners.delete(listener);
    };
  }

  private notifyTerminalFinalizationRetry(): void {
    for (const listener of this.terminalFinalizationRetryListeners) listener();
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
    if (status === 'restored') this.notifyTerminalFinalizationRetry();
  }

  private syncFeeConfiguration(): void {
    if (!this.cradle) return;
    this.cradle.configure_submission_fee(this.feeProvider().toString());
  }

  spillStoredMessages() {
    if (this.qualifyingEvents != 7 || !this.cradle || this.reloading) {
      return;
    }
    this.reliableTransport.drain();
  }

  setGameSession(cradle: ChiaGame) {
    this.cradle = cradle;
    this.syncFeeConfiguration();
    this.syncPendingCoinSolutionRequests();
    if (this.pendingPeerFailure) {
      this.escalatePeerFailure();
      return;
    }
    const command = cradle.pendingTerminalHandoff();
    this.reconcileTerminalHandoff(command);
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
    const result = this.cradle.start_handshake(this.getFee().toString());
    this.processResult(result);
    this.flushPendingCoinStates();
    this.spillStoredMessages();
  }

  private flushPendingCoinStates() {
    // Poller attachment can precede asynchronous WASM restore. Retain raw
    // observations until setGameSession installs the cradle that consumes them.
    if (!this.cradle || !this.transactionCoordinator) return;
    const observations = this.pendingChainObservations;
    this.pendingChainObservations = [];
    const deliveries: Promise<void>[] = [];
    for (const observation of observations) {
      if (observation.kind === 'coin-states') {
        deliveries.push(this.reportCoinStates(observation.peak, observation.records));
      } else {
        deliveries.push(this.reportNewBlock(observation.peak));
      }
    }
    if (deliveries.length > 0) {
      this.trackEffect(Promise.all(deliveries).then(() => undefined));
    }
  }

  getChannelPuzzleHash(): string | null {
    return this.cradle?.get_channel_puzzle_hash() ?? null;
  }

  private async handleNeedCoinSpend(attempt: ActiveFundingAttempt) {
    const { request } = attempt;
    const owner = this.walletReservationOwner();
    const purpose = this.fundingReservationPurpose(attempt);
    const blockchain = this.blockchain;
    if (!blockchain) {
      const message = 'Blockchain is not connected';
      try {
        await this.runRuntimeMutation(() => {
          this.retireFundingAttempt(attempt);
          this.rxjsEmitter?.next({ type: 'error', error: message });
          if (this.cradle) this.processResultNow(this.cradle.wallet_callback_failed(message));
          this.requestCommit();
        });
      } catch (error) {
        if (!this.retired) this.reportAuthoritativeCompletionError('funding failure', error);
      }
      return;
    }
    try {
      const offerAmount = -BigInt(request.amount);
      const extraConditions = request.conditions.map(({ opcode, args }) => ({
        opcode,
        args: [...args],
      }));
      const coinIds = request.coin_id ? [request.coin_id] : undefined;
      const maxHeight = request.max_height === undefined ? undefined : BigInt(request.max_height);
      const openingFee = BigInt(request.fee);

      const outcome = await walletReservationLedger.createOffer(blockchain.rpc, owner, purpose, {
        kind: 'funding',
        uniqueId: this.uniqueId,
        offer: { '1': offerAmount },
        extraConditions,
        coinIds,
        maxHeight,
        openingFee,
      });
      if (outcome.kind !== 'created') {
        const msg = outcome.reason;
        await this.runRuntimeMutation(() => {
          this.retireFundingAttempt(attempt);
          log(`[wasm] ${msg}`);
          this.rxjsEmitter?.next({ type: 'error', error: msg });
          if (this.cradle) this.processResultNow(this.cradle.wallet_callback_failed(msg));
          this.requestCommit();
        });
        return;
      }

      if (this.activeFundingAttempt !== attempt || this.retired) {
        walletReservationLedger.settleOperation(
          owner,
          purpose,
          'cancel-required',
          'funding-offer-stale',
        );
        return;
      }

      if (outcome.material.kind === 'offer') {
        const offerString = outcome.material.offer;
        log('[wasm] createOfferForIds returned offer string; decoding via bech32 WASM path');
        await this.runRuntimeMutation(() => {
          if (!this.cradle || this.retired) {
            walletReservationLedger.settleOperation(
              owner,
              purpose,
              'cancel-required',
              'funding-cradle-unavailable',
              true,
            );
            this.scheduleCancelRequiredEntries();
            this.retireFundingAttempt(attempt);
            this.requestCommit();
            return;
          }
          try {
            const result = requireWasmResult(this.cradle.provide_offer_bech32(offerString));
            this.processResultNow(result);
            walletReservationLedger.settleOperation(
              owner,
              purpose,
              'consumed',
              'funding-offer-consumed',
              true,
            );
            this.flushDeferredWork();
            this.retireFundingAttempt(attempt);
            this.requestCommit();
          } catch (error) {
            walletReservationLedger.settleOperation(
              owner,
              purpose,
              'cancel-required',
              'funding-offer-rejected',
              true,
            );
            this.scheduleCancelRequiredEntries();
            this.requestCommit();
            throw error;
          }
        });
      } else {
        const bundleJson = jsonStringify(outcome.material.bundle);
        await this.runRuntimeMutation(() => {
          this.retireFundingAttempt(attempt);
          if (this.cradle) {
            this.processResultNow(this.cradle.provide_coin_spend_bundle(bundleJson));
          }
          this.requestCommit();
        });
      }
    } catch (e) {
      diagStack('handleNeedCoinSpend error', e);
      log(`[wasm] handleNeedCoinSpend error: ${String(e)}`);
      let msg = extractErrorMessage(e);
      if (/insufficient funds/i.test(msg)) {
        msg =
          'Wallet reports insufficient funds. It may be that your wallet has enough balance but some coins are locked. Free up locked coins in your wallet and try again.';
      }
      if (e instanceof SessionRuntimeRetiredError && this.retired) return;
      try {
        await this.runRuntimeMutation(() => {
          this.retireFundingAttempt(attempt);
          this.rxjsEmitter?.next({ type: 'error', error: msg });
          if (this.cradle) this.processResultNow(this.cradle.wallet_callback_failed(msg));
          this.requestCommit();
        });
      } catch (completionError) {
        if (!this.retired) {
          this.reportAuthoritativeCompletionError('funding failure callback', completionError);
        }
      }
    }
  }

  private retireFundingAttempt(attempt: ActiveFundingAttempt): void {
    if (this.activeFundingAttempt === attempt) this.activeFundingAttempt = null;
  }

  private queueFundingRequest(request: NeedCoinSpendRequest): void {
    const canonical = canonicalizeFundingRequest(request, 'WASM NeedCoinSpend request');
    const key = fundingRequestKey(canonical);
    this.queueCanonicalFundingRequest(key, canonical);
  }

  private queueCanonicalFundingRequest(key: string, request: CanonicalFundingRequest): void {
    const active = this.activeFundingAttempt;
    if (active) {
      if (active.key === key) return;
      const message = `Internal protocol-state violation: received concurrent funding request ${key} while ${active.key} is active`;
      this.retireFundingAttempt(active);
      if (this.cradle) this.processResult(this.cradle.wallet_callback_failed(message));
      throw new Error(message);
    }
    const attempt: ActiveFundingAttempt = {
      key,
      request,
      launchState: { kind: 'idle' },
    };
    this.activeFundingAttempt = attempt;
    this.scheduleFundingRequest(attempt);
  }

  private scheduleFundingRequest(attempt: ActiveFundingAttempt): void {
    const coordinator = this.transactionCoordinator;
    if (!coordinator || this.activeFundingAttempt !== attempt) return;
    if (
      walletReservationLedger.hasBlockingTradeOperation(
        this.walletReservationOwner(),
        this.fundingReservationPurpose(attempt),
      )
    ) {
      return;
    }
    if (attempt.launchState.kind === 'launched') return;
    if (
      attempt.launchState.kind === 'scheduled' &&
      attempt.launchState.coordinator === coordinator
    ) {
      return;
    }
    attempt.launchState = { kind: 'scheduled', coordinator };
    const effect = coordinator.releaseAfterPersistence(attempt.key, () => {
      if (this.activeFundingAttempt !== attempt) return Promise.resolve();
      attempt.launchState = { kind: 'launched' };
      return this.handleNeedCoinSpend(attempt);
    });
    this.trackEffect(effect);
  }

  restoreFundingOutbox(entries: Array<{ key: string; request: CanonicalFundingRequest }>): void {
    let restoredKey: string | undefined;
    let restoredRequest: CanonicalFundingRequest | undefined;
    for (const entry of entries) {
      const request = decodeCanonicalFundingRequest(entry.request, 'persisted funding request');
      const key = fundingRequestKey(request);
      if (entry.key !== key) {
        throw new Error('Persisted funding outbox key does not match its request');
      }
      if (restoredKey === key) {
        throw new Error(`Persisted funding outbox contains duplicate key ${key}`);
      }
      if (restoredKey !== undefined) {
        throw new Error('Persisted funding outbox contains more than one distinct request');
      }
      restoredKey = key;
      restoredRequest = request;
    }

    const restored =
      restoredKey === undefined || restoredRequest === undefined
        ? null
        : { key: restoredKey, request: restoredRequest, launchState: { kind: 'idle' } as const };
    this.activeFundingAttempt = restored;
    if (restored) this.scheduleFundingRequest(restored);
  }

  private walletReservationOwner(): WalletReservationOwner {
    return {
      installationPlayerId: this.uniqueId,
      peerSessionId: this.reliableState.sessionId,
    };
  }

  private fundingReservationPurpose(attempt: ActiveFundingAttempt): WalletReservationPurpose {
    return { kind: 'funding', operationId: attempt.key };
  }

  private feeReservationPurpose(submission: TransactionSubmission): WalletReservationPurpose {
    return { kind: 'fee', operationId: submission.id };
  }

  private retainedFeeTradeIds(submissionId: string): string[] {
    return walletReservationLedger
      .retainedEntriesForOperation(this.walletReservationOwner(), {
        kind: 'fee',
        operationId: submissionId,
      })
      .map((entry) => entry.tradeId);
  }

  private requestRetainedFeeCancellation(submissionId: string, reason: string): void {
    for (const tradeId of this.retainedFeeTradeIds(submissionId)) {
      if (this.transactionCoordinator) {
        this.requireCancellationCoordinated(tradeId, reason);
      } else {
        walletReservationLedger.requireCancellation(tradeId, reason);
      }
    }
  }

  private requireCancellationCoordinated(tradeId: string, reason: string): void {
    walletReservationLedger.requireCancellationCoordinated(tradeId, reason);
    this.scheduleCancellation(tradeId);
  }

  private scheduleCancellation(tradeId: string): void {
    const lease = this.transactionCoordinator;
    if (!lease) return;
    const effect = lease.releaseAfterPersistence(`wallet-offer-cancellation:${tradeId}`, () =>
      walletReservationLedger.launchCancellation(tradeId),
    );
    this.trackEffect(effect);
  }

  private scheduleCancelRequiredEntries(): void {
    for (const entry of walletReservationLedger.entriesFor(this.walletReservationOwner())) {
      if (entry.stage === 'cancel-required') this.scheduleCancellation(entry.tradeId);
    }
  }

  private handleRetiredSubmissionIds(submissionIds: string[]): void {
    for (const submissionId of submissionIds) {
      this.requestRetainedFeeCancellation(submissionId, 'fee-submission-retired');
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

  private async submitTransactionNow(submission: TransactionSubmission) {
    const blockchain = this.blockchain;
    if (!blockchain) {
      this.deferSubmissionUntilFreshSync();
      this.rxjsEmitter?.next({
        type: 'error',
        error: `Transaction ${submission.id} was deferred because the blockchain adapter is unavailable.`,
      });
      this.requestCommit();
      return;
    }
    try {
      if (!this.rewardPuzzleHash) {
        throw new Error('submitTransactionNow: rewardPuzzleHash is not set');
      }
      let feeSourceJson: string | undefined;
      let feeOfferCreated = false;
      const owner = this.walletReservationOwner();
      const purpose = this.feeReservationPurpose(submission);
      if (submission.fee_request) {
        const { amount, target } = submission.fee_request;
        try {
          const feeSource = await walletReservationLedger.createOffer(
            blockchain.rpc,
            owner,
            purpose,
            {
              kind: 'fee',
              uniqueId: this.uniqueId,
              fee: BigInt(amount),
              concurrentSpendCoinId: target,
            },
          );
          if (feeSource.kind === 'unavailable') {
            await this.runRuntimeMutation(() => {
              log(`[wasm] fee source unavailable id=${submission.id}: ${feeSource.reason}`);
              this.deferSubmissionUntilFreshSync();
              this.requestCommit();
            });
            return;
          } else if (feeSource.kind === 'created') {
            feeOfferCreated = true;
            if (this.retired) {
              walletReservationLedger.settleOperation(
                owner,
                purpose,
                'cancel-required',
                'fee-offer-stale',
              );
              return;
            }
            if (feeSource.material.kind === 'offer') {
              feeSourceJson = jsonStringify({
                kind: 'offer',
                offer: feeSource.material.offer,
              });
            } else {
              feeSourceJson = jsonStringify({
                kind: 'bundle',
                bundle: feeSource.material.bundle,
              });
            }
          } else {
            feeSourceJson = jsonStringify({
              kind: 'failure',
              reason: feeSource.reason,
            });
          }
        } catch (e) {
          feeSourceJson = jsonStringify({ kind: 'failure', reason: extractErrorMessage(e) });
        }
      }
      let completion: Promise<void>;
      let finalizedFeeSourceDisposition: FinalizedSubmission['fee_source_disposition'] | undefined;
      try {
        const finalized = await this.runRuntimeMutation(() => {
          if (!this.cradle) {
            throw new Error('WASM cradle became unavailable before submission finalization');
          }
          const result = this.cradle.finalize_submission(submission.id, feeSourceJson);
          finalizedFeeSourceDisposition = result.fee_source_disposition;
          if (result.fee_source_disposition === 'attached') {
            if (feeOfferCreated) {
              walletReservationLedger.settleOperation(
                owner,
                purpose,
                'retained-for-replay',
                'fee-source-attached',
                true,
              );
            }
          } else if (feeOfferCreated) {
            walletReservationLedger.settleOperation(
              owner,
              purpose,
              'cancel-required',
              'fee-source-unused-at-finalization',
              true,
            );
            this.scheduleCancelRequiredEntries();
          }
          this.requestCommit();
          const broadcast = this.releaseSubmissionEffect(`broadcast:${submission.id}`, () =>
            this.broadcastFinalizedSubmission(submission, result),
          );
          return { broadcast };
        });
        completion = finalized.broadcast;
      } catch (error) {
        if (error instanceof SessionRuntimeRetiredError && this.retired) throw error;
        if (feeOfferCreated && finalizedFeeSourceDisposition !== 'attached') {
          await this.runRuntimeMutation(() => {
            walletReservationLedger.settleOperation(
              owner,
              purpose,
              'cancel-required',
              'fee-finalization-rejected',
              true,
            );
            this.scheduleCancelRequiredEntries();
            this.requestCommit();
          });
        }
        throw error;
      }
      await completion;
    } catch (e) {
      await this.runRuntimeMutation(() => this.recordLocalSubmissionFailure(submission, e));
    }
  }

  private async runRuntimeMutation<T>(work: () => T): Promise<T> {
    let lease = this.transactionCoordinator;
    if (!lease) {
      if (this.retired) throw new SessionRuntimeRetiredError();
      throw new Error('Authoritative runtime mutations require SessionMachineRuntime coordination');
    }
    for (;;) {
      try {
        return await lease.enqueueResult(work);
      } catch (error) {
        if (!(error instanceof SessionRuntimeRetiredError) || this.retired) throw error;
        const replacement = this.transactionCoordinator;
        if (!replacement || replacement === lease) throw error;
        lease = replacement;
      }
    }
  }

  private async releaseSubmissionEffect(key: string, launcher: () => Promise<void>): Promise<void> {
    let lease = this.transactionCoordinator;
    if (!lease) {
      if (this.retired) throw new SessionRuntimeRetiredError();
      throw new Error('Submission effects require SessionMachineRuntime coordination');
    }
    for (;;) {
      let started = false;
      try {
        await lease.releaseAfterPersistence(key, () => {
          started = true;
          return launcher();
        });
        return;
      } catch (error) {
        if (started || !(error instanceof SessionRuntimeRetiredError) || this.retired) throw error;
        const replacement = this.transactionCoordinator;
        if (!replacement || replacement === lease) throw error;
        lease = replacement;
      }
    }
  }

  private releaseAfterPersistence(key: string, launcher: () => Promise<void>): Promise<void> {
    if (!this.transactionCoordinator) {
      throw new Error('External effects require SessionMachineRuntime coordination');
    }
    return this.transactionCoordinator.releaseAfterPersistence(key, launcher);
  }

  private async broadcastFinalizedSubmission(
    submission: TransactionSubmission,
    finalized: FinalizedSubmission,
  ): Promise<void> {
    const blockchain = this.blockchain;
    if (!blockchain || !this.rewardPuzzleHash) {
      throw new Error('Blockchain became unavailable before finalized submission broadcast');
    }
    const blob = spend_bundle_to_clvm(finalized.protocol_bundle);
    const appliedFee = BigInt(finalized.applied_fee);
    log(`[wasm] submitTransaction blobLen=${blob.length}`);
    if (finalized.warning) {
      log(`[wasm] submitTransaction: ${finalized.warning}`);
      this.rxjsEmitter?.next({ type: 'error', error: finalized.warning });
    }
    const outcome = await blockchain.rpc.spend(
      blob,
      finalized.bundle,
      this.rewardPuzzleHash,
      'submitTransaction',
      appliedFee || undefined,
    );
    await this.runRuntimeMutation(() => {
      if (!this.cradle) {
        throw new Error('WASM cradle became unavailable before recording the wallet outcome');
      }
      if (outcome.status === 'acknowledged') {
        this.cradle.acknowledge_submission(submission.id);
        this.requestRetainedFeeCancellation(submission.id, 'fee-wallet-acknowledged');
        this.requestCommit();
        return;
      }
      if (outcome.status === 'unavailable') {
        log(`[wasm] submitTransaction unavailable id=${submission.id}: ${outcome.detail}`);
        this.deferSubmissionUntilFreshSync();
        this.requestCommit();
        return;
      }
      this.cradle.reject_submission(submission.id);
      const drained = this.cradle.drain_submissions();
      this.handleRetiredSubmissionIds(drained.retired_submission_ids);
      this.handleSubmissionDrainFailures(drained.failures);
      for (const queued of drained.submissions) this.submitTransaction(queued);
      this.requestCommit();
      const message = rewriteFeeRateRejection(outcome.detail);
      log(`[wasm] submitTransaction rejected id=${submission.id}: ${message}`);
      this.rxjsEmitter?.next({
        type: 'error',
        error: `Wallet rejected transaction ${submission.id}: ${message}`,
      });
      return;
    });
  }

  private recordLocalSubmissionFailure(submission: TransactionSubmission, error: unknown): void {
    const message = extractErrorMessage(error);
    const coinDescs = (submission.bundle.spends ?? [])
      .map((cs: any) => {
        const coinHex = typeof cs.coin === 'string' ? cs.coin : '';
        return coinHex.length >= 64 ? coinHex.slice(0, 64) : coinHex || 'unknown';
      })
      .join(', ');
    diagStack('submitTransaction failed', error);
    log(`[wasm] submitTransaction failed: ${message} coins=[${coinDescs}]`);
    this.deferSubmissionUntilFreshSync();
    this.rxjsEmitter?.next({
      type: 'error',
      error: `Transaction ${submission.id} was retained for retry after a local submission failure: ${rewriteFeeRateRejection(message)}`,
    });
    this.requestCommit();
  }

  private deferSubmissionUntilFreshSync(): void {
    this.resubmitAfterChainSync = true;
    this.resubmitNeedsCoinSnapshot = this.snapshotWatchedCoins().length > 0;
  }

  private handleSubmissionDrainFailures(failures: readonly SubmissionDrainFailure[]): void {
    for (const failure of failures) {
      const handlingError = new Error(
        `Submission drain failure at candidate ${failure.candidate_index}`,
      );
      const javascriptStack = (handlingError.stack ?? handlingError.message).slice(
        0,
        SUBMISSION_DRAIN_JS_STACK_LIMIT,
      );
      const diagnostic = jsonStringify({
        kind: 'submission-drain-failure',
        failure,
        javascript_stack: javascriptStack,
      });
      this.diagnosticLog = appendRecent(this.diagnosticLog, diagnostic, DIAGNOSTIC_LOG_LIMIT);
      const submissionContext =
        failure.retained_submission_id ?? failure.candidate_submission_id ?? 'unassigned';
      this.rxjsEmitter?.next({
        type: 'recoverable-internal-error',
        error:
          `An internal transaction submission failed during ${failure.stage} ` +
          `(candidate ${failure.candidate_index}, submission ${submissionContext}). ` +
          'The failed item was quarantined; the active game can continue.',
        failure,
      });
    }
  }

  private submitTransaction(submission: TransactionSubmission) {
    if (this.transactionPublishNerfed) return;
    if (this.pendingSubmissionDeliveries.has(submission.id)) {
      log(`[wasm] submitTransaction skipped duplicate queued submission id=${submission.id}`);
      return;
    }
    let complete!: () => void;
    const completion = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const delivery: PendingSubmissionDelivery = {
      submission,
      completion,
      complete,
      state: { kind: 'idle' },
    };
    this.pendingSubmissionDeliveries.set(submission.id, delivery);
    this.trackEffect(completion);
    this.scheduleSubmissionDelivery(delivery);
  }

  private scheduleSubmissionDelivery(delivery: PendingSubmissionDelivery): void {
    const lease = this.transactionCoordinator;
    if (!lease || this.pendingSubmissionDeliveries.get(delivery.submission.id) !== delivery) return;
    if (delivery.state.kind === 'launched') return;
    if (delivery.state.kind === 'scheduled-with-lease' && delivery.state.lease === lease) return;

    delivery.state = { kind: 'scheduled-with-lease', lease };
    let release: Promise<void>;
    try {
      release = lease.releaseAfterPersistence(`submission:${delivery.submission.id}`, () => {
        const scheduled = delivery.state;
        if (
          this.pendingSubmissionDeliveries.get(delivery.submission.id) !== delivery ||
          scheduled.kind !== 'scheduled-with-lease' ||
          scheduled.lease !== lease
        ) {
          return Promise.resolve();
        }
        delivery.state = { kind: 'launched' };
        const queued = this.transactionSubmitQueue.enqueue(async () => {
          if (this.retired) {
            log('[wasm] submitTransaction dropped because controller is retired');
            return;
          }
          if (this.transactionPublishNerfed) {
            log('[wasm] submitTransaction dropped because publishing is nerfed');
            return;
          }
          await this.submitTransactionNow(delivery.submission);
        });
        return queued.then(
          () => this.completeSubmissionDelivery(delivery),
          async (error) => {
            if (this.retired && error instanceof SessionRuntimeRetiredError) return;
            await this.runRuntimeMutation(() =>
              this.recordLocalSubmissionFailure(delivery.submission, error),
            );
            this.completeSubmissionDelivery(delivery);
          },
        );
      });
    } catch (error) {
      this.handleSubmissionReleaseError(delivery, lease, error);
      return;
    }
    void release.catch((error) => this.handleSubmissionReleaseError(delivery, lease, error));
  }

  private handleSubmissionReleaseError(
    delivery: PendingSubmissionDelivery,
    lease: SessionRuntimeLease,
    error: unknown,
  ): void {
    const scheduled = delivery.state;
    if (
      this.pendingSubmissionDeliveries.get(delivery.submission.id) !== delivery ||
      scheduled.kind !== 'scheduled-with-lease' ||
      scheduled.lease !== lease
    ) {
      return;
    }
    if (error instanceof SessionRuntimeRetiredError) {
      delivery.state = { kind: 'idle' };
      if (this.transactionCoordinator !== lease) this.scheduleSubmissionDelivery(delivery);
      return;
    }
    void this.runRuntimeMutation(() =>
      this.recordLocalSubmissionFailure(delivery.submission, error),
    ).then(
      () => this.completeSubmissionDelivery(delivery),
      (recordingError) => {
        if (!this.retired) this.reportRuntimeError(recordingError);
      },
    );
  }

  private completeSubmissionDelivery(delivery: PendingSubmissionDelivery): void {
    if (this.pendingSubmissionDeliveries.get(delivery.submission.id) !== delivery) return;
    this.pendingSubmissionDeliveries.delete(delivery.submission.id);
    delivery.complete();
  }

  /**
   * Drain the transactions the transaction manager captured (intercepted from
   * the cradle) and submit each to the wallet/network.  Called after every
   * action that drains the cradle.
   */
  private drainAndSubmitTransactions() {
    if (!this.cradle || !this.blockchain) return;
    this.syncFeeConfiguration();
    let drained;
    try {
      drained = this.cradle.drain_submissions();
    } catch (e) {
      diagStack('drain_submissions failed', e);
      log(`[wasm] drain_submissions failed: ${String(e)}`);
      return;
    }
    this.handleRetiredSubmissionIds(drained.retired_submission_ids);
    this.handleSubmissionDrainFailures(drained.failures);
    for (const submission of drained.submissions) {
      this.submitTransaction(submission);
    }
  }

  processResult(result: WasmResult | undefined): void {
    if (this.transactionCoordinator) {
      this.transactionCoordinator.enqueue(() => this.processResultNow(result));
      return;
    }
    this.processResultNow(result);
  }

  private enqueueStimulus(work: () => void): void {
    if (this.transactionCoordinator) {
      this.transactionCoordinator.enqueue(work);
    } else {
      work();
    }
  }

  private processResultNow(result: WasmResult | undefined): void {
    this.syncFeeConfiguration();
    result = requireWasmResult(result);
    if (this.protocolStopped) {
      return;
    }
    const disposition = result.disposition;
    const terminal = disposition.kind === 'terminal';
    if (terminal) {
      this.stopProtocolWork();
    }

    const blockchain = this.blockchain;
    if (!terminal) {
      for (const coin of result.watchCoins) {
        blockchain?.watchCoin(this, coin);
      }
      for (const coin of result.unwatchCoins) {
        blockchain?.unwatchCoin(this, coin);
      }
    }
    for (const event of result.events) {
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

  queueHostMessage(
    message: Uint8Array,
    disposition: 'active' | 'outbound-reject' = 'active',
  ): bigint {
    if (this.retired || this.protocolStopped) {
      throw new Error('Cannot queue a host message on a stopped reliable transport');
    }
    return this.reliableTransport.allocateOutbound(message, disposition);
  }

  private assertActionSucceeded(result: WasmResult | undefined, action: string): void {
    const required = requireWasmResult(result);
    if (required.actionSucceeded) return;
    const failed = required.events.find(
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
            events: result.events.filter(
              (event) => !('Notification' in event && event.Notification.ActionFailed),
            ),
          }
        : result;
    this.processResult(processed);
    this.assertActionSucceeded(result, action);
    this.requestCommit();
  }

  private processGameCommandResult(
    result: WasmResult | undefined,
    action: string,
    gameId: string,
    actionKind: 'make_move' | 'accept_settlement' | 'cheat',
  ): GameCommandDisposition {
    const required = requireWasmResult(result);
    const rejected = required.events.some(
      (event) =>
        'Notification' in event &&
        event.Notification.MoveRejected?.id != null &&
        String(event.Notification.MoveRejected.id) === gameId,
    );
    const applied = required.events.some(
      (event) =>
        'Notification' in event &&
        event.Notification.LocalActionApplied?.id != null &&
        String(event.Notification.LocalActionApplied.id) === gameId &&
        event.Notification.LocalActionApplied.action === actionKind,
    );
    this.processCommandResult(required, action);
    return rejected ? 'rejected' : applied ? 'applied' : 'queued';
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
    this.unackedMessages = [];
    this.reorderQueue.clear();
  }

  private scheduleDrain(): void {
    if (this.drainScheduled || this.eventQueue.length === 0) return;
    if (this.transactionCoordinator) {
      this.drainScheduled = true;
      this.transactionCoordinator.requestCommit();
      return;
    }
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
  private drainActiveEventsToQuiescence(eventBudget: number = ACTIVE_DRAIN_EVENT_BUDGET): void {
    let drained = 0;
    try {
      while (
        this.eventQueue.length > 0 &&
        !this.protocolStopped &&
        !this.retired &&
        drained < eventBudget
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
      this.requestCommit();
    }
  }

  flushDeferredWork(): void {
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
    if (this.protocolStopped || this.retired) {
      this.drainScheduled = false;
      while (this.eventQueue.length > 0) {
        this.drainOneEvent();
      }
    } else {
      this.drainActiveEventsToQuiescence(
        Math.max(ACTIVE_DRAIN_EVENT_BUDGET, this.eventQueue.length),
      );
    }
  }

  hasDeferredWork(): boolean {
    return this.eventQueue.length > 0 || this.drainScheduled;
  }

  flushTransactionSubmissions(): Promise<void> {
    return this.transactionSubmitQueue.flush();
  }

  async quiesceForTerminalFinalization(): Promise<TerminalQuiescentSnapshot> {
    const maxPasses = 20;
    const reservationOwner = this.walletReservationOwner();
    this.scheduleCancelRequiredEntries();
    for (let pass = 0; pass < maxPasses; pass += 1) {
      this.flushDeferredWork();
      await this.flushPendingSave();

      await Promise.allSettled([...this.pendingEffects]);
      await this.flushTransactionSubmissions();
      await this.reliableTransport.flushPending();
      await walletReservationLedger.awaitOwner(reservationOwner);

      this.flushDeferredWork();
      await this.flushPendingSave();

      if (
        this.pendingEffects.size === 0 &&
        this.eventQueue.length === 0 &&
        !this.drainScheduled &&
        !this.reliableTransport.hasPendingDurability()
      ) {
        const obligations = walletReservationLedger.entriesFor(reservationOwner);
        if (obligations.length > 0) {
          throw new WalletOfferCleanupPendingError(obligations);
        }
        const lease = this.transactionCoordinator;
        if (!lease) {
          throw new Error(
            'SessionController terminal finalization requires an active runtime lease',
          );
        }
        const model = structuredClone(lease.snapshotModel());
        const coinsOfInterest = structuredClone(this.getCoinsOfInterest());
        if (this.transactionCoordinator !== lease) continue;
        return { model, coinsOfInterest };
      }
    }
    const obligations = walletReservationLedger.entriesFor(reservationOwner);
    if (obligations.length > 0) {
      throw new WalletOfferCleanupPendingError(obligations);
    }
    throw new Error(
      `SessionController terminal quiescence did not settle after ${maxPasses} persistence passes`,
    );
  }

  async flushPendingWork(): Promise<void> {
    if (this.retired) {
      await this.flushTransactionSubmissions();
      return;
    }
    for (let i = 0; i < 100; i += 1) {
      this.flushDeferredWork();
      const effects = [...this.pendingEffects];
      await Promise.allSettled(effects);
      await this.flushTransactionSubmissions();
      await this.reliableTransport.flushPending();
      this.flushDeferredWork();
      if (
        this.pendingEffects.size === 0 &&
        this.eventQueue.length === 0 &&
        !this.drainScheduled &&
        !this.reliableTransport.hasPendingDurability()
      ) {
        return;
      }
    }
    throw new Error('SessionController pending work did not settle');
  }

  restoreTerminalHandoff(binding: SessionTerminalHandoffSave | null): void {
    if (this.cradle) {
      throw new Error('terminal handoff restoration must precede WASM cradle installation');
    }
    if (this.terminalHandoff) {
      if (
        binding &&
        this.terminalHandoff.id === binding.id &&
        this.terminalHandoff.msgno === binding.msgno &&
        this.terminalHandoff.sent === binding.sent &&
        this.terminalHandoff.acknowledged === binding.acknowledged &&
        this.terminalHandoff.message.length === binding.message.length &&
        this.terminalHandoff.message.every((byte, index) => byte === binding.message[index])
      ) {
        return;
      }
      throw new Error('terminal handoff was already restored with different state');
    }
    this.terminalHandoff = binding === null ? null : structuredClone(binding);
  }

  restoreTransportCheckpoint(transport: SessionTransportSave): void {
    if (this.transportCheckpointRestored) return;
    this.messageNumber = transport.messageNumber;
    this.remoteNumber = transport.remoteNumber;
    this.unackedMessages = structuredClone(transport.unackedMessages);
    this.reliableState.disposition = transport.disposition;
    this.restoreTerminalHandoff(transport.terminalHandoff);
    this.transportCheckpointRestored = true;
  }

  private reconcileTerminalHandoff(command: { id: string; message: Uint8Array } | null): void {
    const binding = this.terminalHandoff;
    if (!command) {
      if (binding) {
        throw new Error('persisted terminal handoff has no matching Rust command');
      }
      return;
    }
    if (!binding) {
      this.queueTerminalHandoff(command);
      return;
    }
    if (
      binding.id !== command.id ||
      binding.message.length !== command.message.length ||
      !binding.message.every((byte, index) => byte === command.message[index])
    ) {
      throw new Error('persisted terminal handoff does not match Rust pending command');
    }
    const frame = this.unackedMessages.find(({ msgno }) => msgno === binding.msgno);
    if (binding.acknowledged) {
      if (
        !binding.sent ||
        frame ||
        this.unackedMessages.some(({ msgno }) => msgno < binding.msgno)
      ) {
        throw new Error('persisted acknowledged terminal handoff has inconsistent transport state');
      }
      this.completeOutboundTerminalHandoffAfterAck(binding.id);
      return;
    }
    if (
      !frame ||
      frame.msg.length !== binding.message.length ||
      !frame.msg.every((byte, index) => byte === binding.message[index])
    ) {
      throw new Error('persisted terminal handoff does not match its unacked reliable frame');
    }
  }

  private queueTerminalHandoff(command: { id: string; message: Uint8Array }): void {
    if (this.terminalHandoff) {
      throw new Error('cannot replace a pending terminal handoff command');
    }
    const message = Uint8Array.from(command.message);
    const msgno = this.reliableTransport.allocateOutbound(message);
    this.terminalHandoff = {
      id: command.id,
      message,
      msgno,
      sent: false,
      acknowledged: false,
    };
  }

  private dispatchEvent(event: GameSessionEvent): void {
    if ('OutboundMessage' in event) {
      if (this.protocolStopped || this.onChain) return;
      this.reliableTransport.allocateOutbound(event.OutboundMessage);
    } else if ('Notification' in event) {
      const n = event.Notification;
      let notification = n;
      const tag = typeof n === 'object' && n !== null ? Object.keys(n)[0] : String(n);
      if (n.ChannelStatus !== undefined) {
        const cs = n.ChannelStatus;
        const channelStatus = decodeChannelStatusPayload({
          ...cs,
          coin: coerceToBytes(cs.coin),
        });
        if (channelStatus === null) {
          throw new Error('ChannelStatus notification payload is null');
        }
        this.lastChannelStatus = channelStatus;
        notification = { ChannelStatus: channelStatus };
        if (channelStatus.state === 'Active') {
          this.channelReady = true;
          this.ensureProtocolIdentities();
        }
      }
      if (n.ProposalAcceptedGroup !== undefined) {
        for (const member of n.ProposalAcceptedGroup.members) {
          const acceptedId = String(member.id);
          if (!this.activeGameIds.includes(acceptedId)) {
            this.activeGameIds.push(acceptedId);
          }
        }
      }
      if (n.GameStatus !== undefined) {
        const gs = n.GameStatus;
        if (gs.status.startsWith('ended-')) {
          const endedId = gs.id != null ? String(gs.id) : null;
          this.activeGameIds = this.activeGameIds.filter((id) => id !== endedId);
        }
      }
      if (n.GameSettled !== undefined) {
        const settledId = String(n.GameSettled.id);
        this.activeGameIds = this.activeGameIds.filter((id) => id !== settledId);
      }
      this.wasmNotificationHistory = appendRecent(
        this.wasmNotificationHistory,
        jsonStringify(notification),
        WASM_NOTIFICATION_HISTORY_LIMIT,
      );
      if (tag === 'ProposalMade' && !proposalMadeAdmitted(notification)) {
        this.ensureProtocolIdentities();
      }
      if (tag !== 'ProposalMade' || proposalMadeAdmitted(notification)) {
        this.rxjsEmitter?.next({ type: 'notification', data: notification });
      } else {
        this.rxjsEmitter?.next({
          type: 'error',
          error: 'ProposalMade names an unregistered game protocol identity',
        });
      }
    } else if ('ReceiveError' in event) {
      this.rxjsEmitter?.next({ type: 'error', error: event.ReceiveError });
    } else if ('CoinSolutionRequest' in event) {
      this.queueCoinSolutionRequest(event.CoinSolutionRequest);
    } else if ('Log' in event) {
      this.diagnosticLog = appendRecent(this.diagnosticLog, event.Log, DIAGNOSTIC_LOG_LIMIT);
      this.rxjsEmitter?.next({ type: 'log', message: event.Log });
    } else if ('NeedCoinSpend' in event) {
      this.queueFundingRequest(event.NeedCoinSpend);
    } else {
      const keys = Object.keys(event as object);
      throw new Error(`unknown GameSessionEvent: ${keys.join(',') || '(empty)'}`);
    }
  }

  private trackEffect(effect: Promise<void>): void {
    const tracked = effect
      .then(
        () => {},
        () => {},
      )
      .finally(() => {
        this.pendingEffects.delete(tracked);
      });
    this.pendingEffects.add(tracked);
  }

  private queueCoinSolutionRequest(coin: string): void {
    if (this.retired || this.protocolStopped || this.pendingCoinSolutionDeliveries.has(coin))
      return;
    let complete!: () => void;
    const completion = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const delivery: PendingCoinSolutionDelivery = {
      coin,
      completion,
      complete,
      state: { kind: 'idle' },
    };
    this.pendingCoinSolutionDeliveries.set(coin, delivery);
    this.trackEffect(completion);
    this.scheduleCoinSolutionDelivery(delivery);
  }

  private syncPendingCoinSolutionRequests(): void {
    for (const coin of this.cradle?.snapshot_pending_coin_solution_requests?.() ?? []) {
      this.queueCoinSolutionRequest(coin);
    }
  }

  private retryPendingCoinSolutionDeliveries(): void {
    for (const delivery of this.pendingCoinSolutionDeliveries.values()) {
      if (delivery.state.kind === 'idle') this.scheduleCoinSolutionDelivery(delivery);
    }
  }

  private scheduleCoinSolutionDelivery(delivery: PendingCoinSolutionDelivery): void {
    const lease = this.transactionCoordinator;
    if (
      !lease ||
      !this.blockchain ||
      this.pendingCoinSolutionDeliveries.get(delivery.coin) !== delivery
    ) {
      return;
    }
    if (delivery.state.kind === 'launched' || delivery.state.kind === 'blocked') return;
    if (delivery.state.kind === 'scheduled-with-lease' && delivery.state.lease === lease) return;

    delivery.state = { kind: 'scheduled-with-lease', lease };
    let release: Promise<void>;
    try {
      release = lease.releaseAfterPersistence(`coin-solution:${delivery.coin}`, async () => {
        const scheduled = delivery.state;
        if (
          this.pendingCoinSolutionDeliveries.get(delivery.coin) !== delivery ||
          scheduled.kind !== 'scheduled-with-lease' ||
          scheduled.lease !== lease
        ) {
          return;
        }
        delivery.state = { kind: 'launched' };
        await this.fetchAndDeliverCoinSolution(delivery);
      });
    } catch (error) {
      this.handleCoinSolutionReleaseError(delivery, lease, error);
      return;
    }
    void release.catch((error) => this.handleCoinSolutionReleaseError(delivery, lease, error));
  }

  private handleCoinSolutionReleaseError(
    delivery: PendingCoinSolutionDelivery,
    lease: SessionRuntimeLease,
    error: unknown,
  ): void {
    const scheduled = delivery.state;
    if (
      this.pendingCoinSolutionDeliveries.get(delivery.coin) !== delivery ||
      scheduled.kind !== 'scheduled-with-lease' ||
      scheduled.lease !== lease
    ) {
      return;
    }
    if (error instanceof SessionRuntimeRetiredError) {
      delivery.state = { kind: 'idle' };
      if (this.transactionCoordinator !== lease) this.scheduleCoinSolutionDelivery(delivery);
      return;
    }
    delivery.state = { kind: 'idle' };
    this.reportCoinSolutionError(delivery.coin, error);
  }

  private async fetchAndDeliverCoinSolution(delivery: PendingCoinSolutionDelivery): Promise<void> {
    const blockchain = this.blockchain;
    if (!blockchain) {
      delivery.state = { kind: 'idle' };
      return;
    }
    let puzzleAndSolution: string[] | null;
    try {
      puzzleAndSolution = await blockchain.rpc.getPuzzleAndSolution(delivery.coin);
    } catch (error) {
      if (this.pendingCoinSolutionDeliveries.get(delivery.coin) === delivery) {
        delivery.state = { kind: 'idle' };
      }
      this.reportCoinSolutionError(delivery.coin, error);
      return;
    }
    if (this.retired || this.pendingCoinSolutionDeliveries.get(delivery.coin) !== delivery) return;

    try {
      await this.runRuntimeMutation(() => {
        if (!this.cradle) {
          throw new Error('WASM cradle became unavailable before puzzle/solution completion');
        }
        const result = puzzleAndSolution
          ? this.cradle.report_puzzle_and_solution(
              delivery.coin,
              puzzleAndSolution[0],
              puzzleAndSolution[1],
            )
          : this.cradle.report_puzzle_and_solution(delivery.coin, undefined, undefined);
        this.processResultNow(result);
        const required = requireWasmResult(result);
        if (!required.actionSucceeded) {
          const failed = required.events.find(
            (event) =>
              'Notification' in event &&
              event.Notification.ActionFailed &&
              typeof event.Notification.ActionFailed.reason === 'string',
          );
          const reason =
            failed && 'Notification' in failed
              ? failed.Notification.ActionFailed?.reason
              : undefined;
          throw new CoinSolutionCallbackRejectedError(reason);
        }
        this.requestCommit();
      });
      this.completeCoinSolutionDelivery(delivery);
    } catch (error) {
      if (this.pendingCoinSolutionDeliveries.get(delivery.coin) !== delivery) return;
      if (error instanceof CoinSolutionCallbackRejectedError) {
        delivery.state = { kind: 'blocked' };
        delivery.complete();
      } else {
        delivery.state = { kind: 'idle' };
      }
      this.reportCoinSolutionError(delivery.coin, error);
    }
  }

  private completeCoinSolutionDelivery(delivery: PendingCoinSolutionDelivery): void {
    if (this.pendingCoinSolutionDeliveries.get(delivery.coin) !== delivery) return;
    this.pendingCoinSolutionDeliveries.delete(delivery.coin);
    delivery.complete();
  }

  private reportCoinSolutionError(coin: string, error: unknown): void {
    diagStack(`puzzle/solution delivery failed coin=${coin}`, error);
    log(`[wasm] puzzle/solution delivery failed coin=${coin}: ${String(error)}`);
    this.rxjsEmitter?.next({ type: 'error', error: extractErrorMessage(error) });
  }

  // --- Inbound events ---

  deliverMessage(msgno: bigint, msg: Uint8Array) {
    this.notePeerActivity();
    this.reliableTransport.receiveData(msgno, msg);
  }

  failPeerProcessing(reason: string): void {
    if (this.retired || this.pendingPeerFailure) return;
    this.pendingPeerFailure = reason;
    this.reorderQueue.clear();
    log(`[peer-policy] ${reason}`);
    this.rxjsEmitter?.next({ type: 'error', error: reason });
    this.escalatePeerFailure();
  }

  private escalatePeerFailure(): void {
    if (!this.pendingPeerFailure || !this.cradle) return;
    this.goOnChain('peer-failure');
  }

  private deliverOrderedMessage(_msgno: bigint, msg: Uint8Array): void {
    if (this.protocolStopped || this.onChain) return;
    let semantic = null;
    try {
      semantic = decodePeerAppMessage(msg);
    } catch {}
    if (semantic?.type === 'session_reject') {
      if (this.channelReady) {
        this.failPeerProcessing('session_reject received after channel establishment');
        return;
      }
      this.inboundSessionRejected = true;
      this.reliableState.disposition = 'inbound-reject';
      this.reliableTransport.discardOutbound();
      return;
    }
    const result = this.cradle!.deliver_message(msg);
    this.processResult(result);
  }

  private notifyInboundSessionRejectCommitted(): void {
    if (!this.inboundSessionRejectCommitted) return;
    this.inboundSessionRejectCommitted = false;
    const handler = this.inboundSessionRejectHandler;
    this.inboundSessionRejectHandler = null;
    handler?.(this.reliableState.sessionId, this.reliableState.remoteNumber);
  }

  receiveAck(ackMsgno: bigint) {
    if (this.retired) return;
    this.notePeerActivity();
    this.reliableTransport.receiveAck(ackMsgno);
  }

  private handleReliableAcknowledgement(ackMsgno: bigint): void {
    const terminalCommand = this.terminalHandoff;
    const terminalAcknowledged =
      terminalCommand && terminalCommand.sent && ackMsgno >= terminalCommand.msgno;
    if (terminalAcknowledged) {
      this.terminalHandoff = { ...terminalCommand, acknowledged: true };
      this.completeOutboundTerminalHandoffAfterAck(terminalCommand.id);
    }
  }

  resendUnacked(): boolean {
    if (this.protocolStopped) return false;
    return this.reliableTransport.replayUnacked();
  }

  // --- PollingGameSession: driven by the BlockchainPoller ---

  snapshotWatchedCoins(): Array<{ coin_name: string; coin_string: string }> {
    if (!this.cradle) return [];
    return this.cradle.snapshot_watched_coins();
  }

  async reportCoinStates(peak: bigint, records: CoinStateRecord[]): Promise<void> {
    if (this.retired) return;
    if (!this.cradle || !this.transactionCoordinator) {
      this.pendingChainObservations.push({ kind: 'coin-states', peak, records });
      return;
    }
    try {
      await this.runRuntimeMutation(() => this.deliverCoinStates(peak, records));
    } catch (error) {
      if (!this.retired) this.reportAuthoritativeCompletionError('coin snapshot', error);
      throw error;
    }
  }

  async reportNewBlock(peak: bigint): Promise<void> {
    if (this.retired) return;
    if (!this.cradle || !this.transactionCoordinator) {
      this.pendingChainObservations.push({ kind: 'height', peak });
      return;
    }
    try {
      await this.runRuntimeMutation(() => this.deliverHeight(peak));
    } catch (error) {
      if (!this.retired) this.reportAuthoritativeCompletionError('block height', error);
      throw error;
    }
  }

  private deliverHeight(peak: bigint) {
    log(`[wasm] height-only observation height=${peak}`);
    if (!this.cradle) {
      throw new Error('deliverHeight called without cradle');
    }
    this.processResultNow(this.cradle.report_height(peak));
    this.retryPendingCoinSolutionDeliveries();
    if (this.resubmitNeedsCoinSnapshot === false) this.resubmitAfterFreshChainSync();
  }

  private deliverCoinStates(peak: bigint, records: CoinStateRecord[]) {
    log(`[wasm] coin states height=${peak} coins=${records.length}`);
    if (!this.cradle) {
      throw new Error('deliverCoinStates called without cradle');
    }
    const result = this.cradle.report_coin_states(peak, records);
    this.processResultNow(result);
    this.retryPendingCoinSolutionDeliveries();
    this.resubmitNeedsCoinSnapshot = false;
    this.resubmitAfterFreshChainSync();
  }

  private resubmitAfterFreshChainSync() {
    if (!this.resubmitAfterChainSync || this.protocolStopped || !this.cradle) return;
    if (this.blockchain?.rpc.isReadyForPlay?.() === false) return;
    this.resubmitAfterChainSync = false;
    this.cradle.resubmit_submitted();
    this.drainAndSubmitTransactions();
  }

  // --- Persistence ---

  private requestCommit(): void {
    this.transactionCoordinator?.requestCommit();
  }

  restorePresentationTiming(
    timing: Pick<WasmFields, 'waitingStateEnteredAt' | 'cleanShutdownGraceStartedAt'>,
  ): void {
    this.waitingStateEnteredAt = timing.waitingStateEnteredAt;
    this.cleanShutdownGraceStartedAt = timing.cleanShutdownGraceStartedAt;
  }

  setPresentationTiming(
    timing: Partial<Pick<WasmFields, 'waitingStateEnteredAt' | 'cleanShutdownGraceStartedAt'>>,
  ): void {
    this.enqueueStimulus(() => {
      if (timing.waitingStateEnteredAt !== undefined) {
        this.waitingStateEnteredAt = timing.waitingStateEnteredAt;
      }
      if (timing.cleanShutdownGraceStartedAt !== undefined) {
        this.cleanShutdownGraceStartedAt = timing.cleanShutdownGraceStartedAt;
      }
      this.requestCommit();
    });
  }

  async flushPendingSave(): Promise<void> {
    if (this.transactionCoordinator) {
      await this.transactionCoordinator.flush();
      return;
    }
    // Rust intentionally omits transient cradle events from serialization.
    // Move every event into its durable JS representation (message counters,
    // unacked messages, notifications) before taking the lifecycle snapshot.
    this.flushDeferredWork();
    if (this.reliableTransport.hasPendingDurability()) {
      await this.reliableTransport.flushPending();
    }
  }

  prepareInboundSessionRejectPersistence(): { write(): Promise<void> } | null {
    if (!this.inboundSessionRejected) return null;
    const persist = this.persistInboundSessionReject;
    const sessionId = this.reliableState.sessionId;
    const remoteNumber = this.reliableState.remoteNumber;
    return {
      write: async () => {
        if (persist) {
          await persist(sessionId, remoteNumber);
        } else {
          await clearSession();
        }
        this.inboundSessionRejectCommitted = true;
      },
    };
  }

  private completeOutboundTerminalHandoffAfterAck(commandId: string): void {
    if (this.terminalHandoff?.id !== commandId) return;
    if (!this.cradle) {
      this.requestCommit();
      return;
    }
    try {
      const result = this.cradle.completeOutboundTerminalHandoff();
      if (result.disposition.kind !== 'terminal') {
        throw new Error('cooperative terminal handoff did not produce a terminal result');
      }
      this.processResult(result);
      this.terminalHandoff = null;
    } catch (error) {
      const message = extractErrorMessage(error);
      diagStack('complete terminal handoff failed', error);
      this.rxjsEmitter?.next({ type: 'error', error: message });
      this.requestCommit();
    }
  }

  private noteTerminalHandoffSent(msgno: bigint): void {
    if (this.terminalHandoff?.msgno === msgno) {
      this.terminalHandoff = { ...this.terminalHandoff, sent: true };
      this.requestCommit();
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
      gameSessionId: this.reliableState.sessionId,
      messageNumber: this.messageNumber,
      remoteNumber: this.remoteNumber,
      iStarted: this.iStarted,
      myContribution: this.myContribution.toString(),
      theirContribution: this.theirContribution.toString(),
      perGameAmount: this.perGameAmount.toString(),
      rewardPuzzleHash: this.rewardPuzzleHash,
      unackedMessages: [...this.unackedMessages],
      terminalHandoff: this.terminalHandoff === null ? null : structuredClone(this.terminalHandoff),
      wasmNotificationHistory: recentEntries(
        this.wasmNotificationHistory,
        WASM_NOTIFICATION_HISTORY_LIMIT,
      ),
      diagnosticLog: recentEntries(this.diagnosticLog, DIAGNOSTIC_LOG_LIMIT),
      durabilityWarning: this.durabilityWarning,
      fundingOutbox: this.activeFundingAttempt
        ? [
            {
              key: this.activeFundingAttempt.key,
              request: canonicalizeFundingRequest(this.activeFundingAttempt.request),
            },
          ]
        : [],
      transportDisposition: this.reliableState.disposition ?? 'active',
      activeGameIds: [...this.activeGameIds],
      channelStatus: this.lastChannelStatus,
      myAlias: this.myAlias,
      opponentAlias: this.opponentAlias,
      waitingStateEnteredAt: this.waitingStateEnteredAt,
      cleanShutdownGraceStartedAt: this.cleanShutdownGraceStartedAt,
    };
  }

  getCoinsOfInterest(): CoinOfInterestEntry[] {
    if (!this.cradle) return [];
    return this.cradle.coins_of_interest();
  }

  private reportAuthoritativeCompletionError(label: string, error: unknown): void {
    diagStack(`${label} completion failed`, error);
    log(`[wasm] ${label} completion failed: ${String(error)}`);
    this.reportRuntimeError(error);
  }

  reportRuntimeError(error: unknown): void {
    markClientErrorReported(error);
    this.rxjsEmitter?.next({ type: 'error', error: extractErrorMessage(error) });
  }

  /**
   * Game IDs and hand state are host-side presentation state. An abandoned
   * session has no per-game terminal events to retire them individually.
   */
  clearDerivedGamePresentation(): void {
    this.activeGameIds = [];
    this.requestCommit();
  }

  // --- Game actions (called by higher layer) ---

  proposeGame(params: ProposeGameParams): string {
    if (!this.cradle) throw new Error('no cradle');
    if (!this.wc) throw new Error('no wasm');
    const result = this.cradle.propose(params);
    this.processCommandResult(result, 'propose game');
    const scalarId = (result as typeof result & { id?: string }).id;
    if (scalarId !== undefined) return scalarId;
    if (result?.ids?.length !== 1) {
      throw new Error('propose game returned no scalar local proposal id');
    }
    return result.ids[0]!;
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

  makeMove(gameId: string, readable: Program | null): GameCommandDisposition {
    if (!this.cradle) throw new Error('no cradle');
    try {
      const bytes = clvmToBytes(readable);
      const result = this.cradle.make_move(gameId, bytes);
      return this.processGameCommandResult(result, 'make move', gameId, 'make_move');
    } catch (e) {
      const msg = extractErrorMessage(e);
      console.error('[wasm] makeMove failed:', msg);
      markClientErrorReported(e);
      this.rxjsEmitter?.next({
        type: 'game-action-error',
        gameId,
        action: 'make-move',
        error: msg,
      });
      throw e;
    }
  }

  acceptSettlement(gameId: string): GameCommandDisposition {
    if (!this.cradle) throw new Error('no cradle');
    try {
      const result = this.cradle.acceptSettlement(gameId);
      return this.processGameCommandResult(
        result,
        'accept settlement',
        gameId,
        'accept_settlement',
      );
    } catch (e) {
      const msg = extractErrorMessage(e);
      console.error('[wasm] acceptSettlement failed:', msg);
      markClientErrorReported(e);
      this.rxjsEmitter?.next({
        type: 'game-action-error',
        gameId,
        action: 'accept-settlement',
        error: msg,
      });
      throw e;
    }
  }

  cheat(gameId: string, moverShare: bigint): GameCommandDisposition {
    if (!this.cradle) throw new Error('no cradle');
    try {
      const result = this.cradle.cheat(gameId, moverShare);
      return this.processGameCommandResult(result, 'cheat', gameId, 'cheat');
    } catch (e) {
      const msg = extractErrorMessage(e);
      console.error('[wasm] cheat failed:', msg);
      markClientErrorReported(e);
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

  goOnChain(origin: 'dashboard' | 'peer-failure' | 'hub-remap' | 'direct' = 'direct'): boolean {
    if (!this.cradle) throw new Error('no cradle');
    this.goOnChainSequence += 1;
    log(
      `[wasm] goOnChain invoked sequence=${this.goOnChainSequence} origin=${origin} alreadyOnChain=${this.onChain}`,
    );
    try {
      const result = this.cradle.go_on_chain();
      const startedOnChain = result.actionSucceeded && result.disposition.kind === 'active';
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
