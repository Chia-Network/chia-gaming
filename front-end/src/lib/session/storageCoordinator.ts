import {
  type ClaimedStorageSnapshot,
  type DurableRejectionTombstone,
  type DurableStorageAuthority,
  readRejectionTombstones,
  readSessionRecord,
  readWalletOperationRecord,
  indexedDbStoragePort,
  StorageAuthorityLostError,
} from './indexedDb';
import type { SessionSave } from './saveEnvelope';
import type { WalletOperationEntry } from './walletOperationStore';

export type StorageAuthorityLossReason = 'takeover' | 'sibling-reset' | 'durable-authority-lost';

export type StorageMutationResult =
  | { status: 'committed' }
  | { status: 'failed'; error: unknown }
  | { status: 'authority-lost'; error: StorageAuthorityLostError };

type QueuedMutation = {
  authority: DurableStorageAuthority;
  run: () => Promise<void>;
  resolve: (result: StorageMutationResult) => void;
};

/**
 * Sole in-memory owner of durable storage authority and mutation ordering.
 * IndexedDB remains the transaction/codec layer and receives an explicit
 * authority handle for every mutation.
 */
export class StorageCoordinator {
  private authority: DurableStorageAuthority | null = null;
  private generation = 0;
  private lifecycle = 0;
  private claimSequence = 0;
  private fenced = false;
  private running = false;
  private readonly queue: QueuedMutation[] = [];
  private readonly authorityLostListeners = new Set<(reason: StorageAuthorityLossReason) => void>();
  private pendingMutationBarrierForTests: Promise<void> | null = null;
  private pendingCheckpointHoldForTests: {
    barrier: Promise<void>;
    committed: () => void;
  } | null = null;
  private pendingClaimHoldForTests: {
    barrier: Promise<void>;
    claimed: () => void;
  } | null = null;

  hasAuthority(): boolean {
    return this.authority !== null && !this.fenced;
  }

  isFenced(): boolean {
    return this.fenced;
  }

  onAuthorityLost(listener: (reason: StorageAuthorityLossReason) => void): void {
    this.authorityLostListeners.add(listener);
  }

  offAuthorityLost(listener: (reason: StorageAuthorityLossReason) => void): void {
    this.authorityLostListeners.delete(listener);
  }

  loseAuthority(reason: StorageAuthorityLossReason): void {
    if (this.fenced) return;
    this.fenced = true;
    this.generation += 1;
    this.notifyAuthorityLost(reason);
  }

  private notifyAuthorityLost(reason: StorageAuthorityLossReason): void {
    for (const listener of this.authorityLostListeners) {
      try {
        listener(reason);
      } catch {
        // Authority notification must reach the remaining listeners.
      }
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
    sessionRecord: unknown | null;
    walletOperationRecord: Awaited<ReturnType<typeof readWalletOperationRecord>>;
  }> {
    await this.waitForMutations();
    const [sessionRecord, walletOperationRecord] = await Promise.all([
      readSessionRecord(),
      readWalletOperationRecord(),
    ]);
    return { sessionRecord, walletOperationRecord };
  }

  async readSession(): Promise<unknown | null> {
    await this.waitForMutations();
    return readSessionRecord();
  }

  async readWalletOperations(): Promise<Awaited<ReturnType<typeof readWalletOperationRecord>>> {
    await this.waitForMutations();
    return readWalletOperationRecord();
  }

  async readRejections(): Promise<DurableRejectionTombstone[]> {
    await this.waitForMutations();
    return readRejectionTombstones();
  }

  async beginHardReset(ownerTabId: string): Promise<DurableStorageAuthority> {
    const authority = await indexedDbStoragePort.beginHardReset(ownerTabId);
    this.authority = authority;
    this.generation += 1;
    this.fenced = true;
    return authority;
  }

  hardResetMutation(authority: DurableStorageAuthority, reset: () => Promise<void>): Promise<void> {
    return this.requireCommitted(
      this.enqueue(
        authority,
        this.generation,
        async () => {
          await indexedDbStoragePort.validatePendingHardReset(authority);
          await reset();
        },
        true,
      ),
    );
  }

  checkpoint(
    session: SessionSave,
    entries: WalletOperationEntry[],
  ): Promise<StorageMutationResult> {
    const sessionSnapshot = structuredClone(session);
    const entriesSnapshot = structuredClone(entries);
    return this.mutate(async (authority) => {
      await indexedDbStoragePort.writeCheckpoint(sessionSnapshot, entriesSnapshot, authority);
      const hold = this.pendingCheckpointHoldForTests;
      this.pendingCheckpointHoldForTests = null;
      if (hold) {
        hold.committed();
        await hold.barrier;
      }
    });
  }

  writeSession(record: SessionSave): Promise<StorageMutationResult> {
    const snapshot = structuredClone(record);
    return this.mutate((authority) => indexedDbStoragePort.writeSession(snapshot, authority));
  }

  deleteSession(): Promise<StorageMutationResult> {
    return this.mutate(indexedDbStoragePort.deleteSession);
  }

  writeWalletOperations(entries: WalletOperationEntry[]): Promise<StorageMutationResult> {
    const snapshot = structuredClone(entries);
    return this.mutate((authority) =>
      indexedDbStoragePort.writeWalletOperations(snapshot, authority),
    );
  }

  deleteWalletOperations(): Promise<StorageMutationResult> {
    return this.mutate(indexedDbStoragePort.deleteWalletOperations);
  }

  writeRejection(tombstone: DurableRejectionTombstone): Promise<StorageMutationResult> {
    const snapshot = structuredClone(tombstone);
    return this.mutate((authority) => indexedDbStoragePort.writeRejection(snapshot, authority));
  }

  replaceSessionWithRejection(
    tombstone: DurableRejectionTombstone,
  ): Promise<StorageMutationResult> {
    const snapshot = structuredClone(tombstone);
    return this.mutate((authority) =>
      indexedDbStoragePort.replaceSessionWithRejection(snapshot, authority),
    );
  }

  deleteRejection(peerId: string, sessionId: string): Promise<StorageMutationResult> {
    return this.mutate((authority) =>
      indexedDbStoragePort.deleteRejection(peerId, sessionId, authority),
    );
  }

  pruneRejections(): Promise<StorageMutationResult> {
    return this.mutate(indexedDbStoragePort.pruneRejections);
  }

  /** Promise adapter for callers whose contract already models rejection. */
  persist(result: Promise<StorageMutationResult>): Promise<void> {
    return this.requireCommitted(result);
  }

  resetForTests(): void {
    this.lifecycle += 1;
    this.authority = null;
    this.generation += 1;
    this.claimSequence += 1;
    this.fenced = false;
    this.queue.length = 0;
    this.running = false;
    this.authorityLostListeners.clear();
    this.pendingMutationBarrierForTests = null;
    this.pendingCheckpointHoldForTests = null;
    this.pendingClaimHoldForTests = null;
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

  private mutate(
    write: (authority: DurableStorageAuthority) => Promise<void>,
  ): Promise<StorageMutationResult> {
    if (!this.authority || this.fenced) {
      return Promise.resolve({
        status: 'authority-lost',
        error: new StorageAuthorityLostError(),
      });
    }
    const authority = { ...this.authority };
    return this.enqueue(authority, this.generation, () => write(authority));
  }

  private enqueue(
    authority: DurableStorageAuthority,
    generation: number,
    run: () => Promise<void>,
    allowFenced = false,
  ): Promise<StorageMutationResult> {
    const lifecycle = this.lifecycle;
    return new Promise((resolve) => {
      this.queue.push({
        authority,
        run: async () => {
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
            if (!this.fenced) this.notifyAuthorityLost('durable-authority-lost');
            throw new StorageAuthorityLostError();
          }
        },
        resolve,
      });
      this.pump();
    });
  }

  private pump(): void {
    if (this.running) return;
    const mutation = this.queue.shift();
    if (!mutation) return;
    const lifecycle = this.lifecycle;
    this.running = true;
    void mutation
      .run()
      .then(
        () => mutation.resolve({ status: 'committed' }),
        (error) => {
          if (lifecycle !== this.lifecycle) {
            mutation.resolve({ status: 'committed' });
            return;
          }
          if (error instanceof StorageAuthorityLostError) {
            if (
              lifecycle === this.lifecycle &&
              this.authority?.ownerTabId === mutation.authority.ownerTabId &&
              this.authority.writeEpoch === mutation.authority.writeEpoch &&
              this.authority.resetEpoch === mutation.authority.resetEpoch
            ) {
              this.loseAuthority('durable-authority-lost');
            }
            mutation.resolve({ status: 'authority-lost', error });
          } else {
            mutation.resolve({ status: 'failed', error });
          }
        },
      )
      .finally(() => {
        if (lifecycle !== this.lifecycle) return;
        this.running = false;
        this.pump();
      });
  }

  private waitForMutations(): Promise<void> {
    if (!this.running && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const poll = () => {
        if (!this.running && this.queue.length === 0) resolve();
        else setTimeout(poll, 0);
      };
      poll();
    });
  }

  private async requireCommitted(result: Promise<StorageMutationResult>): Promise<void> {
    const completed = await result;
    if (completed.status === 'committed') return;
    throw completed.error;
  }
}

export const storageCoordinator = new StorageCoordinator();
