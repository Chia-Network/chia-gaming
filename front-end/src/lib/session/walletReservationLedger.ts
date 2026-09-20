import type { InternalBlockchainInterface } from '../../types/ChiaGaming';
import { log } from '../../services/log';
import {
  decodeWalletReservationLedger,
  MAX_WALLET_RESERVATION_REASON_LENGTH,
  walletReservationOperationKey,
  type WalletReservationLedgerEntry,
  type WalletReservationOwner,
  type WalletReservationPurpose,
} from './walletReservationLedgerSchema';

type PersistLedger = (entries: WalletReservationLedgerEntry[]) => Promise<void>;

function boundedReason(reason: string): string {
  return reason.slice(0, MAX_WALLET_RESERVATION_REASON_LENGTH);
}

function cancellationIsTerminalSuccess(error: unknown): boolean {
  const detail = error instanceof Error ? error.message : String(error);
  return (
    /\balready[- ]?(?:spent|cancelled|canceled)\b/i.test(detail) ||
    /\b(?:offer|trade)\b.{0,80}\b(?:gone|not[- ]?found|does not exist|unknown)\b/i.test(detail) ||
    /\b(?:gone|not[- ]?found)\b.{0,80}\b(?:offer|trade)\b/i.test(detail)
  );
}

export class WalletReservationLedger {
  private readonly entriesByTradeId = new Map<string, WalletReservationLedgerEntry>();
  private readonly tradeIdByOperation = new Map<string, string>();
  private readonly inFlightAttempts = new Map<string, Promise<unknown>>();
  private readonly inFlightCancellations = new Map<string, Promise<void>>();
  private readonly listeners = new Set<() => void>();
  private rpc: InternalBlockchainInterface | null = null;
  private persist: PersistLedger | null = null;
  private connectionUnsubscribe: (() => void) | null = null;
  private initialized = false;
  private dirty = false;
  private revision = 0;

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

  hydrateFromDisk(entries: unknown): void {
    const decoded = decodeWalletReservationLedger(entries, 'walletReservationLedger');
    if (!this.initialized) {
      if (this.entriesByTradeId.size > 0 || this.tradeIdByOperation.size > 0 || this.dirty) {
        throw new Error('Wallet reservation ledger is uninitialized with in-memory state');
      }
      for (const entry of decoded) this.install(this.promoteRestoredEntry(entry));
      this.initialized = true;
      if (decoded.some((entry) => entry.stage === 'reserved')) this.markDirty();
    } else {
      for (const diskEntry of decoded) this.assertDiskEntryCompatible(diskEntry);
      for (const diskEntry of decoded) this.mergeDiskEntry(diskEntry);
    }
    this.retryCancelRequired();
    this.notify();
  }

  /** Test/standalone restore; production hydration checkpoints after cache merge. */
  restore(entries: unknown): void {
    this.hydrateFromDisk(entries);
    this.persistIfDirty();
  }

  persistIfDirty(): void {
    if (this.dirty) this.persistSnapshot();
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
    const operation = walletReservationOperationKey(owner, purpose);
    const existingTradeId = this.tradeIdByOperation.get(operation);
    if (existingTradeId) {
      const existing = this.entriesByTradeId.get(existingTradeId)!;
      if (existing.tradeId !== decoded.tradeId) {
        throw new Error(`Wallet reservation operation already owns trade ${existing.tradeId}`);
      }
      return structuredClone(existing);
    }
    const existingTrade = this.entriesByTradeId.get(decoded.tradeId);
    if (existingTrade) {
      throw new Error(`Wallet trade ${decoded.tradeId} belongs to another operation`);
    }
    this.install(decoded);
    this.changed();
    return structuredClone(decoded);
  }

  resolve(owner: WalletReservationOwner, purpose: WalletReservationPurpose): void {
    const tradeId = this.tradeIdByOperation.get(walletReservationOperationKey(owner, purpose));
    if (!tradeId) return;
    this.remove(tradeId);
    this.changed();
  }

  requireCancellation(
    owner: WalletReservationOwner,
    purpose: WalletReservationPurpose,
    reason: string,
  ): void {
    const tradeId = this.tradeIdByOperation.get(walletReservationOperationKey(owner, purpose));
    if (!tradeId) return;
    const entry = this.entriesByTradeId.get(tradeId)!;
    entry.stage = 'cancel-required';
    entry.reason = boundedReason(reason);
    this.changed();
    this.attemptCancellation(entry);
  }

  routeStaleResult(
    tradeId: string,
    owner: WalletReservationOwner,
    purpose: WalletReservationPurpose,
    reason: string,
  ): void {
    this.registerReserved(tradeId, owner, purpose, reason);
    this.requireCancellation(owner, purpose, reason);
  }

  hasOperation(owner: WalletReservationOwner, purpose: WalletReservationPurpose): boolean {
    return this.tradeIdByOperation.has(walletReservationOperationKey(owner, purpose));
  }

  entriesForSession(gameSessionId: string): WalletReservationLedgerEntry[] {
    return this.snapshot().filter((entry) => entry.owner.gameSessionId === gameSessionId);
  }

  async runAttempt<T>(
    owner: WalletReservationOwner,
    purpose: WalletReservationPurpose,
    launch: () => Promise<T>,
  ): Promise<T> {
    const key = walletReservationOperationKey(owner, purpose);
    if (this.hasOperation(owner, purpose)) {
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

  retryCancelRequired(gameSessionId?: string): void {
    for (const entry of this.entriesByTradeId.values()) {
      if (
        entry.stage === 'cancel-required' &&
        (gameSessionId === undefined || entry.owner.gameSessionId === gameSessionId)
      ) {
        this.attemptCancellation(entry);
      }
    }
  }

  async awaitSession(gameSessionId: string): Promise<void> {
    const pending = [...this.inFlightCancellations.entries()]
      .filter(
        ([tradeId]) => this.entriesByTradeId.get(tradeId)?.owner.gameSessionId === gameSessionId,
      )
      .map(([, promise]) => promise);
    await Promise.allSettled(pending);
  }

  private install(entry: WalletReservationLedgerEntry): void {
    this.entriesByTradeId.set(entry.tradeId, entry);
    this.tradeIdByOperation.set(
      walletReservationOperationKey(entry.owner, entry.purpose),
      entry.tradeId,
    );
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
    const operation = walletReservationOperationKey(diskEntry.owner, diskEntry.purpose);
    const byTrade = this.entriesByTradeId.get(diskEntry.tradeId);
    const operationTradeId = this.tradeIdByOperation.get(operation);
    if (byTrade || operationTradeId) return;
    this.install(this.promoteRestoredEntry(diskEntry));
    if (diskEntry.stage === 'reserved') this.markDirty();
  }

  private assertDiskEntryCompatible(diskEntry: WalletReservationLedgerEntry): void {
    const operation = walletReservationOperationKey(diskEntry.owner, diskEntry.purpose);
    const byTrade = this.entriesByTradeId.get(diskEntry.tradeId);
    const operationTradeId = this.tradeIdByOperation.get(operation);
    if (
      (byTrade || operationTradeId) &&
      (!byTrade ||
        operationTradeId !== diskEntry.tradeId ||
        walletReservationOperationKey(byTrade.owner, byTrade.purpose) !== operation)
    ) {
      throw new Error(`Wallet reservation ledger conflict for trade ${diskEntry.tradeId}`);
    }
  }

  private remove(tradeId: string): void {
    const entry = this.entriesByTradeId.get(tradeId);
    if (!entry) return;
    this.entriesByTradeId.delete(tradeId);
    this.tradeIdByOperation.delete(walletReservationOperationKey(entry.owner, entry.purpose));
  }

  private changed(): void {
    this.markDirty();
    this.persistSnapshot();
    this.notify();
  }

  private markDirty(): void {
    this.dirty = true;
    this.revision += 1;
  }

  private persistSnapshot(): void {
    const persist = this.persist;
    if (!persist) return;
    const snapshot = this.snapshot();
    const revision = this.revision;
    void persist(snapshot).then(
      () => {
        if (this.revision === revision) this.dirty = false;
      },
      (error) => {
        this.dirty = true;
        log(`[wallet-reservation-ledger] persistence failed: ${String(error)}`);
      },
    );
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private attemptCancellation(entry: WalletReservationLedgerEntry): void {
    if (this.inFlightCancellations.has(entry.tradeId)) return;
    const cancelOffer = this.rpc?.cancelOffer;
    if (!cancelOffer) return;
    const attempt = (async () => {
      try {
        await cancelOffer(entry.tradeId);
        this.remove(entry.tradeId);
        this.changed();
      } catch (error) {
        if (cancellationIsTerminalSuccess(error)) {
          this.remove(entry.tradeId);
          this.changed();
          return;
        }
        log(
          `[wallet-reservation-ledger] cancel failed trade_id=${entry.tradeId}: ${String(error)}`,
        );
      } finally {
        this.inFlightCancellations.delete(entry.tradeId);
      }
    })();
    this.inFlightCancellations.set(entry.tradeId, attempt);
  }

  /** @internal */
  resetForTests(): void {
    this.connectionUnsubscribe?.();
    this.connectionUnsubscribe = null;
    this.rpc = null;
    this.initialized = false;
    this.entriesByTradeId.clear();
    this.tradeIdByOperation.clear();
    this.inFlightAttempts.clear();
    this.inFlightCancellations.clear();
    this.listeners.clear();
    this.dirty = false;
    this.revision = 0;
  }
}

export const walletReservationLedger = new WalletReservationLedger();
