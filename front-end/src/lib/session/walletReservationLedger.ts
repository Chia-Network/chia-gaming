import type {
  WalletOfferProvider,
  WalletOfferCompletion,
  WalletOfferRequest,
  WalletOfferCancellationOutcome,
} from '../../types/ChiaGaming';
import { log } from '../../services/log';
import { jsonStringify } from '../../util/jsonSafe';
import {
  decodeWalletReservationLedger,
  decodeWalletReservationRecord,
  MAX_WALLET_RESERVATION_REASON_LENGTH,
  walletReservationOperationKey,
  walletReservationOperationPrefix,
  walletReservationOwnerKey,
  walletProviderScopeKey,
  type WalletReservationLedgerEntry,
  type WalletReservationCancellationEntry,
  type WalletReservationRecoveryEntry,
  type WalletReservationTradeEntry,
  type WalletReservationOwner,
  type WalletReservationPurpose,
  type WalletReservationRecoveryRequest,
} from './walletReservationLedgerSchema';
import type { CanonicalFundingRequest } from './fundingRequest';

type PersistLedger = (entries: WalletReservationLedgerEntry[]) => Promise<void>;

export interface WalletReservationLedgerCheckpoint {
  entries: WalletReservationLedgerEntry[];
  revision: number;
}

function boundedReason(reason: string): string {
  return reason.slice(0, MAX_WALLET_RESERVATION_REASON_LENGTH);
}

export type WalletReservationTransition =
  | { kind: 'retire-creation'; reason: string }
  | { kind: 'creation-completed'; tradeId?: string; reason: string }
  | { kind: 'creation-rejected' }
  | { kind: 'require-cancellation'; reason: string }
  | { kind: 'cancellation-pending'; recoveryId: string }
  | { kind: 'cancellation-failed'; reason: string }
  | { kind: 'cancellation-completed' };

export function transitionWalletReservation(
  entry: WalletReservationLedgerEntry,
  transition: WalletReservationTransition,
): WalletReservationLedgerEntry | null {
  switch (transition.kind) {
    case 'retire-creation':
      if (entry.stage !== 'creating') return entry;
      return {
        ...entry,
        disposition: 'cancel-on-create',
        reason: boundedReason(transition.reason),
      };
    case 'creation-completed':
      if (entry.stage !== 'creating')
        throw new Error('Creation completion requires creating state');
      return transition.tradeId
        ? {
            owner: entry.owner,
            purpose: entry.purpose,
            stage: entry.disposition === 'cancel-on-create' ? 'cancel-required' : 'reserved',
            tradeId: transition.tradeId,
            reason: boundedReason(transition.reason),
          }
        : null;
    case 'creation-rejected':
      if (entry.stage !== 'creating') throw new Error('Creation rejection requires creating state');
      return null;
    case 'require-cancellation':
      if (entry.stage === 'creating') {
        return {
          ...entry,
          disposition: 'cancel-on-create',
          reason: boundedReason(transition.reason),
        };
      }
      return 'tradeId' in entry
        ? {
            owner: entry.owner,
            purpose: entry.purpose,
            stage: 'cancel-required',
            tradeId: entry.tradeId,
            reason: boundedReason(transition.reason),
          }
        : entry;
    case 'cancellation-pending':
      if (entry.stage !== 'cancel-required') {
        throw new Error('Pending cancellation requires cancel-required state');
      }
      return { ...entry, stage: 'cancelling', recoveryId: transition.recoveryId };
    case 'cancellation-failed':
      if (entry.stage !== 'cancelling') {
        throw new Error('Cancellation failure requires cancelling state');
      }
      return {
        owner: entry.owner,
        purpose: entry.purpose,
        stage: 'cancel-required',
        tradeId: entry.tradeId,
        reason: boundedReason(transition.reason),
      };
    case 'cancellation-completed':
      if (entry.stage !== 'cancel-required' && entry.stage !== 'cancelling') {
        throw new Error('Cancellation completion requires cancellation state');
      }
      return null;
  }
}

export class WalletReservationCoordinator {
  private readonly entriesByTradeId = new Map<
    string,
    WalletReservationTradeEntry | WalletReservationCancellationEntry
  >();
  private readonly recoveriesByOperation = new Map<string, WalletReservationRecoveryEntry>();
  private readonly inFlightAttempts = new Map<string, Promise<unknown>>();
  private readonly inFlightCancellations = new Map<string, Promise<void>>();
  private readonly coordinatedLaunchRequired = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private readonly providers = new Map<string, WalletOfferProvider>();
  private persist: PersistLedger | null = null;
  private initialized = false;
  private dirty = false;
  private revision = 0;
  private coordinatedDirtyRevision: number | null = null;
  private lastPersistence: Promise<void> = Promise.resolve();
  private hydrationPromise!: Promise<void>;
  private hydrationResolve!: () => void;
  private hydrationReject!: (error: unknown) => void;
  private hydrationState: 'pending' | 'ready' | 'failed' = 'ready';

  constructor() {
    this.resetHydration(true);
  }

  awaitHydrated(): Promise<void> {
    return this.hydrationPromise;
  }

  beginHydration(): void {
    if (this.hydrationState === 'ready' && !this.initialized) {
      this.resetHydration(false);
    }
  }

  runAfterHydration<T>(run: () => Promise<T> | T): Promise<T> | T {
    if (this.hydrationState === 'ready') return run();
    return this.hydrationPromise.then(run);
  }

  failHydration(error: unknown): void {
    if (this.hydrationState !== 'pending') return;
    this.hydrationState = 'failed';
    this.hydrationReject(error);
  }

  configurePersistence(persist: PersistLedger): void {
    this.persist = persist;
  }

  attachProvider(provider: WalletOfferProvider): void {
    const key = walletProviderScopeKey(provider.scope);
    if (this.providers.get(key) === provider) return;
    this.providers.set(key, provider);
    this.retryCancelRequiredForScope(provider.scope);
    this.retryCreatingForScope(provider.scope);
    this.notify();
  }

  providerReady(provider: WalletOfferProvider): void {
    if (this.providers.get(walletProviderScopeKey(provider.scope)) !== provider) return;
    this.retryCancelRequiredForScope(provider.scope);
    this.retryCreatingForScope(provider.scope);
  }

  getScopeStatus(
    installationPlayerId: string,
    peerSessionId: string,
  ): { kind: 'ready' } | { kind: 'unavailable' } | { kind: 'mismatch' } {
    const relevant = this.snapshot().filter(
      (entry) =>
        entry.owner.installationPlayerId === installationPlayerId &&
        entry.owner.peerSessionId === peerSessionId,
    );
    if (relevant.length === 0) return { kind: 'ready' };
    const scopes = new Set(this.providers.keys());
    if (scopes.size === 0) return { kind: 'unavailable' };
    return relevant.every((entry) => scopes.has(walletProviderScopeKey(entry.owner.providerScope)))
      ? { kind: 'ready' }
      : { kind: 'mismatch' };
  }

  getRecoveryReadiness(): 'ready' | 'wallet-unavailable' | 'scope-mismatch' {
    const entries = this.snapshot();
    if (entries.length === 0) return 'ready';
    if (this.providers.size === 0) return 'wallet-unavailable';
    return entries.some(
      (entry) => !this.providers.has(walletProviderScopeKey(entry.owner.providerScope)),
    )
      ? 'scope-mismatch'
      : 'ready';
  }

  detachProvider(provider: WalletOfferProvider): void {
    const key = walletProviderScopeKey(provider.scope);
    if (this.providers.get(key) !== provider) return;
    this.providers.delete(key);
    this.notify();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): WalletReservationLedgerEntry[] {
    return [...this.entriesByTradeId.values(), ...this.recoveriesByOperation.values()].map(
      (entry) => structuredClone(entry),
    );
  }

  isDirty(): boolean {
    return this.dirty;
  }

  hydrateFromDisk(record: unknown | null): void {
    try {
      const entries = record === null ? [] : decodeWalletReservationRecord(record).entries;
      this.hydrateEntries(entries);
      if (this.hydrationState === 'pending') {
        this.hydrationState = 'ready';
        this.hydrationResolve();
      }
    } catch (error) {
      this.failHydration(error);
      throw error;
    }
  }

  hydrateClaimedSnapshot(record: unknown | null): void {
    this.entriesByTradeId.clear();
    this.recoveriesByOperation.clear();
    this.inFlightAttempts.clear();
    this.inFlightCancellations.clear();
    this.coordinatedLaunchRequired.clear();
    this.initialized = false;
    this.dirty = false;
    this.coordinatedDirtyRevision = null;
    this.lastPersistence = Promise.resolve();
    this.resetHydration(false);
    this.hydrateFromDisk(record);
  }

  private hydrateEntries(decoded: WalletReservationLedgerEntry[]): void {
    if (!this.initialized) {
      this.initialized = true;
    }
    for (const diskEntry of decoded) this.mergeDiskEntry(diskEntry);
    this.persistIfDirty();
    for (const entry of this.entriesByTradeId.values()) {
      if (entry.stage === 'cancel-required' || entry.stage === 'cancelling') {
        this.scheduleCancellationAfterPersistence(entry);
      }
    }
    this.notify();
  }

  /** Test/standalone restore; production hydration checkpoints after cache merge. */
  restore(entries: unknown): void {
    this.hydrateEntries(decodeWalletReservationLedger(entries, 'walletReservationLedger'));
    this.persistIfDirty();
  }

  persistIfDirty(): Promise<void> {
    if (this.dirty && this.coordinatedDirtyRevision === null) this.persistSnapshot();
    return this.lastPersistence;
  }

  flushPersistence(): Promise<void> {
    return this.lastPersistence;
  }

  checkpoint(): WalletReservationLedgerCheckpoint {
    return { entries: this.snapshot(), revision: this.revision };
  }

  combinedCheckpointPersisted(checkpoint: WalletReservationLedgerCheckpoint): void {
    if (
      this.coordinatedDirtyRevision !== null &&
      this.coordinatedDirtyRevision <= checkpoint.revision
    ) {
      this.coordinatedDirtyRevision = null;
    }
    if (this.revision === checkpoint.revision) {
      this.dirty = false;
    } else if (this.dirty && this.coordinatedDirtyRevision === null) {
      this.persistSnapshot();
    }
  }

  registerReserved(
    tradeId: string,
    owner: WalletReservationOwner,
    purpose: WalletReservationPurpose,
    reason = 'wallet-offer-created',
  ): WalletReservationLedgerEntry {
    this.initialized = true;
    const decoded = decodeWalletReservationLedger(
      [
        {
          tradeId,
          owner,
          purpose,
          stage: 'reserved',
          reason: boundedReason(reason),
        },
      ],
      'wallet reservation registration',
    )[0]!;
    if (decoded.stage === 'creating') {
      throw new Error('Internal wallet reservation registration error');
    }
    const existingTrade = this.entriesByTradeId.get(decoded.tradeId);
    if (existingTrade) {
      if (
        walletReservationOperationKey(existingTrade.owner, existingTrade.purpose) !==
        walletReservationOperationKey(decoded.owner, decoded.purpose)
      ) {
        throw new Error(`Wallet trade ${decoded.tradeId} belongs to another operation`);
      }
      return structuredClone(existingTrade);
    }
    this.install(decoded);
    this.changed();
    return structuredClone(decoded);
  }

  resolve(tradeId: string): void {
    this.remove(tradeId);
    this.changed();
  }

  resolveCoordinated(tradeId: string): void {
    this.remove(tradeId);
    this.changed(true);
  }

  requireCancellation(tradeId: string, reason: string): void {
    const entry = this.entriesByTradeId.get(tradeId);
    if (!entry) return;
    const required = transitionWalletReservation(entry, {
      kind: 'require-cancellation',
      reason,
    });
    if (!required || required.stage === 'creating') {
      throw new Error('Trade cancellation transition produced invalid state');
    }
    this.entriesByTradeId.set(tradeId, required);
    this.changed();
    this.scheduleCancellationAfterPersistence(required);
  }

  requireCancellationCoordinated(tradeId: string, reason: string): void {
    const entry = this.entriesByTradeId.get(tradeId);
    if (!entry) return;
    const required = transitionWalletReservation(entry, {
      kind: 'require-cancellation',
      reason,
    });
    if (!required || required.stage === 'creating') {
      throw new Error('Trade cancellation transition produced invalid state');
    }
    this.entriesByTradeId.set(tradeId, required);
    this.coordinatedLaunchRequired.add(tradeId);
    this.changed(true);
  }

  retainForReplay(tradeId: string, reason = 'fee-source-attached'): void {
    const entry = this.entriesByTradeId.get(tradeId);
    if (!entry) {
      throw new Error(`Cannot retain unknown wallet trade ${tradeId}`);
    }
    entry.stage = 'retained-for-replay';
    entry.reason = boundedReason(reason);
    this.changed();
  }

  retainForReplayCoordinated(tradeId: string, reason = 'fee-source-attached'): void {
    const entry = this.entriesByTradeId.get(tradeId);
    if (!entry) {
      throw new Error(`Cannot retain unknown wallet trade ${tradeId}`);
    }
    entry.stage = 'retained-for-replay';
    entry.reason = boundedReason(reason);
    this.changed(true);
  }

  routeStaleResult(
    tradeId: string,
    owner: WalletReservationOwner,
    purpose: WalletReservationPurpose,
    reason: string,
  ): void {
    const decoded = decodeWalletReservationLedger(
      [{ tradeId, owner, purpose, stage: 'cancel-required', reason: boundedReason(reason) }],
      'stale wallet reservation result',
    )[0]!;
    const existing = this.entriesByTradeId.get(tradeId);
    if (existing) {
      if (
        walletReservationOperationKey(existing.owner, existing.purpose) !==
        walletReservationOperationKey(owner, purpose)
      ) {
        throw new Error(`Wallet trade ${tradeId} belongs to another operation`);
      }
      const required = transitionWalletReservation(existing, {
        kind: 'require-cancellation',
        reason: decoded.reason,
      });
      if (!required || required.stage === 'creating') {
        throw new Error('Stale trade cancellation transition produced invalid state');
      }
      this.entriesByTradeId.set(tradeId, required);
    } else {
      this.install(decoded);
    }
    this.changed();
    const entry = this.entriesByTradeId.get(tradeId)!;
    this.scheduleCancellationAfterPersistence(entry);
  }

  hasBlockingOperation(owner: WalletReservationOwner, purpose: WalletReservationPurpose): boolean {
    const operation = walletReservationOperationKey(owner, purpose);
    return this.snapshot().some(
      (entry) => walletReservationOperationKey(entry.owner, entry.purpose) === operation,
    );
  }

  hasBlockingTradeOperation(
    owner: WalletReservationOwner,
    purpose: WalletReservationPurpose,
  ): boolean {
    const operation = walletReservationOperationKey(owner, purpose);
    return [...this.entriesByTradeId.values()].some(
      (entry) => walletReservationOperationKey(entry.owner, entry.purpose) === operation,
    );
  }

  entriesFor(owner: WalletReservationOwner): WalletReservationLedgerEntry[] {
    const ownerKey = walletReservationOwnerKey(owner);
    return this.snapshot().filter((entry) => walletReservationOwnerKey(entry.owner) === ownerKey);
  }

  hasEntriesForSession(installationPlayerId: string, peerSessionId: string): boolean {
    return this.snapshot().some(
      (entry) =>
        entry.owner.installationPlayerId === installationPlayerId &&
        entry.owner.peerSessionId === peerSessionId,
    );
  }

  creatingFundingEntryForSession(
    installationPlayerId: string,
    peerSessionId: string,
  ): WalletReservationRecoveryEntry | null {
    const entries = [...this.recoveriesByOperation.values()].filter(
      (entry) =>
        entry.purpose.kind === 'funding' &&
        entry.request.kind === 'funding' &&
        entry.owner.installationPlayerId === installationPlayerId &&
        entry.owner.peerSessionId === peerSessionId,
    );
    if (entries.length > 1) {
      throw new Error('Wallet reservation ledger contains conflicting funding recoveries');
    }
    return entries[0] ? structuredClone(entries[0]) : null;
  }

  retainedEntriesForOperation(
    owner: WalletReservationOwner,
    purpose: WalletReservationPurpose,
  ): WalletReservationTradeEntry[] {
    const operation = walletReservationOperationKey(owner, purpose);
    return this.snapshot().filter(
      (entry): entry is WalletReservationTradeEntry =>
        entry.stage === 'retained-for-replay' &&
        walletReservationOperationKey(entry.owner, entry.purpose) === operation,
    );
  }

  async createOffer(
    owner: WalletReservationOwner,
    purpose: WalletReservationPurpose,
    request: WalletOfferRequest,
    recoveryRequest: WalletReservationRecoveryRequest = request.kind === 'fee'
      ? request
      : (() => {
          throw new Error('Funding creation requires its canonical durable request');
        })(),
    isRetired: () => boolean = () => false,
  ): Promise<WalletOfferCompletion> {
    await this.awaitHydrated();
    const provider = this.providerFor(owner);
    if (!provider) {
      return {
        kind: 'unavailable',
        reason: 'Reconnect the original wallet account to resume this operation',
      };
    }
    const operation = { owner, purpose };
    const key = walletReservationOperationKey(owner, purpose);
    if (
      [...this.entriesByTradeId.values()].some(
        (entry) => walletReservationOperationKey(entry.owner, entry.purpose) === key,
      )
    ) {
      throw new Error('Wallet reservation cleanup is pending for this operation');
    }
    return this.runAttempt(
      owner,
      purpose,
      async () => {
        let recovery = this.recoveriesByOperation.get(key);
        let completion: WalletOfferCompletion;
        if (recovery?.stage === 'creating') {
          if (jsonStringify(recovery.request) !== jsonStringify(recoveryRequest)) {
            throw new Error('Persisted wallet offer request conflicts with the requested recovery');
          }
          if (provider.capability !== 'recoverable') {
            throw new Error('Wallet provider cannot reconcile its persisted offer creation');
          }
          completion = await provider.reconcileCreation(operation, request, recovery.recoveryId);
        } else {
          if (provider.capability === 'best-effort') {
            completion = await provider.beginCreation(operation, request);
          } else {
            const begun = await provider.beginCreation(operation, request);
            if (begun.kind !== 'pending') {
              completion = begun;
            } else {
              recovery = {
                owner,
                purpose,
                stage: 'creating',
                disposition: isRetired() ? 'cancel-on-create' : 'active',
                recoveryId: begun.recoveryId,
                request: structuredClone(recoveryRequest),
                reason: boundedReason('wallet-offer-creation-pending'),
              };
              this.recoveriesByOperation.set(key, recovery);
              this.changed();
              await this.flushPersistence();
              completion = await provider.reconcileCreation(operation, request, begun.recoveryId);
            }
          }
        }
        if (completion.kind === 'created') {
          if (recovery) {
            this.recoveriesByOperation.delete(key);
            const transitioned = transitionWalletReservation(recovery, {
              kind: 'creation-completed',
              tradeId: completion.tradeId,
              reason: `${purpose.kind}-offer-created`,
            });
            if (transitioned) this.install(transitioned);
            this.changed();
            if (transitioned?.stage === 'cancel-required') {
              this.scheduleCancellationAfterPersistence(transitioned);
            }
          } else if (completion.tradeId) {
            this.registerReserved(
              completion.tradeId,
              owner,
              purpose,
              `${purpose.kind}-offer-created`,
            );
          }
        } else if (completion.kind === 'failure' && recovery) {
          this.recoveriesByOperation.delete(key);
          this.changed();
        }
        return completion;
      },
      true,
    );
  }

  settleOperation(
    owner: WalletReservationOwner,
    purpose: WalletReservationPurpose,
    disposition: 'consumed' | 'cancel-required' | 'retained-for-replay',
    reason: string,
    coordinated = false,
  ): void {
    const operation = walletReservationOperationKey(owner, purpose);
    for (const entry of [...this.entriesByTradeId.values()]) {
      if (walletReservationOperationKey(entry.owner, entry.purpose) !== operation) continue;
      if (disposition === 'consumed') {
        if (coordinated) this.resolveCoordinated(entry.tradeId);
        else this.resolve(entry.tradeId);
      } else if (disposition === 'cancel-required') {
        if (coordinated) this.requireCancellationCoordinated(entry.tradeId, reason);
        else this.requireCancellation(entry.tradeId, reason);
      } else {
        if (coordinated) this.retainForReplayCoordinated(entry.tradeId, reason);
        else this.retainForReplay(entry.tradeId, reason);
      }
    }
  }

  retireOperation(
    owner: WalletReservationOwner,
    purpose: WalletReservationPurpose,
    reason: string,
    coordinated = false,
  ): void {
    const operation = walletReservationOperationKey(owner, purpose);
    const recovery = this.recoveriesByOperation.get(operation);
    if (recovery) {
      this.recoveriesByOperation.set(
        operation,
        transitionWalletReservation(recovery, {
          kind: 'retire-creation',
          reason,
        }) as WalletReservationRecoveryEntry,
      );
      this.changed(coordinated);
    }
    this.settleOperation(owner, purpose, 'cancel-required', reason, coordinated);
  }

  promoteReservedForOwner(owner: WalletReservationOwner, reason: string): void {
    const ownerKey = walletReservationOwnerKey(owner);
    for (const [operation, entry] of this.recoveriesByOperation) {
      if (walletReservationOwnerKey(entry.owner) !== ownerKey) continue;
      this.recoveriesByOperation.set(
        operation,
        transitionWalletReservation(entry, {
          kind: 'retire-creation',
          reason,
        }) as WalletReservationRecoveryEntry,
      );
      this.changed();
    }
    for (const entry of [...this.entriesByTradeId.values()]) {
      if (entry.stage === 'reserved' && walletReservationOwnerKey(entry.owner) === ownerKey) {
        this.requireCancellation(entry.tradeId, reason);
      }
    }
  }

  async runAttempt<T>(
    owner: WalletReservationOwner,
    purpose: WalletReservationPurpose,
    launch: () => Promise<T>,
    allowExisting = false,
  ): Promise<T> {
    await this.awaitHydrated();
    const key = walletReservationOperationKey(owner, purpose);
    if (!allowExisting && this.hasBlockingOperation(owner, purpose)) {
      throw new Error('Wallet reservation cleanup is pending for this operation');
    }
    const existing = this.inFlightAttempts.get(key);
    if (existing) return existing as Promise<T>;
    const attempt = launch().finally(() => {
      if (this.inFlightAttempts.get(key) === attempt) this.inFlightAttempts.delete(key);
    });
    this.inFlightAttempts.set(key, attempt);
    return attempt;
  }

  retryCancelRequired(owner?: WalletReservationOwner): void {
    const ownerKey = owner ? walletReservationOwnerKey(owner) : undefined;
    for (const entry of this.entriesByTradeId.values()) {
      if (
        (entry.stage === 'cancel-required' || entry.stage === 'cancelling') &&
        !this.coordinatedLaunchRequired.has(entry.tradeId) &&
        (ownerKey === undefined || walletReservationOwnerKey(entry.owner) === ownerKey)
      ) {
        this.attemptCancellation(entry);
      }
    }
  }

  private retryCancelRequiredForScope(scope: WalletReservationOwner['providerScope']): void {
    const scopeKey = walletProviderScopeKey(scope);
    for (const entry of this.entriesByTradeId.values()) {
      if (
        (entry.stage === 'cancel-required' || entry.stage === 'cancelling') &&
        walletProviderScopeKey(entry.owner.providerScope) === scopeKey &&
        !this.coordinatedLaunchRequired.has(entry.tradeId)
      ) {
        this.attemptCancellation(entry);
      }
    }
  }

  private retryCreatingForScope(scope: WalletReservationOwner['providerScope']): void {
    const scopeKey = walletProviderScopeKey(scope);
    for (const entry of this.recoveriesByOperation.values()) {
      if (walletProviderScopeKey(entry.owner.providerScope) !== scopeKey) continue;
      if (entry.disposition !== 'cancel-on-create') continue;
      void this.reconcileDetachedCreation(entry);
    }
  }

  launchCancellation(tradeId: string): Promise<void> {
    this.coordinatedLaunchRequired.delete(tradeId);
    const entry = this.entriesByTradeId.get(tradeId);
    if (!entry || (entry.stage !== 'cancel-required' && entry.stage !== 'cancelling')) {
      return Promise.resolve();
    }
    return this.attemptCancellation(entry);
  }

  async awaitOwner(owner: WalletReservationOwner): Promise<void> {
    const ownerKey = walletReservationOwnerKey(owner);
    const operationPrefix = walletReservationOperationPrefix(owner);
    // Attachment-triggered reconciliation enters runAttempt after its already
    // resolved hydration gate, so give that continuation one turn to register.
    await Promise.resolve();
    for (;;) {
      const pending = [
        ...[...this.inFlightAttempts.entries()]
          .filter(([operation]) => operation.startsWith(operationPrefix))
          .map(([, promise]) => promise),
        ...[...this.inFlightCancellations.entries()]
          .filter(([tradeId]) => {
            const entry = this.entriesByTradeId.get(tradeId);
            return entry !== undefined && walletReservationOwnerKey(entry.owner) === ownerKey;
          })
          .map(([, promise]) => promise),
      ];
      if (pending.length === 0) return;
      await Promise.allSettled(pending);
    }
  }

  private install(entry: WalletReservationLedgerEntry): void {
    if (entry.stage === 'creating') {
      this.recoveriesByOperation.set(
        walletReservationOperationKey(entry.owner, entry.purpose),
        entry,
      );
    } else {
      this.entriesByTradeId.set(entry.tradeId, entry);
    }
  }

  private promoteRestoredEntry(entry: WalletReservationLedgerEntry): WalletReservationLedgerEntry {
    return entry.stage === 'reserved'
      ? {
          ...entry,
          stage: 'cancel-required',
          reason: boundedReason('orphaned-reservation-restored'),
        }
      : entry;
  }

  private mergeDiskEntry(diskEntry: WalletReservationLedgerEntry): void {
    if (diskEntry.stage === 'creating') {
      const operation = walletReservationOperationKey(diskEntry.owner, diskEntry.purpose);
      if (!this.recoveriesByOperation.has(operation)) this.install(diskEntry);
      return;
    }
    const byTrade = this.entriesByTradeId.get(diskEntry.tradeId);
    if (
      byTrade &&
      walletReservationOperationKey(byTrade.owner, byTrade.purpose) !==
        walletReservationOperationKey(diskEntry.owner, diskEntry.purpose)
    ) {
      throw new Error(`Wallet reservation ledger conflict for trade ${diskEntry.tradeId}`);
    }
    if (byTrade) return;
    this.install(this.promoteRestoredEntry(diskEntry));
    if (diskEntry.stage === 'reserved') this.markDirty();
  }

  private remove(tradeId: string): void {
    const entry = this.entriesByTradeId.get(tradeId);
    if (!entry) return;
    this.entriesByTradeId.delete(tradeId);
    this.coordinatedLaunchRequired.delete(tradeId);
  }

  private changed(coordinated = false): void {
    this.markDirty(coordinated);
    if (this.coordinatedDirtyRevision === null) this.persistSnapshot();
    this.notify();
  }

  private markDirty(coordinated = false): void {
    this.dirty = true;
    this.revision += 1;
    if (coordinated) this.coordinatedDirtyRevision = this.revision;
  }

  private persistSnapshot(): void {
    const persist = this.persist;
    if (!persist) return;
    const snapshot = this.snapshot();
    const revision = this.revision;
    const attempt = persist(snapshot).then(
      () => {
        if (this.revision === revision) this.dirty = false;
      },
      (error) => {
        this.dirty = true;
        log(`[wallet-reservation-ledger] persistence failed: ${String(error)}`);
      },
    );
    this.lastPersistence = attempt;
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private scheduleCancellationAfterPersistence(entry: WalletReservationLedgerEntry): Promise<void> {
    if (entry.stage !== 'cancel-required' && entry.stage !== 'cancelling') {
      return Promise.resolve();
    }
    const existing = this.inFlightCancellations.get(entry.tradeId);
    if (existing) return existing;
    const scheduled = this.flushPersistence()
      .then(() => this.performCancellation(entry))
      .finally(() => {
        if (this.inFlightCancellations.get(entry.tradeId) === scheduled) {
          this.inFlightCancellations.delete(entry.tradeId);
        }
      });
    this.inFlightCancellations.set(entry.tradeId, scheduled);
    return scheduled;
  }

  private attemptCancellation(entry: WalletReservationLedgerEntry): Promise<void> {
    if (entry.stage !== 'cancel-required' && entry.stage !== 'cancelling') {
      return Promise.resolve();
    }
    const existing = this.inFlightCancellations.get(entry.tradeId);
    if (existing) return existing;
    if (!this.providerFor(entry.owner)) return Promise.resolve();
    const attempt = this.performCancellation(entry).finally(() => {
      if (this.inFlightCancellations.get(entry.tradeId) === attempt) {
        this.inFlightCancellations.delete(entry.tradeId);
      }
    });
    this.inFlightCancellations.set(entry.tradeId, attempt);
    return attempt;
  }

  private async performCancellation(entry: WalletReservationLedgerEntry): Promise<void> {
    if (entry.stage !== 'cancel-required' && entry.stage !== 'cancelling') return;
    await this.awaitHydrated();
    const provider = this.providerFor(entry.owner);
    if (!provider) return;
    try {
      let outcome: WalletOfferCancellationOutcome;
      if (entry.stage === 'cancelling') {
        if (provider.capability !== 'recoverable') {
          throw new Error('Best-effort provider cannot own a cancelling recovery');
        }
        outcome = await provider.reconcileCancellation(entry.tradeId, entry.recoveryId);
      } else {
        if (provider.capability === 'recoverable') {
          const begun = await provider.beginCancellation(entry.tradeId);
          if (begun.status !== 'pending') {
            outcome = begun;
          } else {
            const cancelling = transitionWalletReservation(entry, {
              kind: 'cancellation-pending',
              recoveryId: begun.recoveryId,
            }) as WalletReservationCancellationEntry;
            this.entriesByTradeId.set(entry.tradeId, cancelling);
            this.changed();
            await this.flushPersistence();
            outcome = await provider.reconcileCancellation(
              cancelling.tradeId,
              cancelling.recoveryId,
            );
            entry = cancelling;
          }
        } else {
          outcome = await provider.cancel(entry.tradeId);
        }
      }
      if (this.entriesByTradeId.get(entry.tradeId) !== entry) return;
      if (outcome.status === 'cancelled' || outcome.status === 'already-terminal') {
        this.remove(entry.tradeId);
        this.changed();
        return;
      }
      if (entry.stage === 'cancelling' && outcome.status === 'rejected') {
        const required = transitionWalletReservation(entry, {
          kind: 'cancellation-failed',
          reason: outcome.detail,
        }) as WalletReservationTradeEntry;
        this.entriesByTradeId.set(entry.tradeId, required);
        this.changed();
      }
      log(
        `[wallet-reservation-ledger] cancel ${outcome.status} trade_id=${entry.tradeId}: ${outcome.detail}`,
      );
    } catch (error) {
      if (this.entriesByTradeId.get(entry.tradeId) !== entry) return;
      log(`[wallet-reservation-ledger] cancel threw trade_id=${entry.tradeId}: ${String(error)}`);
    }
  }

  private providerFor(owner: WalletReservationOwner): WalletOfferProvider | null {
    return this.providers.get(walletProviderScopeKey(owner.providerScope)) ?? null;
  }

  private async reconcileDetachedCreation(entry: WalletReservationRecoveryEntry): Promise<void> {
    const provider = this.providerFor(entry.owner);
    if (!provider || provider.capability !== 'recoverable') return;
    const key = walletReservationOperationKey(entry.owner, entry.purpose);
    await this.runAttempt(
      entry.owner,
      entry.purpose,
      async () => {
        const current = this.recoveriesByOperation.get(key);
        if (current !== entry || current.disposition !== 'cancel-on-create') return;
        const request = providerRequestFromRecovery(entry.owner, current.request);
        const completion = await provider.reconcileCreation(
          { owner: entry.owner, purpose: entry.purpose },
          request,
          entry.recoveryId,
        );
        if (completion.kind === 'unavailable') return;
        if (completion.kind === 'failure') {
          this.recoveriesByOperation.delete(key);
          this.changed();
          return;
        }
        this.recoveriesByOperation.delete(key);
        const transitioned = transitionWalletReservation(entry, {
          kind: 'creation-completed',
          tradeId: completion.tradeId,
          reason: 'retired-creation-completed',
        });
        if (transitioned) this.install(transitioned);
        this.changed();
        if (transitioned?.stage === 'cancel-required') {
          this.scheduleCancellationAfterPersistence(transitioned);
        }
      },
      true,
    );
  }

  /** @internal */
  clearForHardReset(): void {
    this.providers.clear();
    this.initialized = true;
    this.entriesByTradeId.clear();
    this.recoveriesByOperation.clear();
    this.inFlightAttempts.clear();
    this.inFlightCancellations.clear();
    this.coordinatedLaunchRequired.clear();
    this.dirty = false;
    this.coordinatedDirtyRevision = null;
    this.revision += 1;
    this.resetHydration(true);
    this.notify();
  }

  /** @internal */
  resetForTests(hydrated = true): void {
    this.providers.clear();
    this.initialized = false;
    this.entriesByTradeId.clear();
    this.recoveriesByOperation.clear();
    this.inFlightAttempts.clear();
    this.inFlightCancellations.clear();
    this.coordinatedLaunchRequired.clear();
    this.listeners.clear();
    this.dirty = false;
    this.revision = 0;
    this.coordinatedDirtyRevision = null;
    this.lastPersistence = Promise.resolve();
    this.resetHydration(hydrated);
  }

  private resetHydration(ready: boolean): void {
    this.hydrationState = ready ? 'ready' : 'pending';
    this.hydrationPromise = new Promise<void>((resolve, reject) => {
      this.hydrationResolve = resolve;
      this.hydrationReject = reject;
    });
    // Hydration can fail before the first wallet mutation subscribes. Keep the
    // rejection sticky without surfacing an unhandled-promise warning.
    void this.hydrationPromise.catch(() => {});
    if (ready) this.hydrationResolve();
  }
}

function providerRequestFromRecovery(
  owner: WalletReservationOwner,
  request: WalletReservationRecoveryRequest,
): WalletOfferRequest {
  if (request.kind === 'fee') return structuredClone(request);
  const canonical = request.canonical;
  return {
    kind: 'funding',
    uniqueId: owner.installationPlayerId,
    offer: { '1': -BigInt(canonical.amount) },
    extraConditions: canonical.conditions.map(({ opcode, args }) => ({ opcode, args: [...args] })),
    ...(canonical.coin_id === undefined ? {} : { coinIds: [canonical.coin_id] }),
    ...(canonical.max_height === undefined ? {} : { maxHeight: BigInt(canonical.max_height) }),
    openingFee: BigInt(canonical.fee),
  };
}

export interface WalletReservationOperationHandle {
  readonly owner: WalletReservationOwner;
  readonly purpose: WalletReservationPurpose;
  createFunding(request: CanonicalFundingRequest): Promise<WalletOfferCompletion>;
  createFee(request: Extract<WalletOfferRequest, { kind: 'fee' }>): Promise<WalletOfferCompletion>;
  settle(
    disposition: 'consumed' | 'cancel-required' | 'retained-for-replay',
    reason: string,
    coordinated?: boolean,
  ): void;
  retire(reason: string): void;
}

export function walletReservationOperation(
  coordinator: WalletReservationCoordinator,
  owner: WalletReservationOwner,
  purpose: WalletReservationPurpose,
): WalletReservationOperationHandle {
  let retired = false;
  return {
    owner,
    purpose,
    createFunding: (request) =>
      coordinator.createOffer(
        owner,
        purpose,
        providerRequestFromRecovery(owner, { kind: 'funding', canonical: request }),
        { kind: 'funding', canonical: request },
        () => retired,
      ),
    createFee: (request) => {
      if (!/^[0-9a-f]{64}$/.test(request.concurrentSpendCoinId)) {
        throw new Error('Fee target coin id must be lowercase 64-hex');
      }
      return coordinator.createOffer(owner, purpose, request, request, () => retired);
    },
    settle: (disposition, reason, coordinated = false) =>
      coordinator.settleOperation(owner, purpose, disposition, reason, coordinated),
    retire: (reason) => {
      retired = true;
      coordinator.retireOperation(owner, purpose, reason);
    },
  };
}

/** Application-owned coordinator used by persistence and active composition. */
export const walletReservationCoordinator = new WalletReservationCoordinator();
/** @deprecated Use walletReservationCoordinator. */
export const walletReservationLedger = walletReservationCoordinator;
