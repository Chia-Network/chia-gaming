import type { InternalBlockchainInterface } from '../../types/ChiaGaming';
import { log } from '../../services/log';
import {
  decodeWalletReservationLedger,
  decodeWalletReservationRecord,
  MAX_WALLET_RESERVATION_REASON_LENGTH,
  walletReservationOperationKey,
  walletReservationOwnerKey,
  type WalletReservationLedgerEntry,
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
  private readonly entriesByTradeId = new Map<string, WalletReservationLedgerEntry>();
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
    return [...this.entriesByTradeId.values()].map((entry) => structuredClone(entry));
  }

  isDirty(): boolean {
    return this.dirty;
  }

  hydrateFromDisk(record: unknown | null): void {
    const entries = record === null ? [] : decodeWalletReservationRecord(record).entries;
    this.hydrateEntries(entries);
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
  ): WalletReservationLedgerEntry[] {
    const operation = walletReservationOperationKey(owner, purpose);
    return this.snapshot().filter(
      (entry) =>
        entry.stage === 'retained-for-replay' &&
        walletReservationOperationKey(entry.owner, entry.purpose) === operation,
    );
  }

  async runAttempt<T>(
    owner: WalletReservationOwner,
    purpose: WalletReservationPurpose,
    launch: () => Promise<T>,
  ): Promise<T> {
    const key = walletReservationOperationKey(owner, purpose);
    if (this.hasBlockingOperation(owner, purpose)) {
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
    this.entriesByTradeId.set(entry.tradeId, entry);
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
    const existing = this.inFlightCancellations.get(entry.tradeId);
    if (existing) return existing;
    const cancelOffer = this.rpc?.cancelOffer;
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
    const cancelOffer = this.rpc?.cancelOffer;
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
    this.inFlightAttempts.clear();
    this.inFlightCancellations.clear();
    this.coordinatedLaunchRequired.clear();
    this.dirty = false;
    this.coordinatedDirtyRevision = null;
    this.revision += 1;
    this.notify();
  }

  /** @internal */
  resetForTests(): void {
    this.connectionUnsubscribe?.();
    this.connectionUnsubscribe = null;
    this.rpc = null;
    this.initialized = false;
    this.entriesByTradeId.clear();
    this.inFlightAttempts.clear();
    this.inFlightCancellations.clear();
    this.coordinatedLaunchRequired.clear();
    this.listeners.clear();
    this.dirty = false;
    this.revision = 0;
    this.coordinatedDirtyRevision = null;
    this.lastPersistence = Promise.resolve();
  }
}

export const walletReservationLedger = new WalletReservationLedger();
