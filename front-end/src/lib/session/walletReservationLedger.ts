import type {
  InternalBlockchainInterface,
  WalletOfferCompletion,
  WalletOfferRequest,
} from '../../types/ChiaGaming';
import { log } from '../../services/log';
import {
  decodeWalletReservationLedger,
  decodeWalletReservationRecord,
  MAX_WALLET_RESERVATION_REASON_LENGTH,
  walletReservationOperationKey,
  walletReservationOwnerKey,
  type WalletReservationLedgerEntry,
  type WalletReservationRecoveryEntry,
  type WalletReservationTradeEntry,
  type WalletReservationOwner,
  type WalletReservationPurpose,
} from './walletReservationLedgerSchema';

type PersistLedger = (entries: WalletReservationLedgerEntry[]) => Promise<void>;

export interface WalletReservationLedgerCheckpoint {
  entries: WalletReservationLedgerEntry[];
  revision: number;
}

function boundedReason(reason: string): string {
  return reason.slice(0, MAX_WALLET_RESERVATION_REASON_LENGTH);
}

export class WalletReservationLedger {
  private readonly entriesByTradeId = new Map<string, WalletReservationTradeEntry>();
  private readonly recoveriesByOperation = new Map<string, WalletReservationRecoveryEntry>();
  private readonly inFlightAttempts = new Map<string, Promise<unknown>>();
  private readonly inFlightCancellations = new Map<string, Promise<void>>();
  private readonly coordinatedLaunchRequired = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private rpc: InternalBlockchainInterface | null = null;
  private persist: PersistLedger | null = null;
  private connectionUnsubscribe: (() => void) | null = null;
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

  attachRpc(rpc: InternalBlockchainInterface): void {
    if (this.rpc !== rpc) {
      this.connectionUnsubscribe?.();
      this.connectionUnsubscribe = null;
      this.rpc = rpc;
      try {
        const unsubscribe = rpc.onConnectionChange?.((connected) => {
          if (connected) this.retryCancelRequired();
        });
        if (typeof unsubscribe === 'function') this.connectionUnsubscribe = unsubscribe;
      } catch {
        // Minimal simulator/test adapters may not implement connection events.
      }
    }
    this.retryCancelRequired();
  }

  detachRpc(rpc: InternalBlockchainInterface): void {
    if (this.rpc !== rpc) return;
    this.connectionUnsubscribe?.();
    this.connectionUnsubscribe = null;
    this.rpc = null;
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

  private hydrateEntries(decoded: WalletReservationLedgerEntry[]): void {
    if (!this.initialized) {
      this.initialized = true;
    }
    for (const diskEntry of decoded) this.mergeDiskEntry(diskEntry);
    this.persistIfDirty();
    for (const entry of this.entriesByTradeId.values()) {
      if (entry.stage === 'cancel-required') this.scheduleCancellationAfterPersistence(entry);
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
    entry.stage = 'cancel-required';
    entry.reason = boundedReason(reason);
    this.changed();
    this.scheduleCancellationAfterPersistence(entry);
  }

  requireCancellationCoordinated(tradeId: string, reason: string): void {
    const entry = this.entriesByTradeId.get(tradeId);
    if (!entry) return;
    entry.stage = 'cancel-required';
    entry.reason = boundedReason(reason);
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
      existing.stage = 'cancel-required';
      existing.reason = decoded.reason;
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
    rpc: InternalBlockchainInterface,
    owner: WalletReservationOwner,
    purpose: WalletReservationPurpose,
    request: WalletOfferRequest,
  ): Promise<WalletOfferCompletion> {
    await this.awaitHydrated();
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
          if (!rpc.reconcileWalletOffer) {
            throw new Error('Wallet provider cannot reconcile its persisted offer creation');
          }
          completion = await rpc.reconcileWalletOffer(operation, request, recovery.recoveryId);
        } else {
          const begun = await rpc.beginWalletOffer(operation, request);
          if (begun.kind !== 'pending') {
            completion = begun;
          } else {
            recovery = {
              owner,
              purpose,
              stage: 'creating',
              recoveryId: begun.recoveryId,
              reason: boundedReason('wallet-offer-creation-pending'),
            };
            this.recoveriesByOperation.set(key, recovery);
            this.changed();
            await this.flushPersistence();
            if (!rpc.reconcileWalletOffer) {
              throw new Error('Wallet provider returned recoverable creation without capability');
            }
            completion = await rpc.reconcileWalletOffer(operation, request, begun.recoveryId);
          }
        }
        if (completion.kind === 'created') {
          this.recoveriesByOperation.delete(key);
          if (completion.tradeId) {
            this.registerReserved(
              completion.tradeId,
              owner,
              purpose,
              `${purpose.kind}-offer-created`,
            );
          } else {
            this.changed();
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

  promoteReservedForOwner(owner: WalletReservationOwner, reason: string): void {
    const ownerKey = walletReservationOwnerKey(owner);
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
        entry.stage === 'cancel-required' &&
        !this.coordinatedLaunchRequired.has(entry.tradeId) &&
        (ownerKey === undefined || walletReservationOwnerKey(entry.owner) === ownerKey)
      ) {
        this.attemptCancellation(entry);
      }
    }
  }

  launchCancellation(tradeId: string): Promise<void> {
    this.coordinatedLaunchRequired.delete(tradeId);
    const entry = this.entriesByTradeId.get(tradeId);
    if (!entry || entry.stage !== 'cancel-required') return Promise.resolve();
    return this.attemptCancellation(entry);
  }

  async awaitOwner(owner: WalletReservationOwner): Promise<void> {
    const ownerKey = walletReservationOwnerKey(owner);
    const pending = [...this.inFlightCancellations.entries()]
      .filter(([tradeId]) => {
        const entry = this.entriesByTradeId.get(tradeId);
        return entry !== undefined && walletReservationOwnerKey(entry.owner) === ownerKey;
      })
      .map(([, promise]) => promise);
    await Promise.allSettled(pending);
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
    if (entry.stage !== 'cancel-required') return Promise.resolve();
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
    if (entry.stage !== 'cancel-required') return Promise.resolve();
    const existing = this.inFlightCancellations.get(entry.tradeId);
    if (existing) return existing;
    const cancelOffer = this.rpc?.releaseWalletOffer;
    if (!cancelOffer) return Promise.resolve();
    const attempt = this.performCancellation(entry).finally(() => {
      if (this.inFlightCancellations.get(entry.tradeId) === attempt) {
        this.inFlightCancellations.delete(entry.tradeId);
      }
    });
    this.inFlightCancellations.set(entry.tradeId, attempt);
    return attempt;
  }

  private async performCancellation(entry: WalletReservationLedgerEntry): Promise<void> {
    if (entry.stage !== 'cancel-required') return;
    await this.awaitHydrated();
    const cancelOffer = this.rpc?.releaseWalletOffer;
    if (!cancelOffer) return;
    try {
      const outcome = await cancelOffer(entry.tradeId);
      if (this.entriesByTradeId.get(entry.tradeId) !== entry) return;
      if (outcome.status === 'cancelled' || outcome.status === 'already-terminal') {
        this.remove(entry.tradeId);
        this.changed();
        return;
      }
      log(
        `[wallet-reservation-ledger] cancel ${outcome.status} trade_id=${entry.tradeId}: ${outcome.detail}`,
      );
    } catch (error) {
      if (this.entriesByTradeId.get(entry.tradeId) !== entry) return;
      log(`[wallet-reservation-ledger] cancel threw trade_id=${entry.tradeId}: ${String(error)}`);
    }
  }

  /** @internal */
  clearForHardReset(): void {
    this.connectionUnsubscribe?.();
    this.connectionUnsubscribe = null;
    this.rpc = null;
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
    this.connectionUnsubscribe?.();
    this.connectionUnsubscribe = null;
    this.rpc = null;
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

export const walletReservationLedger = new WalletReservationLedger();
