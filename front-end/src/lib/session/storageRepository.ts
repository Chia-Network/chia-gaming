import {
  type ClaimedStorageSnapshot,
  type DurableStorageAuthority,
  inspectApplicationState,
  indexedDbStoragePort,
  InvalidApplicationStateError,
  StorageAuthorityLostError,
  StorageAuthorityRequiredError,
} from './indexedDb';
import {
  DURABLE_APPLICATION_STATE_SCHEMA,
  DURABLE_APPLICATION_STATE_VERSION,
  MAX_DURABLE_REJECTION_TRANSPORTS,
  type DurableApplicationState,
  type DurableRejectionTransport,
  type SessionTransportSave,
} from './saveEnvelope';
import { decodeDurableApplicationState } from './persistence';
import * as sessionPreferences from './sessionPreferences';
import * as sessionState from './sessionStateTransitions';
import type { HardResetResult } from '../../hooks/saveHardReset';
import {
  markLeaseClaimed,
  clearSavedSessionMarker,
  getStorageTabId,
  hasWalletConnectStorage,
  installStorageCoordination,
  type StorageAuthorityLossReason,
  markSavedSession,
  randomHex,
  resetStorageCoordinationForTests,
} from '../../hooks/saveCoordination';
import {
  reduceWalletOperation,
  walletProviderScopeKey,
  type WalletOperationCommand,
  type WalletOperationEffect,
  type WalletOperationEntry,
} from './walletOperationStore';
import { diagStack } from '../../services/log';

type StorageLifecycleEvent = 'claim' | 'authority-lost' | 'hard-reset';
interface ScheduledPersist {
  promise: Promise<void>;
  resolve(): void;
  reject(reason: unknown): void;
  unsubscribe(): void;
}

function newApplicationState(): DurableApplicationState {
  return {
    schema: DURABLE_APPLICATION_STATE_SCHEMA,
    version: DURABLE_APPLICATION_STATE_VERSION,
    identity: { playerId: randomHex() },
    preferences: {},
    history: {},
    session: null,
    walletContext: null,
    walletObligations: [],
    rejectionTransports: [],
  };
}

class StorageRepository {
  private authority: DurableStorageAuthority | null = null;
  private generation = 0;
  private lifecycle = 0;
  private claimSequence = 0;
  private fenced = false;
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly authorityLostListeners = new Set<(reason: StorageAuthorityLossReason) => void>();
  private readonly lifecycleListeners = new Set<
    (generation: number, event: StorageLifecycleEvent) => void
  >();
  private pendingMutationBarrierForTests: Promise<void> | null = null;
  private pendingCheckpointHoldForTests: {
    barrier: Promise<void>;
    committed: () => void;
  } | null = null;
  private pendingClaimHoldForTests: {
    barrier: Promise<void>;
    claimed: () => void;
  } | null = null;

  get lifecycleGeneration(): number {
    return this.generation;
  }
  isGenerationCurrent(generation: number): boolean {
    return generation === this.generation && this.hasAuthority();
  }
  onLifecycle(listener: (generation: number, event: StorageLifecycleEvent) => void): () => void {
    this.lifecycleListeners.add(listener);
    return () => this.lifecycleListeners.delete(listener);
  }

  hasAuthority(): boolean {
    return this.authority !== null && !this.fenced;
  }

  onAuthorityLost(listener: (reason: StorageAuthorityLossReason) => void): () => void {
    this.authorityLostListeners.add(listener);
    return () => this.authorityLostListeners.delete(listener);
  }

  loseAuthority(reason: StorageAuthorityLossReason): void {
    if (this.fenced) return;
    this.fenced = true;
    this.generation += 1;
    this.notifyLifecycle('authority-lost');
    this.notifyAuthorityLost(reason);
  }

  private notifyLifecycle(event: StorageLifecycleEvent): void {
    for (const listener of this.lifecycleListeners) {
      try {
        listener(this.generation, event);
      } catch {
        // Lifecycle notification must reach the remaining listeners.
      }
    }
  }

  private notifyAuthorityLost(reason: StorageAuthorityLossReason): void {
    for (const listener of this.authorityLostListeners) {
      try {
        listener(reason);
      } catch {}
    }
  }

  async claimAndRead(ownerTabId: string): Promise<ClaimedStorageSnapshot> {
    const lifecycle = this.lifecycle;
    const generation = this.generation;
    const claimSequence = ++this.claimSequence;
    const snapshot = await indexedDbStoragePort.claimAndRead(ownerTabId);
    if (
      lifecycle !== this.lifecycle ||
      generation !== this.generation ||
      claimSequence !== this.claimSequence
    ) {
      throw new StorageAuthorityLostError();
    }
    this.authority = snapshot.authority;
    this.generation += 1;
    this.fenced = false;
    const claimedGeneration = this.generation;
    const hold = this.pendingClaimHoldForTests;
    this.pendingClaimHoldForTests = null;
    if (hold) {
      hold.claimed();
      await hold.barrier;
    }
    if (
      lifecycle !== this.lifecycle ||
      claimSequence !== this.claimSequence ||
      claimedGeneration !== this.generation ||
      this.fenced ||
      !this.authority ||
      this.authority.ownerTabId !== snapshot.authority.ownerTabId ||
      this.authority.writeEpoch !== snapshot.authority.writeEpoch ||
      this.authority.resetEpoch !== snapshot.authority.resetEpoch
    ) {
      throw new StorageAuthorityLostError();
    }
    return snapshot;
  }

  async inspect(): Promise<{
    applicationState: DurableApplicationState | null;
    applicationStateError?: InvalidApplicationStateError;
  }> {
    await this.mutationTail;
    return inspectApplicationState();
  }

  async beginHardReset(ownerTabId: string): Promise<DurableStorageAuthority> {
    const authority = await indexedDbStoragePort.beginHardReset(ownerTabId);
    this.authority = authority;
    this.generation += 1;
    this.fenced = true;
    this.notifyLifecycle('hard-reset');
    return authority;
  }

  hardResetMutation(authority: DurableStorageAuthority, reset: () => Promise<void>): Promise<void> {
    return this.enqueue(
      authority,
      this.generation,
      async () => {
        await indexedDbStoragePort.validatePendingHardReset(authority);
        await reset();
      },
      true,
    );
  }

  async checkpointApplicationState(session: DurableApplicationState): Promise<void> {
    await this.prepareApplicationStateCapture(() => session).write();
  }

  private writeRoot(next: DurableApplicationState): Promise<void> {
    return this.runAuthorizedMutation(async (authority) => {
      await indexedDbStoragePort.writeApplicationState(next, authority);
      const hold = this.pendingCheckpointHoldForTests;
      this.pendingCheckpointHoldForTests = null;
      if (hold) {
        hold.committed();
        await hold.barrier;
      }
    }).catch((error) => {
      if (
        !(error instanceof StorageAuthorityLostError) &&
        !(error instanceof StorageAuthorityRequiredError)
      ) {
        diagStack('aggregate checkpoint failed', error);
      }
      throw error;
    });
  }

  /**
   * Apply one synchronous root transform and freeze its complete write input.
   * Mutations after this call update `root` independently and are checkpointed
   * later, so invoking the returned closure cannot overwrite them in memory.
   */
  prepareApplicationStateCapture(
    transform: (current: DurableApplicationState) => DurableApplicationState,
  ) {
    if (!this.hasAuthority()) throw this.authorityMutationError();
    const next = sessionState.capSessionHistories(transform(structuredClone(this.root)));
    decodeDurableApplicationState(next);
    this.root = next;
    const snapshot = structuredClone(next);

    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    const pending = this.takeScheduledPersist();

    let written = false;
    return {
      write: async () => {
        if (written) throw new Error('Durable application capture may only be written once');
        written = true;
        try {
          await this.writeRoot(snapshot);
          if (snapshot.session !== null) markSavedSession();
          pending?.resolve();
        } catch (error) {
          pending?.reject(error);
          throw error;
        }
      },
    };
  }

  holdNextMutationForTests(barrier: Promise<void>): void {
    this.pendingMutationBarrierForTests = barrier;
  }

  holdNextCheckpointAfterCommitForTests(barrier: Promise<void>, committed: () => void): void {
    this.pendingCheckpointHoldForTests = { barrier, committed };
  }

  holdNextClaimAfterCommitForTests(barrier: Promise<void>, claimed: () => void): void {
    this.pendingClaimHoldForTests = { barrier, claimed };
  }

  private authorityMutationError(): StorageAuthorityRequiredError | StorageAuthorityLostError {
    return this.fenced ? new StorageAuthorityLostError() : new StorageAuthorityRequiredError();
  }

  private runAuthorizedMutation(
    write: (authority: DurableStorageAuthority) => Promise<void>,
  ): Promise<void> {
    if (!this.authority || this.fenced) {
      return Promise.reject(this.authorityMutationError());
    }
    const authority = { ...this.authority };
    return this.enqueue(authority, this.generation, () => write(authority));
  }

  private enqueue(
    authority: DurableStorageAuthority,
    generation: number,
    run: () => Promise<void>,
    allowFenced = false,
  ): Promise<void> {
    const lifecycle = this.lifecycle;
    const execution = this.mutationTail.then(async () => {
      const barrier = this.pendingMutationBarrierForTests;
      this.pendingMutationBarrierForTests = null;
      if (barrier) await barrier;
      await run();
      if (lifecycle !== this.lifecycle) return;
      if (
        (!allowFenced && this.fenced) ||
        generation !== this.generation ||
        !this.authority ||
        this.authority.ownerTabId !== authority.ownerTabId ||
        this.authority.writeEpoch !== authority.writeEpoch ||
        this.authority.resetEpoch !== authority.resetEpoch
      ) {
        throw new StorageAuthorityLostError();
      }
    });
    this.mutationTail = execution.then(
      () => {},
      () => {},
    );
    return execution.catch((error: unknown) => {
      this.handleMutationFailure(lifecycle, authority, error);
      throw error;
    });
  }

  private handleMutationFailure(
    lifecycle: number,
    authority: DurableStorageAuthority,
    error: unknown,
  ): void {
    if (lifecycle !== this.lifecycle || !(error instanceof StorageAuthorityLostError)) return;
    if (
      this.authority?.ownerTabId === authority.ownerTabId &&
      this.authority.writeEpoch === authority.writeEpoch &&
      this.authority.resetEpoch === authority.resetEpoch
    ) {
      this.loseAuthority('durable-authority-lost');
    }
  }

  private stopPersistenceForHardReset(): void {
    this.root = newApplicationState();
    if (!this.fenced) this.loseAuthority('durable-authority-lost');
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.settleScheduledPersist();
  }

  private root = newApplicationState();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private scheduledPersist: ScheduledPersist | null = null;
  private readonly PERSIST_DEBOUNCE_MS = 300;

  shouldOfferResumeOrStartOver(state: DurableApplicationState = this.root): boolean {
    return (
      !!(state.preferences.blockchainType || state.preferences.hubUrl) ||
      hasWalletConnectStorage() ||
      state.session !== null ||
      state.walletObligations.length > 0 ||
      state.rejectionTransports.length > 0
    );
  }

  private queueWrite(state: DurableApplicationState): Promise<void> {
    const snapshot = sessionState.capSessionHistories(state);
    const write = this.checkpointApplicationState(snapshot).then(() => {
      if (snapshot.session !== null) {
        markSavedSession();
      }
    });
    return write;
  }

  private takeScheduledPersist(): ScheduledPersist | null {
    const pending = this.scheduledPersist;
    this.scheduledPersist = null;
    pending?.unsubscribe();
    return pending;
  }

  private settleScheduledPersist(error?: unknown): void {
    const pending = this.takeScheduledPersist();
    if (error === undefined) pending?.resolve();
    else pending?.reject(error);
  }

  flushAggregate(): Promise<void> {
    if (!this.hasAuthority()) return Promise.reject(this.authorityMutationError());
    return (async () => {
      if (this.persistTimer) {
        clearTimeout(this.persistTimer);
        this.persistTimer = null;
      }
      const pending = this.takeScheduledPersist();
      let write: Promise<void>;
      try {
        write = this.queueWrite(this.root);
      } catch (error) {
        pending?.reject(error);
        return Promise.reject(error);
      }
      void write.then(
        () => pending?.resolve(),
        (error) => {
          pending?.reject(error);
        },
      );
      return pending?.promise ?? write;
    })();
  }

  private schedulePersist(): Promise<void> {
    if (!this.hasAuthority() || this.fenced) return Promise.resolve();
    if (this.scheduledPersist) return this.scheduledPersist.promise;
    let resolve!: () => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<void>((accept, fail) => {
      resolve = accept;
      reject = fail;
    });
    void promise.catch(() => {});
    const unsubscribe = this.onAuthorityLost(() => {
      this.settleScheduledPersist(new StorageAuthorityLostError());
    });
    this.scheduledPersist = { promise, resolve, reject, unsubscribe };
    const timer = setTimeout(() => {
      this.persistTimer = null;
      void this.flushAggregate().catch((error) => {
        this.settleScheduledPersist(error);
      });
    }, this.PERSIST_DEBOUNCE_MS);
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();
    this.persistTimer = timer;
    return promise;
  }

  constructor() {
    installStorageCoordination(
      (reason) => this.loseAuthority(reason),
      () => this.stopPersistenceForHardReset(),
    );
  }

  private preAuthorityCommonPatch: sessionState.CommonSessionPatch = {};

  _resetForTests(): void {
    this.lifecycle += 1;
    this.authority = null;
    this.generation += 1;
    this.claimSequence += 1;
    this.fenced = false;
    this.mutationTail = Promise.resolve();
    this.authorityLostListeners.clear();
    this.lifecycleListeners.clear();
    this.pendingMutationBarrierForTests = null;
    this.pendingCheckpointHoldForTests = null;
    this.pendingClaimHoldForTests = null;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.settleScheduledPersist();
    this.root = newApplicationState();
    this.preAuthorityCommonPatch = {};
    resetStorageCoordinationForTests();
  }

  loadState(): DurableApplicationState {
    return this.root;
  }

  walletObligations(): WalletOperationEntry[] {
    return structuredClone(this.root.walletObligations);
  }

  walletContext(): DurableApplicationState['walletContext'] {
    return this.root.walletContext ? structuredClone(this.root.walletContext) : null;
  }

  ensureWalletContext(context: NonNullable<DurableApplicationState['walletContext']>): void {
    if (!this.hasAuthority()) throw this.authorityMutationError();
    if (this.root.walletContext) {
      if (walletProviderScopeKey(this.root.walletContext) !== walletProviderScopeKey(context)) {
        throw new Error('Internal wallet consistency error: walletContext cannot change');
      }
      return;
    }
    this.root = { ...this.root, walletContext: structuredClone(context) };
    void this.schedulePersist();
  }

  _replaceApplicationStateForTests(state: DurableApplicationState): void {
    decodeDurableApplicationState(state);
    this.root = structuredClone(state);
  }

  reduceWallet(command: WalletOperationCommand): WalletOperationEffect[] {
    if (!this.hasAuthority()) throw this.authorityMutationError();
    const reduction = reduceWalletOperation(this.root.walletObligations, command);
    if (reduction.effects.some((effect) => effect.kind === 'persist')) {
      const walletContext = this.root.walletContext;
      if (!walletContext && reduction.nextState.length > 0) {
        throw new Error('Internal wallet consistency error: obligations require walletContext');
      }
      const next = {
        ...this.root,
        walletContext,
        walletObligations: reduction.nextState,
      };
      this.root = next;
      void this.schedulePersist();
    }
    return reduction.effects;
  }

  private async installClaimedApplicationState(
    snapshot: ClaimedStorageSnapshot,
  ): Promise<DurableApplicationState> {
    if (snapshot.applicationStateError) throw snapshot.applicationStateError;
    const record = snapshot.applicationState;
    const patch = this.preAuthorityCommonPatch;
    this.preAuthorityCommonPatch = {};
    this.root = sessionState.mergeClaimedSession(record, this.root, patch);
    const restoredWallet = reduceWalletOperation(this.root.walletObligations, {
      kind: 'restore-aggregate',
    });
    this.root = { ...this.root, walletObligations: restoredWallet.nextState };

    const hasPatch =
      Object.keys(patch).length > 0 ||
      restoredWallet.effects.some((effect) => effect.kind === 'persist');
    if (hasPatch) {
      try {
        await this.queueWrite(this.root);
      } catch (error) {
        if (error instanceof StorageAuthorityLostError) throw error;
      }
    }
    if (this.shouldOfferResumeOrStartOver(this.root)) markSavedSession();
    else clearSavedSessionMarker();
    this.notifyLifecycle('claim');
    return structuredClone(this.root);
  }

  async claimApplicationState(): Promise<DurableApplicationState> {
    const snapshot = await this.claimAndRead(getStorageTabId());
    markLeaseClaimed();
    return this.installClaimedApplicationState(snapshot);
  }

  private mutateCommon(
    fn: (state: DurableApplicationState) => DurableApplicationState,
  ): Promise<void> {
    if (!this.hasAuthority()) {
      const state = this.loadState();
      const before = structuredClone(state);
      this.root = fn(state);
      const patch = sessionState.commonPatch(before, this.root);
      this.preAuthorityCommonPatch = {
        identity: { ...this.preAuthorityCommonPatch.identity, ...patch.identity },
        preferences: { ...this.preAuthorityCommonPatch.preferences, ...patch.preferences },
        history: { ...this.preAuthorityCommonPatch.history, ...patch.history },
      };
      return Promise.resolve();
    }
    return this.mutateSession(fn);
  }

  private mutateSession(
    fn: (state: DurableApplicationState) => DurableApplicationState,
  ): Promise<void> {
    if (!this.hasAuthority()) return Promise.reject(this.authorityMutationError());
    this.root = fn(this.root);
    return this.schedulePersist();
  }

  getPlayerId(): string {
    const state = this.loadState();
    if (!this.hasAuthority()) {
      this.preAuthorityCommonPatch.identity = {
        ...this.preAuthorityCommonPatch.identity,
        playerId: state.identity.playerId,
      };
    }
    return state.identity.playerId;
  }

  async ensureHubIdentity(): Promise<string> {
    if (!this.hasAuthority()) {
      throw new Error('Hub identity cannot be minted before durable storage authority is claimed');
    }
    return this.getSessionId();
  }

  query<K extends keyof sessionPreferences.SessionPreferenceQueries>(
    key: K,
  ): sessionPreferences.SessionPreferenceQueries[K] {
    return sessionPreferences.selectSessionPreference(this.loadState(), key);
  }

  updatePreference(update: sessionPreferences.SessionPreferenceUpdate): Promise<void> {
    const persisted = this.mutateCommon((state) =>
      sessionPreferences.applySessionPreferenceUpdate(state, update),
    );
    if (update.key === 'hubUrl' && update.value) markSavedSession();
    return persisted;
  }

  getSessionId(): string {
    const state = this.loadState();
    if (state.identity.sessionId) return state.identity.sessionId;
    if (!this.hasAuthority()) {
      throw new Error(
        'getSessionId called before ensureHubIdentity and durable storage authority was claimed',
      );
    }
    const sessionId = randomHex();
    this.root = {
      ...state,
      identity: { ...state.identity, sessionId },
    };
    void this.schedulePersist();
    return sessionId;
  }

  regenerateSessionId(): string {
    const state = this.loadState();
    const sessionId = randomHex();
    this.root = {
      ...state,
      identity: { ...state.identity, sessionId, myHubPlayerId: undefined },
    };
    if (this.hasAuthority()) {
      void this.schedulePersist();
    } else {
      this.preAuthorityCommonPatch.identity = {
        ...this.preAuthorityCommonPatch.identity,
        sessionId,
        myHubPlayerId: undefined,
      };
    }
    return sessionId;
  }

  clearHubIdentity(): void {
    void this.mutateCommon((state) => ({
      ...state,
      identity: { ...state.identity, sessionId: undefined, myHubPlayerId: undefined },
    }));
  }

  updateCommon(patch: sessionState.CommonSessionPatch): Promise<void> {
    return this.mutateCommon((state) => sessionState.applyCommonPatch(state, patch));
  }

  patchPreHandshakeTransport(transport: SessionTransportSave): Promise<void> {
    return this.mutateSession((state) => sessionState.patchSessionTransport(state, transport));
  }

  persistRejectionTransport(tombstone: DurableRejectionTransport): Promise<void> {
    return this.prepareApplicationStateCapture((state) => {
      const session = state.session;
      const matchesRejectedSession =
        (session?.phase === 'live' || session?.phase === 'pre-handshake') &&
        session.pairing.peerId === tombstone.peerId &&
        session.pairing.gameSessionId === tombstone.sessionId;
      const next = matchesRejectedSession ? sessionState.freshSessionState(state) : state;
      return {
        ...next,
        rejectionTransports: [
          ...next.rejectionTransports.filter(
            (record) =>
              record.peerId !== tombstone.peerId || record.sessionId !== tombstone.sessionId,
          ),
          structuredClone(tombstone),
        ]
          .sort((a, b) => a.createdAt - b.createdAt)
          .slice(-MAX_DURABLE_REJECTION_TRANSPORTS),
      };
    }).write();
  }

  clearSessionPairing(): Promise<void> {
    return this.mutateSession(sessionState.clearSessionPeer);
  }

  async readCurrentState(): Promise<DurableApplicationState | null> {
    if (!this.hasAuthority()) {
      const { applicationState, applicationStateError } = await this.inspect();
      if (applicationStateError) throw applicationStateError;
      if (applicationState && this.shouldOfferResumeOrStartOver(applicationState)) {
        markSavedSession();
        return structuredClone(applicationState);
      }
      clearSavedSessionMarker();
      return null;
    }
    if (this.shouldOfferResumeOrStartOver(this.root)) {
      markSavedSession();
      return structuredClone(this.root);
    }
    clearSavedSessionMarker();
    return null;
  }

  clearSession(): Promise<void> {
    if (!this.hasAuthority()) return Promise.reject(this.authorityMutationError());
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.settleScheduledPersist();
    this.root = sessionState.freshSessionState(this.root);
    const deletePromise = this.queueWrite(this.root).then(() => {
      if (
        this.root.preferences.blockchainType ||
        this.root.preferences.hubUrl ||
        this.root.walletObligations.length > 0
      ) {
        markSavedSession();
      } else {
        clearSavedSessionMarker();
      }
    });
    return deletePromise;
  }

  async hardReset(): Promise<HardResetResult> {
    const authority = await this.beginHardReset(getStorageTabId());
    const { hardResetStorage } = await import('../../hooks/saveHardReset');
    this.stopPersistenceForHardReset();
    return hardResetStorage(authority, (owned, reset) => this.hardResetMutation(owned, reset));
  }

  getOrCreateAlias(): string {
    const state = this.loadState();
    const existing = sessionPreferences.selectSessionPreference(state, 'alias');
    if (existing) return existing;
    const generated = `Player_${randomHex().substring(0, 8)}`;
    if (this.hasAuthority()) {
      void this.updatePreference({ key: 'alias', value: generated });
    } else {
      this.root = sessionPreferences.applySessionPreferenceUpdate(state, {
        key: 'alias',
        value: generated,
      });
      this.preAuthorityCommonPatch.preferences = {
        ...this.preAuthorityCommonPatch.preferences,
        alias: generated,
      };
    }
    return generated;
  }
}

export const storageRepository = new StorageRepository();
