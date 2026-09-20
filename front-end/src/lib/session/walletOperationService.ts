import type {
  WalletOfferProvider,
  WalletOfferCompletion,
  WalletOfferBeginOutcome,
  WalletOfferRequest,
  WalletOfferCancellationOutcome,
} from '../../types/ChiaGaming';
import { log } from '../../services/log';
import { jsonStringify } from '../../util/jsonSafe';
import {
  decodeWalletOperationEntries,
  decodeWalletOperationRecord,
  MAX_WALLET_OPERATION_REASON_LENGTH,
  reduceWalletOperation,
  walletOperationKey,
  walletOperationOwnerPrefix,
  walletOperationOwnerKey,
  walletProviderScopeKey,
  type WalletOperationEntry,
  type WalletOperationCancellationEntry,
  type WalletBestEffortCancellationUncertainEntry,
  type WalletOperationRecoveryEntry,
  type WalletBestEffortUncertainEntry,
  type WalletOperationTradeEntry,
  type WalletOperationOwner,
  type WalletOperationPurpose,
  type WalletOperationRecoveryRequest,
  type WalletOperationTransition,
} from './walletOperationStore';
import type { CanonicalFundingRequest } from './fundingRequest';
import {
  WalletProviderRegistry,
  walletProviderRegistry,
  type WalletProviderRegistryEvent,
} from './walletProviderRegistry';
import { StorageAuthorityLostError } from './indexedDb';

type PersistOperations = (entries: WalletOperationEntry[]) => Promise<void>;

export interface WalletOperationLaunchPolicy {
  launch<T>(key: string, persist: () => Promise<void>, effect: () => Promise<T>): Promise<T>;
}

const persistenceGatedLaunchPolicy: WalletOperationLaunchPolicy = {
  async launch<T>(
    _key: string,
    persist: () => Promise<void>,
    effect: () => Promise<T>,
  ): Promise<T> {
    await persist();
    return effect();
  },
};

export interface WalletOperationCheckpoint {
  entries: WalletOperationEntry[];
  revision: number;
}

function boundedReason(reason: string): string {
  return reason.slice(0, MAX_WALLET_OPERATION_REASON_LENGTH);
}

function orphanRiskWarning(owner: WalletOperationOwner): string {
  const provider = owner.providerScope.provider === 'cloud' ? 'Cloud Wallet' : 'WalletConnect';
  return `${provider} lost the original create-offer response. A prior external reservation may still exist even though a later attempt succeeded.`;
}

function transitionWalletOperation(
  entry: WalletOperationEntry,
  transition: WalletOperationTransition,
): WalletOperationEntry | null {
  return reduceWalletOperation(entry, entry.owner, entry.purpose, transition);
}

export class WalletOperationService {
  private readonly entriesByTradeId = new Map<
    string,
    | WalletOperationTradeEntry
    | WalletOperationCancellationEntry
    | WalletBestEffortCancellationUncertainEntry
  >();
  private readonly recoveriesByOperation = new Map<
    string,
    WalletOperationRecoveryEntry | WalletBestEffortUncertainEntry
  >();
  private readonly restoredUncertainCreations = new Set<string>();
  private readonly restoredUncertainCancellations = new Set<string>();
  private readonly pendingCreationReadiness = new Map<string, bigint>();
  private readonly pendingCancellationReadiness = new Map<string, bigint>();
  private readonly inFlightAttempts = new Map<string, Promise<unknown>>();
  private readonly completedAttempts = new Map<string, WalletOfferCompletion>();
  private readonly inFlightCancellations = new Map<string, Promise<void>>();
  private readonly coordinatedLaunchRequired = new Set<string>();
  private readonly retiredSessions = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private persist: PersistOperations | null = null;
  private initialized = false;
  private dirty = false;
  private revision = 0;
  private coordinatedDirtyRevision: number | null = null;
  private lastPersistence: Promise<void> = Promise.resolve();
  private persistenceAuthorityLost: StorageAuthorityLostError | null = null;
  private hydrationPromise!: Promise<void>;
  private hydrationResolve!: () => void;
  private hydrationReject!: (error: unknown) => void;
  private hydrationState: 'pending' | 'ready' | 'failed' = 'ready';

  constructor(
    private readonly providerRegistry: WalletProviderRegistry = new WalletProviderRegistry(),
    private readonly launchPolicy: WalletOperationLaunchPolicy = persistenceGatedLaunchPolicy,
  ) {
    this.resetHydration(true);
    this.providerRegistry.subscribe((event) => this.handleProviderRegistryEvent(event));
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

  configurePersistence(persist: PersistOperations): void {
    this.persist = persist;
    this.persistenceAuthorityLost = null;
  }

  attachProvider(provider: WalletOfferProvider): void {
    this.providerRegistry.attach(provider);
  }

  providerReady(provider: WalletOfferProvider): void {
    this.providerRegistry.ready(provider);
  }

  providerReconnectReady(provider: WalletOfferProvider): void {
    this.providerRegistry.reconnectReady(provider);
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
    const scopes = this.providerRegistry.scopeKeys();
    if (scopes.size === 0) return { kind: 'unavailable' };
    return relevant.every((entry) => scopes.has(walletProviderScopeKey(entry.owner.providerScope)))
      ? { kind: 'ready' }
      : { kind: 'mismatch' };
  }

  getRecoveryReadiness(): 'ready' | 'wallet-unavailable' | 'scope-mismatch' {
    const entries = this.snapshot();
    if (entries.length === 0) return 'ready';
    if (this.providerRegistry.scopeKeys().size === 0) return 'wallet-unavailable';
    return entries.some((entry) => !this.providerRegistry.hasScope(entry.owner.providerScope))
      ? 'scope-mismatch'
      : 'ready';
  }

  detachProvider(provider: WalletOfferProvider): void {
    this.providerRegistry.detach(provider);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): WalletOperationEntry[] {
    return [...this.entriesByTradeId.values(), ...this.recoveriesByOperation.values()].map(
      (entry) => structuredClone(entry),
    );
  }

  isDirty(): boolean {
    return this.dirty;
  }

  hydrateFromDisk(record: unknown | null): void {
    try {
      const entries = record === null ? [] : decodeWalletOperationRecord(record).entries;
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
    this.restoredUncertainCreations.clear();
    this.restoredUncertainCancellations.clear();
    this.pendingCreationReadiness.clear();
    this.pendingCancellationReadiness.clear();
    this.initialized = false;
    this.dirty = false;
    this.coordinatedDirtyRevision = null;
    this.lastPersistence = Promise.resolve();
    this.persistenceAuthorityLost = null;
    this.resetHydration(false);
    this.hydrateFromDisk(record);
  }

  private hydrateEntries(decoded: WalletOperationEntry[]): void {
    if (!this.initialized) {
      this.initialized = true;
    }
    for (const diskEntry of decoded) {
      this.mergeDiskEntry(diskEntry);
      if (diskEntry.stage === 'best-effort-uncertain') {
        this.restoredUncertainCreations.add(walletOperationKey(diskEntry.owner, diskEntry.purpose));
      } else if (diskEntry.stage === 'best-effort-cancellation-uncertain') {
        this.restoredUncertainCancellations.add(diskEntry.tradeId);
      }
    }
    this.persistIfDirty();
    for (const entry of this.entriesByTradeId.values()) {
      if (entry.stage === 'cancel-required' || entry.stage === 'cancelling') {
        this.scheduleCancellationAfterPersistence(entry);
      }
    }
    this.retryRestoredUncertainty();
    this.notify();
  }

  /** Test/standalone restore; production hydration checkpoints after cache merge. */
  restore(entries: unknown): void {
    this.hydrateEntries(decodeWalletOperationEntries(entries, 'walletOperationService'));
    this.persistIfDirty();
  }

  persistIfDirty(): Promise<void> {
    if (this.dirty && this.coordinatedDirtyRevision === null) this.persistSnapshot();
    return this.lastPersistence;
  }

  flushPersistence(): Promise<void> {
    if (this.persistenceAuthorityLost) return Promise.reject(this.persistenceAuthorityLost);
    return this.lastPersistence;
  }

  checkpoint(): WalletOperationCheckpoint {
    return { entries: this.snapshot(), revision: this.revision };
  }

  combinedCheckpointPersisted(checkpoint: WalletOperationCheckpoint): void {
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
    owner: WalletOperationOwner,
    purpose: WalletOperationPurpose,
    reason = 'wallet-offer-created',
  ): WalletOperationEntry {
    this.initialized = true;
    const decoded = decodeWalletOperationEntries(
      [
        {
          tradeId,
          owner,
          purpose,
          stage: 'reserved',
          reason: boundedReason(reason),
        },
      ],
      'wallet operation registration',
    )[0]!;
    if (decoded.stage === 'creating' || decoded.stage === 'best-effort-uncertain') {
      throw new Error('Internal wallet operation registration error');
    }
    const existingTrade = this.entriesByTradeId.get(decoded.tradeId);
    if (existingTrade) {
      if (
        walletOperationKey(existingTrade.owner, existingTrade.purpose) !==
        walletOperationKey(decoded.owner, decoded.purpose)
      ) {
        throw new Error(`Wallet trade ${decoded.tradeId} belongs to another operation`);
      }
      return structuredClone(existingTrade);
    }
    const reserved = reduceWalletOperation(null, decoded.owner, decoded.purpose, {
      kind: 'reserve',
      tradeId: decoded.tradeId,
      reason: decoded.reason,
    });
    if (!reserved) throw new Error('Reservation transition unexpectedly removed the operation');
    this.install(reserved);
    this.changed();
    return structuredClone(reserved);
  }

  resolve(tradeId: string, coordinated = false): void {
    const entry = this.entriesByTradeId.get(tradeId);
    if (!entry) return;
    reduceWalletOperation(entry, entry.owner, entry.purpose, { kind: 'consume' });
    this.remove(tradeId);
    this.changed(coordinated);
  }

  requireCancellation(tradeId: string, reason: string, coordinated = false): void {
    const entry = this.entriesByTradeId.get(tradeId);
    if (!entry) return;
    const required = transitionWalletOperation(entry, {
      kind: 'require-cancellation',
      reason,
    });
    if (!required || required.stage === 'creating' || required.stage === 'best-effort-uncertain') {
      throw new Error('Trade cancellation transition produced invalid state');
    }
    this.entriesByTradeId.set(tradeId, required);
    if (coordinated) this.coordinatedLaunchRequired.add(tradeId);
    this.changed(coordinated);
    if (!coordinated) this.scheduleCancellationAfterPersistence(required);
  }

  retainForReplay(tradeId: string, reason = 'fee-source-attached', coordinated = false): void {
    const entry = this.entriesByTradeId.get(tradeId);
    if (!entry) {
      throw new Error(`Cannot retain unknown wallet trade ${tradeId}`);
    }
    const retained = reduceWalletOperation(entry, entry.owner, entry.purpose, {
      kind: 'retain-for-replay',
      reason,
    });
    if (!retained || retained.stage === 'creating' || retained.stage === 'best-effort-uncertain') {
      throw new Error('Replay retention produced invalid state');
    }
    this.entriesByTradeId.set(tradeId, retained);
    this.changed(coordinated);
  }

  routeStaleResult(
    tradeId: string,
    owner: WalletOperationOwner,
    purpose: WalletOperationPurpose,
    reason: string,
  ): void {
    const decoded = decodeWalletOperationEntries(
      [{ tradeId, owner, purpose, stage: 'cancel-required', reason: boundedReason(reason) }],
      'stale wallet operation result',
    )[0]!;
    const existing = this.entriesByTradeId.get(tradeId);
    if (existing) {
      if (
        walletOperationKey(existing.owner, existing.purpose) !== walletOperationKey(owner, purpose)
      ) {
        throw new Error(`Wallet trade ${tradeId} belongs to another operation`);
      }
      const required = reduceWalletOperation(existing, owner, purpose, {
        kind: 'stale-result',
        tradeId,
        reason: decoded.reason,
      });
      if (
        !required ||
        required.stage === 'creating' ||
        required.stage === 'best-effort-uncertain'
      ) {
        throw new Error('Stale trade cancellation transition produced invalid state');
      }
      this.entriesByTradeId.set(tradeId, required);
    } else {
      const stale = reduceWalletOperation(null, owner, purpose, {
        kind: 'stale-result',
        tradeId,
        reason: decoded.reason,
      });
      if (stale) this.install(stale);
    }
    this.changed();
    const entry = this.entriesByTradeId.get(tradeId)!;
    this.scheduleCancellationAfterPersistence(entry);
  }

  hasBlockingOperation(owner: WalletOperationOwner, purpose: WalletOperationPurpose): boolean {
    const operation = walletOperationKey(owner, purpose);
    return this.snapshot().some(
      (entry) => walletOperationKey(entry.owner, entry.purpose) === operation,
    );
  }

  hasBlockingTradeOperation(owner: WalletOperationOwner, purpose: WalletOperationPurpose): boolean {
    const operation = walletOperationKey(owner, purpose);
    return [...this.entriesByTradeId.values()].some(
      (entry) => walletOperationKey(entry.owner, entry.purpose) === operation,
    );
  }

  entriesFor(owner: WalletOperationOwner): WalletOperationEntry[] {
    const ownerKey = walletOperationOwnerKey(owner);
    return this.snapshot().filter((entry) => walletOperationOwnerKey(entry.owner) === ownerKey);
  }

  hasEntriesForSession(installationPlayerId: string, peerSessionId: string): boolean {
    return this.snapshot().some(
      (entry) =>
        entry.owner.installationPlayerId === installationPlayerId &&
        entry.owner.peerSessionId === peerSessionId,
    );
  }

  ownerForSession(
    installationPlayerId: string,
    peerSessionId: string,
  ): WalletOperationOwner | null {
    const owners = this.snapshot()
      .filter(
        (entry) =>
          entry.owner.installationPlayerId === installationPlayerId &&
          entry.owner.peerSessionId === peerSessionId,
      )
      .map((entry) => entry.owner);
    const unique = new Map(owners.map((owner) => [walletOperationOwnerKey(owner), owner]));
    if (unique.size > 1) {
      throw new Error('Wallet operations for one session span multiple provider scopes');
    }
    const owner = unique.values().next().value as WalletOperationOwner | undefined;
    return owner ? structuredClone(owner) : null;
  }

  creatingFundingEntryForSession(
    installationPlayerId: string,
    peerSessionId: string,
  ): WalletOperationRecoveryEntry | null {
    const entries = [...this.recoveriesByOperation.values()].filter(
      (entry): entry is WalletOperationRecoveryEntry =>
        entry.stage === 'creating' &&
        entry.purpose.kind === 'funding' &&
        entry.request.kind === 'funding' &&
        entry.owner.installationPlayerId === installationPlayerId &&
        entry.owner.peerSessionId === peerSessionId,
    );
    if (entries.length > 1) {
      throw new Error('Wallet operation record contains conflicting funding recoveries');
    }
    return entries[0] ? structuredClone(entries[0]) : null;
  }

  retainedEntriesForOperation(
    owner: WalletOperationOwner,
    purpose: WalletOperationPurpose,
  ): WalletOperationTradeEntry[] {
    const operation = walletOperationKey(owner, purpose);
    return this.snapshot().filter(
      (entry): entry is WalletOperationTradeEntry =>
        entry.stage === 'retained-for-replay' &&
        walletOperationKey(entry.owner, entry.purpose) === operation,
    );
  }

  async createOffer(
    owner: WalletOperationOwner,
    purpose: WalletOperationPurpose,
    request: WalletOfferRequest,
    recoveryRequest: WalletOperationRecoveryRequest = request.kind === 'fee'
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
    const key = walletOperationKey(owner, purpose);
    const completed = this.completedAttempts.get(key);
    if (completed) {
      this.completedAttempts.delete(key);
      return completed;
    }
    if (
      [...this.entriesByTradeId.values()].some(
        (entry) => walletOperationKey(entry.owner, entry.purpose) === key,
      )
    ) {
      throw new Error('Wallet operation cleanup is pending for this operation');
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
          if (
            provider.capability !== 'recoverable' &&
            provider.capability !== 'recoverable-after-begin'
          ) {
            throw new Error('Wallet provider cannot reconcile its persisted offer creation');
          }
          const recoveryId = recovery.recoveryId;
          completion = await this.launchProviderMutation(key, () =>
            provider.reconcileCreation(operation, request, recoveryId),
          );
        } else if (recovery?.stage === 'best-effort-uncertain') {
          if (jsonStringify(recovery.request) !== jsonStringify(recoveryRequest)) {
            throw new Error('Persisted wallet offer request conflicts with the uncertain attempt');
          }
          return {
            kind: 'unavailable',
            reason:
              'Wallet response was lost; a replacement starts on the next wallet readiness epoch',
          };
        } else {
          if (provider.capability === 'best-effort') {
            try {
              completion = await this.launchProviderMutation(key, () =>
                provider.beginCreation(operation, request),
              );
            } catch (error) {
              this.recordCreationUncertainty(
                owner,
                purpose,
                recoveryRequest,
                'walletconnect-response-unavailable',
                isRetired,
              );
              log(
                `[wallet-operation-service] WalletConnect response lost; an external offer may be orphaned operation=${key}: ${String(error)}`,
              );
              return {
                kind: 'unavailable',
                reason: `${String(error)}. WalletConnect response was lost; an external reservation may be orphaned. A replacement will start after reconnect.`,
              };
            }
            if (completion.kind === 'unavailable') {
              this.recordCreationUncertainty(
                owner,
                purpose,
                recoveryRequest,
                'walletconnect-response-unavailable',
                isRetired,
              );
              log(
                `[wallet-operation-service] WalletConnect response uncertain; external reservation risk operation=${key}`,
              );
              return completion;
            }
          } else if (provider.capability === 'terminal') {
            completion = await this.launchProviderMutation(key, () =>
              provider.beginCreation(operation, request),
            );
          } else {
            let begun;
            try {
              begun = await this.launchProviderMutation(key, () =>
                provider.beginCreation(operation, request),
              );
            } catch (error) {
              if (provider.capability !== 'recoverable-after-begin') throw error;
              this.recordCreationUncertainty(
                owner,
                purpose,
                recoveryRequest,
                'cloud-response-unavailable',
                isRetired,
              );
              log(
                `[wallet-operation-service] Cloud begin response lost; a signature request may be orphaned operation=${key}: ${String(error)}`,
              );
              return {
                kind: 'unavailable',
                reason: `${String(error)}. Cloud Wallet response was lost; a signature request may be orphaned. A replacement will start after reconnect.`,
              };
            }
            if (provider.capability === 'recoverable-after-begin' && begun.kind === 'unavailable') {
              this.recordCreationUncertainty(
                owner,
                purpose,
                recoveryRequest,
                'cloud-response-unavailable',
                isRetired,
              );
              log(
                `[wallet-operation-service] Cloud begin response uncertain; signature request orphan risk operation=${key}`,
              );
              return begun;
            }
            if (begun.kind !== 'pending') {
              completion = begun;
            } else {
              recovery = reduceWalletOperation(null, owner, purpose, {
                kind: 'creation-pending',
                recoveryId: begun.recoveryId,
                request: recoveryRequest,
                reason: 'wallet-offer-creation-pending',
                retired: isRetired() || this.isSessionRetired(owner),
              }) as WalletOperationRecoveryEntry;
              this.recoveriesByOperation.set(key, recovery);
              this.changed();
              await this.flushPersistence();
              completion = await this.launchProviderMutation(key, () =>
                provider.reconcileCreation(operation, request, begun.recoveryId),
              );
            }
          }
        }
        if (completion.kind === 'created') {
          if (recovery) {
            this.recoveriesByOperation.delete(key);
            const transitioned = transitionWalletOperation(recovery, {
              kind: 'creation-completed',
              tradeId: completion.tradeId,
              reason: `${purpose.kind}-offer-created`,
            });
            if (transitioned) this.install(transitioned);
            if (transitioned?.orphanRisk) {
              const warning = orphanRiskWarning(transitioned.owner);
              completion = { ...completion, warning };
              log(`[wallet-operation-service] ${warning} operation=${key}`);
            }
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
          reduceWalletOperation(recovery, owner, purpose, { kind: 'creation-rejected' });
          this.recoveriesByOperation.delete(key);
          this.changed();
        }
        return completion;
      },
      true,
    );
  }

  private recordCreationUncertainty(
    owner: WalletOperationOwner,
    purpose: WalletOperationPurpose,
    request: WalletOperationRecoveryRequest,
    reason: string,
    isRetired: () => boolean,
  ): void {
    const key = walletOperationKey(owner, purpose);
    const uncertain = reduceWalletOperation(null, owner, purpose, {
      kind: 'creation-uncertain',
      request,
      generation: 0n,
      readinessEpoch: BigInt(this.providerRegistry.readinessEpoch(owner.providerScope)),
      reason,
      retired: isRetired() || this.isSessionRetired(owner),
      orphanRisk: 'pre-id-response-lost',
    }) as WalletBestEffortUncertainEntry;
    this.recoveriesByOperation.set(key, uncertain);
    this.changed();
  }

  settleOperation(
    owner: WalletOperationOwner,
    purpose: WalletOperationPurpose,
    disposition: 'consumed' | 'cancel-required' | 'retained-for-replay',
    reason: string,
    coordinated = false,
  ): void {
    const operation = walletOperationKey(owner, purpose);
    for (const entry of [...this.entriesByTradeId.values()]) {
      if (walletOperationKey(entry.owner, entry.purpose) !== operation) continue;
      if (disposition === 'consumed') {
        this.resolve(entry.tradeId, coordinated);
      } else if (disposition === 'cancel-required') {
        this.requireCancellation(entry.tradeId, reason, coordinated);
      } else {
        this.retainForReplay(entry.tradeId, reason, coordinated);
      }
    }
  }

  retireOperation(
    owner: WalletOperationOwner,
    purpose: WalletOperationPurpose,
    reason: string,
    coordinated = false,
  ): void {
    const operation = walletOperationKey(owner, purpose);
    const recovery = this.recoveriesByOperation.get(operation);
    if (recovery) {
      this.recoveriesByOperation.set(
        operation,
        transitionWalletOperation(recovery, {
          kind: 'retire',
          reason,
        }) as WalletOperationRecoveryEntry,
      );
      this.changed(coordinated);
    }
    this.settleOperation(owner, purpose, 'cancel-required', reason, coordinated);
  }

  promoteReservedForOwner(owner: WalletOperationOwner, reason: string): void {
    const ownerKey = walletOperationOwnerKey(owner);
    for (const [operation, entry] of this.recoveriesByOperation) {
      if (walletOperationOwnerKey(entry.owner) !== ownerKey) continue;
      this.recoveriesByOperation.set(
        operation,
        transitionWalletOperation(entry, {
          kind: 'retire',
          reason,
        }) as WalletOperationRecoveryEntry,
      );
      this.changed();
    }
    for (const entry of [...this.entriesByTradeId.values()]) {
      if (entry.stage === 'reserved' && walletOperationOwnerKey(entry.owner) === ownerKey) {
        this.requireCancellation(entry.tradeId, reason);
      }
    }
  }

  retireSession(
    installationPlayerId: string,
    peerSessionId: string,
    reason: string,
    coordinated = false,
  ): void {
    this.retiredSessions.add(this.sessionKey(installationPlayerId, peerSessionId));
    let changed = false;
    for (const [operation, entry] of this.recoveriesByOperation) {
      if (
        entry.owner.installationPlayerId !== installationPlayerId ||
        entry.owner.peerSessionId !== peerSessionId
      ) {
        continue;
      }
      const retired = reduceWalletOperation(entry, entry.owner, entry.purpose, {
        kind: 'retire',
        reason,
      });
      if (retired && retired !== entry) {
        this.recoveriesByOperation.set(
          operation,
          retired as WalletOperationRecoveryEntry | WalletBestEffortUncertainEntry,
        );
        changed = true;
      }
    }
    const cancelAfterPersistence: WalletOperationEntry[] = [];
    for (const [tradeId, entry] of this.entriesByTradeId) {
      if (
        entry.owner.installationPlayerId !== installationPlayerId ||
        entry.owner.peerSessionId !== peerSessionId ||
        entry.stage === 'retained-for-replay'
      ) {
        continue;
      }
      const retired = reduceWalletOperation(entry, entry.owner, entry.purpose, {
        kind: 'retire',
        reason,
      });
      if (!retired || retired.stage === 'creating' || retired.stage === 'best-effort-uncertain') {
        throw new Error('Session retirement produced an invalid trade transition');
      }
      this.entriesByTradeId.set(tradeId, retired);
      if (coordinated) this.coordinatedLaunchRequired.add(tradeId);
      else cancelAfterPersistence.push(retired);
      changed = true;
    }
    if (!changed) return;
    this.changed(coordinated);
    for (const entry of cancelAfterPersistence) this.scheduleCancellationAfterPersistence(entry);
  }

  async runAttempt<T>(
    owner: WalletOperationOwner,
    purpose: WalletOperationPurpose,
    launch: () => Promise<T>,
    allowExisting = false,
  ): Promise<T> {
    await this.awaitHydrated();
    const key = walletOperationKey(owner, purpose);
    if (!allowExisting && this.hasBlockingOperation(owner, purpose)) {
      throw new Error('Wallet operation cleanup is pending for this operation');
    }
    const existing = this.inFlightAttempts.get(key);
    if (existing) return existing as Promise<T>;
    const attempt = launch().finally(() => {
      if (this.inFlightAttempts.get(key) === attempt) this.inFlightAttempts.delete(key);
    });
    this.inFlightAttempts.set(key, attempt);
    return attempt;
  }

  retryCancelRequired(owner?: WalletOperationOwner): void {
    const ownerKey = owner ? walletOperationOwnerKey(owner) : undefined;
    for (const entry of this.entriesByTradeId.values()) {
      if (
        (entry.stage === 'cancel-required' || entry.stage === 'cancelling') &&
        !this.coordinatedLaunchRequired.has(entry.tradeId) &&
        (ownerKey === undefined || walletOperationOwnerKey(entry.owner) === ownerKey)
      ) {
        this.attemptCancellation(entry);
      }
    }
  }

  private retryCancelRequiredForScope(scope: WalletOperationOwner['providerScope']): void {
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

  private retryCreatingForScope(scope: WalletOperationOwner['providerScope']): void {
    const scopeKey = walletProviderScopeKey(scope);
    for (const entry of this.recoveriesByOperation.values()) {
      if (walletProviderScopeKey(entry.owner.providerScope) !== scopeKey) continue;
      if (entry.stage !== 'creating') continue;
      if (entry.disposition !== 'cancel-on-create') continue;
      void this.reconcileDetachedCreation(entry);
    }
  }

  private retryUncertainForScope(
    scope: WalletOperationOwner['providerScope'],
    readinessEpoch: bigint,
  ): void {
    const scopeKey = walletProviderScopeKey(scope);
    for (const entry of this.recoveriesByOperation.values()) {
      if (
        entry.stage !== 'best-effort-uncertain' ||
        walletProviderScopeKey(entry.owner.providerScope) !== scopeKey
      ) {
        continue;
      }
      const operation = walletOperationKey(entry.owner, entry.purpose);
      const restored = this.restoredUncertainCreations.has(operation);
      if (!restored && readinessEpoch <= entry.lastAttemptEpoch) continue;
      if (this.inFlightAttempts.has(operation)) {
        this.rememberPendingEpoch(this.pendingCreationReadiness, operation, readinessEpoch);
        continue;
      }
      this.scheduleUncertainCreation(entry, readinessEpoch, restored);
    }
  }

  private retryUncertainCancellationForScope(
    scope: WalletOperationOwner['providerScope'],
    readinessEpoch: bigint,
  ): void {
    const scopeKey = walletProviderScopeKey(scope);
    for (const entry of this.entriesByTradeId.values()) {
      if (
        entry.stage !== 'best-effort-cancellation-uncertain' ||
        walletProviderScopeKey(entry.owner.providerScope) !== scopeKey
      ) {
        continue;
      }
      const restored = this.restoredUncertainCancellations.has(entry.tradeId);
      if (!restored && readinessEpoch <= entry.lastAttemptEpoch) continue;
      if (this.inFlightCancellations.has(entry.tradeId)) {
        this.rememberPendingEpoch(this.pendingCancellationReadiness, entry.tradeId, readinessEpoch);
        continue;
      }
      this.scheduleUncertainCancellation(entry, readinessEpoch, restored);
    }
  }

  private rememberPendingEpoch(
    pending: Map<string, bigint>,
    key: string,
    readinessEpoch: bigint,
  ): void {
    const previous = pending.get(key);
    if (previous === undefined || readinessEpoch > previous) pending.set(key, readinessEpoch);
  }

  private scheduleUncertainCreation(
    entry: WalletBestEffortUncertainEntry,
    readinessEpoch: bigint,
    newRegistryGeneration: boolean,
  ): void {
    const operation = walletOperationKey(entry.owner, entry.purpose);
    const attempt = this.launchUncertainReplacement(
      entry,
      readinessEpoch,
      newRegistryGeneration,
    ).finally(() => {
      if (this.inFlightAttempts.get(operation) !== attempt) return;
      this.inFlightAttempts.delete(operation);
      this.launchPendingCreationReadiness(operation);
    });
    this.inFlightAttempts.set(operation, attempt);
  }

  private launchPendingCreationReadiness(operation: string): void {
    const readinessEpoch = this.pendingCreationReadiness.get(operation);
    if (readinessEpoch === undefined) return;
    this.pendingCreationReadiness.delete(operation);
    const entry = this.recoveriesByOperation.get(operation);
    if (entry?.stage !== 'best-effort-uncertain') return;
    const restored = this.restoredUncertainCreations.has(operation);
    if (!restored && readinessEpoch <= entry.lastAttemptEpoch) return;
    this.scheduleUncertainCreation(entry, readinessEpoch, restored);
  }

  private scheduleUncertainCancellation(
    entry: WalletBestEffortCancellationUncertainEntry,
    readinessEpoch: bigint,
    newRegistryGeneration: boolean,
  ): void {
    const attempt = this.launchUncertainCancellation(
      entry,
      readinessEpoch,
      newRegistryGeneration,
    ).finally(() => {
      if (this.inFlightCancellations.get(entry.tradeId) !== attempt) return;
      this.inFlightCancellations.delete(entry.tradeId);
      this.launchPendingCancellationReadiness(entry.tradeId);
    });
    this.inFlightCancellations.set(entry.tradeId, attempt);
  }

  private launchPendingCancellationReadiness(tradeId: string): void {
    const readinessEpoch = this.pendingCancellationReadiness.get(tradeId);
    if (readinessEpoch === undefined) return;
    this.pendingCancellationReadiness.delete(tradeId);
    const entry = this.entriesByTradeId.get(tradeId);
    if (entry?.stage !== 'best-effort-cancellation-uncertain') return;
    const restored = this.restoredUncertainCancellations.has(tradeId);
    if (!restored && readinessEpoch <= entry.lastAttemptEpoch) return;
    this.scheduleUncertainCancellation(entry, readinessEpoch, restored);
  }

  private async launchUncertainCancellation(
    entry: WalletBestEffortCancellationUncertainEntry,
    readinessEpoch: bigint,
    newRegistryGeneration: boolean,
  ): Promise<void> {
    const provider = this.providerFor(entry.owner);
    if (!provider || provider.capability !== 'recoverable-after-begin') return;
    const marked = reduceWalletOperation(entry, entry.owner, entry.purpose, {
      kind: 'uncertain-cancellation-attempt-launched',
      readinessEpoch,
      reason: entry.reason,
      newRegistryGeneration,
    }) as WalletBestEffortCancellationUncertainEntry;
    if (marked === entry) return;
    this.restoredUncertainCancellations.delete(entry.tradeId);
    this.entriesByTradeId.set(entry.tradeId, marked);
    this.changed();
    await this.flushPersistence();
    await this.performCancellation(marked);
  }

  private async launchUncertainReplacement(
    entry: WalletBestEffortUncertainEntry,
    readinessEpoch: bigint,
    newRegistryGeneration: boolean,
  ): Promise<void> {
    const provider = this.providerFor(entry.owner);
    if (
      !provider ||
      (provider.capability !== 'best-effort' && provider.capability !== 'recoverable-after-begin')
    ) {
      return;
    }
    const key = walletOperationKey(entry.owner, entry.purpose);
    const request = providerRequestFromRecovery(entry.owner, entry.request);
    const operation = { owner: entry.owner, purpose: entry.purpose };
    const marked = reduceWalletOperation(entry, entry.owner, entry.purpose, {
      kind: 'uncertain-attempt-launched',
      readinessEpoch,
      reason: entry.reason,
      newRegistryGeneration,
    }) as WalletBestEffortUncertainEntry;
    if (marked === entry) return;
    this.restoredUncertainCreations.delete(key);
    this.recoveriesByOperation.set(key, marked);
    this.changed();
    await this.flushPersistence();
    let activeRecovery: WalletBestEffortUncertainEntry | WalletOperationRecoveryEntry = marked;
    let completion: WalletOfferCompletion | WalletOfferBeginOutcome =
      await this.launchProviderMutation(key, () =>
        provider.beginCreation(operation, request),
      ).catch(
        (error): WalletOfferCompletion => ({
          kind: 'unavailable',
          reason: String(error),
        }),
      );
    if (this.recoveriesByOperation.get(key) !== marked) return;
    if (completion.kind === 'pending') {
      if (provider.capability !== 'recoverable-after-begin') {
        throw new Error('Best-effort provider returned a recovery id');
      }
      const identified = reduceWalletOperation(marked, entry.owner, entry.purpose, {
        kind: 'creation-recovery-identified',
        recoveryId: completion.recoveryId,
        reason: 'wallet-offer-creation-recovery-identified',
      }) as WalletOperationRecoveryEntry;
      this.recoveriesByOperation.set(key, identified);
      this.changed();
      await this.flushPersistence();
      completion = await this.launchProviderMutation(key, () =>
        provider.reconcileCreation(operation, request, identified.recoveryId),
      );
      if (this.recoveriesByOperation.get(key) !== identified) return;
      activeRecovery = identified;
    }
    if (completion.kind === 'unavailable') {
      const unavailable = reduceWalletOperation(activeRecovery, entry.owner, entry.purpose, {
        kind: 'creation-unavailable',
        reason: completion.reason,
      }) as WalletBestEffortUncertainEntry | WalletOperationRecoveryEntry;
      this.recoveriesByOperation.set(key, unavailable);
      this.changed();
      return;
    }
    if (completion.kind === 'created') {
      this.recoveriesByOperation.delete(key);
      const completed = reduceWalletOperation(activeRecovery, entry.owner, entry.purpose, {
        kind: 'creation-completed',
        tradeId: completion.tradeId,
        reason: `${entry.purpose.kind}-offer-created-after-uncertainty`,
      });
      if (completed) this.install(completed);
      if (completed?.orphanRisk) {
        const warning = orphanRiskWarning(completed.owner);
        completion = { ...completion, warning };
        log(`[wallet-operation-service] ${warning} operation=${key}`);
      }
      this.completedAttempts.set(key, completion);
      this.changed();
      if (completed?.stage === 'cancel-required') {
        this.scheduleCancellationAfterPersistence(completed);
      }
      return;
    }
    reduceWalletOperation(activeRecovery, entry.owner, entry.purpose, {
      kind: 'creation-rejected',
    });
    this.recoveriesByOperation.delete(key);
    this.changed();
    this.completedAttempts.set(key, completion);
  }

  private retryRestoredUncertainty(): void {
    for (const entry of this.snapshot()) {
      if (
        entry.stage !== 'best-effort-uncertain' &&
        entry.stage !== 'best-effort-cancellation-uncertain'
      ) {
        continue;
      }
      const epoch = this.providerRegistry.readinessEpoch(entry.owner.providerScope);
      if (epoch === 0) continue;
      this.retryUncertainForScope(entry.owner.providerScope, BigInt(epoch));
      this.retryUncertainCancellationForScope(entry.owner.providerScope, BigInt(epoch));
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

  async awaitOwner(owner: WalletOperationOwner): Promise<void> {
    const ownerKey = walletOperationOwnerKey(owner);
    const operationPrefix = walletOperationOwnerPrefix(owner);
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
            return entry !== undefined && walletOperationOwnerKey(entry.owner) === ownerKey;
          })
          .map(([, promise]) => promise),
      ];
      if (pending.length === 0) return;
      await Promise.allSettled(pending);
    }
  }

  private install(entry: WalletOperationEntry): void {
    const operation = walletOperationKey(entry.owner, entry.purpose);
    if (entry.stage === 'creating' || entry.stage === 'best-effort-uncertain') {
      if (this.tradesForOperation(operation).length > 0) {
        throw new Error('Wallet operation cannot own recovery and trade stages together');
      }
      this.recoveriesByOperation.set(operation, entry);
      return;
    }
    if (this.recoveriesByOperation.has(operation)) {
      throw new Error('Wallet operation cannot own recovery and trade stages together');
    }
    const existing = this.entriesByTradeId.get(entry.tradeId);
    if (existing && walletOperationKey(existing.owner, existing.purpose) !== operation) {
      throw new Error(`Wallet trade ${entry.tradeId} belongs to another operation`);
    }
    this.entriesByTradeId.set(entry.tradeId, entry);
  }

  private tradesForOperation(operation: string): WalletOperationEntry[] {
    return [...this.entriesByTradeId.values()].filter(
      (entry) => walletOperationKey(entry.owner, entry.purpose) === operation,
    );
  }

  private promoteRestoredEntry(entry: WalletOperationEntry): WalletOperationEntry {
    if (entry.stage !== 'reserved') return entry;
    return (
      reduceWalletOperation(entry, entry.owner, entry.purpose, {
        kind: 'require-cancellation',
        reason: 'orphaned-reservation-restored',
      }) ?? entry
    );
  }

  private mergeDiskEntry(diskEntry: WalletOperationEntry): void {
    if (diskEntry.stage === 'creating' || diskEntry.stage === 'best-effort-uncertain') {
      const operation = walletOperationKey(diskEntry.owner, diskEntry.purpose);
      if (!this.recoveriesByOperation.has(operation)) this.install(diskEntry);
      return;
    }
    const byTrade = this.entriesByTradeId.get(diskEntry.tradeId);
    if (
      byTrade &&
      walletOperationKey(byTrade.owner, byTrade.purpose) !==
        walletOperationKey(diskEntry.owner, diskEntry.purpose)
    ) {
      throw new Error(`Wallet operation record conflict for trade ${diskEntry.tradeId}`);
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
        if (error instanceof StorageAuthorityLostError) {
          this.persistenceAuthorityLost = error;
          throw error;
        }
        log(`[wallet-operation-service] persistence failed: ${String(error)}`);
      },
    );
    this.lastPersistence = attempt;
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private scheduleCancellationAfterPersistence(entry: WalletOperationEntry): Promise<void> {
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

  private attemptCancellation(entry: WalletOperationEntry): Promise<void> {
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

  private async performCancellation(entry: WalletOperationEntry): Promise<void> {
    if (
      entry.stage !== 'cancel-required' &&
      entry.stage !== 'best-effort-cancellation-uncertain' &&
      entry.stage !== 'cancelling'
    ) {
      return;
    }
    const tradeId = entry.tradeId;
    await this.awaitHydrated();
    const provider = this.providerFor(entry.owner);
    if (!provider) return;
    try {
      let outcome: WalletOfferCancellationOutcome;
      if (entry.stage === 'cancelling') {
        if (
          provider.capability !== 'recoverable' &&
          provider.capability !== 'recoverable-after-begin'
        ) {
          throw new Error('Non-recoverable provider cannot own a cancelling recovery');
        }
        const recoveryId = entry.recoveryId;
        outcome = await this.launchProviderMutation(`cancel:${tradeId}`, () =>
          provider.reconcileCancellation(tradeId, recoveryId),
        );
      } else if (
        provider.capability === 'recoverable' ||
        provider.capability === 'recoverable-after-begin'
      ) {
        const begun = await this.launchProviderMutation(`cancel:${tradeId}`, () =>
          provider.beginCancellation(tradeId),
        ).catch(
          (error): WalletOfferCancellationOutcome => ({
            status: 'unavailable',
            detail: String(error),
          }),
        );
        if (begun.status !== 'pending') {
          if (begun.status === 'unavailable' && provider.capability === 'recoverable-after-begin') {
            if (entry.stage === 'cancel-required') {
              const uncertain = reduceWalletOperation(entry, entry.owner, entry.purpose, {
                kind: 'cancellation-uncertain',
                readinessEpoch: BigInt(
                  this.providerRegistry.readinessEpoch(entry.owner.providerScope),
                ),
                reason: 'cloud-cancellation-response-lost-orphan-risk',
              }) as WalletBestEffortCancellationUncertainEntry;
              this.entriesByTradeId.set(entry.tradeId, uncertain);
              this.changed();
              entry = uncertain;
            } else {
              const unavailable = transitionWalletOperation(entry, {
                kind: 'cancellation-unavailable',
                reason: begun.detail,
              }) as WalletBestEffortCancellationUncertainEntry;
              this.entriesByTradeId.set(entry.tradeId, unavailable);
              this.changed();
              entry = unavailable;
            }
            log(
              `[wallet-operation-service] Cloud cancellation response uncertain; signature request orphan risk trade_id=${tradeId}`,
            );
          }
          outcome = begun;
        } else {
          const cancelling =
            entry.stage === 'best-effort-cancellation-uncertain'
              ? (transitionWalletOperation(entry, {
                  kind: 'cancellation-recovery-identified',
                  recoveryId: begun.recoveryId,
                }) as WalletOperationCancellationEntry)
              : (transitionWalletOperation(entry, {
                  kind: 'cancellation-pending',
                  recoveryId: begun.recoveryId,
                }) as WalletOperationCancellationEntry);
          this.entriesByTradeId.set(entry.tradeId, cancelling);
          this.changed();
          await this.flushPersistence();
          outcome = await this.launchProviderMutation(`cancel:${tradeId}`, () =>
            provider.reconcileCancellation(cancelling.tradeId, cancelling.recoveryId),
          );
          entry = cancelling;
        }
      } else {
        outcome = await this.launchProviderMutation(`cancel:${tradeId}`, () =>
          provider.cancel(tradeId),
        );
      }
      if (this.entriesByTradeId.get(entry.tradeId) !== entry) return;
      if (outcome.status === 'cancelled' || outcome.status === 'already-terminal') {
        reduceWalletOperation(entry, entry.owner, entry.purpose, {
          kind: 'cancellation-completed',
        });
        this.remove(entry.tradeId);
        this.changed();
        return;
      }
      if (
        (entry.stage === 'cancelling' || entry.stage === 'best-effort-cancellation-uncertain') &&
        outcome.status === 'rejected'
      ) {
        const required = transitionWalletOperation(entry, {
          kind: 'cancellation-failed',
          reason: outcome.detail,
        }) as WalletOperationTradeEntry;
        this.entriesByTradeId.set(entry.tradeId, required);
        this.changed();
      }
      log(
        `[wallet-operation-service] cancel ${outcome.status} trade_id=${entry.tradeId}: ${outcome.detail}`,
      );
    } catch (error) {
      if (this.entriesByTradeId.get(entry.tradeId) !== entry) return;
      log(`[wallet-operation-service] cancel threw trade_id=${entry.tradeId}: ${String(error)}`);
    }
  }

  private providerFor(owner: WalletOperationOwner): WalletOfferProvider | null {
    return this.providerRegistry.provider(owner.providerScope);
  }

  private launchProviderMutation<T>(key: string, effect: () => Promise<T>): Promise<T> {
    return this.launchPolicy.launch(key, () => this.flushPersistence(), effect);
  }

  private sessionKey(installationPlayerId: string, peerSessionId: string): string {
    return `${installationPlayerId.length}:${installationPlayerId}${peerSessionId.length}:${peerSessionId}`;
  }

  private isSessionRetired(owner: WalletOperationOwner): boolean {
    return this.retiredSessions.has(
      this.sessionKey(owner.installationPlayerId, owner.peerSessionId),
    );
  }

  private handleProviderRegistryEvent(event: WalletProviderRegistryEvent): void {
    if (event.kind === 'detached') {
      this.notify();
      return;
    }
    this.retryCancelRequiredForScope(event.provider.scope);
    this.retryCreatingForScope(event.provider.scope);
    this.retryUncertainForScope(event.provider.scope, BigInt(event.readinessEpoch));
    this.retryUncertainCancellationForScope(event.provider.scope, BigInt(event.readinessEpoch));
    this.notify();
  }

  private async reconcileDetachedCreation(entry: WalletOperationRecoveryEntry): Promise<void> {
    const provider = this.providerFor(entry.owner);
    if (
      !provider ||
      (provider.capability !== 'recoverable' && provider.capability !== 'recoverable-after-begin')
    ) {
      return;
    }
    const key = walletOperationKey(entry.owner, entry.purpose);
    await this.runAttempt(
      entry.owner,
      entry.purpose,
      async () => {
        const current = this.recoveriesByOperation.get(key);
        if (current !== entry || current.disposition !== 'cancel-on-create') return;
        const request = providerRequestFromRecovery(entry.owner, current.request);
        const completion = await this.launchProviderMutation(key, () =>
          provider.reconcileCreation(
            { owner: entry.owner, purpose: entry.purpose },
            request,
            entry.recoveryId,
          ),
        );
        if (completion.kind === 'unavailable') return;
        if (completion.kind === 'failure') {
          this.recoveriesByOperation.delete(key);
          this.changed();
          return;
        }
        this.recoveriesByOperation.delete(key);
        const transitioned = transitionWalletOperation(entry, {
          kind: 'creation-completed',
          tradeId: completion.tradeId,
          reason: 'retired-creation-completed',
        });
        if (transitioned) this.install(transitioned);
        if (transitioned?.orphanRisk) {
          const warning = orphanRiskWarning(transitioned.owner);
          log(`[wallet-operation-service] ${warning} operation=${key}`);
        }
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
    this.providerRegistry.clear();
    this.initialized = true;
    this.entriesByTradeId.clear();
    this.recoveriesByOperation.clear();
    this.inFlightAttempts.clear();
    this.inFlightCancellations.clear();
    this.coordinatedLaunchRequired.clear();
    this.restoredUncertainCreations.clear();
    this.restoredUncertainCancellations.clear();
    this.pendingCreationReadiness.clear();
    this.pendingCancellationReadiness.clear();
    this.retiredSessions.clear();
    this.dirty = false;
    this.coordinatedDirtyRevision = null;
    this.revision += 1;
    this.resetHydration(true);
    this.notify();
  }

  /** @internal */
  resetForTests(hydrated = true): void {
    this.providerRegistry.clear();
    this.initialized = false;
    this.entriesByTradeId.clear();
    this.recoveriesByOperation.clear();
    this.inFlightAttempts.clear();
    this.inFlightCancellations.clear();
    this.coordinatedLaunchRequired.clear();
    this.restoredUncertainCreations.clear();
    this.restoredUncertainCancellations.clear();
    this.pendingCreationReadiness.clear();
    this.pendingCancellationReadiness.clear();
    this.retiredSessions.clear();
    this.listeners.clear();
    this.dirty = false;
    this.revision = 0;
    this.coordinatedDirtyRevision = null;
    this.lastPersistence = Promise.resolve();
    this.persistenceAuthorityLost = null;
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
  owner: WalletOperationOwner,
  request: WalletOperationRecoveryRequest,
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

export interface WalletOperationHandle {
  readonly owner: WalletOperationOwner;
  readonly purpose: WalletOperationPurpose;
  createFunding(request: CanonicalFundingRequest): Promise<WalletOfferCompletion>;
  createFee(request: Extract<WalletOfferRequest, { kind: 'fee' }>): Promise<WalletOfferCompletion>;
  settle(
    disposition: 'consumed' | 'cancel-required' | 'retained-for-replay',
    reason: string,
    coordinated?: boolean,
  ): void;
  retire(reason: string): void;
}

export function walletOperation(
  coordinator: WalletOperationService,
  owner: WalletOperationOwner,
  purpose: WalletOperationPurpose,
): WalletOperationHandle {
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

/** Application-owned service used by persistence and active composition. */
export const walletOperationService = new WalletOperationService(walletProviderRegistry);
