import { BlockchainPoller } from '../../hooks/BlockchainPoller';
import { SessionController } from '../../hooks/SessionController';
import {
  SessionMachineRuntime,
  SessionRuntimeRetiredError,
} from '../session/sessionMachineRuntime';
import type { SessionModel } from '../session/types';
import { createSessionModel } from '../session/model';
import type {
  InternalBlockchainInterface,
  TransactionSubmission,
  WalletProviderScope,
} from '../../types/ChiaGaming';
import {
  makeMockCradle,
  makePeerConn,
  mockRpc,
  mockWasmConnection,
  testSpendBundle,
} from './message_protocol.harness';

interface PendingRelease {
  readonly launcher: () => Promise<void>;
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

export class ControlledRuntime {
  private readonly pending = new Map<string, PendingRelease>();
  private readonly pendingMutations: Array<{
    readonly reject: (error: unknown) => void;
  }> = [];
  private mutationCount = 0;
  private controller: SessionController | null = null;

  constructor(
    private readonly holdMutationNumber?: number,
    private readonly heldEffectPrefix?: string,
    private readonly snapshot: () => SessionModel = () => createSessionModel(),
  ) {}

  retire(): void {
    for (const release of this.pending.values()) {
      release.reject(new SessionRuntimeRetiredError());
    }
    this.pending.clear();
    for (const mutation of this.pendingMutations.splice(0)) {
      mutation.reject(new SessionRuntimeRetiredError());
    }
  }

  activatePersistence(): void {}

  requestCommit(): void {}

  flush(): Promise<void> {
    if (this.controller) {
      this.controller.flushDeferredWork();
      const commit = this.controller.prepareReliableCommit();
      this.controller.completeReliableCommit(commit, true);
    }
    return Promise.resolve();
  }

  attachController(controller: SessionController): void {
    this.controller = controller;
  }

  enqueue(work: () => void): void {
    work();
  }

  enqueueResult<T>(work: () => T): Promise<T> {
    this.mutationCount += 1;
    if (this.mutationCount === this.holdMutationNumber) {
      return new Promise<T>((_resolve, reject) => {
        this.pendingMutations.push({ reject });
      });
    }
    try {
      return Promise.resolve(work());
    } catch (error) {
      return Promise.reject(error);
    }
  }

  releaseAfterPersistence(key: string, launcher: () => Promise<void>): Promise<void> {
    const existing = this.pending.get(key);
    if (existing) return existing.promise;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    void promise.catch(() => {});
    const release = { launcher, promise, resolve, reject };
    this.pending.set(key, release);
    if (!key.startsWith('submission:') && !key.startsWith(this.heldEffectPrefix ?? '\0')) {
      void this.launch(key);
    }
    return promise;
  }

  snapshotModel(): SessionModel {
    return structuredClone(this.snapshot());
  }

  has(key: string): boolean {
    return this.pending.has(key);
  }

  count(key: string): number {
    return this.pending.has(key) ? 1 : 0;
  }

  hasPendingMutation(): boolean {
    return this.pendingMutations.length > 0;
  }

  reject(key: string, error: unknown): void {
    const release = this.pending.get(key);
    if (!release) throw new Error(`No pending release for ${key}`);
    this.pending.delete(key);
    release.reject(error);
  }

  async launch(key: string): Promise<void> {
    const release = this.pending.get(key);
    if (!release) throw new Error(`No pending release for ${key}`);
    this.pending.delete(key);
    try {
      await release.launcher();
      release.resolve();
    } catch (error) {
      release.reject(error);
    }
  }
}

export function commitRuntime(controller: SessionController, runtime: ControlledRuntime): void {
  runtime.attachController(controller);
  controller.commitSessionRuntime(runtime as unknown as SessionMachineRuntime);
}

export function bestEffortWalletRpc(
  beginCreation?: jest.Mock,
  cancel?: jest.Mock,
): Partial<InternalBlockchainInterface> {
  return {
    getWalletOfferProvider: () => ({
      capability: 'best-effort',
      feeMaterial: 'reserved-offer',
      scope: { provider: 'simulator', identity: 'submission-handoff' },
      beginCreation:
        beginCreation ??
        jest.fn(async () => ({
          kind: 'unavailable' as const,
          reason: 'creation unavailable',
        })),
      cancel:
        cancel ??
        jest.fn(async () => ({
          status: 'unavailable' as const,
          detail: 'cancellation unavailable',
        })),
    }),
  };
}

export function unreservedWalletRpc(
  beginCreation?: jest.Mock,
  cancel?: jest.Mock,
): Partial<InternalBlockchainInterface> {
  return {
    getWalletOfferProvider: () => ({
      capability: 'best-effort',
      feeMaterial: 'unreserved-bundle',
      scope: { provider: 'simulator', identity: 'submission-handoff' },
      beginCreation:
        beginCreation ??
        jest.fn(async () => ({
          kind: 'created-ephemeral' as const,
          material: { kind: 'bundle' as const, bundle: {} },
        })),
      cancel:
        cancel ??
        jest.fn(async () => ({
          status: 'unavailable' as const,
          detail: 'cancellation unavailable',
        })),
    }),
  };
}

export function recoverableWalletRpc(
  beginCreation: jest.Mock,
  reconcileCreation: jest.Mock,
  beginCancellation: jest.Mock = jest.fn(async () => ({
    status: 'unavailable' as const,
    detail: 'cancellation unavailable',
  })),
  reconcileCancellation: jest.Mock = jest.fn(async () => ({
    status: 'unavailable' as const,
    detail: 'cancellation unavailable',
  })),
): Partial<InternalBlockchainInterface> {
  return {
    getWalletOfferProvider: () => ({
      capability: 'recoverable',
      feeMaterial: 'reserved-offer',
      scope: { provider: 'simulator', identity: 'submission-handoff' },
      beginCreation,
      reconcileCreation,
      beginCancellation,
      reconcileCancellation,
    }),
  };
}

export function setup(
  spend: jest.Mock,
  rpcOverrides: Partial<InternalBlockchainInterface> = {},
  walletProviderScope?: WalletProviderScope,
) {
  const adapter = { ...mockRpc, spend, ...rpcOverrides } as InternalBlockchainInterface;
  const blockchain = new BlockchainPoller(adapter, 60_000);
  blockchain.refreshProviderReadiness();
  const controller = new SessionController(
    blockchain,
    'submission-handoff',
    100n,
    100n,
    makePeerConn([], []),
    undefined,
    walletProviderScope,
  );
  const cradle = makeMockCradle();
  controller.rewardPuzzleHash = '11'.repeat(32);
  controller.loadWasm(mockWasmConnection);
  controller.setGameSession(cradle);
  const submit = (submission: TransactionSubmission) =>
    (
      controller as unknown as {
        submitTransaction(value: TransactionSubmission): void;
      }
    ).submitTransaction(submission);
  return { blockchain, controller, cradle, submit };
}

export const submission = (id: string): TransactionSubmission => ({
  id,
  attempt_token: `${id}-attempt-1`,
  predecessor_attempt_token: null,
  relationship: 'initial',
  bundle: testSpendBundle(id),
  fee_request: null,
});

export const nextAttempt = (
  previous: TransactionSubmission,
  attempt_token: string,
  relationship: TransactionSubmission['relationship'] = 'exact',
): TransactionSubmission => ({
  ...previous,
  attempt_token,
  predecessor_attempt_token: previous.attempt_token,
  relationship,
});
