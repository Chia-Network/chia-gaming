import { SessionRuntimeRetiredError } from './sessionMachineTypes';
import { Program } from 'clvm-lib';
import { type SessionWallet, type SessionFunding } from '../wallet/sessionWallet';
import { type RehydratedDurableApplicationState } from './persistence';
import {
  type SessionFrontend,
  type SessionFrontendEvent,
  type SessionPresentation,
} from './sessionFrontend';
import { MIN_NONZERO_FEE_MOJOS } from '../../constants/fees';
import { diagStack, log } from '../../services/log';
import {
  ReliablePeerTransport,
  type PreparedReliableCommit,
  type ReliableMessageConsumer,
  type ReliableCommitCoordinator,
} from '../../services/PeerSession';
import {
  type ChannelStatusPayload,
  ChiaGame,
  CoinOfInterestEntry,
  CoinStateRecord,
  GameSessionEvent,
  NeedCoinSpendRequest,
  PeerConnectionResult,
  ProposeGameParams,
  SubmissionDrainFailure,
  TransactionSubmission,
  WalletOfferCompletion,
  WalletProviderScope,
  WasmConnection,
  WasmEvent,
  WasmNotification,
  WasmResult,
  requireWasmResult,
} from '../../types/ChiaGaming';
import { coerceToBytes } from '../../util';
import { jsonStringify } from '../../util/jsonSafe';
import { markClientErrorReported, wasClientErrorReported } from '../clientError';
import {
  protocolIdForCatalog,
  catalogGameTypeFromWire,
  completeRegisteredGames,
} from '../gameIdentities';
import { PollingGameSession } from '../wallet/BlockchainPoller';
import {
  entryForOperation,
  providerRequestFromRecovery,
  restoredFundingForSink,
  walletSessionKey,
} from './channelFundingSelectors';
import {
  type ChannelFundingOwner,
  type ChannelFundingPurpose,
  channelFundingKey,
} from './channelFundingStore';
import {
  canonicalizeFundingRequest,
  fundingRequestKey,
  type CanonicalFundingRequest,
} from './fundingRequest';
import {
  WASM_NOTIFICATION_HISTORY_LIMIT,
  appendDiagnosticEntry,
  appendRecent,
  recentDiagnosticEntries,
  recentEntries,
} from './historyLimits';
import { StorageAuthorityLostError, StorageAuthorityRequiredError } from './indexedDb';
import { validateChannelStatus } from './persistencePayloads';
import { providerScopeKey, type ProviderOwner } from './providerKeys';
import { DEFAULT_SESSION_RECEIVE_POLICY, type ReadonlySessionReceivePolicy } from './receivePolicy';
import { type SessionTerminalHandoffSave, type SessionTransportSave } from './saveEnvelope';
import { storageRepository } from './storageRepository';
import { SubmissionPump } from './submissionPump';
import { type SessionModel, type RegisteredGameType } from './types';
import { cancelRetiredWalletReservations } from './walletReservationRetirement';
import { type GameIntent, type GameActionRejection } from '@games/host';
import {
  DEFAULT_CATALOG_GAME_TYPE,
  packageFor,
  restoreRegisteredGameHandState,
  snapshotRegisteredGameHand,
  type RegisteredGameHand,
} from '../gameRegistry';
import { coinIdHex, dispatchWasmNotification } from './gameSessionEvents';
import {
  createComposeDraftState,
  createSessionModel,
  DEFAULT_GAME_TIMEOUT_BLOCKS,
  selectSessionPhase,
  type HandProposal,
} from './model';
import { createSessionMachineState, reduceSessionMachine } from './sessionMachine';
import { type ActiveGameHandContext } from './sessionMachineGame';
import { buildDurableApplicationState } from './sessionMachinePersist';
import {
  type LocalGameCommand,
  type SessionControllerCommand,
  type SessionMachineEffect,
  type LocalGameActionRequest,
  type SessionMachineEvent,
  type SessionMachineState,
} from './sessionMachineTypes';

export type GameCommandDisposition = GameActionRejection | 'queued' | 'applied';

export interface TerminalQuiescentSnapshot {
  model: SessionModel;
  coinsOfInterest: CoinOfInterestEntry[];
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
  transportDisposition: 'active' | 'proposal-received' | 'outbound-reject' | 'inbound-reject';
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

type CoinSolutionDeliveryState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'scheduled' }
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

export class SessionController implements PollingGameSession, ReliableCommitCoordinator {
  myContribution: bigint;
  theirContribution: bigint;
  perGameAmount: bigint;
  rewardPuzzleHash: string | null;
  wc: WasmConnection | undefined;
  private peerSendKeepalive: (() => void) | null = null;
  private transactionPublishNerfed = false;
  private lastPeerMessageTime: number = Date.now();
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  readonly reliableTransport: ReliablePeerTransport;
  private readonly reliableConsumer: ReliableMessageConsumer;
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
  private blockchain: SessionWallet | null;
  private blockchainAttached = false;
  private eventQueue: GameSessionEvent[] = [];
  private pendingChainObservations: Array<
    | { kind: 'coin-states'; peak: bigint; records: CoinStateRecord[] }
    | { kind: 'height'; peak: bigint }
    | { kind: 'snapshot-ready'; peak: bigint }
  > = [];
  wasmNotificationHistory: string[] = [];
  diagnosticLog: string[] = [];
  private readonly receivePolicy: ReadonlySessionReceivePolicy;
  private pendingPeerFailure: string | null = null;
  private restoreStatus: RestoreStatus = 'idle';
  private restoreError: string | null = null;
  private restorePromise: Promise<void> | null = null;
  private terminalSealed = false;
  private readonly submissionPump: SubmissionPump;
  private readonly pendingCoinSolutionDeliveries = new Map<string, PendingCoinSolutionDelivery>();
  private puzzleSolutionReadinessUnsubscribe: (() => void) | null = null;
  private goOnChainSequence = 0;
  private beforeUnloadHandler: (() => void) | null = null;
  private pendingEffects = new Set<Promise<void>>();
  private pendingFunding: {
    owner: ChannelFundingOwner | null;
    purpose: ChannelFundingPurpose;
    request: CanonicalFundingRequest;
    effect?: Promise<void>;
    materialReady?: boolean;
  } | null = null;
  private fundingInFlight: NonNullable<SessionController['pendingFunding']> | null = null;
  private fundingEffectSequence = 0;
  private channelFundingUnsubscribe: (() => void) | null = null;
  private fundingRuntime: SessionFunding | null;
  private walletProviderScope: WalletProviderScope | null = null;
  private protocolStopped = false;
  private retired = false;
  private transportCheckpointRestored = false;
  lastChannelStatus: ChannelStatusPayload | null = null;
  myAlias: string | undefined = undefined;
  opponentAlias: string | undefined = undefined;
  private durabilityFailureReported = false;
  private waitingStateEnteredAt: bigint | null = null;
  private cleanShutdownGraceStartedAt: bigint | null = null;
  private feeProvider: () => bigint = () => 0n;
  private state: SessionMachineState = createSessionMachineState(createSessionModel());
  private published: SessionPresentation;
  private readonly frontendListeners = new Set<(event: SessionFrontendEvent) => void>();
  readonly frontend: SessionFrontend = {
    snapshot: () => this.published,
    subscribe: (listener) => {
      this.frontendListeners.add(listener);
      return () => {
        this.frontendListeners.delete(listener);
      };
    },
    dispatch: (intent) => this.dispatch(intent),
    game: {
      isChannelReady: () => this.published.channelReady,
      dispatch: (intent) => this.dispatchGameIntent(intent),
    },
  };
  private restoring = false;
  private activeHand: RegisteredGameHand | null = null;
  private readonly activeHandContext: ActiveGameHandContext = {
    create: (gameType, init) => {
      this.activeHand = packageFor(gameType).createHand(init);
      return snapshotRegisteredGameHand(gameType, this.activeHand);
    },
    receive: (update) => {
      this.requireActiveHand().receive(update);
      return this.snapshotActiveHand();
    },
    clear: () => {
      this.activeHand = null;
    },
  };
  private draining = false;
  private readonly pendingEvents: SessionMachineEvent[] = [];
  private readonly pendingControllerWork: PendingControllerWork[] = [];
  private readonly pendingExternalEffects = new Map<string, PendingExternalEffect>();
  private committing = false;
  private durabilityDirty = false;
  private durabilityDegraded = false;
  private projectionPending = false;
  private projecting = false;
  private cancelCommitTask: (() => void) | null = null;
  private commitPromise: Promise<void> = Promise.resolve();
  private detachStorageRuntime: (() => void) | null = null;
  private activated = false;
  private persistenceActivated = false;
  private executionRetired = false;
  private readonly frontendEvents: SessionFrontendEvent[] = [];
  private publishingFrontend = false;

  private get reliableState() {
    return this.reliableTransport.state;
  }

  get getFee(): () => bigint {
    return this.feeProvider;
  }

  set getFee(provider: () => bigint) {
    this.feeProvider = provider;
    this.syncFeeConfiguration();
  }

  constructor(
    blockchain: SessionWallet | null,
    uniqueId: string,
    myContribution: bigint,
    theirContribution: bigint,
    peer_conn: PeerConnectionResult,
    fundingRuntime: SessionFunding | null = blockchain?.channelFundingRuntime ?? null,
    walletProviderScope?: WalletProviderScope,
  ) {
    const { sendMessage, sendAck } = peer_conn;
    this.receivePolicy = peer_conn.receivePolicy ?? DEFAULT_SESSION_RECEIVE_POLICY;
    const reliableState =
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
            reliableState,
            this.receivePolicy,
            (msgno, body) => sendMessage(Number(msgno), body),
            (msgno) => sendAck(Number(msgno)),
          );
    this.persistInboundSessionReject = peer_conn.persistInboundSessionReject ?? null;
    this.inboundSessionRejectHandler = peer_conn.onSessionReject ?? null;
    this.reliableConsumer = {
      mode: 'channel',
      isReady: () =>
        !!this.wc &&
        !!this.cradle &&
        this.qualifyingEvents === 7 &&
        !this.reloading &&
        !this.pendingPeerFailure &&
        !this.retired,
      deliver: () => {
        throw new Error('accepted session leaked a peer message to TypeScript');
      },
      channelResult: (result) => this.processResult(result),
      error: (reason) => {
        this.receiveEvent({ type: 'error', error: reason });
        this.requestCommit();
      },
      persist: () =>
        Promise.reject(
          new Error('Active-session persistence requires session execution coordination'),
        ),
      failure: (reason) => this.failPeerProcessing(reason),
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
    this.fundingRuntime = fundingRuntime;
    if (walletProviderScope) {
      this.walletProviderScope = structuredClone(walletProviderScope);
    } else {
      this.walletProviderScope =
        blockchain?.resolveProviderOwner(this.walletProviderOwnerSelector())?.providerScope ?? null;
    }
    this.submissionPump = new SubmissionPump({
      getCradle: () => this.cradle,
      getBlockchain: () => this.blockchain,
      getRewardPuzzleHash: () => this.rewardPuzzleHash,
      getWalletOwner: () => this.currentProviderOwner(),
      getInstallationPlayerId: () => this.uniqueId,
      isRetired: () => this.retired,
      isPublishingDisabled: () => this.transactionPublishNerfed,
      enqueueResult: (work) => this.enqueueResult(work),
      releaseAfterPersistence: (key, launcher) => this.releaseAfterPersistence(key, launcher),
      requestCommit: () => this.requestCommit(),
      reportWarning: (message) => {
        log(`[wasm] submitTransaction: ${message}`);
        this.receiveEvent({ type: 'error', error: rewriteFeeRateRejection(message) });
      },
      reportLocalFailure: (submission, error) =>
        this.recordLocalSubmissionFailure(submission, error),
      reportError: (error) => this.reportRuntimeError(error),
      requestFreshSync: () => this.requestFreshChainSnapshot(),
    });
    this.submissionPump.providerReady(blockchain?.rpc.isReadyForPlay?.() !== false && !!blockchain);
    this.published = this.presentation(this.state);
    this.subscribeFundingRuntime();
    this.beforeUnloadHandler = () => {
      void this.flushPendingSave().catch((error) => this.reportBackgroundSaveError(error));
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', this.beforeUnloadHandler);
    }
  }

  private activateExecutionPersistence(): void {
    if (!this.executionActive || this.persistenceActivated || !this.getWasmFields()) return;
    this.activatePersistence();
    this.reliableTransport.attachCommitCoordinator(this);
    this.scheduleFunding();
    for (const delivery of this.pendingCoinSolutionDeliveries.values())
      this.scheduleCoinSolutionDelivery(delivery);
    this.flushPendingCoinStates();
    if (this.eventQueue.length > 0) this.requestCommit();
  }

  private requireFundingRuntime(): SessionFunding {
    if (!this.fundingRuntime) {
      throw new Error('Channel funding coordinator is unavailable');
    }
    return this.fundingRuntime;
  }

  private queueFunding(request: NeedCoinSpendRequest): void {
    const canonical = canonicalizeFundingRequest(request, 'WASM NeedCoinSpend request');
    const purpose = { kind: 'funding' as const, operationId: fundingRequestKey(canonical) };
    if (
      this.pendingFunding?.purpose.operationId !== undefined &&
      this.pendingFunding.purpose.operationId !== purpose.operationId
    ) {
      const message = `Internal protocol-state violation: received concurrent funding request ${purpose.operationId} while ${this.pendingFunding.purpose.operationId} is active`;
      this.pendingFunding = null;
      if (this.cradle) this.processResultNow(this.cradle.wallet_callback_failed(message));
      throw new Error(message);
    }
    this.pendingFunding ??= { owner: null, purpose, request: canonical };
    this.scheduleFunding();
  }

  private scheduleFunding(): void {
    if (
      !this.fundingRuntime ||
      !this.executionActive ||
      !this.blockchain ||
      !this.cradle ||
      this.retired
    )
      return;
    if (!this.pendingFunding) {
      const restored = restoredFundingForSink(
        storageRepository.channelFundingOperations(),
        walletSessionKey(this.uniqueId, this.reliableState.sessionId),
      );
      if (restored) {
        this.pendingFunding = {
          owner: restored.owner,
          purpose: restored.purpose,
          request: restored.request.canonical,
        };
      }
    }
    let pending = this.pendingFunding;
    if (!pending) return;
    const connected = this.currentProviderOwnerForRead();
    // Completed material belongs to this session even if its wallet disconnects
    // while authoritative delivery is queued behind a checkpoint.
    const awaitingChannel =
      this.fundingInFlight === pending &&
      pending.owner &&
      entryForOperation(
        storageRepository.channelFundingOperations(),
        pending.owner,
        pending.purpose,
      )?.stage === 'awaiting-channel';
    if (
      !pending.materialReady &&
      !awaitingChannel &&
      pending.owner &&
      connected &&
      providerScopeKey(pending.owner.providerScope) !== providerScopeKey(connected.providerScope)
    ) {
      this.requireFundingRuntime().supersedeOperation(pending.owner, pending.purpose);
      const key = channelFundingKey(pending.owner, pending.purpose);
      const entries = storageRepository.channelFundingOperations();
      const superseded = entries.filter(
        (entry) => channelFundingKey(entry.owner, entry.purpose) === key,
      );
      storageRepository.replaceChannelFunding(
        entries.filter((entry) => channelFundingKey(entry.owner, entry.purpose) !== key),
      );
      cancelRetiredWalletReservations(superseded);
      if (pending.effect) this.pendingEffects.delete(pending.effect);
      pending = { owner: connected, purpose: pending.purpose, request: pending.request };
      this.pendingFunding = pending;
    }
    if (this.fundingInFlight === pending || pending.effect) return;
    if (
      !pending.owner ||
      !entryForOperation(
        storageRepository.channelFundingOperations(),
        pending.owner,
        pending.purpose,
      )
    ) {
      pending.owner = this.currentProviderOwnerForRead();
    }
    if (!pending.owner) return;
    if (
      !this.fundingRuntime.providerScopeKeys().has(providerScopeKey(pending.owner.providerScope))
    ) {
      return;
    }
    const operation = entryForOperation(
      storageRepository.channelFundingOperations(),
      pending.owner,
      pending.purpose,
    );
    if (operation && operation.stage !== 'creating' && operation.stage !== 'awaiting-channel') {
      return;
    }
    const generation = storageRepository.lifecycleGeneration;
    const effect = this.releaseAfterPersistence(
      `funding:${pending.purpose.operationId}:${++this.fundingEffectSequence}`,
      async () => {
        if (!storageRepository.isGenerationCurrent(generation) || this.pendingFunding !== pending)
          return;
        this.fundingInFlight = pending;
        try {
          const recovery = { kind: 'funding' as const, canonical: pending.request };
          const outcome = await this.requireFundingRuntime().createOffer(
            pending.owner!,
            pending.purpose,
            providerRequestFromRecovery(pending.owner!, recovery),
            recovery,
            () => this.retired || this.pendingFunding !== pending,
          );
          await this.handleFundingOutcome(pending, outcome, generation);
        } finally {
          if (this.fundingInFlight === pending) this.fundingInFlight = null;
        }
      },
    );
    pending.effect = this.trackEffect(effect);
    void pending.effect.finally(() => {
      pending.effect = undefined;
    });
  }

  private async handleFundingOutcome(
    pending: NonNullable<SessionController['pendingFunding']>,
    outcome: WalletOfferCompletion,
    generation: number,
  ): Promise<void> {
    if (this.pendingFunding !== pending) return;
    if (outcome.kind === 'unavailable') {
      this.requestCommit();
      return;
    }
    if (outcome.kind === 'failure') {
      await this.enqueueResult(() => {
        if (
          this.pendingFunding !== pending ||
          this.retired ||
          !storageRepository.isGenerationCurrent(generation)
        )
          return;
        this.pendingFunding = null;
        this.reportFundingWarning(outcome.reason);
        if (this.cradle) this.processResultNow(this.cradle.wallet_callback_failed(outcome.reason));
        this.requestCommit();
      });
      return;
    }
    const current = entryForOperation(
      storageRepository.channelFundingOperations(),
      pending.owner!,
      pending.purpose,
    );
    if (
      outcome.kind === 'created-reserved' &&
      current &&
      current.stage !== 'awaiting-channel' &&
      current.stage !== 'creating' &&
      current.stage !== 'best-effort-uncertain'
    ) {
      this.pendingFunding = null;
      this.requestCommit();
      return;
    }
    if (!storageRepository.isGenerationCurrent(generation)) {
      if (outcome.kind === 'created-reserved') {
        this.requireFundingRuntime().cancelIdentifiedReservation(outcome.tradeId);
      }
      this.pendingFunding = null;
      this.requestCommit();
      return;
    }
    if (this.retired) {
      this.pendingFunding = null;
      this.requestCommit();
      return;
    }
    pending.materialReady = true;
    await this.enqueueResult(() => {
      if (
        this.pendingFunding !== pending ||
        this.retired ||
        !storageRepository.isGenerationCurrent(generation)
      )
        return;
      try {
        if (outcome.warning) this.reportFundingWarning(outcome.warning);
        if (!this.cradle) {
          throw new Error('WASM cradle is unavailable for funding completion');
        }
        let result: WasmResult;
        try {
          result =
            outcome.material.kind === 'offer'
              ? this.cradle.provide_offer_bech32(outcome.material.offer)
              : this.cradle.provide_coin_spend_bundle(outcome.material.bundle);
        } catch (error) {
          const message = extractErrorMessage(error);
          diagStack('handleNeedCoinSpend error', error);
          if (outcome.kind === 'created-reserved') {
            this.requireFundingRuntime().cancelIdentifiedReservation(outcome.tradeId);
          }
          this.reportFundingWarning(message);
          this.processResultNow(this.cradle.wallet_callback_failed(message));
          return;
        }
        try {
          this.processResultNow(requireWasmResult(result));
          if (outcome.material.kind === 'offer') this.flushDeferredWork();
        } catch (error) {
          this.reportAuthoritativeCompletionError('funding material', error);
          throw error;
        }
      } finally {
        if (this.pendingFunding === pending) this.pendingFunding = null;
        this.requestCommit();
      }
    });
  }

  private reportFundingWarning(message: string): void {
    log(`[wasm] ${message}`);
    this.receiveEvent({ type: 'error', error: message });
  }

  private subscribeFundingRuntime(): void {
    if (!this.fundingRuntime || this.channelFundingUnsubscribe) return;
    this.channelFundingUnsubscribe = this.fundingRuntime.subscribe(() => {
      this.requestCommit();
      this.scheduleFunding();
      this.notifyTerminalFinalizationRetry();
    });
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

  get remoteNumber(): bigint {
    return this.reliableState.remoteNumber;
  }

  get unackedMessages(): Array<{ msgno: bigint; msg: Uint8Array }> {
    return this.reliableState.unackedMessages;
  }

  setReloading() {
    this.reloading = true;
  }

  attachBlockchain(blockchain: SessionWallet) {
    if (this.blockchain && this.blockchain !== blockchain) {
      this.blockchain.detachGameSession(this);
      this.blockchainAttached = false;
    }
    this.puzzleSolutionReadinessUnsubscribe?.();
    const alreadyAttached = this.blockchain === blockchain && this.blockchainAttached;
    this.blockchain = blockchain;
    const owner = this.currentProviderOwner();
    if (owner) storageRepository.setWalletContext(owner.providerScope);
    this.submissionPump.providerReady(blockchain.rpc.isReadyForPlay?.() !== false);
    if (!this.fundingRuntime) {
      this.fundingRuntime = blockchain.channelFundingRuntime;
      this.subscribeFundingRuntime();
      this.scheduleFunding();
    } else if (this.fundingRuntime !== blockchain.channelFundingRuntime) {
      throw new Error('Blockchain attachment uses another channel funding coordinator');
    }
    this.scheduleFunding();
    if (alreadyAttached) {
      blockchain.updateCoinInterest(this);
    } else {
      blockchain.attachGameSession(this);
      this.blockchainAttached = true;
    }
    this.syncPendingCoinSolutionRequests();
    this.retryPendingCoinSolutionDeliveries();
    this.flushPendingCoinStates();
    const readinessUnsubscribe = blockchain.onSessionReadiness(
      this.walletProviderOwnerSelector(),
      (ready) => {
        this.submissionPump.providerReady(ready);
        if (ready) {
          this.syncPendingCoinSolutionRequests();
          this.retryPendingCoinSolutionDeliveries();
          this.requestFeeUpgrades();
        }
      },
    );
    this.puzzleSolutionReadinessUnsubscribe =
      typeof readinessUnsubscribe === 'function' ? readinessUnsubscribe : null;
    if (blockchain.resolveProviderOwner(this.walletProviderOwnerSelector()))
      this.requestFeeUpgrades();
    this.notifyTerminalFinalizationRetry();
  }

  detachBlockchain(blockchain: SessionWallet) {
    if (this.blockchain !== blockchain) return;
    blockchain.detachGameSession(this);
    this.blockchainAttached = false;
    this.puzzleSolutionReadinessUnsubscribe?.();
    this.puzzleSolutionReadinessUnsubscribe = null;
    this.blockchain = null;
    this.submissionPump.providerReady(false);
  }

  setPeerKeepalive(sendKeepalive: () => void) {
    this.peerSendKeepalive = sendKeepalive;
    this.startKeepaliveTimer();
  }

  cleanup() {
    if (this.retired) return;
    this.pendingFunding = null;
    this.retired = true;
    this.channelFundingUnsubscribe?.();
    this.channelFundingUnsubscribe = null;
    this.submissionPump.retireAll();
    for (const delivery of [...this.pendingCoinSolutionDeliveries.values()]) {
      this.completeCoinSolutionDelivery(delivery);
    }
    this.pendingEffects.clear();
    if (this.persistenceActivated) this.reliableTransport.detachCommitCoordinator(this);
    this.retireExecution();
    this.cleanShutdownCalled = true;
    // Retirement is not a manager terminal disposition: detach this session
    // without stopping a shared poller, but make any in-flight active drain
    // inert immediately.
    this.protocolStopped = true;
    this.eventQueue = [];
    this.reliableTransport.clearRuntime(true);
    this.blockchain?.detachGameSession(this);
    this.blockchainAttached = false;
    this.puzzleSolutionReadinessUnsubscribe?.();
    this.puzzleSolutionReadinessUnsubscribe = null;
    this.blockchain = null;
    this.persistInboundSessionReject = null;
    this.inboundSessionRejectHandler = null;
    this.stopKeepaliveTimer();
    if (this.beforeUnloadHandler && typeof window !== 'undefined') {
      window.removeEventListener('beforeunload', this.beforeUnloadHandler);
      this.beforeUnloadHandler = null;
    }
    this.cradle = undefined;
  }

  reportDurabilityError(error: unknown): void {
    if (this.durabilityFailureReported) return;
    this.durabilityFailureReported = true;
    const detail = extractErrorMessage(error);
    const warning = `Session storage failed: ${detail}. The session is continuing without a durable checkpoint; progress may be lost if this page closes before storage succeeds.`;
    this.receiveEvent({ type: 'durability-error', error: warning });
  }

  clearDurabilityError(): void {
    this.durabilityFailureReported = false;
  }

  private reportBackgroundSaveError(error: unknown): void {
    this.reportDurabilityError(error);
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
      this.sendPeerKeepalive();
    }, KEEPALIVE_INTERVAL_MS);
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();
    this.keepaliveTimer = timer;
  }

  sendPeerKeepalive(): void {
    // The hub's server heartbeat also calls this, so background timer
    // throttling cannot make an otherwise responsive peer appear stuck.
    // Once the signed close is ready, only chain confirmation remains. Keep
    // reliable close-message delivery and acknowledgements independent of this.
    if (
      this.keepaliveTimer !== null &&
      this.lastChannelStatus?.state !== 'ShutdownTransactionPending'
    )
      this.peerSendKeepalive?.();
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
      this.receiveEvent({ type: 'error', error: message });
    }
  }

  isOffChainActive(): boolean {
    return this.lastChannelStatus?.state === 'Active';
  }

  restoreChannelStatus(status: ChannelStatusPayload | null): void {
    this.lastChannelStatus = status;
    this.channelReady = status !== null && isActivatedChannelStatus(status.state);
    if (this.executionActive) this.publishReadiness(this.channelReady);
    if (this.channelReady && this.wc) {
      this.ensureProtocolIdentities();
    }
  }

  getRestoreStatus(): RestoreStatus {
    return this.restoreStatus;
  }

  getRestoreError(): string | null {
    return this.restoreError;
  }

  private notifyTerminalFinalizationRetry(): void {
    if (this.executionActive) this.publishFrontend({ type: 'terminal-retry' });
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
        this.receiveEvent({ type: 'error', error: msg });
        throw e;
      });
    return this.restorePromise;
  }

  private setRestoreStatus(status: RestoreStatus, error: string | null) {
    this.restoreStatus = status;
    this.restoreError = error;
    if (this.executionActive) this.dispatchHostProjection();
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
    this.reliableTransport.consumerReady();
  }

  setGameSession(cradle: ChiaGame) {
    this.cradle = cradle;
    this.activateExecutionPersistence();
    this.syncFeeConfiguration();
    this.syncPendingCoinSolutionRequests();
    if (this.pendingPeerFailure) {
      this.escalatePeerFailure();
      return;
    }
    this.blockchain?.updateCoinInterest(this);
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
    if (!this.cradle || !this.executionActive) return;
    const observations = this.pendingChainObservations;
    this.pendingChainObservations = [];
    const deliveries: Promise<void>[] = [];
    for (const observation of observations) {
      if (observation.kind === 'coin-states') {
        deliveries.push(this.reportCoinStates(observation.peak, observation.records));
      } else if (observation.kind === 'height') {
        deliveries.push(this.reportNewBlock(observation.peak));
      } else {
        deliveries.push(this.reportChainSnapshotReady(observation.peak));
      }
    }
    if (deliveries.length > 0) {
      this.trackEffect(Promise.all(deliveries).then(() => undefined));
    }
  }

  getChannelPuzzleHash(): string | null {
    return this.cradle?.get_channel_puzzle_hash() ?? null;
  }

  private currentProviderOwner(): ProviderOwner | null {
    const connected =
      this.blockchain?.resolveProviderOwner(this.walletProviderOwnerSelector()) ?? null;
    if (connected) this.walletProviderScope = structuredClone(connected.providerScope);
    if (!this.walletProviderScope) return null;
    return {
      ...this.walletProviderOwnerSelector(),
      providerScope: structuredClone(this.walletProviderScope),
    };
  }

  getWalletProviderScope(): WalletProviderScope {
    const owner = this.currentProviderOwner();
    if (!owner) throw new Error('Wallet provider account scope is unavailable');
    return structuredClone(owner.providerScope);
  }

  private walletProviderOwnerSelector(): Pick<
    ProviderOwner,
    'installationPlayerId' | 'peerSessionId'
  > {
    return {
      installationPlayerId: this.uniqueId,
      peerSessionId: this.reliableState.sessionId,
    };
  }

  private currentProviderOwnerForRead(): ProviderOwner | null {
    const owner = this.currentProviderOwner();
    if (
      !owner &&
      [...storageRepository.channelFundingOperations(), ...storageRepository.feeAttachments()].some(
        (entry) =>
          entry.owner.installationPlayerId === this.uniqueId &&
          entry.owner.peerSessionId === this.reliableState.sessionId,
      )
    ) {
      throw new Error('Wallet provider account scope is unavailable for durable wallet recovery');
    }
    return owner;
  }

  private providerOwner(): ProviderOwner {
    const owner = this.currentProviderOwner();
    if (!owner) throw new Error('Wallet provider account scope is unavailable');
    return owner;
  }

  private handleRetiredSubmissionIds(submissionIds: string[]): void {
    for (const submissionId of submissionIds) {
      this.submissionPump.retire(submissionId);
    }
  }

  emitRewardAddress() {
    if (!this.rewardPuzzleHash) {
      throw new Error('emitRewardAddress: rewardPuzzleHash is not set');
    }
    this.receiveEvent({ type: 'address', data: { puzzleHash: this.rewardPuzzleHash } });
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

  private recordLocalSubmissionFailure(submission: TransactionSubmission, error: unknown): void {
    this.cradle?.submission_attempt_unavailable(submission.attempt_token);
    const message = extractErrorMessage(error);
    const coinDescs = (submission.bundle.spends ?? [])
      .map((cs: any) => {
        const coinHex = typeof cs.coin === 'string' ? cs.coin : '';
        return coinHex.length >= 64 ? coinHex.slice(0, 64) : coinHex || 'unknown';
      })
      .join(', ');
    diagStack('submitTransaction failed', error);
    log(`[wasm] submitTransaction failed: ${message} coins=[${coinDescs}]`);
    this.receiveEvent({
      type: 'error',
      error: `Transaction ${submission.id} was retained for retry after a local submission failure: ${rewriteFeeRateRejection(message)}`,
    });
    this.requestCommit();
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
      this.diagnosticLog = appendDiagnosticEntry(
        this.diagnosticLog,
        jsonStringify({
          kind: 'submission-drain-failure',
          failure,
          javascript_stack: javascriptStack,
        }),
      );
      const submissionContext =
        failure.retained_submission_id ?? failure.candidate_submission_id ?? 'unassigned';
      this.receiveEvent({
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
    this.submissionPump.submit(submission);
  }

  private requestFreshChainSnapshot(): void {
    if (!this.blockchain || !this.cradle || this.protocolStopped) return;
    this.blockchain.updateCoinInterest(this);
  }

  /**
   * Drain the transactions the transaction manager captured (intercepted from
   * the cradle) and submit each to the wallet/network.  Called after every
   * action that drains the cradle.
   */
  private drainAndSubmitTransactions() {
    if (!this.cradle) return;
    this.syncFeeConfiguration();
    const drained = this.cradle.drain_submissions();
    for (const submission of drained.submissions) {
      this.submitTransaction(submission);
    }
    this.handleRetiredSubmissionIds(drained.retired_submission_ids);
    this.handleSubmissionDrainFailures(drained.failures);
  }

  processResult(result: WasmResult | undefined): void {
    if (this.executionRetired) return;
    if (this.executionActive) {
      this.enqueue(() => this.processResultNow(result));
      return;
    }
    this.processResultNow(result);
  }

  private enqueueStimulus(work: () => void): void {
    if (this.executionRetired) return;
    if (this.executionActive) {
      this.enqueue(work);
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
      blockchain?.updateCoinInterest(this, result);
    }
    for (const event of result.events) {
      if (!terminal || this.isTerminalPresentationEvent(event)) {
        this.eventQueue.push(event);
      }
    }

    // A terminal manager drain can still contain already-queued on-chain
    // submissions (for example a mature timeout claim). Actual abandonment
    // clears that queue in Rust before it reaches this boundary.
    this.drainAndSubmitTransactions();
    if (terminal) {
      this.flushDeferredWork();
      return;
    }
    if (this.eventQueue.length > 0 || this.reliableTransport.hasPendingDurability())
      this.requestCommit();
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
    const rejection = required.events.find(
      (event) => 'Notification' in event && String(event.Notification.MoveRejected?.id) === gameId,
    );
    const rejected =
      rejection && 'Notification' in rejection ? rejection.Notification.MoveRejected : undefined;
    const applied = required.events.some(
      (event) =>
        'Notification' in event &&
        String(event.Notification.LocalActionApplied?.id) === gameId &&
        event.Notification.LocalActionApplied?.action === actionKind,
    );
    // Immediate validation failures belong to the calling game UI, not the shared banner.
    this.processCommandResult(
      rejected
        ? { ...required, events: required.events.filter((event) => event !== rejection) }
        : required,
      action,
    );
    return rejected
      ? { tag: rejected.tag, message: rejected.message }
      : applied
        ? 'applied'
        : 'queued';
  }

  private isTerminalPresentationEvent(event: GameSessionEvent): boolean {
    return (
      'Notification' in event ||
      'Log' in event ||
      'ReceiveError' in event ||
      'ChannelCoinConfirmed' in event ||
      'ChannelCreationTimedOut' in event
    );
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
    this.blockchain?.pauseChainPolling();
    this.stopKeepaliveTimer();
    // A terminal drain is a replacement boundary, not an append-only update:
    // stale status/protocol work must not render after it. Per-game terminal
    // facts from an earlier manager drain remain authoritative, however, and
    // may be the only terminal notification emitted for that accepted game.
    this.eventQueue = this.eventQueue.filter((event) => this.isQueuedGameTerminalEvent(event));
  }

  flushDeferredWork(eventBudget = Number.POSITIVE_INFINITY): void {
    let drained = 0;
    while (this.eventQueue.length > 0 && !this.retired && drained < eventBudget) {
      this.drainOneEvent();
      drained += 1;
    }
  }

  private drainOneEvent(): void {
    const event = this.eventQueue.shift();
    if (!event) return;
    try {
      this.dispatchEvent(event);
    } catch (e) {
      diagStack('dispatchEvent error', e);
      this.receiveEvent({ type: 'error', error: extractErrorMessage(e) });
    }
    if (!this.retired) {
      this.requestCommit();
    }
  }

  hasDeferredWork(): boolean {
    return this.eventQueue.length > 0;
  }

  flushTransactionSubmissions(): Promise<void> {
    return this.submissionPump.flush();
  }

  async quiesceAndSealForTerminalFinalization(): Promise<TerminalQuiescentSnapshot> {
    const maxPasses = 20;
    let checkpointFailed = false;
    const flushCheckpoint = async (): Promise<void> => {
      if (checkpointFailed) return;
      try {
        await this.flush();
      } catch (error) {
        if (
          error instanceof StorageAuthorityLostError ||
          error instanceof StorageAuthorityRequiredError
        ) {
          throw error;
        }
        checkpointFailed = true;
      }
    };
    for (let pass = 0; pass < maxPasses; pass += 1) {
      if (!this.executionActive) {
        throw new Error('SessionController terminal finalization requires an active runtime');
      }
      await flushCheckpoint();

      await Promise.allSettled([...this.pendingEffects]);
      await this.flushTransactionSubmissions();
      await flushCheckpoint();

      if (
        this.pendingEffects.size === 0 &&
        this.submissionPump.isQuiescent() &&
        this.eventQueue.length === 0 &&
        (checkpointFailed || !this.reliableTransport.hasPendingDurability())
      ) {
        const model = this.snapshotModel();
        const coinsOfInterest = structuredClone(this.getCoinsOfInterest());
        if (!this.persistenceActivated) {
          throw new Error(
            'SessionController terminal persistence sealing requires an active runtime',
          );
        }
        storageRepository.retireSessionWalletReservations(this.reliableState.sessionId);
        this.terminalSealed = true;
        this.reliableTransport.detachCommitCoordinator(this);
        this.retireExecution();
        return { model, coinsOfInterest };
      }
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
      await (this.executionActive ? this.flush() : Promise.resolve());
      const effects = [...this.pendingEffects];
      await Promise.allSettled(effects);
      await this.flushTransactionSubmissions();
      await (this.executionActive ? this.flush() : Promise.resolve());
      if (
        this.pendingEffects.size === 0 &&
        this.submissionPump.isQuiescent() &&
        this.eventQueue.length === 0 &&
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
    this.reliableTransport.restore(this.reliableState, binding);
  }

  restoreTransportCheckpoint(transport: SessionTransportSave): void {
    if (this.transportCheckpointRestored) return;
    this.reliableTransport.restore({
      sessionId: this.reliableState.sessionId,
      messageNumber: transport.messageNumber,
      remoteNumber: transport.remoteNumber,
      unackedMessages: transport.unackedMessages,
      disposition: transport.disposition,
    });
    this.restoreTerminalHandoff(transport.terminalHandoff);
    this.transportCheckpointRestored = true;
  }

  private dispatchEvent(event: GameSessionEvent): void {
    if ('Notification' in event) {
      const n = event.Notification;
      let notification = n;
      const tag = typeof n === 'object' && n !== null ? Object.keys(n)[0] : String(n);
      if (n.ChannelStatus !== undefined) {
        const cs = n.ChannelStatus;
        const channelStatus = validateChannelStatus({
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
          if (this.executionActive) this.publishReadiness(true);
          this.ensureProtocolIdentities();
        }
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
        this.receiveEvent({ type: 'notification', data: notification });
      } else {
        this.receiveEvent({
          type: 'error',
          error: 'ProposalMade names an unregistered game protocol identity',
        });
      }
    } else if ('ReceiveError' in event) {
      this.receiveEvent({ type: 'error', error: event.ReceiveError });
    } else if ('CoinSolutionRequest' in event) {
      this.queueCoinSolutionRequest(event.CoinSolutionRequest);
    } else if ('Log' in event) {
      this.diagnosticLog = appendDiagnosticEntry(this.diagnosticLog, event.Log);
      this.receiveEvent({ type: 'log', message: event.Log });
    } else if ('NeedCoinSpend' in event) {
      this.queueFunding(event.NeedCoinSpend);
    } else if ('ChannelCoinConfirmed' in event) {
      this.pendingFunding = null;
      this.requireFundingRuntime().channelCoinConfirmed(
        this.uniqueId,
        this.reliableState.sessionId,
      );
    } else if ('ChannelCreationTimedOut' in event) {
      this.pendingFunding = null;
      const warning = this.requireFundingRuntime().channelCreationTimedOut(
        this.uniqueId,
        this.reliableState.sessionId,
      );
      if (warning) this.reportFundingWarning(warning);
    } else {
      const keys = Object.keys(event as object);
      throw new Error(`unknown GameSessionEvent: ${keys.join(',') || '(empty)'}`);
    }
  }

  private trackEffect(effect: Promise<void>): Promise<void> {
    const tracked = effect
      .then(
        () => {},
        () => {},
      )
      .finally(() => {
        this.pendingEffects.delete(tracked);
      });
    this.pendingEffects.add(tracked);
    return tracked;
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
    if (
      !this.executionActive ||
      !this.blockchain ||
      this.pendingCoinSolutionDeliveries.get(delivery.coin) !== delivery
    ) {
      return;
    }
    if (delivery.state.kind === 'launched' || delivery.state.kind === 'blocked') return;
    if (delivery.state.kind === 'scheduled') return;

    delivery.state = { kind: 'scheduled' };
    const release = this.releaseAfterPersistence(`coin-solution:${delivery.coin}`, async () => {
      if (
        this.pendingCoinSolutionDeliveries.get(delivery.coin) !== delivery ||
        delivery.state.kind !== 'scheduled'
      )
        return;
      delivery.state = { kind: 'launched' };
      await this.fetchAndDeliverCoinSolution(delivery);
    });
    void release.catch((error) => this.handleCoinSolutionReleaseError(delivery, error));
  }

  private handleCoinSolutionReleaseError(
    delivery: PendingCoinSolutionDelivery,
    error: unknown,
  ): void {
    if (
      this.pendingCoinSolutionDeliveries.get(delivery.coin) !== delivery ||
      delivery.state.kind !== 'scheduled'
    ) {
      return;
    }
    delivery.state = { kind: 'idle' };
    if (error instanceof SessionRuntimeRetiredError && this.retired) return;
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
      await this.enqueueResult(() => {
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
    this.receiveEvent({ type: 'error', error: extractErrorMessage(error) });
  }

  // --- Inbound events ---

  deliverMessage(msgno: bigint, msg: Uint8Array) {
    this.notePeerActivity();
    this.reliableTransport.receiveData(msgno, msg);
  }

  failPeerProcessing(reason: string): void {
    if (this.retired || this.pendingPeerFailure) return;
    this.pendingPeerFailure = reason;
    this.reliableTransport.reportFailure(reason);
    log(`[peer-policy] ${reason}`);
    this.receiveEvent({ type: 'error', error: reason });
    this.escalatePeerFailure();
  }

  private escalatePeerFailure(): void {
    if (!this.pendingPeerFailure || !this.cradle) return;
    this.goOnChain('peer-failure');
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

  reportPeerConnectivity(event: 'registered' | 'peer-available'): boolean {
    if (this.protocolStopped) return false;
    return this.reliableTransport.connectivity(event);
  }

  getPeerProtocol() {
    return this.reliableTransport.protocol;
  }

  isRetired(): boolean {
    return this.retired;
  }

  // --- PollingGameSession: driven by the BlockchainPoller ---

  snapshotWatchedCoins(): Array<{ coin_name: string; coin_string: string }> {
    if (!this.cradle) return [];
    return this.cradle.snapshot_watched_coins();
  }

  async reportCoinStates(peak: bigint, records: CoinStateRecord[]): Promise<void> {
    if (this.executionRetired) return;
    if (!this.cradle || !this.executionActive) {
      this.pendingChainObservations.push({ kind: 'coin-states', peak, records });
      return;
    }
    try {
      await this.enqueueResult(() => this.deliverCoinStates(peak, records));
    } catch (error) {
      if (!this.retired) this.reportAuthoritativeCompletionError('coin snapshot', error);
      throw error;
    }
  }

  async reportNewBlock(peak: bigint): Promise<void> {
    if (this.executionRetired) return;
    if (!this.cradle || !this.executionActive) {
      this.pendingChainObservations.push({ kind: 'height', peak });
      return;
    }
    try {
      await this.enqueueResult(() => this.deliverHeight(peak));
    } catch (error) {
      if (!this.retired) this.reportAuthoritativeCompletionError('block height', error);
      throw error;
    }
  }

  async reportChainSnapshotReady(peak: bigint): Promise<void> {
    if (this.executionRetired) return;
    if (!this.cradle || !this.executionActive) {
      this.pendingChainObservations.push({ kind: 'snapshot-ready', peak });
      return;
    }
    try {
      await this.enqueueResult(() => this.deliverChainSnapshotReady(peak));
    } catch (error) {
      if (!this.retired) this.reportAuthoritativeCompletionError('chain snapshot ready', error);
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
  }

  private deliverCoinStates(peak: bigint, records: CoinStateRecord[]) {
    log(`[wasm] coin states height=${peak} coins=${records.length}`);
    if (!this.cradle) {
      throw new Error('deliverCoinStates called without cradle');
    }
    const result = this.cradle.report_coin_states(peak, records);
    this.processResultNow(result);
    this.retryPendingCoinSolutionDeliveries();
  }

  private deliverChainSnapshotReady(peak: bigint): void {
    log(`[wasm] chain snapshot ready height=${peak}`);
    if (!this.cradle) {
      throw new Error('deliverChainSnapshotReady called without cradle');
    }
    if (this.protocolStopped) return;
    this.cradle.chain_snapshot_ready();
    this.submissionPump.chainReady();
    this.drainAndSubmitTransactions();
  }

  private requestFeeUpgrades(): void {
    this.enqueueStimulus(() => {
      if (
        !this.cradle ||
        this.protocolStopped ||
        !this.blockchain ||
        this.blockchain?.rpc.isReadyForPlay?.() === false ||
        !this.blockchain.resolveProviderOwner(this.walletProviderOwnerSelector())
      ) {
        return;
      }
      this.cradle.request_fee_upgrades();
      this.drainAndSubmitTransactions();
    });
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
    if (this.persistenceActivated && !this.executionRetired) {
      await this.flush();
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

  persistInboundSessionRejectIfNeeded(): Promise<void> | null {
    if (this.reliableState.disposition !== 'inbound-reject') return null;
    const persist = this.persistInboundSessionReject;
    const sessionId = this.reliableState.sessionId;
    const remoteNumber = this.reliableState.remoteNumber;
    return (async () => {
      if (persist) {
        await persist(sessionId, remoteNumber);
      } else {
        await storageRepository.clearSession();
      }
      this.inboundSessionRejectCommitted = true;
    })();
  }

  getWasmFields(): WasmFields | null {
    // Null means the cradle is not loaded yet (e.g. mid-restore). Serialize
    // failures must throw so callers like durability flush do not treat a
    // failed snapshot as a successful no-op.
    if (!this.cradle || !this.wc) return null;
    const serializedGameSession = this.cradle.serialize();
    const transport = this.reliableTransport.state;
    return {
      serializedGameSession,
      gameSessionSchemaVersion: BigInt(this.wc.game_session_serialization_schema()),
      pairingToken: this.pairingToken,
      gameSessionId: transport.sessionId,
      messageNumber: transport.messageNumber,
      remoteNumber: transport.remoteNumber,
      iStarted: this.iStarted,
      myContribution: this.myContribution.toString(),
      theirContribution: this.theirContribution.toString(),
      perGameAmount: this.perGameAmount.toString(),
      rewardPuzzleHash: this.rewardPuzzleHash,
      unackedMessages: [...transport.unackedMessages],
      terminalHandoff: transport.terminalHandoff,
      wasmNotificationHistory: recentEntries(
        this.wasmNotificationHistory,
        WASM_NOTIFICATION_HISTORY_LIMIT,
      ),
      diagnosticLog: recentDiagnosticEntries(this.diagnosticLog),
      transportDisposition: transport.disposition ?? 'active',
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
    this.receiveEvent({ type: 'error', error: extractErrorMessage(error) });
  }

  // --- Game actions (called by higher layer) ---

  proposeGame(params: ProposeGameParams): string {
    if (!this.cradle) throw new Error('no cradle');
    if (!this.wc) throw new Error('no wasm');
    const result = this.cradle.propose(params);
    this.processCommandResult(result, 'propose game');
    if (result.id === undefined) {
      throw new Error('propose game returned no scalar local proposal id');
    }
    return result.id;
  }

  acceptProposal(gameId: string): void {
    if (!this.cradle) throw new Error('no cradle');
    try {
      const result = this.cradle.accept_proposal(gameId);
      this.processCommandResult(result, 'accept proposal');
    } catch (e) {
      const msg = extractErrorMessage(e);
      console.error('[wasm] acceptProposal failed:', msg);
      this.receiveEvent({ type: 'error', error: msg });
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
      this.receiveEvent({ type: 'error', error: msg });
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
      this.receiveEvent({
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
      this.receiveEvent({
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
      this.receiveEvent({ type: 'error', error: msg });
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
      this.receiveEvent({ type: 'error', error: msg });
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
      this.receiveEvent({ type: 'error', error: msg });
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
      this.receiveEvent({ type: 'error', error: msg });
      return false;
    }
  }

  isTransactionPublishNerfed(): boolean {
    return this.transactionPublishNerfed;
  }

  setTransactionPublishNerfed(nerfed: boolean): void {
    this.transactionPublishNerfed = nerfed;
    log(`[wasm] transaction publish ${nerfed ? 'nerfed' : 'enabled'}`);
    this.publishFrontend({ type: 'publishing-policy', nerfed });
  }

  nerf(): void {
    this.setTransactionPublishNerfed(true);
  }

  getState(): SessionMachineState {
    return this.state;
  }

  snapshotModel(): SessionMachineState['model'] {
    return structuredClone(this.state.model);
  }

  activate(): void {
    if (this.activated || this.executionRetired) return;
    this.activated = true;
    this.activateExecutionPersistence();
    if (!this.executionRetired) this.dispatchHostProjection();
  }

  activatePersistence(): void {
    if (this.persistenceActivated || this.executionRetired) return;
    if (!this.activated) {
      throw new Error('Session persistence activation requires execution');
    }
    this.persistenceActivated = true;
    this.detachStorageRuntime = storageRepository.attachRuntime(this);
    this.scheduleCommit(false);
  }

  private presentation(state: SessionMachineState): SessionPresentation {
    return {
      model: state.model,
      phase: selectSessionPhase(state.model, state.coordination.hostOnChain),
      hand: this.activeHand,
      coins: this.getCoinsOfInterest(),
      channelReady: this.isChannelReady(),
    };
  }

  private render(state: SessionMachineState): void {
    this.published = this.presentation(state);
    this.publishFrontend({ type: 'batch-complete', presentation: this.published });
  }

  publishReadiness(ready: boolean): void {
    this.published = { ...this.published, channelReady: ready };
    this.publishFrontend({ type: 'readiness', ready });
  }

  publishFrontend(event: SessionFrontendEvent): void {
    this.frontendEvents.push(event);
    if (this.publishingFrontend) return;
    this.publishingFrontend = true;
    try {
      while (this.frontendEvents.length) {
        const next = this.frontendEvents.shift()!;
        for (const listener of this.frontendListeners) listener(next);
      }
    } finally {
      this.publishingFrontend = false;
    }
  }

  private dispatchGameIntent(intent: GameIntent): GameActionRejection | void {
    const game = this.state.model.game;
    const gameType = game.activeGameType as RegisteredGameType;
    if (intent.type === 'state-changed') {
      this.commitHandStateChanged(gameType);
      return;
    }
    if (!Number.isInteger(intent.memberIndex) || intent.memberIndex < 0) {
      throw new Error(
        `Internal game action member index must be a nonnegative integer: ${intent.memberIndex}`,
      );
    }
    const id = game.currentHandIds[intent.memberIndex];
    if (id === undefined) {
      throw new Error(
        `Internal game action member index ${intent.memberIndex} is outside the current hand`,
      );
    }
    return runWithRuntimeErrorReporting(
      () =>
        this.commitLocalGameAction({
          gameType,
          id,
          command:
            intent.type === 'make-move'
              ? { type: 'make-move', readable: intent.readable }
              : intent.type === 'accept-settlement'
                ? { type: 'accept-settlement' }
                : { type: 'cheat', moverShare: intent.moverShare },
        }),
      (message) => this.dispatch({ type: 'enqueue-error', kind: 'infra-error', message }),
    );
  }

  retireExecution(): void {
    if (this.executionRetired) return;
    this.executionRetired = true;
    this.cancelCommitTask?.();
    this.cancelCommitTask = null;
    const error = new SessionRuntimeRetiredError();
    for (const work of this.pendingControllerWork.splice(0)) {
      if (work.kind === 'result') work.reject(error);
    }
    for (const effect of this.pendingExternalEffects.values()) {
      effect.deferred.reject(error);
    }
    this.pendingExternalEffects.clear();
    this.pendingEvents.length = 0;
    this.detachStorageRuntime?.();
    this.detachStorageRuntime = null;
  }

  receiveEvent(event: WasmEvent): void {
    if (!this.executionActive) return;
    switch (event.type) {
      case 'notification':
        dispatchWasmNotification(
          event.data,
          (notification) =>
            this.dispatch({
              type: 'wasm-notification',
              notification,
              iStarted: this.iStarted,
            }),
          (error) =>
            this.dispatch({ type: 'enqueue-error', kind: 'infra-error', message: String(error) }),
        );
        this.dispatchHostProjection();
        break;
      case 'error':
        this.dispatch({ type: 'enqueue-error', kind: 'infra-error', message: event.error });
        break;
      case 'game-action-error':
        this.dispatch({ type: 'enqueue-error', kind: 'action-failed', message: event.error });
        break;
      case 'durability-error':
        this.dispatch({ type: 'enqueue-error', kind: 'durability-error', message: event.error });
        break;
      case 'recoverable-internal-error':
        this.dispatch({
          type: 'enqueue-error',
          kind: 'recoverable-internal-error',
          message: event.error,
        });
        this.dispatchHostProjection();
        break;
      case 'log':
        log(`[wasm] ${event.message}`);
        this.dispatchHostProjection();
        break;
      case 'address':
        break;
    }
  }

  private dispatchHostProjection(): void {
    const status = this.getRestoreStatus();
    this.dispatch({
      type: 'host-projection',
      restore: {
        restoring: this.restoring,
        status,
        error: this.getRestoreError(),
      },
      wasmNotificationHistory: this.wasmNotificationHistory,
      diagnosticLog: this.diagnosticLog,
    });
  }

  private isDurabilityProjection(event: SessionMachineEvent): boolean {
    return (
      (event.type === 'enqueue-error' && event.kind === 'durability-error') ||
      ((event.type === 'dismiss-channel' || event.type === 'dismiss-channel-notification') &&
        this.state.model.channel.queue[0]?.kind === 'durability-error')
    );
  }

  dispatch(event: SessionMachineEvent): void {
    if (this.executionRetired) return;
    const durabilityProjection = this.isDurabilityProjection(event);
    this.pendingEvents.push(event);
    if (this.committing && durabilityProjection) {
      return;
    }
    if (this.committing) return;
    if (this.draining) return;
    this.runTransaction(undefined, !durabilityProjection);
    if (durabilityProjection && this.projectionPending) {
      this.projectionPending = false;
      try {
        this.render(this.state);
      } catch (error) {
        this.reportRuntimeError(error);
      }
    }
  }

  private drainMachineEvents(): void {
    while (this.pendingEvents.length > 0) {
      const next = this.pendingEvents.shift()!;
      const previous = this.state;
      const transition = reduceSessionMachine(previous, next, this.activeHandContext);
      this.state = transition.state;
      if (this.state !== previous) {
        this.projectionPending = true;
        if (transition.durability === 'durable') this.durabilityDirty = true;
      }
      for (const effect of transition.effects) {
        this.runSessionEffect(effect);
      }
    }
  }

  getGameHand(): RegisteredGameHand | null {
    return this.activeHand;
  }

  commitHandStateChanged(gameType: RegisteredGameType): void {
    const game = this.state.model.game;
    if (game.activeGameType !== gameType) {
      throw new Error(
        `Internal hand state gameType ${gameType} does not match active ${game.activeGameType}`,
      );
    }
    this.dispatch({ type: 'hand-state-changed', handState: this.snapshotActiveHand() });
  }

  commitLocalGameAction(request: LocalGameActionRequest): GameActionRejection | void {
    let rejection: GameActionRejection | undefined;
    this.runTransaction(() => {
      const game = this.state.model.game;
      if (game.activeGameType !== request.gameType) {
        throw new Error(
          `Internal local action gameType ${request.gameType} does not match active ${game.activeGameType}`,
        );
      }
      if (!game.currentHandIds.includes(request.id)) {
        throw new Error(`Internal local action game id ${request.id} is not a current hand member`);
      }
      if (!game.activeIds.includes(request.id)) {
        throw new Error(`Internal local action game id ${request.id} is not active`);
      }
      const instance = game.instances[request.id];
      if (!instance) {
        throw new Error(`Internal local action game id ${request.id} has no game instance`);
      }
      if (
        instance.presentation !== 'off-chain-my-turn' &&
        instance.presentation !== 'on-chain-my-turn'
      ) {
        throw new Error(`Internal local action for game ${request.id} attempted outside our turn`);
      }
      const result = this.runLocalGameCommand(request.command, request.id);
      if (typeof result === 'object') rejection = result;
    });
    return rejection;
  }

  private requireActiveHand(): RegisteredGameHand {
    if (this.activeHand === null) {
      throw new Error('Game update requires an active hand instance');
    }
    return this.activeHand;
  }

  private snapshotActiveHand() {
    return snapshotRegisteredGameHand(
      this.state.model.game.activeGameType,
      this.requireActiveHand(),
    );
  }

  private restoreHandFrom(checkpoint: ReturnType<typeof this.snapshotActiveHand> | null): void {
    if (checkpoint === null) {
      this.activeHand = null;
      return;
    }
    const gameType = checkpoint.gameType as RegisteredGameType;
    this.activeHand = restoreRegisteredGameHandState(gameType, checkpoint);
  }

  enqueue(work: () => void): void {
    if (this.executionRetired) return;
    if (this.committing) {
      this.pendingControllerWork.push({ kind: 'fire-and-forget', run: work });
      return;
    }
    this.runTransaction(work);
  }

  enqueueResult<T>(work: () => T): Promise<T> {
    const deferred = createResultDeferred<T>();
    if (!this.executionActive) {
      deferred.reject(
        this.executionRetired
          ? new SessionRuntimeRetiredError()
          : new Error('Authoritative mutations require active session execution'),
      );
      return deferred.promise;
    }
    const run = () => {
      try {
        deferred.resolve(work());
      } catch (error) {
        deferred.reject(error);
      }
    };
    if (this.committing) {
      this.pendingControllerWork.push({ kind: 'result', run, reject: deferred.reject });
    } else {
      this.runTransaction(run);
    }
    return deferred.promise;
  }

  releaseAfterPersistence(key: string, launcher: () => Promise<void>): Promise<void> {
    if (!this.activated)
      return Promise.reject(new Error('External effects require active session execution'));
    if (this.executionRetired) {
      const deferred = createDeferred();
      deferred.reject(new SessionRuntimeRetiredError());
      return deferred.promise;
    }
    const pending = this.pendingExternalEffects.get(key);
    if (pending) return pending.deferred.promise;
    const effect = { launcher, deferred: createDeferred() };
    this.pendingExternalEffects.set(key, effect);
    this.scheduleCommit(true);
    return effect.deferred.promise;
  }

  private runTransaction(work?: () => void, requestCommit = true): void {
    if (this.executionRetired) return;
    if (this.draining) {
      work?.();
      return;
    }
    this.draining = true;
    try {
      work?.();
      for (;;) {
        this.drainMachineEvents();
        this.flushDeferredWork();
        if (this.pendingEvents.length === 0 && !this.hasDeferredWork()) break;
      }
    } catch (error) {
      this.pendingEvents.length = 0;
      throw error;
    } finally {
      this.draining = false;
    }
    if (requestCommit) this.scheduleCommit(false);
  }

  requestCommit(): void {
    if (this.executionActive) this.scheduleCommit(true);
  }

  private scheduleCommit(markDirty: boolean): void {
    if (this.executionRetired) return;
    if (markDirty) this.durabilityDirty = true;
    if (!this.durabilityDirty && !this.projectionPending) return;
    if (!this.persistenceActivated) {
      if (!this.committing && !this.draining && !this.projecting) {
        this.projecting = true;
        try {
          while (this.projectionPending) {
            this.projectionPending = false;
            try {
              this.render(this.state);
            } catch (error) {
              this.reportRuntimeError(error);
            }
          }
        } finally {
          this.projecting = false;
        }
      }
      return;
    }
    if (this.committing || this.draining || this.cancelCommitTask !== null) return;
    // Background throttling must not delay the save that releases messages/ACKs.
    this.cancelCommitTask = scheduleCommitTask(() => {
      this.cancelCommitTask = null;
      this.startCommit();
    });
  }

  private writeCheckpoint(persistenceState: SessionMachineState): Promise<void> {
    const wasm = this.getWasmFields();
    if (!wasm) throw new SessionSnapshotUnavailableError();
    const capture = {
      kind: 'live' as const,
      wasm,
      model: persistenceState.model,
      walletProviderScope: this.getWalletProviderScope(),
      restoring: this.restoring,
      restoreStatus: this.getRestoreStatus(),
      restoreError: this.getRestoreError(),
    };
    const snapshot = storageRepository.patchApplicationState(
      (root) => buildDurableApplicationState(root, capture)!,
    );
    return storageRepository.write(snapshot);
  }

  private startCommit(): void {
    if (
      this.executionRetired ||
      this.committing ||
      this.draining ||
      (!this.durabilityDirty && !this.projectionPending)
    ) {
      return;
    }
    this.runTransaction(undefined, false);
    if (this.committing || this.draining || (!this.durabilityDirty && !this.projectionPending)) {
      return;
    }
    const projectedState = this.state;
    const shouldProject = this.projectionPending;
    if (!this.durabilityDirty) {
      this.projectionPending = false;
      try {
        this.render(projectedState);
      } catch (error) {
        this.reportRuntimeError(error);
      }
      return;
    }
    const reliableCommit = this.prepareReliableCommit();
    const externalEffects = [...this.pendingExternalEffects.entries()];
    const recoveringDurability = this.durabilityDegraded;
    const persistenceState = recoveringDurability
      ? reduceSessionMachine(
          structuredClone(projectedState),
          { type: 'clear-durability-error' },
          this.activeHandContext,
        ).state
      : structuredClone(projectedState);
    this.durabilityDirty = false;
    this.projectionPending = false;
    this.committing = true;
    let write: Promise<void>;
    try {
      const rejectionWrite = this.persistInboundSessionRejectIfNeeded();
      if (rejectionWrite) {
        write = rejectionWrite;
      } else {
        write = this.writeCheckpoint(persistenceState);
      }
    } catch (error) {
      write = Promise.reject(error);
    }
    const releaseExternalEffects = () => {
      for (const [key, effect] of externalEffects) {
        if (this.pendingExternalEffects.get(key) !== effect) continue;
        this.pendingExternalEffects.delete(key);
        let completion: Promise<void>;
        try {
          completion = effect.launcher();
        } catch (error) {
          effect.deferred.reject(error);
          continue;
        }
        void Promise.resolve(completion).then(effect.deferred.resolve, effect.deferred.reject);
      }
    };
    let writeFailed = false;
    let snapshotInvariantFailed = false;
    let activityDirtyBeforeFailure = false;
    this.commitPromise = write
      .then(
        () => {
          if (this.executionRetired) return;
          const renderedState = recoveringDurability
            ? reduceSessionMachine(
                this.state,
                { type: 'clear-durability-error' },
                this.activeHandContext,
              ).state
            : projectedState;
          if (recoveringDurability) {
            this.durabilityDegraded = false;
            this.clearDurabilityError();
            this.state = renderedState;
          }
          if (shouldProject) {
            try {
              this.render(renderedState);
            } catch (error) {
              this.reportRuntimeError(error);
            }
          }
          try {
            this.completeReliableCommit(reliableCommit, true);
          } catch (error) {
            this.reportRuntimeError(error);
          }
          releaseExternalEffects();
        },
        (error) => {
          if (this.executionRetired) throw error;
          if (error instanceof SessionSnapshotUnavailableError) {
            writeFailed = true;
            snapshotInvariantFailed = true;
            this.durabilityDirty = true;
            this.projectionPending ||= shouldProject;
            throw error;
          }
          if (error instanceof StorageAuthorityLostError) {
            this.retireExecution();
            throw error;
          }
          writeFailed = true;
          activityDirtyBeforeFailure = this.durabilityDirty;
          this.durabilityDirty = true;
          this.durabilityDegraded = true;
          this.reportDurabilityError(error);
          if (shouldProject) {
            try {
              this.render(projectedState);
            } catch (renderError) {
              this.reportRuntimeError(renderError);
            }
          }
          try {
            this.completeReliableCommit(reliableCommit, false);
          } catch (releaseError) {
            this.reportRuntimeError(releaseError);
          }
          releaseExternalEffects();
          throw error;
        },
      )
      .finally(() => {
        this.committing = false;
        if (this.executionRetired) return;
        if (this.pendingControllerWork.length > 0 || this.pendingEvents.length > 0) {
          const work = this.pendingControllerWork.splice(0);
          const queuedActivity =
            work.length > 0 ||
            this.pendingEvents.some((event) => !this.isDurabilityProjection(event));
          this.runTransaction(
            () => {
              for (const task of work) task.run();
            },
            !snapshotInvariantFailed &&
              (!writeFailed || activityDirtyBeforeFailure || queuedActivity),
          );
          if (
            !snapshotInvariantFailed &&
            writeFailed &&
            !activityDirtyBeforeFailure &&
            !queuedActivity
          ) {
            this.projectionPending = false;
            try {
              this.render(this.state);
            } catch (error) {
              this.reportRuntimeError(error);
            }
          }
        } else if (!snapshotInvariantFailed && (!writeFailed || activityDirtyBeforeFailure)) {
          this.scheduleCommit(false);
        }
      });
    void this.commitPromise.catch(() => {});
  }

  async flush(): Promise<void> {
    if (this.executionRetired) return;
    if (!this.persistenceActivated) {
      this.scheduleCommit(false);
      return;
    }
    this.cancelCommitTask?.();
    this.cancelCommitTask = null;
    if (
      !this.committing &&
      (this.durabilityDirty || this.projectionPending || this.pendingEvents.length > 0)
    ) {
      this.startCommit();
    }
    await this.commitPromise;
    if (
      this.committing ||
      this.durabilityDirty ||
      this.projectionPending ||
      this.pendingEvents.length > 0 ||
      this.pendingControllerWork.length > 0 ||
      this.pendingExternalEffects.size > 0
    ) {
      return this.flush();
    }
  }

  initializeExecution(
    restoring: boolean,
    bootstrap?: RehydratedDurableApplicationState,
  ): SessionFrontend {
    if (this.activated) return this.frontend;
    this.restoring = restoring;
    const handProposal: HandProposal = {
      gameType: DEFAULT_CATALOG_GAME_TYPE,
      senderIsPlayerA: !this.iStarted,
      gameTimeout: DEFAULT_GAME_TIMEOUT_BLOCKS,
      parameters: this.perGameAmount,
    };
    this.state = createSessionMachineState(
      bootstrap
        ? structuredClone(bootstrap.model)
        : createSessionModel({
            channel: { cleanShutdownStarted: this.cleanShutdownCalled },
            betweenHand: { lastHandProposal: null, compose: createComposeDraftState(handProposal) },
          }),
      {
        firstGameAccepted:
          bootstrap?.state.session?.phase === 'live' &&
          bootstrap.state.session.presentation.channelStatus?.state === 'Active',
      },
    );

    this.restoreHandFrom(this.state.model.game.handState);
    this.published = this.presentation(this.state);
    this.activate();
    return this.frontend;
  }
  get executionActive(): boolean {
    return this.activated && !this.executionRetired;
  }

  runLocalGameCommand(command: LocalGameCommand, id: string): GameCommandDisposition {
    switch (command.type) {
      case 'make-move':
        return this.makeMove(id, command.readable);
      case 'accept-settlement':
        return this.acceptSettlement(id);
      case 'cheat':
        return this.cheat(id, command.moverShare);
    }
  }

  runSessionEffect(effect: SessionMachineEffect): void {
    switch (effect.type) {
      case 'controller-accept-proposal':
        this.runControllerCommand(
          'accept-proposal',
          () => this.acceptProposal(effect.id),
          () =>
            this.dispatch({
              type: 'proposal-command-succeeded',
              command: 'accept-proposal',
              id: effect.id,
            }),
        );
        return;
      case 'controller-cancel-proposal':
        this.runControllerCommand(
          'cancel-proposal',
          () => this.cancel_proposal(effect.id),
          () =>
            this.dispatch({
              type: 'proposal-command-succeeded',
              command: 'cancel-proposal',
              id: effect.id,
            }),
        );
        return;
      case 'controller-propose-game': {
        if (!this.isOffChainActive()) {
          this.commandFailed('propose-game', new Error('channel is not active off-chain'));
          return;
        }
        if (this.state.model.game.activeIds.length > 0) {
          this.commandFailed('propose-game', new Error('a game is already active'));
          return;
        }
        this.runControllerCommand(
          'propose-game',
          () =>
            this.proposeGame({
              game_type: protocolIdForCatalog(effect.handProposal.gameType),
              timeout: effect.handProposal.gameTimeout,
              sender_is_player_a: effect.handProposal.senderIsPlayerA,
              parameters: effect.handProposal.parameters,
            }),
          (id) =>
            this.dispatch({
              type: 'proposal-sent',
              id,
              handProposal: effect.handProposal,
            }),
        );
        return;
      }
      case 'controller-clean-shutdown':
        this.runControllerCommand(
          'clean-shutdown',
          () => this.cleanShutdown(),
          () => this.dispatch({ type: 'clean-shutdown-command-succeeded' }),
        );
        return;
      case 'controller-go-on-chain': {
        this.runControllerCommand(
          'go-on-chain',
          () => this.goOnChain(),
          (started) => {
            if (!started) {
              this.commandFailed('go-on-chain', new Error('WASM rejected go on chain'));
              return;
            }
            this.dispatch({ type: 'go-on-chain-result', started: true });
          },
        );
        return;
      }
      case 'request-coin-enrichment':
        void coinIdHex(effect.coin)
          .then((coinHex) => {
            this.dispatch({
              type: 'coin-enrichment-completed',
              target: effect.target,
              id: effect.id,
              generation: effect.generation,
              coinHex,
              channelState: effect.channelState,
            });
          })
          .catch((error) => this.reportRuntimeError(error));
        return;
    }
  }

  private runControllerCommand<T>(
    command: SessionControllerCommand,
    run: () => T,
    succeeded: (result: T) => void,
  ): void {
    let result: T;
    try {
      result = run();
    } catch (error) {
      this.commandFailed(command, error);
      return;
    }
    succeeded(result);
  }

  private commandFailed(command: SessionControllerCommand, error: unknown): void {
    this.dispatch({
      type: 'controller-command-failed',
      command,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function scheduleCommitTask(task: () => void): () => void {
  if (typeof window !== 'undefined' && typeof window.MessageChannel === 'function') {
    const channel = new window.MessageChannel();
    const cancel = () => {
      channel.port1.onmessage = null;
      channel.port1.close();
      channel.port2.close();
    };
    channel.port1.onmessage = () => {
      cancel();
      task();
    };
    channel.port2.postMessage(null);
    return cancel;
  }
  const timer = setTimeout(task, 0);
  if (typeof timer === 'object' && 'unref' in timer) timer.unref();
  return () => clearTimeout(timer);
}

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
}

interface ResultDeferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

type PendingControllerWork =
  | { readonly kind: 'fire-and-forget'; readonly run: () => void }
  | {
      readonly kind: 'result';
      readonly run: () => void;
      readonly reject: (error: unknown) => void;
    };

interface PendingExternalEffect {
  readonly launcher: () => Promise<void>;
  readonly deferred: Deferred;
}

class SessionSnapshotUnavailableError extends Error {
  constructor() {
    super('Active session cannot persist before WASM fields are serializable');
    this.name = 'SessionSnapshotUnavailableError';
  }
}

function createDeferred(): Deferred {
  let resolvePromise!: () => void;
  let rejectPromise!: (error: unknown) => void;
  let settled = false;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  void promise.catch(() => {});
  return {
    promise,
    resolve: () => {
      if (settled) return;
      settled = true;
      resolvePromise();
    },
    reject: (error) => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    },
  };
}

function createResultDeferred<T>(): ResultDeferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  void promise.catch(() => {});
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

export function runWithRuntimeErrorReporting<T>(
  run: () => T,
  report: (message: string) => void,
): T {
  try {
    return run();
  } catch (error) {
    if (!wasClientErrorReported(error)) {
      markClientErrorReported(error);
      report(error instanceof Error ? error.message : String(error));
    }
    throw error;
  }
}
