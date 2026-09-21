import {
  type ClaimedStorageSnapshot,
  type DurableStorageAuthority,
  inspectSessionRecord,
  readRejectionTombstones,
  readSessionRecord,
  readWalletOperationRecord,
  indexedDbStoragePort,
  type DurableRejectionTombstone,
  InvalidSessionRecordError,
  StorageAuthorityLostError,
  StorageAuthorityRequiredError,
} from './indexedDb';
import type { SessionSave } from './saveEnvelope';
import { decodeSessionSaveEnvelope } from './persistence';
import * as sessionPreferences from './sessionPreferences';
import * as sessionState from './sessionStateTransitions';
import { hardResetStorage, type HardResetResult } from '../../hooks/saveHardReset';
import { loadPreferences, savePreferences } from '../../hooks/savePreferences';
import {
  markLeaseClaimed,
  clearSavedSessionMarker,
  getStorageTabId,
  hasSavedSessionMarker,
  hasWalletConnectStorage,
  installStorageCoordination,
  type StorageAuthorityLossReason,
  markSavedSession,
  randomHex,
  resetStorageCoordinationForTests,
} from '../../hooks/saveCoordination';
import { walletOperationRuntime } from './walletOperationRuntime';
import { decodeWalletOperationRecord } from './walletOperationCodec';
import { walletProviderScopeKey, type WalletOperationEntry } from './walletOperationStore';

type StorageLifecycleEvent = 'claim' | 'authority-lost' | 'hard-reset';
type BootStorageHydrationResult =
  | { status: 'ready'; discardedSession: boolean; durableSession: SessionSave | null }
  | { status: 'failed'; error: string };

function assertSessionWalletScope(
  session: SessionSave,
  entries: readonly WalletOperationEntry[],
): void {
  if (
    !sessionState.isDurableSession(session) ||
    !('walletProviderScope' in session) ||
    !session.walletProviderScope
  ) {
    return;
  }
  const expected = walletProviderScopeKey(session.walletProviderScope);
  if (entries.some((entry) => walletProviderScopeKey(entry.owner.providerScope) !== expected)) {
    throw new Error(
      'Internal wallet consistency error: durable session and wallet ledger scopes differ',
    );
  }
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
    this.notifyLifecycle('claim');
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
    sessionRecord: unknown | null;
    sessionError?: InvalidSessionRecordError;
    walletOperationRecord: Awaited<ReturnType<typeof readWalletOperationRecord>>;
  }> {
    await this.mutationTail;
    const [session, walletOperationRecord] = await Promise.all([
      inspectSessionRecord(),
      readWalletOperationRecord(),
    ]);
    return { ...session, walletOperationRecord };
  }

  async readRejections(): Promise<DurableRejectionTombstone[]> {
    return this.readAfterMutations(readRejectionTombstones);
  }

  private async readAfterMutations<T>(read: () => Promise<T>): Promise<T> {
    await this.mutationTail;
    return read();
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

  saveSessionAndWalletOperations(
    session: SessionSave,
    entries: WalletOperationEntry[],
  ): Promise<void> {
    const sessionSnapshot = structuredClone(session);
    const entriesSnapshot = structuredClone(entries);
    assertSessionWalletScope(sessionSnapshot, entriesSnapshot);
    return this.runAuthorizedMutation(async (authority) => {
      await indexedDbStoragePort.writeCheckpoint(sessionSnapshot, entriesSnapshot, authority);
      const hold = this.pendingCheckpointHoldForTests;
      this.pendingCheckpointHoldForTests = null;
      if (hold) {
        hold.committed();
        await hold.barrier;
      }
    });
  }

  saveWalletOperations(entries: WalletOperationEntry[]): Promise<void> {
    const snapshot = structuredClone(entries);
    return this.runAuthorizedMutation((authority) =>
      indexedDbStoragePort.writeWalletOperations(snapshot, authority),
    );
  }

  private deleteSessionRecord(): Promise<void> {
    return this.runAuthorizedMutation((authority) => indexedDbStoragePort.deleteSession(authority));
  }

  writeRejection(tombstone: DurableRejectionTombstone): Promise<void> {
    const snapshot = structuredClone(tombstone);
    return this.runAuthorizedMutation((authority) =>
      indexedDbStoragePort.writeRejection(snapshot, authority),
    );
  }

  deleteRejection(peerId: string, sessionId: string): Promise<void> {
    return this.runAuthorizedMutation((authority) =>
      indexedDbStoragePort.deleteRejection(peerId, sessionId, authority),
    );
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
    this.cached = null;
    this.stagedTerminal = null;
    if (!this.fenced) this.loseAuthority('durable-authority-lost');
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.settleScheduledPersist();
    this.identityDiskChecked = true;
    this.storageRepositoryHydratedFromDisk = true;
    this.walletOperationRuntimeHydration = null;
  }

  private cached: SessionSave | null = null;
  private stagedTerminal: SessionSave | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private persistPromise: Promise<void> | null = null;
  private resolvePersist: (() => void) | null = null;
  private rejectPersist: ((reason: unknown) => void) | null = null;
  private persistAuthorityLostUnsubscribe: (() => void) | null = null;
  private readonly PERSIST_DEBOUNCE_MS = 300;

  shouldOfferResumeOrStartOver(state: SessionSave = loadPreferences()): boolean {
    return (
      sessionPreferences.hasConnectionPreferences(state, hasWalletConnectStorage()) ||
      hasSavedSessionMarker()
    );
  }

  private async readCompatibleSessionRecord(): Promise<{
    record: SessionSave | null;
    discarded: boolean;
  }> {
    let record: unknown | null;
    try {
      record = await this.readAfterMutations(readSessionRecord);
    } catch (error) {
      if (!(error instanceof InvalidSessionRecordError)) throw error;
      console.error('[save] rejecting unreadable session record:', error);
      await this.deleteSessionRecord();
      markSavedSession();
      return { record: null, discarded: true };
    }
    if (!record) return { record: null, discarded: false };
    const decoded = sessionState.decodeCurrentSession(record);
    if (!decoded) {
      console.error('[save] rejecting incompatible session record');
      await this.deleteSessionRecord();
      markSavedSession();
      return { record: null, discarded: true };
    }
    return { record: decoded, discarded: false };
  }

  private queueWrite(state: SessionSave): Promise<void> {
    const snapshot = sessionState.capSessionHistories(state);
    const ledgerCheckpoint = walletOperationRuntime.checkpoint();
    sessionState.assertPersistableSession(snapshot);
    decodeSessionSaveEnvelope(snapshot);
    assertSessionWalletScope(snapshot, ledgerCheckpoint.entries);
    const write = this.saveSessionAndWalletOperations(snapshot, ledgerCheckpoint.entries).then(
      () => {
        walletOperationRuntime.combinedCheckpointPersisted(ledgerCheckpoint);
        if (sessionState.isDurableSession(snapshot)) {
          markSavedSession();
        }
      },
    );
    return write;
  }

  private settleScheduledPersist(error?: unknown): void {
    if (this.persistAuthorityLostUnsubscribe) {
      this.persistAuthorityLostUnsubscribe();
      this.persistAuthorityLostUnsubscribe = null;
    }
    const resolve = this.resolvePersist;
    const reject = this.rejectPersist;
    this.persistPromise = null;
    this.resolvePersist = null;
    this.rejectPersist = null;
    if (error === undefined) resolve?.();
    else reject?.(error);
  }

  flushSessionSave(): Promise<void> {
    if (!this.hasAuthority()) return Promise.reject(this.authorityMutationError());
    return this.hydrateSessionCacheFromDiskStrict().then(async () => {
      if (!this.cached || this.fenced) {
        await walletOperationRuntime.persistIfDirty();
        return;
      }
      if (this.persistTimer) {
        clearTimeout(this.persistTimer);
        this.persistTimer = null;
      }
      const pending = this.persistPromise;
      const resolve = this.resolvePersist;
      const reject = this.rejectPersist;
      if (this.persistAuthorityLostUnsubscribe) {
        this.persistAuthorityLostUnsubscribe();
        this.persistAuthorityLostUnsubscribe = null;
      }
      this.persistPromise = null;
      this.resolvePersist = null;
      this.rejectPersist = null;
      if (this.stagedTerminal) {
        const terminal = this.stagedTerminal;
        let write: Promise<void>;
        try {
          write = this.queueWrite(terminal).then(() => {
            if (this.stagedTerminal !== terminal) return;
            this.cached = terminal;
            this.stagedTerminal = null;
            savePreferences(terminal);
          });
        } catch (error) {
          reject?.(error);
          return Promise.reject(error);
        }
        void write.then(
          () => resolve?.(),
          (error) => {
            console.error('[save] failed to persist terminal session state:', error);
            reject?.(error);
          },
        );
        return pending ? Promise.all([pending, write]).then(() => {}) : write;
      }
      if (
        !sessionState.isDurableSession(this.cached) &&
        hasSavedSessionMarker() &&
        !sessionPreferences.hasConnectionPreferences(this.cached, hasWalletConnectStorage()) &&
        walletOperationRuntime.snapshot().length === 0
      ) {
        const error = new Error(
          'Refusing to persist non-resumable in-memory state over a marked saved session',
        );
        console.error('[save]', error.message);
        reject?.(error);
        return Promise.reject(error);
      }
      let write: Promise<void>;
      try {
        write = this.queueWrite(this.cached);
      } catch (error) {
        reject?.(error);
        return Promise.reject(error);
      }
      void write.then(
        () => resolve?.(),
        (error) => {
          console.error('[save] failed to persist session state:', error);
          reject?.(error);
        },
      );
      return pending ?? write;
    });
  }

  private schedulePersist(): Promise<void> {
    if (!this.hasAuthority() || this.fenced) return Promise.resolve();
    if (this.persistPromise) return this.persistPromise;
    this.persistPromise = new Promise<void>((resolve, reject) => {
      this.resolvePersist = resolve;
      this.rejectPersist = reject;
    });
    void this.persistPromise.catch(() => {});
    this.persistAuthorityLostUnsubscribe = this.onAuthorityLost(() => {
      this.settleScheduledPersist(new StorageAuthorityLostError());
    });
    const timer = setTimeout(() => {
      this.persistTimer = null;
      void this.flushSessionSave().catch((error) => {
        this.settleScheduledPersist(error);
      });
    }, this.PERSIST_DEBOUNCE_MS);
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();
    this.persistTimer = timer;
    return this.persistPromise;
  }

  constructor() {
    installStorageCoordination(
      (reason) => this.loseAuthority(reason),
      () => this.stopPersistenceForHardReset(),
    );
    walletOperationRuntime.configureLifecycle({
      generation: () => this.lifecycleGeneration,
      isCurrent: (generation) => this.isGenerationCurrent(generation),
    });
    walletOperationRuntime.configurePersistence(async (entries) => {
      await this.saveWalletOperations(entries);
    });
  }

  private identityDiskChecked = false;
  private storageRepositoryHydratedFromDisk = false;
  private walletOperationRuntimeHydration: Promise<void> | null = null;
  private pendingCommonPatch: sessionState.CommonSessionPatch = {};

  _resetForTests(options: { preserveWalletOperationRuntime?: boolean } = {}): void {
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
    this.cached = null;
    this.stagedTerminal = null;
    this.identityDiskChecked = false;
    this.storageRepositoryHydratedFromDisk = false;
    this.walletOperationRuntimeHydration = null;
    this.pendingCommonPatch = {};
    resetStorageCoordinationForTests();
    if (!options.preserveWalletOperationRuntime) walletOperationRuntime.resetForTests();
  }

  loadState(): SessionSave {
    return (this.cached ??= loadPreferences());
  }

  hydrateOwnedStorage(): Promise<void> {
    return this.hydrateSessionCacheFromDiskStrict().then(() => {});
  }

  private hydrateWalletSnapshot(): Promise<void> {
    if (!this.hasAuthority()) return Promise.resolve();
    if (this.walletOperationRuntimeHydration) return this.walletOperationRuntimeHydration;
    walletOperationRuntime.beginHydration();
    this.walletOperationRuntimeHydration = (async () => {
      const record = await this.readAfterMutations(readWalletOperationRecord);
      walletOperationRuntime.hydrateFromDisk(record);
    })().catch((error) => {
      walletOperationRuntime.failHydration(error);
      throw error;
    });
    return this.walletOperationRuntimeHydration;
  }

  private async hydrateSessionCacheFromDiskStrict(): Promise<boolean> {
    if (this.fenced) {
      this.identityDiskChecked = true;
      this.storageRepositoryHydratedFromDisk = true;
      return false;
    }
    await this.hydrateWalletSnapshot();
    if (this.cached && sessionState.isDurableSession(this.cached)) {
      assertSessionWalletScope(this.cached, walletOperationRuntime.snapshot());
      this.identityDiskChecked = true;
      this.storageRepositoryHydratedFromDisk = true;
      return false;
    }
    if (!hasSavedSessionMarker()) {
      this.identityDiskChecked = true;
      this.storageRepositoryHydratedFromDisk = true;
      return false;
    }
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (this.persistPromise && this.cached && !sessionState.isDurableSession(this.cached)) {
      this.settleScheduledPersist();
    }

    const { record, discarded } = await this.readCompatibleSessionRecord();
    this.identityDiskChecked = true;
    this.storageRepositoryHydratedFromDisk = true;
    if (!record) {
      if (!discarded) return false;
      this.cached = loadPreferences();
      return true;
    }
    assertSessionWalletScope(record, walletOperationRuntime.snapshot());
    this.cached = sessionState.mergeDurableSession(record, this.cached ?? loadPreferences());
    savePreferences(this.cached);
    return false;
  }

  private async installClaimedStorageSnapshot(
    snapshot: ClaimedStorageSnapshot,
  ): Promise<SessionSave | null> {
    if (snapshot.walletOperationError) {
      walletOperationRuntime.beginHydration();
      walletOperationRuntime.failHydration(snapshot.walletOperationError);
      throw snapshot.walletOperationError;
    }
    let record: SessionSave | null = null;
    let discarded = false;
    if (snapshot.sessionError) {
      console.error('[save] rejecting unreadable session record:', snapshot.sessionError);
      await this.deleteSessionRecord();
      markSavedSession();
      discarded = true;
    } else if (snapshot.sessionRecord) {
      record = sessionState.decodeCurrentSession(snapshot.sessionRecord);
      if (!record) {
        console.error('[save] rejecting incompatible session record');
        await this.deleteSessionRecord();
        markSavedSession();
        discarded = true;
      }
    }
    const walletEntries =
      snapshot.walletOperationRecord === null
        ? []
        : decodeWalletOperationRecord(snapshot.walletOperationRecord).entries;
    if (record) assertSessionWalletScope(record, walletEntries);
    walletOperationRuntime.hydrateClaimedSnapshot(
      snapshot.walletOperationRecord,
      record && sessionState.isDurableSession(record) ? record.walletProviderScope : null,
    );
    this.walletOperationRuntimeHydration = Promise.resolve();

    const patch = this.pendingCommonPatch;
    this.pendingCommonPatch = {};
    this.cached = sessionState.mergeClaimedSession(record, loadPreferences(), patch);
    this.identityDiskChecked = true;
    this.storageRepositoryHydratedFromDisk = true;
    savePreferences(this.cached);

    const hasPatch = Object.keys(patch).length > 0;
    if (hasPatch) await this.queueWrite(this.cached);
    if (discarded) return null;
    if (record && sessionState.isDurableSession(record)) {
      markSavedSession();
      return this.cached;
    }
    if (
      sessionPreferences.hasConnectionPreferences(this.cached, hasWalletConnectStorage()) ||
      walletOperationRuntime.snapshot().length > 0 ||
      hasSavedSessionMarker()
    ) {
      return this.cached;
    }
    return null;
  }

  async claimLease(): Promise<ClaimedStorageSnapshot> {
    const snapshot = await this.claimAndRead(getStorageTabId());
    markLeaseClaimed();
    return snapshot;
  }

  async claimAndHydrateSession(): Promise<SessionSave | null> {
    const snapshot = await this.claimLease();
    return this.installClaimedStorageSnapshot(snapshot);
  }

  async hydrateSessionCacheFromDisk(): Promise<BootStorageHydrationResult> {
    try {
      if (!this.hasAuthority()) {
        const {
          sessionRecord: session,
          sessionError,
          walletOperationRecord: ledger,
        } = await this.inspect();
        const decoded =
          session && !sessionError ? sessionState.decodeCurrentSession(session) : null;
        if (ledger) decodeWalletOperationRecord(ledger);
        const discardedSession = sessionError !== undefined || (session !== null && !decoded);
        return {
          status: 'ready',
          discardedSession,
          durableSession: decoded && sessionState.isDurableSession(decoded) ? decoded : null,
        };
      }
      const discardedSession = await this.hydrateSessionCacheFromDiskStrict();
      const state = this.loadState();
      return {
        status: 'ready',
        discardedSession,
        durableSession: sessionState.isDurableSession(state) ? structuredClone(state) : null,
      };
    } catch (error) {
      return {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private mutateCommon(fn: (state: SessionSave) => SessionSave): Promise<void> {
    if (!this.hasAuthority()) {
      const state = this.loadState();
      const before = structuredClone(state);
      this.cached = fn(state);
      const patch = sessionState.commonPatch(before, this.cached);
      this.pendingCommonPatch = {
        identity: { ...this.pendingCommonPatch.identity, ...patch.identity },
        preferences: { ...this.pendingCommonPatch.preferences, ...patch.preferences },
        history: { ...this.pendingCommonPatch.history, ...patch.history },
      };
      savePreferences(this.cached);
      return Promise.resolve();
    }
    return this.mutateSession(fn);
  }

  private mutateSession(fn: (state: SessionSave) => SessionSave): Promise<void> {
    if (!this.hasAuthority()) return Promise.reject(this.authorityMutationError());
    const apply = () => {
      this.cached = fn(this.loadState());
      savePreferences(this.cached);
      return this.schedulePersist();
    };
    if (
      (this.cached && sessionState.isDurableSession(this.cached)) ||
      !hasSavedSessionMarker() ||
      this.storageRepositoryHydratedFromDisk
    ) {
      return apply();
    }
    return this.hydrateSessionCacheFromDiskStrict().then(apply);
  }

  getPlayerId(): string {
    const state = this.loadState();
    if (this.hasAuthority()) {
      savePreferences(state);
    } else {
      this.pendingCommonPatch.identity = {
        ...this.pendingCommonPatch.identity,
        playerId: state.identity.playerId,
      };
    }
    return state.identity.playerId;
  }

  async ensureHubIdentity(): Promise<string> {
    if (!this.hasAuthority()) {
      await this.peekSession();
      if (this.loadState().identity.sessionId) return this.loadState().identity.sessionId!;
      throw new Error('Hub identity cannot be minted before durable storage authority is claimed');
    }
    if (hasSavedSessionMarker() && !this.identityDiskChecked) {
      await this.hydrateSessionCacheFromDiskStrict();
    }
    this.identityDiskChecked = true;
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
    if (hasSavedSessionMarker() && !this.identityDiskChecked) {
      throw new Error(
        'getSessionId called before ensureHubIdentity/hydrate with a saved session marker',
      );
    }
    state.identity.sessionId = randomHex();
    savePreferences(state);
    void this.schedulePersist();
    return state.identity.sessionId;
  }

  regenerateSessionId(): string {
    this.identityDiskChecked = true;
    const state = this.loadState();
    state.identity.sessionId = randomHex();
    state.identity.myHubPlayerId = undefined;
    if (this.hasAuthority()) {
      savePreferences(state);
      void this.schedulePersist();
    } else {
      this.pendingCommonPatch.identity = {
        ...this.pendingCommonPatch.identity,
        sessionId: state.identity.sessionId,
        myHubPlayerId: undefined,
      };
    }
    return state.identity.sessionId;
  }

  clearHubIdentity(): void {
    this.identityDiskChecked = true;
    void this.mutateCommon((state) => ({
      ...state,
      identity: { ...state.identity, sessionId: undefined, myHubPlayerId: undefined },
    }));
  }

  saveSession(update: sessionState.SessionStateUpdate): Promise<void> {
    const apply = (state: SessionSave) => sessionState.applySessionUpdate(state, update);
    return update.scope === 'common' ? this.mutateCommon(apply) : this.mutateSession(apply);
  }

  patchPreHandshakeTransport(
    transport: sessionState.SessionReplacement['transport'],
  ): Promise<void> {
    return this.mutateSession((state) => sessionState.patchSessionTransport(state, transport));
  }

  clearSessionPairing(): Promise<void> {
    return this.mutateSession(sessionState.clearSessionPeer);
  }

  async replaceSession(checkpoint: sessionState.SessionReplacement): Promise<void> {
    if (!this.hasAuthority()) throw this.authorityMutationError();
    await this.hydrateSessionCacheFromDiskStrict();
    if (this.persistPromise) await this.flushSessionSave();
    const replacement = sessionState.createPreHandshakeSession(this.loadState(), checkpoint);
    await this.queueWrite(replacement);
    this.cached = replacement;
    this.stagedTerminal = null;
    savePreferences(replacement);
  }

  saveTerminalSession(fields: sessionState.TerminalFields): Promise<void> {
    return this.mutateSession((state) => sessionState.createTerminalSession(state, fields));
  }

  async stageTerminalSession(fields: sessionState.TerminalFields): Promise<void> {
    if (!this.hasAuthority()) throw this.authorityMutationError();
    await this.hydrateSessionCacheFromDiskStrict();
    this.stagedTerminal = sessionState.createTerminalSession(this.loadState(), fields);
  }

  discardStagedTerminalSession(): void {
    this.stagedTerminal = null;
  }

  async peekSession(): Promise<SessionSave | null> {
    if (!this.hasAuthority()) {
      const { sessionRecord: rawSession, walletOperationRecord: rawLedger } = await this.inspect();
      if (rawLedger) decodeWalletOperationRecord(rawLedger);
      const inspected = rawSession ? sessionState.decodeCurrentSession(rawSession) : null;
      if (rawSession && !inspected) console.error('[save] rejecting incompatible session record');
      if (inspected) {
        const local = loadPreferences();
        this.cached = sessionState.mergeInspectedSession(inspected, local, this.pendingCommonPatch);
        this.identityDiskChecked = true;
        this.storageRepositoryHydratedFromDisk = true;
        if (
          sessionState.isDurableSession(inspected) ||
          sessionPreferences.hasConnectionPreferences(inspected, hasWalletConnectStorage())
        )
          return this.cached;
      }
      const preferences = loadPreferences();
      return sessionPreferences.hasConnectionPreferences(preferences, hasWalletConnectStorage()) ||
        rawLedger?.entries.length
        ? preferences
        : null;
    }
    const wipedIncompatible = await this.hydrateSessionCacheFromDiskStrict();
    if (this.persistPromise) await this.flushSessionSave();
    const { record, discarded } = await this.readCompatibleSessionRecord();
    if (discarded) {
      this.cached = loadPreferences();
      return null;
    }
    if (record) {
      this.cached = sessionState.mergeInspectedSession(record, loadPreferences(), {});
      savePreferences(this.cached);
      if (sessionState.isDurableSession(this.cached)) {
        markSavedSession();
        return this.cached;
      }
      if (
        sessionPreferences.hasConnectionPreferences(this.cached, hasWalletConnectStorage()) ||
        walletOperationRuntime.snapshot().length > 0
      ) {
        markSavedSession();
        return this.cached;
      }
      clearSavedSessionMarker();
      return null;
    }
    this.cached = loadPreferences();
    if (sessionPreferences.hasConnectionPreferences(this.cached, hasWalletConnectStorage())) {
      markSavedSession();
      return this.cached;
    }
    if (!wipedIncompatible) {
      clearSavedSessionMarker();
    }
    return null;
  }

  clearSession(): Promise<void> {
    if (!this.hasAuthority()) return Promise.reject(this.authorityMutationError());
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.settleScheduledPersist();
    this.cached = sessionState.freshSessionState(this.loadState());
    savePreferences(this.cached);
    const deletePromise = this.deleteSessionRecord().then(() => {
      if (
        this.cached?.preferences.blockchainType ||
        this.cached?.preferences.hubUrl ||
        walletOperationRuntime.snapshot().length > 0
      ) {
        markSavedSession();
      } else {
        clearSavedSessionMarker();
      }
    });
    return deletePromise;
  }

  replaceSessionWithRejection(tombstone: DurableRejectionTombstone): Promise<void> {
    if (!this.hasAuthority()) return Promise.reject(this.authorityMutationError());
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.settleScheduledPersist();
    this.cached = sessionState.freshSessionState(this.loadState());
    savePreferences(this.cached);
    const snapshot = structuredClone(tombstone);
    const replacePromise = this.runAuthorizedMutation((authority) =>
      indexedDbStoragePort.replaceSessionWithRejection(snapshot, authority),
    ).then(() => {
      if (
        this.cached?.preferences.blockchainType ||
        this.cached?.preferences.hubUrl ||
        walletOperationRuntime.snapshot().length > 0
      ) {
        markSavedSession();
      } else {
        clearSavedSessionMarker();
      }
    });
    return replacePromise;
  }

  async clearGameSessionPreservingHistory(
    history?: Partial<SessionSave['history']>,
  ): Promise<void> {
    if (!this.hasAuthority()) throw this.authorityMutationError();
    await this.hydrateSessionCacheFromDiskStrict();
    if (this.persistPromise) await this.flushSessionSave();
    const current = sessionState.applySessionUpdate(this.loadState(), {
      scope: 'common',
      history,
    });
    const checkpoint = sessionState.preservationCheckpoint(current);
    const replacement = checkpoint
      ? sessionState.createPreHandshakeSession(current, checkpoint)
      : sessionState.freshSessionState(current);
    await this.queueWrite(replacement);
    this.cached = replacement;
    this.stagedTerminal = null;
    savePreferences(replacement);
    if (
      sessionPreferences.hasConnectionPreferences(replacement, hasWalletConnectStorage()) ||
      walletOperationRuntime.snapshot().length > 0 ||
      sessionState.isDurableSession(replacement)
    ) {
      markSavedSession();
    } else {
      clearSavedSessionMarker();
    }
  }

  async hardReset(): Promise<HardResetResult> {
    const authority = await this.beginHardReset(getStorageTabId());
    this.stopPersistenceForHardReset();
    walletOperationRuntime.clearForHardReset();
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
      this.cached = sessionPreferences.applySessionPreferenceUpdate(state, {
        key: 'alias',
        value: generated,
      });
      this.pendingCommonPatch.preferences = {
        ...this.pendingCommonPatch.preferences,
        alias: generated,
      };
    }
    return generated;
  }
}

export const storageRepository = new StorageRepository();
