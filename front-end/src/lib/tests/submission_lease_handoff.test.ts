import { expectConsoleError } from '../../../scripts/testSetup';
import { BlockchainPoller } from '../../hooks/BlockchainPoller';
import { SessionController } from '../../hooks/SessionController';
import type { SessionRuntimeLease } from '../session/sessionRuntimeLease';
import { SessionRuntimeRetiredError } from '../session/sessionMachineRuntime';
import type { SessionModel } from '../session/types';
import { createSessionModel } from '../session/model';
import { canonicalizeFundingRequest, fundingRequestKey } from '../session/fundingRequest';
import { SubmissionDeliveryCoordinator } from '../session/submissionDeliveryCoordinator';
import { WalletOperationService, walletOperationService } from '../session/walletOperationService';
import type { InternalBlockchainInterface, TransactionSubmission } from '../../types/ChiaGaming';
import {
  makeMockCradle,
  makePeerConn,
  mockRpc,
  mockWasmConnection,
  submissionDrain,
  testSpendBundle,
  wasmResult,
} from './message_protocol.harness';

interface PendingRelease {
  readonly launcher: () => Promise<void>;
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

class ControlledLease implements SessionRuntimeLease {
  private readonly pending = new Map<string, PendingRelease>();
  private readonly pendingMutations: Array<{
    readonly reject: (error: unknown) => void;
  }> = [];
  private mutationCount = 0;

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

  requestCommit(): void {}

  flush(): Promise<void> {
    return Promise.resolve();
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
    return this.snapshot();
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

function deferredVoid(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function setup(spend: jest.Mock, rpcOverrides: Partial<InternalBlockchainInterface> = {}) {
  const legacy = rpcOverrides as Record<string, any>;
  const adapter = { ...mockRpc, spend, ...rpcOverrides } as InternalBlockchainInterface;
  if (!rpcOverrides.getWalletOfferProvider) {
    adapter.getWalletOfferProvider = () => {
      const scope = { provider: 'simulator' as const, identity: 'submission-handoff' };
      if (legacy.reconcileWalletOffer) {
        return {
          capability: 'recoverable' as const,
          scope,
          beginCreation: legacy.beginWalletOffer,
          reconcileCreation: legacy.reconcileWalletOffer,
          beginCancellation:
            legacy.beginWalletOfferCancellation ??
            (async () => ({ status: 'unavailable' as const, detail: 'cancellation unavailable' })),
          reconcileCancellation:
            legacy.reconcileWalletOfferCancellation ??
            (async () => ({ status: 'unavailable' as const, detail: 'cancellation unavailable' })),
        };
      }
      return {
        capability: 'best-effort' as const,
        scope,
        beginCreation:
          legacy.beginWalletOffer ??
          (async () => ({ kind: 'unavailable' as const, reason: 'creation unavailable' })),
        cancel:
          legacy.beginWalletOfferCancellation ??
          (async () => ({ status: 'unavailable' as const, detail: 'cancellation unavailable' })),
      };
    };
  }
  const blockchain = new BlockchainPoller(adapter, 60_000);
  blockchain.refreshWalletOperationProvider();
  const controller = new SessionController(
    blockchain,
    'submission-handoff',
    100n,
    100n,
    makePeerConn([], []),
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

const submission = (id: string): TransactionSubmission => ({
  id,
  attempt_token: `${id}-attempt-1`,
  bundle: testSpendBundle(id),
  fee_request: null,
  intent_fingerprint: 'aa'.repeat(32),
});

describe('submission delivery lease handoff', () => {
  it('retires a delivery before persistence-gated launch', async () => {
    const spend = jest.fn().mockResolvedValue({ status: 'acknowledged' });
    const { controller, cradle, submit } = setup(spend);
    const lease = new ControlledLease();
    try {
      controller.attachTransactionCoordinator(lease);
      submit(submission('retired-before-launch'));
      expect(lease.has('submission:retired-before-launch')).toBe(true);

      (
        controller as unknown as {
          handleRetiredSubmissionIds(ids: string[]): void;
        }
      ).handleRetiredSubmissionIds(['retired-before-launch']);
      await lease.launch('submission:retired-before-launch');
      await controller.flushPendingWork();

      expect(spend).not.toHaveBeenCalled();
      expect(cradle.finalize_submission).not.toHaveBeenCalled();
      expect(cradle.acknowledge_submission).not.toHaveBeenCalled();
      expect(cradle.reject_submission).not.toHaveBeenCalled();
      expect(
        (
          controller as unknown as {
            submissionDeliveries: { hasPrelaunch(id: string): boolean };
          }
        ).submissionDeliveries.hasPrelaunch('retired-before-launch'),
      ).toBe(false);
    } finally {
      controller.cleanup();
    }
  });

  it.each([
    { status: 'acknowledged' as const },
    { status: 'rejected' as const, detail: 'late rejection' },
  ])('makes a late $status wallet completion harmless after retirement', async (outcome) => {
    let resolveSpend!: (value: typeof outcome) => void;
    const spend = jest.fn(
      () =>
        new Promise<typeof outcome>((resolve) => {
          resolveSpend = resolve;
        }),
    );
    const { controller, cradle, submit } = setup(spend);
    const lease = new ControlledLease();
    try {
      controller.attachTransactionCoordinator(lease);
      submit(submission(`retired-after-${outcome.status}`));
      const launch = lease.launch(`submission:retired-after-${outcome.status}`);
      for (let i = 0; i < 20 && spend.mock.calls.length === 0; i += 1) {
        await Promise.resolve();
      }
      expect(spend).toHaveBeenCalledTimes(1);

      (
        controller as unknown as {
          handleRetiredSubmissionIds(ids: string[]): void;
        }
      ).handleRetiredSubmissionIds([`retired-after-${outcome.status}`]);
      resolveSpend(outcome);
      await launch;
      await controller.flushPendingWork();

      expect(cradle.acknowledge_submission).not.toHaveBeenCalled();
      expect(cradle.reject_submission).not.toHaveBeenCalled();
      expect(cradle.drain_submissions).not.toHaveBeenCalled();
    } finally {
      controller.cleanup();
    }
  });

  it('reschedules an unlaunched delivery on the replacement lease exactly once', async () => {
    const spend = jest.fn().mockResolvedValue({ status: 'acknowledged' });
    const { controller, cradle, submit } = setup(spend);
    const first = new ControlledLease();
    const replacement = new ControlledLease();
    try {
      controller.attachTransactionCoordinator(first);
      submit(submission('before-persistence'));
      expect(first.has('submission:before-persistence')).toBe(true);

      controller.attachTransactionCoordinator(replacement);
      expect(replacement.count('submission:before-persistence')).toBe(1);
      await replacement.launch('submission:before-persistence');
      await controller.flushPendingWork();

      expect(spend).toHaveBeenCalledTimes(1);
      expect(cradle.acknowledge_submission).toHaveBeenCalledTimes(1);
      expect(cradle.acknowledge_submission).toHaveBeenCalledWith('before-persistence-attempt-1');
      expect(cradle.relinquish_submission_attempt).toHaveBeenCalledWith(
        'before-persistence-attempt-1',
      );
    } finally {
      controller.cleanup();
    }
  });

  it('replaces an unlaunched bridge entry with the latest Rust attempt', async () => {
    const spend = jest.fn().mockResolvedValue({ status: 'acknowledged' });
    const { controller, cradle, submit } = setup(spend);
    const lease = new ControlledLease(undefined, 'submission-relinquishment:');
    const first = submission('prelaunch-successor');
    const successor = { ...first, attempt_token: 'prelaunch-successor-attempt-2' };
    try {
      controller.attachTransactionCoordinator(lease);
      submit(first);
      submit(successor);
      for (
        let pass = 0;
        pass < 20 && (cradle.relinquish_submission_attempt as jest.Mock).mock.calls.length === 0;
        pass += 1
      ) {
        await Promise.resolve();
      }
      expect(cradle.finalize_submission).not.toHaveBeenCalled();
      const relinquishmentKey =
        'submission-relinquishment:prelaunch-successor:prelaunch-successor-attempt-1';
      for (let pass = 0; pass < 20 && !lease.has(relinquishmentKey); pass += 1) {
        await Promise.resolve();
      }
      await lease.launch(relinquishmentKey);
      await controller.flushTransactionSubmissions();
      await lease.launch('submission:prelaunch-successor');
      const successorRelinquishmentKey =
        'submission-relinquishment:prelaunch-successor:prelaunch-successor-attempt-2';
      for (let pass = 0; pass < 20 && !lease.has(successorRelinquishmentKey); pass += 1) {
        await Promise.resolve();
      }
      await lease.launch(successorRelinquishmentKey);
      await controller.flushPendingWork();

      expect(cradle.finalize_submission).toHaveBeenCalledTimes(1);
      expect(cradle.finalize_submission).toHaveBeenCalledWith(successor.attempt_token, undefined);
      expect(cradle.acknowledge_submission).toHaveBeenCalledWith(successor.attempt_token);
      expect(cradle.relinquish_submission_attempt).toHaveBeenCalledWith(first.attempt_token);
      expect(spend).toHaveBeenCalledTimes(1);
    } finally {
      controller.cleanup();
    }
  });

  it('retains coordinator ownership until relinquishment is checkpointed', async () => {
    const spend = jest.fn().mockResolvedValue({ status: 'acknowledged' });
    const { controller, cradle, submit } = setup(spend);
    const lease = new ControlledLease(undefined, 'submission-relinquishment:');
    try {
      controller.attachTransactionCoordinator(lease);
      submit(submission('checkpointed-relinquishment'));
      await lease.launch('submission:checkpointed-relinquishment');
      for (
        let pass = 0;
        pass < 20 && (cradle.relinquish_submission_attempt as jest.Mock).mock.calls.length === 0;
        pass += 1
      ) {
        await Promise.resolve();
      }

      expect(cradle.relinquish_submission_attempt).toHaveBeenCalledWith(
        'checkpointed-relinquishment-attempt-1',
      );
      expect(
        (
          controller as unknown as {
            submissionDeliveries: { hasPending(): boolean };
          }
        ).submissionDeliveries.hasPending(),
      ).toBe(true);

      const relinquishmentKey =
        'submission-relinquishment:checkpointed-relinquishment:checkpointed-relinquishment-attempt-1';
      for (let pass = 0; pass < 20 && !lease.has(relinquishmentKey); pass += 1) {
        await Promise.resolve();
      }
      await lease.launch(relinquishmentKey);
      await controller.flushPendingWork();
      expect(
        (
          controller as unknown as {
            submissionDeliveries: { hasPending(): boolean };
          }
        ).submissionDeliveries.hasPending(),
      ).toBe(false);
    } finally {
      controller.cleanup();
    }
  });

  it('preserves a successor arriving while a launched failure is being recorded', async () => {
    const lease = new ControlledLease();
    const failure = deferredVoid();
    const first = submission('launched-failure-successor');
    const successor = { ...first, attempt_token: 'launched-failure-successor-attempt-2' };
    const recordFailure = jest.fn(() => failure.promise);
    const coordinator = new SubmissionDeliveryCoordinator({
      getLease: () => lease,
      canLaunch: () => true,
      run: jest.fn().mockRejectedValue(new Error('launch failed')),
      classifySuccessor: () => 'exact',
      relinquishAttempt: jest.fn().mockResolvedValue(undefined),
      requireFreshSync: jest.fn(),
      recordFailure,
      reportError: jest.fn(),
      isRetired: () => false,
    });

    coordinator.submit(first, false);
    await lease.launch('submission:launched-failure-successor');
    for (let pass = 0; pass < 20 && recordFailure.mock.calls.length === 0; pass += 1) {
      await Promise.resolve();
    }
    expect(recordFailure).toHaveBeenCalledWith(first, expect.any(Error));

    coordinator.submit(successor, false);
    failure.resolve();
    await coordinator.flush();

    expect(lease.has('submission:launched-failure-successor')).toBe(true);
  });

  it('preserves a successor arriving while a prelaunch failure is being recorded', async () => {
    const lease = new ControlledLease();
    const failure = deferredVoid();
    const first = submission('prelaunch-failure-successor');
    const successor = { ...first, attempt_token: 'prelaunch-failure-successor-attempt-2' };
    const recordFailure = jest.fn(() => failure.promise);
    const coordinator = new SubmissionDeliveryCoordinator({
      getLease: () => lease,
      canLaunch: () => true,
      run: jest.fn(),
      classifySuccessor: () => 'exact',
      relinquishAttempt: jest.fn().mockResolvedValue(undefined),
      requireFreshSync: jest.fn(),
      recordFailure,
      reportError: jest.fn(),
      isRetired: () => false,
    });

    coordinator.submit(first, false);
    lease.reject('submission:prelaunch-failure-successor', new Error('persistence failed'));
    for (let pass = 0; pass < 20 && recordFailure.mock.calls.length === 0; pass += 1) {
      await Promise.resolve();
    }
    expect(recordFailure).toHaveBeenCalledWith(first, expect.any(Error));

    coordinator.submit(successor, false);
    failure.resolve();
    await coordinator.flush();

    expect(lease.has('submission:prelaunch-failure-successor')).toBe(true);
  });

  it('keeps a launched delivery queue-owned across lease replacement', async () => {
    let resolveSpend!: (value: { status: 'acknowledged' }) => void;
    const spendGate = new Promise<{ status: 'acknowledged' }>((resolve) => {
      resolveSpend = resolve;
    });
    const spend = jest.fn(() => spendGate);
    const { controller, cradle, submit } = setup(spend);
    const first = new ControlledLease();
    const replacement = new ControlledLease();
    try {
      controller.attachTransactionCoordinator(first);
      submit(submission('after-launch'));
      const launch = first.launch('submission:after-launch');
      for (let i = 0; i < 10 && spend.mock.calls.length === 0; i += 1) {
        await Promise.resolve();
      }
      expect(spend).toHaveBeenCalledTimes(1);

      controller.attachTransactionCoordinator(replacement);
      expect(replacement.has('submission:after-launch')).toBe(false);

      resolveSpend({ status: 'acknowledged' });
      await launch;
      await controller.flushPendingWork();
      expect(spend).toHaveBeenCalledTimes(1);
      expect(cradle.acknowledge_submission).toHaveBeenCalledTimes(1);
    } finally {
      controller.cleanup();
    }
  });

  it('hands an unlaunched finalized broadcast to the replacement lease', async () => {
    const spend = jest.fn().mockResolvedValue({ status: 'acknowledged' });
    const { controller, cradle, submit } = setup(spend);
    const first = new ControlledLease(undefined, 'broadcast:');
    const replacement = new ControlledLease();
    try {
      controller.attachTransactionCoordinator(first);
      submit(submission('finalized-broadcast-handoff'));
      const launch = first.launch('submission:finalized-broadcast-handoff');
      const broadcastKey = `broadcast:finalized-broadcast-handoff:${'bb'.repeat(32)}`;
      for (let i = 0; i < 50 && !first.has(broadcastKey); i += 1) {
        await Promise.resolve();
      }

      expect(first.has(broadcastKey)).toBe(true);
      expect(cradle.finalize_submission).toHaveBeenCalledTimes(1);
      expect(spend).not.toHaveBeenCalled();

      controller.attachTransactionCoordinator(replacement);
      await launch;
      await controller.flushPendingWork();

      expect(cradle.finalize_submission).toHaveBeenCalledTimes(1);
      expect(spend).toHaveBeenCalledTimes(1);
      expect(cradle.acknowledge_submission).toHaveBeenCalledTimes(1);
      expect(cradle.acknowledge_submission).toHaveBeenCalledWith(
        'finalized-broadcast-handoff-attempt-1',
      );
    } finally {
      controller.cleanup();
    }
  });

  it('cleans a finalized fee reservation independently of lease replacement', async () => {
    const spend = jest.fn().mockResolvedValue({ status: 'rejected', detail: 'wallet rejected' });
    const beginWalletOffer = jest.fn().mockResolvedValue({
      kind: 'created',
      material: { kind: 'offer', offer: 'offer-fee' },
      tradeId: 'trade-fee',
    });
    const beginWalletOfferCancellation = jest.fn().mockResolvedValue({ status: 'cancelled' });
    const { controller, cradle, submit } = setup(spend, {
      beginWalletOffer,
      beginWalletOfferCancellation,
    });
    const first = new ControlledLease();
    const replacement = new ControlledLease();
    try {
      controller.attachTransactionCoordinator(first);
      (cradle.drain_submissions as jest.Mock).mockReturnValueOnce(
        submissionDrain([], ['fee-release-handoff']),
      );
      submit({
        ...submission('fee-release-handoff'),
        fee_request: { target: '22'.repeat(32), amount: '10' },
      });
      const launch = first.launch('submission:fee-release-handoff');
      for (let i = 0; i < 50 && beginWalletOfferCancellation.mock.calls.length === 0; i += 1) {
        await Promise.resolve();
      }
      expect(spend).toHaveBeenCalledTimes(1);
      expect(cradle.reject_submission).toHaveBeenCalledTimes(1);
      expect(beginWalletOfferCancellation).not.toHaveBeenCalled();

      controller.attachTransactionCoordinator(replacement);
      await launch;
      controller.processResult(wasmResult());
      await controller.flushPendingWork();

      expect(spend).toHaveBeenCalledTimes(1);
      expect(cradle.reject_submission).toHaveBeenCalledTimes(1);
      expect(beginWalletOfferCancellation).toHaveBeenCalledTimes(1);
      expect(beginWalletOfferCancellation).toHaveBeenCalledWith('trade-fee');
    } finally {
      controller.cleanup();
    }
  });

  it('hands an acknowledged wallet outcome to the replacement lease without rebroadcasting', async () => {
    const spend = jest.fn().mockResolvedValue({ status: 'acknowledged' });
    const { controller, cradle, submit } = setup(spend);
    const first = new ControlledLease(2);
    const replacement = new ControlledLease();
    try {
      controller.attachTransactionCoordinator(first);
      submit(submission('acknowledged-handoff'));
      const launch = first.launch('submission:acknowledged-handoff');
      for (let i = 0; i < 50 && !first.hasPendingMutation(); i += 1) {
        await Promise.resolve();
      }
      expect(spend).toHaveBeenCalledTimes(1);
      expect(first.hasPendingMutation()).toBe(true);
      expect(cradle.acknowledge_submission).not.toHaveBeenCalled();

      controller.attachTransactionCoordinator(replacement);
      await launch;
      await controller.flushPendingWork();

      expect(spend).toHaveBeenCalledTimes(1);
      expect(cradle.finalize_submission).toHaveBeenCalledTimes(1);
      expect(cradle.acknowledge_submission).toHaveBeenCalledTimes(1);
      expect(cradle.acknowledge_submission).toHaveBeenCalledWith('acknowledged-handoff-attempt-1');
    } finally {
      controller.cleanup();
    }
  });

  it.each([
    [
      'block-height completion',
      (controller: SessionController) => controller.reportNewBlock(7n),
      'report_height',
      [7n],
    ],
    [
      'coin-snapshot completion',
      (controller: SessionController) =>
        controller.reportCoinStates(8n, [
          { coin: 'coin-state', created_height: 8n, spent_height: null },
        ]),
      'report_coin_states',
      [8n, [{ coin: 'coin-state', created_height: 8n, spent_height: null }]],
    ],
  ] as const)(
    'hands %s to a replacement lease exactly once',
    async (_label, deliver, cradleMethod, expectedArguments) => {
      const { controller, cradle } = setup(jest.fn());
      const first = new ControlledLease(1);
      const replacement = new ControlledLease();
      try {
        controller.attachTransactionCoordinator(first);
        const completion = deliver(controller);
        expect(first.hasPendingMutation()).toBe(true);

        controller.attachTransactionCoordinator(replacement);
        await completion;

        const callback = cradle[cradleMethod] as jest.Mock;
        expect(callback).toHaveBeenCalledTimes(1);
        expect(callback).toHaveBeenCalledWith(...expectedArguments);
      } finally {
        controller.cleanup();
      }
    },
  );

  it.each([
    [
      'block-height observation',
      (controller: SessionController) => controller.reportNewBlock(7n),
      'report_height',
      [7n],
    ],
    [
      'coin-snapshot observation',
      (controller: SessionController) =>
        controller.reportCoinStates(8n, [
          { coin: 'coin-state', created_height: 8n, spent_height: null },
        ]),
      'report_coin_states',
      [8n, [{ coin: 'coin-state', created_height: 8n, spent_height: null }]],
    ],
  ] as const)(
    'queues a %s until a committed runtime lease exists',
    async (_label, deliver, cradleMethod, expectedArguments) => {
      const { controller, cradle } = setup(jest.fn());
      const lease = new ControlledLease();
      try {
        await deliver(controller);
        const callback = cradle[cradleMethod] as jest.Mock;
        expect(callback).not.toHaveBeenCalled();

        controller.attachTransactionCoordinator(lease);
        await controller.flushPendingWork();

        expect(callback).toHaveBeenCalledTimes(1);
        expect(callback).toHaveBeenCalledWith(...expectedArguments);
      } finally {
        controller.cleanup();
      }
    },
  );

  it.each([
    [
      'block-height',
      'report_height',
      (controller: SessionController) => controller.reportNewBlock(9n),
    ],
    [
      'coin-snapshot',
      'report_coin_states',
      (controller: SessionController) => controller.reportCoinStates(9n, []),
    ],
  ] as const)(
    'propagates and reports a non-retirement %s callback failure',
    async (_label, cradleMethod, deliver) => {
      expectConsoleError('authoritative callback failed');
      const { controller, cradle } = setup(jest.fn());
      const lease = new ControlledLease();
      const errors: string[] = [];
      const subscription = controller.getObservable().subscribe((event) => {
        if (event.type === 'error') errors.push(event.error);
      });
      (cradle[cradleMethod] as jest.Mock).mockImplementation(() => {
        throw new Error('authoritative callback failed');
      });
      try {
        controller.attachTransactionCoordinator(lease);
        await expect(deliver(controller)).rejects.toThrow('authoritative callback failed');
        expect(errors).toEqual(['authoritative callback failed']);
      } finally {
        subscription.unsubscribe();
        controller.cleanup();
      }
    },
  );

  it('hands wallet failure recording to the replacement lease without retrying the wallet', async () => {
    expectConsoleError('wallet failed after broadcast');
    const spend = jest.fn().mockRejectedValue(new Error('wallet failed after broadcast'));
    const { controller, cradle, submit } = setup(spend);
    const first = new ControlledLease(2);
    const replacement = new ControlledLease();
    const recordFailure = jest.spyOn(
      controller as unknown as {
        recordLocalSubmissionFailure(submission: TransactionSubmission, error: unknown): void;
      },
      'recordLocalSubmissionFailure',
    );
    const errors: string[] = [];
    const subscription = controller.getObservable().subscribe((event) => {
      if (event.type === 'error') errors.push(event.error);
    });
    try {
      controller.attachTransactionCoordinator(first);
      submit(submission('failure-handoff'));
      const launch = first.launch('submission:failure-handoff');
      for (let i = 0; i < 50 && !first.hasPendingMutation(); i += 1) {
        await Promise.resolve();
      }
      expect(spend).toHaveBeenCalledTimes(1);
      expect(first.hasPendingMutation()).toBe(true);
      expect(errors).toEqual([]);

      controller.attachTransactionCoordinator(replacement);
      await launch;
      await controller.flushPendingWork();

      expect(spend).toHaveBeenCalledTimes(1);
      expect(cradle.finalize_submission).toHaveBeenCalledTimes(1);
      expect(recordFailure).toHaveBeenCalledTimes(1);
      expect(errors).toEqual([
        expect.stringMatching(
          /failure-handoff.*retained for retry.*wallet failed after broadcast/i,
        ),
      ]);
    } finally {
      subscription.unsubscribe();
      controller.cleanup();
    }
  });

  it('does not duplicate scheduling when the same lease attaches repeatedly', async () => {
    const spend = jest.fn().mockResolvedValue({ status: 'acknowledged' });
    const { controller, submit } = setup(spend);
    const lease = new ControlledLease();
    try {
      controller.attachTransactionCoordinator(lease);
      submit(submission('repeated-attach'));
      controller.attachTransactionCoordinator(lease);
      controller.attachTransactionCoordinator(lease);

      expect(lease.count('submission:repeated-attach')).toBe(1);
      await lease.launch('submission:repeated-attach');
      await controller.flushPendingWork();
      expect(spend).toHaveBeenCalledTimes(1);
    } finally {
      controller.cleanup();
    }
  });

  it('accepts and orders a variant upgrade under the same durable intent', async () => {
    let resolveFirstSpend!: (value: { status: 'acknowledged' }) => void;
    const spend = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<{ status: 'acknowledged' }>((resolve) => {
            resolveFirstSpend = resolve;
          }),
      )
      .mockResolvedValue({ status: 'acknowledged' });
    const { controller, cradle, submit } = setup(spend);
    const lease = new ControlledLease();
    const first = submission('variant-upgrade');
    const upgrade = { ...first, attempt_token: 'variant-upgrade-attempt-2' };
    try {
      controller.attachTransactionCoordinator(lease);
      submit(first);
      await lease.launch('submission:variant-upgrade');
      for (let pass = 0; pass < 20 && spend.mock.calls.length === 0; pass += 1) {
        await Promise.resolve();
      }
      expect(spend).toHaveBeenCalledTimes(1);

      submit(upgrade);
      resolveFirstSpend({ status: 'acknowledged' });
      for (let pass = 0; pass < 20 && !lease.has('submission:variant-upgrade'); pass += 1) {
        await Promise.resolve();
      }
      expect(lease.has('submission:variant-upgrade')).toBe(true);
      await lease.launch('submission:variant-upgrade');
      await controller.flushPendingWork();

      expect(spend).toHaveBeenCalledTimes(2);
      expect((cradle.finalize_submission as jest.Mock).mock.calls.map((call) => call[0])).toEqual([
        'variant-upgrade-attempt-1',
        'variant-upgrade-attempt-2',
      ]);
    } finally {
      controller.cleanup();
    }
  });

  it('schedules a successor without reporting a superseded in-flight wallet result', async () => {
    let resolveFirstSpend!: (value: { status: 'acknowledged' }) => void;
    const spend = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<{ status: 'acknowledged' }>((resolve) => {
            resolveFirstSpend = resolve;
          }),
      )
      .mockResolvedValue({ status: 'acknowledged' });
    const { controller, cradle, submit } = setup(spend);
    const lease = new ControlledLease();
    const first = submission('superseded-wallet-result');
    const intermediate = { ...first, attempt_token: 'superseded-wallet-result-attempt-2' };
    const successor = { ...first, attempt_token: 'superseded-wallet-result-attempt-3' };
    (cradle.submission_successor_relationship as jest.Mock).mockReturnValue('exact');
    try {
      controller.attachTransactionCoordinator(lease);
      submit(first);
      const firstLaunch = lease.launch('submission:superseded-wallet-result');
      for (let pass = 0; pass < 20 && spend.mock.calls.length === 0; pass += 1) {
        await Promise.resolve();
      }

      submit(intermediate);
      submit(successor);
      resolveFirstSpend({ status: 'acknowledged' });
      await firstLaunch;
      await controller.flushTransactionSubmissions();

      expect(cradle.acknowledge_submission_attempt).not.toHaveBeenCalledWith(first.attempt_token);
      expect(cradle.submission_attempt_unavailable).not.toHaveBeenCalledWith(first.attempt_token);
      expect(cradle.relinquish_submission_attempt).not.toHaveBeenCalledWith(first.attempt_token);
      expect(cradle.relinquish_submission_attempt).toHaveBeenCalledWith(intermediate.attempt_token);
      expect(lease.has('submission:superseded-wallet-result')).toBe(true);

      await lease.launch('submission:superseded-wallet-result');
      await controller.flushPendingWork();
      expect(cradle.acknowledge_submission_attempt).toHaveBeenCalledWith(successor.attempt_token);
    } finally {
      controller.cleanup();
    }
  });

  it('gates an exact successor after an unavailable attempted variant until snapshot ready', async () => {
    let resolveSpend!: (value: { status: 'unavailable'; detail: string }) => void;
    const spend = jest.fn(
      () =>
        new Promise<{ status: 'unavailable'; detail: string }>((resolve) => {
          resolveSpend = resolve;
        }),
    );
    const { controller, cradle, submit } = setup(spend);
    const firstLease = new ControlledLease();
    const replacementLease = new ControlledLease();
    const first = submission('exact-successor');
    const successor = { ...first, attempt_token: 'exact-successor-attempt-2' };
    try {
      controller.attachTransactionCoordinator(firstLease);
      submit(first);
      const launch = firstLease.launch('submission:exact-successor');
      for (let pass = 0; pass < 20 && spend.mock.calls.length === 0; pass += 1) {
        await Promise.resolve();
      }
      submit(successor);
      resolveSpend({ status: 'unavailable', detail: 'wallet syncing' });
      await launch;
      await controller.flushTransactionSubmissions();

      expect(cradle.submission_successor_relationship).toHaveBeenCalledWith(
        successor.attempt_token,
        first.attempt_token,
      );
      expect(firstLease.has('submission:exact-successor')).toBe(false);

      controller.attachTransactionCoordinator(replacementLease);
      await controller.reportChainSnapshotReady(2n);
      expect(replacementLease.has('submission:exact-successor')).toBe(true);
    } finally {
      controller.cleanup();
    }
  });

  it('launches a Rust-classified newer fee-bearing successor without fresh sync', async () => {
    let resolveSpend!: (value: { status: 'unavailable'; detail: string }) => void;
    const spend = jest.fn(
      () =>
        new Promise<{ status: 'unavailable'; detail: string }>((resolve) => {
          resolveSpend = resolve;
        }),
    );
    const { controller, cradle, submit } = setup(spend);
    const lease = new ControlledLease();
    const first = submission('fee-successor');
    const successor = {
      ...first,
      attempt_token: 'fee-successor-attempt-2',
      fee_request: { target: '22'.repeat(32), amount: '10' },
    };
    (cradle.submission_successor_relationship as jest.Mock).mockReturnValue('newer-fee-bearing');
    try {
      controller.attachTransactionCoordinator(lease);
      submit(first);
      const launch = lease.launch('submission:fee-successor');
      for (let pass = 0; pass < 20 && spend.mock.calls.length === 0; pass += 1) {
        await Promise.resolve();
      }
      submit(successor);
      resolveSpend({ status: 'unavailable', detail: 'wallet syncing' });
      await launch;
      await controller.flushTransactionSubmissions();

      expect(lease.has('submission:fee-successor')).toBe(true);
      expect(cradle.chain_snapshot_ready).not.toHaveBeenCalled();
    } finally {
      controller.cleanup();
    }
  });

  it('does not gate an unrelated submission behind an exact successor fresh-sync wait', async () => {
    let resolveFirst!: (value: { status: 'unavailable'; detail: string }) => void;
    const spend = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<{ status: 'unavailable'; detail: string }>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValue({ status: 'acknowledged' });
    const { controller, submit } = setup(spend);
    const lease = new ControlledLease();
    const first = submission('snapshot-gated');
    const successor = { ...first, attempt_token: 'snapshot-gated-attempt-2' };
    const unrelated = submission('unrelated-urgent');
    try {
      controller.attachTransactionCoordinator(lease);
      submit(first);
      const launch = lease.launch('submission:snapshot-gated');
      for (let pass = 0; pass < 20 && spend.mock.calls.length === 0; pass += 1) {
        await Promise.resolve();
      }
      submit(successor);
      resolveFirst({ status: 'unavailable', detail: 'wallet syncing' });
      await launch;
      await controller.flushTransactionSubmissions();

      submit(unrelated);
      expect(lease.has('submission:snapshot-gated')).toBe(false);
      expect(lease.has('submission:unrelated-urgent')).toBe(true);
      await lease.launch('submission:unrelated-urgent');
      await controller.flushTransactionSubmissions();
      expect(spend).toHaveBeenCalledTimes(2);
    } finally {
      controller.cleanup();
    }
  });

  it('fails a duplicate stable id with a mismatched intent before wallet side effects', () => {
    const spend = jest.fn().mockResolvedValue({ status: 'acknowledged' });
    const { controller, cradle, submit } = setup(spend);
    const lease = new ControlledLease();
    try {
      controller.attachTransactionCoordinator(lease);
      submit(submission('intent-mismatch'));

      expect(() =>
        submit({
          ...submission('intent-mismatch'),
          intent_fingerprint: 'dd'.repeat(32),
          attempt_token: 'intent-mismatch-attempt-2',
        }),
      ).toThrow('mismatched durable intent fingerprint');
      expect(spend).not.toHaveBeenCalled();
      expect(cradle.finalize_submission).not.toHaveBeenCalled();
    } finally {
      controller.cleanup();
    }
  });

  it('records an unexpected release failure once and retires the delivery', async () => {
    expectConsoleError('release exploded');
    const spend = jest.fn().mockResolvedValue({ status: 'acknowledged' });
    const { controller, submit } = setup(spend);
    const lease = new ControlledLease();
    const errors: string[] = [];
    const subscription = controller.getObservable().subscribe((event) => {
      if (event.type === 'error') errors.push(event.error);
    });
    try {
      controller.attachTransactionCoordinator(lease);
      submit(submission('release-failure'));
      lease.reject('submission:release-failure', new Error('release exploded'));
      for (
        let i = 0;
        i < 10 &&
        (
          controller as unknown as {
            submissionDeliveries: { hasPrelaunch(id: string): boolean };
          }
        ).submissionDeliveries.hasPrelaunch('release-failure');
        i += 1
      ) {
        await Promise.resolve();
      }

      expect(spend).not.toHaveBeenCalled();
      expect(errors).toEqual([
        expect.stringMatching(/release-failure.*retained for retry.*release exploded/i),
      ]);
      expect(
        (
          controller as unknown as {
            submissionDeliveries: { hasPrelaunch(id: string): boolean };
          }
        ).submissionDeliveries.hasPrelaunch('release-failure'),
      ).toBe(false);
    } finally {
      subscription.unsubscribe();
      controller.cleanup();
    }
  });

  it('keeps network rejection authoritative when durable fee cleanup fails', async () => {
    const spend = jest.fn().mockResolvedValue({ status: 'rejected', detail: 'invalid spend' });
    const beginWalletOffer = jest.fn().mockResolvedValue({
      kind: 'created',
      material: { kind: 'offer', offer: 'offer-fee' },
      tradeId: 'trade-cleanup-fails',
    });
    const beginWalletOfferCancellation = jest
      .fn()
      .mockResolvedValue({ status: 'rejected', detail: 'wallet cleanup failed' });
    const { controller, cradle, submit } = setup(spend, {
      beginWalletOffer,
      beginWalletOfferCancellation,
    });
    const lease = new ControlledLease();
    try {
      controller.attachTransactionCoordinator(lease);
      (cradle.drain_submissions as jest.Mock).mockReturnValueOnce(
        submissionDrain([], ['network-rejected-cleanup-fails']),
      );
      submit({
        ...submission('network-rejected-cleanup-fails'),
        fee_request: { target: '22'.repeat(32), amount: '10' },
      });
      await lease.launch('submission:network-rejected-cleanup-fails');
      await controller.flushTransactionSubmissions();
      controller.processResult(wasmResult());
      await controller.flushPendingWork();

      expect(cradle.reject_submission).toHaveBeenCalledWith(
        'network-rejected-cleanup-fails-attempt-1',
      );
      expect(cradle.acknowledge_submission).not.toHaveBeenCalled();
      expect(beginWalletOfferCancellation).toHaveBeenCalledTimes(1);
      expect(walletOperationService.snapshot()).toEqual([
        expect.objectContaining({
          tradeId: 'trade-cleanup-fails',
          stage: 'cancel-required',
          reason: 'fee-submission-retired',
        }),
      ]);
    } finally {
      controller.cleanup();
    }
  });

  it('starts coordinated fee cleanup only after its persistence release', async () => {
    expectConsoleError('fee source rejected by Rust');
    const spend = jest.fn();
    const beginWalletOffer = jest.fn().mockResolvedValue({
      kind: 'created',
      material: { kind: 'offer', offer: 'offer-fee' },
      tradeId: 'trade-finalize-rejected',
    });
    const beginWalletOfferCancellation = jest.fn().mockResolvedValue({ status: 'cancelled' });
    const { controller, cradle, submit } = setup(spend, {
      beginWalletOffer,
      beginWalletOfferCancellation,
    });
    (cradle.finalize_submission as jest.Mock).mockImplementation(() => {
      throw new Error('fee source rejected by Rust');
    });
    const lease = new ControlledLease(undefined, 'wallet-offer-cancellation:');
    try {
      controller.attachTransactionCoordinator(lease);
      submit({
        ...submission('finalize-rejected'),
        fee_request: { target: '22'.repeat(32), amount: '10' },
      });
      await lease.launch('submission:finalize-rejected');
      for (
        let pass = 0;
        pass < 20 && !lease.has('wallet-offer-cancellation:trade-finalize-rejected');
        pass += 1
      ) {
        await Promise.resolve();
      }

      expect(beginWalletOfferCancellation).not.toHaveBeenCalled();
      await lease.launch('wallet-offer-cancellation:trade-finalize-rejected');
      await controller.flushPendingWork();

      expect(spend).not.toHaveBeenCalled();
      expect(beginWalletOfferCancellation).toHaveBeenCalledWith('trade-finalize-rejected');
      expect(walletOperationService.snapshot()).toEqual([]);
    } finally {
      controller.cleanup();
    }
  });

  it('keeps terminal quiescence blocked on the delivery entry and queue job', async () => {
    let resolveSpend!: (value: { status: 'acknowledged' }) => void;
    const spend = jest.fn(
      () =>
        new Promise<{ status: 'acknowledged' }>((resolve) => {
          resolveSpend = resolve;
        }),
    );
    const { controller, submit } = setup(spend);
    const lease = new ControlledLease();
    try {
      controller.attachTransactionCoordinator(lease);
      submit(submission('slow-wallet'));
      let quiesced = false;
      const quiescence = controller.quiesceForTerminalFinalization().then(() => {
        quiesced = true;
      });
      await Promise.resolve();
      expect(spend).not.toHaveBeenCalled();
      expect(quiesced).toBe(false);

      const launch = lease.launch('submission:slow-wallet');
      for (let i = 0; i < 10 && spend.mock.calls.length === 0; i += 1) {
        await Promise.resolve();
      }

      expect(spend).toHaveBeenCalledTimes(1);
      expect(quiesced).toBe(false);
      expect(
        (
          controller as unknown as {
            submissionDeliveries: {
              hasPrelaunch(id: string): boolean;
              hasPending(): boolean;
            };
          }
        ).submissionDeliveries.hasPrelaunch('slow-wallet'),
      ).toBe(false);
      expect((controller as any).submissionDeliveries.hasPending()).toBe(true);

      resolveSpend({ status: 'acknowledged' });
      await launch;
      await quiescence;
      expect(quiesced).toBe(true);
    } finally {
      controller.cleanup();
    }
  });

  it('revalidates quiescence when the active lease changes during snapshot', async () => {
    const { controller } = setup(jest.fn());
    const firstModel = createSessionModel({ myRunningBalance: 1n });
    const replacementModel = createSessionModel({ myRunningBalance: 2n });
    const replacementSnapshot = jest.fn(() => replacementModel);
    const replacement = new ControlledLease(undefined, undefined, replacementSnapshot);
    const firstSnapshot = jest.fn(() => {
      controller.attachTransactionCoordinator(replacement);
      return firstModel;
    });
    const first = new ControlledLease(undefined, undefined, firstSnapshot);
    try {
      controller.attachTransactionCoordinator(first);

      const snapshot = await controller.quiesceForTerminalFinalization();
      expect(snapshot).toEqual({ model: replacementModel, coinsOfInterest: [] });
      expect(snapshot.model).not.toBe(replacementModel);
      expect(firstSnapshot).toHaveBeenCalledTimes(1);
      expect(replacementSnapshot).toHaveBeenCalledTimes(1);
    } finally {
      controller.cleanup();
    }
  });

  it('fails terminal quiescence explicitly without an active lease', async () => {
    const { controller } = setup(jest.fn());
    try {
      await expect(controller.quiesceForTerminalFinalization()).rejects.toThrow(
        'terminal finalization requires an active runtime lease',
      );
    } finally {
      controller.cleanup();
    }
  });

  it('fails terminal quiescence when the authoritative coin query fails', async () => {
    const { controller, cradle } = setup(jest.fn());
    const lease = new ControlledLease();
    (cradle.coins_of_interest as jest.Mock).mockImplementation(() => {
      throw new Error('coin query failed');
    });
    try {
      controller.attachTransactionCoordinator(lease);
      await expect(controller.quiesceForTerminalFinalization()).rejects.toThrow(
        'coin query failed',
      );
    } finally {
      controller.cleanup();
    }
  });

  it('settles unlaunched submissions and tracked work synchronously on repeated cleanup', async () => {
    const spend = jest.fn();
    const { controller, submit } = setup(spend);
    const lease = new ControlledLease();
    let finishEffect!: () => void;
    const effect = new Promise<void>((resolve) => {
      finishEffect = resolve;
    });
    (
      controller as unknown as {
        trackEffect(effect: Promise<void>): void;
      }
    ).trackEffect(effect);
    controller.attachTransactionCoordinator(lease);
    submit(submission('never-launched'));

    controller.cleanup();
    controller.cleanupAfterTerminalFlush();

    await expect(controller.flushTransactionSubmissions()).resolves.toBeUndefined();
    await expect(controller.flushPendingWork()).resolves.toBeUndefined();
    expect(spend).not.toHaveBeenCalled();
    expect(
      (
        controller as unknown as {
          submissionDeliveries: { hasPending(): boolean };
        }
      ).submissionDeliveries.hasPending(),
    ).toBe(false);
    finishEffect();
  });

  it('detaches a launched wallet job from cleanup quiescence and never mutates the dropped cradle', async () => {
    let resolveSpend!: (value: { status: 'acknowledged' }) => void;
    const spend = jest.fn(
      () =>
        new Promise<{ status: 'acknowledged' }>((resolve) => {
          resolveSpend = resolve;
        }),
    );
    const { controller, cradle, submit } = setup(spend);
    const lease = new ControlledLease();
    controller.attachTransactionCoordinator(lease);
    submit(submission('late-wallet'));
    const launch = lease.launch('submission:late-wallet');
    for (let pass = 0; pass < 20 && spend.mock.calls.length === 0; pass += 1) {
      await Promise.resolve();
    }
    expect(spend).toHaveBeenCalledTimes(1);

    controller.cleanup();
    await expect(controller.flushPendingWork()).resolves.toBeUndefined();
    await expect(controller.flushTransactionSubmissions()).resolves.toBeUndefined();
    await expect(launch).resolves.toBeUndefined();

    resolveSpend({ status: 'acknowledged' });
    for (let pass = 0; pass < 20; pass += 1) await Promise.resolve();
    expect(cradle.acknowledge_submission).not.toHaveBeenCalled();
    expect(cradle.reject_submission).not.toHaveBeenCalled();
    expect((controller as unknown as { cradle: unknown }).cradle).toBeUndefined();
  });

  it('routes a late funding offer through the global ledger after cleanup', async () => {
    walletOperationService.resetForTests();
    let resolveOffer!: (value: {
      kind: 'created';
      material: { kind: 'offer'; offer: string };
      tradeId: string;
    }) => void;
    const beginWalletOffer = jest.fn(
      () =>
        new Promise<{
          kind: 'created';
          material: { kind: 'offer'; offer: string };
          tradeId: string;
        }>((resolve) => {
          resolveOffer = resolve;
        }),
    );
    const beginWalletOfferCancellation = jest.fn().mockResolvedValue({ status: 'cancelled' });
    const { controller, cradle } = setup(jest.fn(), {
      beginWalletOffer,
      beginWalletOfferCancellation,
    });
    const lease = new ControlledLease();
    const request = canonicalizeFundingRequest({
      amount: '100',
      fee: '0',
      conditions: [{ opcode: 60n, args: ['launcher'] }],
    });
    controller.processResult(wasmResult({ events: [{ NeedCoinSpend: request }] }));
    controller.flushDeferredWork();
    controller.attachTransactionCoordinator(lease);
    for (let pass = 0; pass < 20 && beginWalletOffer.mock.calls.length === 0; pass += 1) {
      await Promise.resolve();
    }
    expect(beginWalletOffer).toHaveBeenCalledTimes(1);

    controller.cleanup();
    resolveOffer({
      kind: 'created',
      material: { kind: 'offer', offer: 'offer1late' },
      tradeId: 'trade-late-funding',
    });
    for (
      let pass = 0;
      pass < 50 && beginWalletOfferCancellation.mock.calls.length === 0;
      pass += 1
    ) {
      await Promise.resolve();
    }
    const owner = {
      installationPlayerId: 'submission-handoff',
      peerSessionId: '00'.repeat(16),
      providerScope: { provider: 'simulator' as const, identity: 'submission-handoff' },
    };
    await walletOperationService.awaitOwner(owner);

    expect(beginWalletOfferCancellation).toHaveBeenCalledWith('trade-late-funding');
    expect(walletOperationService.entriesFor(owner)).toEqual([]);
    expect(cradle.provide_coin_spend_bundle).not.toHaveBeenCalled();
  });

  it('retires a fee creation whose recovery id arrives after controller cleanup', async () => {
    walletOperationService.resetForTests();
    let finishBegin!: (value: { kind: 'pending'; recoveryId: string }) => void;
    const beginWalletOffer = jest.fn(
      () =>
        new Promise<{ kind: 'pending'; recoveryId: string }>((resolve) => {
          finishBegin = resolve;
        }),
    );
    const reconcileWalletOffer = jest
      .fn()
      .mockResolvedValueOnce({ kind: 'unavailable', reason: 'wallet disconnected' })
      .mockResolvedValueOnce({
        kind: 'created',
        material: { kind: 'offer', offer: 'offer1latefee' },
        tradeId: 'trade-late-fee',
      });
    const beginWalletOfferCancellation = jest.fn().mockResolvedValue({ status: 'cancelled' });
    const { blockchain, controller, cradle, submit } = setup(jest.fn(), {
      beginWalletOffer,
      reconcileWalletOffer,
      beginWalletOfferCancellation,
    });
    const lease = new ControlledLease();
    controller.attachTransactionCoordinator(lease);
    submit({
      ...submission('late-fee-recovery'),
      fee_request: { target: '22'.repeat(32), amount: '10' },
    });
    await lease.launch('submission:late-fee-recovery');
    for (let pass = 0; pass < 20 && beginWalletOffer.mock.calls.length === 0; pass += 1) {
      await Promise.resolve();
    }
    expect(beginWalletOffer).toHaveBeenCalledTimes(1);

    controller.cleanup();
    finishBegin({ kind: 'pending', recoveryId: 'SR_late_fee' });
    for (let pass = 0; pass < 30 && reconcileWalletOffer.mock.calls.length === 0; pass += 1) {
      await Promise.resolve();
    }
    const owner = walletOperationService.snapshot()[0]!.owner;
    await walletOperationService.awaitOwner(owner);
    expect(walletOperationService.snapshot()).toEqual([
      expect.objectContaining({
        stage: 'creating',
        disposition: 'cancel-on-create',
        recoveryId: 'SR_late_fee',
      }),
    ]);

    const provider = blockchain.rpc.getWalletOfferProvider({
      installationPlayerId: owner.installationPlayerId,
      peerSessionId: owner.peerSessionId,
    });
    expect(provider).not.toBeNull();
    walletOperationService.providerReady(provider!);
    await walletOperationService.awaitOwner(owner);

    expect(beginWalletOffer).toHaveBeenCalledTimes(1);
    expect(reconcileWalletOffer).toHaveBeenCalledTimes(2);
    expect(beginWalletOfferCancellation).toHaveBeenCalledWith('trade-late-fee');
    expect(walletOperationService.entriesFor(owner)).toEqual([]);
    expect(cradle.finalize_submission).not.toHaveBeenCalled();
    expect(cradle.acknowledge_submission).not.toHaveBeenCalled();
    expect(cradle.reject_submission).not.toHaveBeenCalled();
  });
});

describe('durable wallet operation record', () => {
  const owner = {
    installationPlayerId: 'submission-handoff',
    peerSessionId: '00'.repeat(16),
    providerScope: { provider: 'simulator' as const, identity: 'submission-handoff' },
  };

  beforeEach(() => walletOperationService.resetForTests());

  it('keeps a Rust funding request idle until an adapter establishes scope', async () => {
    const controller = new SessionController(
      null,
      'submission-handoff',
      100n,
      100n,
      makePeerConn([], []),
      walletOperationService,
    );
    const cradle = makeMockCradle();
    controller.rewardPuzzleHash = '11'.repeat(32);
    controller.loadWasm(mockWasmConnection);
    controller.setGameSession(cradle);
    controller.attachTransactionCoordinator(new ControlledLease());
    const request = canonicalizeFundingRequest({
      amount: '100',
      fee: '0',
      conditions: [{ opcode: 60n, args: ['launcher'] }],
    });

    expect(() =>
      controller.processResult(wasmResult({ events: [{ NeedCoinSpend: request }] })),
    ).not.toThrow();
    controller.flushDeferredWork();

    const beginWalletOffer = jest.fn().mockResolvedValue({
      kind: 'created',
      material: { kind: 'bundle', bundle: testSpendBundle('restore-before-adapter') },
    });
    const blockchain = new BlockchainPoller(
      { ...mockRpc, beginWalletOffer } as InternalBlockchainInterface,
      60_000,
    );
    controller.attachBlockchain(blockchain);
    await controller.flushPendingWork();

    expect(beginWalletOffer).toHaveBeenCalledTimes(1);
    expect(cradle.provide_coin_spend_bundle).toHaveBeenCalledTimes(1);
    controller.cleanup();
  });

  it('keeps a failed independent write dirty and recovers on a later checkpoint', async () => {
    const ledger = new WalletOperationService();
    let fail = true;
    const writes: string[][] = [];
    ledger.configurePersistence(async (entries) => {
      if (fail) throw new Error('disk full');
      writes.push(entries.map((entry) => entry.tradeId));
    });

    ledger.registerReserved('trade-dirty', owner, {
      kind: 'funding',
      operationId: 'funding-operation',
    });
    await ledger.flushPersistence();
    expect(ledger.isDirty()).toBe(true);

    fail = false;
    await ledger.persistIfDirty();
    expect(writes).toEqual([['trade-dirty']]);
    expect(ledger.isDirty()).toBe(false);
  });

  it('reconciles a scoped creating operation when Rust re-emits funding intent', async () => {
    const beginWalletOffer = jest.fn();
    const reconcileWalletOffer = jest.fn().mockResolvedValue({
      kind: 'created',
      material: { kind: 'bundle', bundle: testSpendBundle('ledger-only-funding') },
    });
    const { controller, cradle } = setup(jest.fn(), {
      beginWalletOffer,
      reconcileWalletOffer,
    });
    const request = canonicalizeFundingRequest({
      amount: '100',
      fee: '0',
      conditions: [{ opcode: 60n, args: ['launcher'] }],
    });
    walletOperationService.restore([
      {
        owner,
        purpose: {
          kind: 'funding',
          operationId: fundingRequestKey(
            canonicalizeFundingRequest({
              amount: '100',
              fee: '0',
              conditions: request.conditions,
            }),
          ),
        },
        stage: 'creating',
        disposition: 'active',
        recoveryId: 'SR_ledger_only',
        request: { kind: 'funding', canonical: request },
        reason: 'pending',
      },
    ]);
    const lease = new ControlledLease();
    controller.processResult(wasmResult({ events: [{ NeedCoinSpend: request }] }));
    controller.flushDeferredWork();
    controller.attachTransactionCoordinator(lease);
    await controller.flushPendingWork();

    expect(beginWalletOffer).not.toHaveBeenCalled();
    expect(reconcileWalletOffer).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ kind: 'funding', offer: { '1': -100n } }),
      'SR_ledger_only',
    );
    expect(cradle.provide_coin_spend_bundle).toHaveBeenCalledTimes(1);
  });

  it('reconciles one persisted Cloud creation across session and WASM replacement', async () => {
    const persistedLedgers: unknown[][] = [];
    walletOperationService.configurePersistence(async (entries) => {
      persistedLedgers.push(structuredClone(entries));
    });
    const beginWalletOffer = jest
      .fn()
      .mockResolvedValue({ kind: 'pending', recoveryId: 'SR_full_reload' });
    const reconcileWalletOffer = jest
      .fn()
      .mockResolvedValueOnce({ kind: 'unavailable', reason: 'cloud disconnected' })
      .mockResolvedValueOnce({
        kind: 'created',
        material: { kind: 'bundle', bundle: testSpendBundle('cloud-restored-funding') },
        tradeId: 'Offer_full_reload',
      });
    const rpcOverrides = {
      getWalletOfferProvider: () => ({
        capability: 'recoverable' as const,
        scope: { provider: 'cloud' as const, walletId: 'Wallet_1' },
        beginCreation: beginWalletOffer,
        reconcileCreation: reconcileWalletOffer,
        beginCancellation: jest.fn().mockResolvedValue({ status: 'cancelled' as const }),
        reconcileCancellation: jest.fn().mockResolvedValue({ status: 'cancelled' as const }),
      }),
    };
    const request = canonicalizeFundingRequest({
      amount: '100',
      fee: '0',
      conditions: [{ opcode: 60n, args: ['launcher'] }],
    });
    const first = setup(jest.fn(), rpcOverrides);
    let persistedLedger!: ReturnType<typeof walletOperationService.snapshot>;
    try {
      first.controller.processResult(wasmResult({ events: [{ NeedCoinSpend: request }] }));
      first.controller.flushDeferredWork();
      first.controller.attachTransactionCoordinator(new ControlledLease());
      await first.controller.flushPendingWork();

      expect(beginWalletOffer).toHaveBeenCalledTimes(1);
      expect(reconcileWalletOffer).toHaveBeenCalledTimes(1);
      expect(first.cradle.provide_coin_spend_bundle).not.toHaveBeenCalled();
      expect(persistedLedgers).toContainEqual([
        expect.objectContaining({
          stage: 'creating',
          recoveryId: 'SR_full_reload',
        }),
      ]);
      persistedLedger = walletOperationService.snapshot();
    } finally {
      first.controller.cleanup();
    }

    walletOperationService.resetForTests();
    walletOperationService.restore(persistedLedger);
    const restored = setup(jest.fn(), rpcOverrides);
    try {
      restored.controller.processResult(wasmResult({ events: [{ NeedCoinSpend: request }] }));
      restored.controller.flushDeferredWork();
      restored.controller.attachTransactionCoordinator(new ControlledLease());
      await restored.controller.flushPendingWork();

      expect(beginWalletOffer).toHaveBeenCalledTimes(1);
      expect(reconcileWalletOffer).toHaveBeenCalledTimes(2);
      expect(reconcileWalletOffer).toHaveBeenLastCalledWith(
        expect.objectContaining({
          owner: expect.objectContaining({
            providerScope: { provider: 'cloud', walletId: 'Wallet_1' },
          }),
        }),
        expect.any(Object),
        'SR_full_reload',
      );
      expect(restored.cradle.provide_coin_spend_bundle).toHaveBeenCalledTimes(1);
    } finally {
      restored.controller.cleanup();
    }
  });

  it('blocks replacement funding until a restored reservation is cancelled', async () => {
    let finishCancel!: () => void;
    const beginWalletOfferCancellation = jest.fn(
      () =>
        new Promise<{ status: 'cancelled' }>((resolve) => {
          finishCancel = () => resolve({ status: 'cancelled' });
        }),
    );
    const beginWalletOffer = jest.fn().mockResolvedValue({
      kind: 'created',
      material: { kind: 'bundle', bundle: testSpendBundle('restored-funding') },
    });
    const { controller } = setup(jest.fn(), { beginWalletOffer, beginWalletOfferCancellation });
    const lease = new ControlledLease();
    const request = canonicalizeFundingRequest({
      amount: '100',
      fee: '0',
      conditions: [{ opcode: 60n, args: ['launcher'] }],
    });
    const purpose = { kind: 'funding' as const, operationId: fundingRequestKey(request) };
    try {
      controller.processResult(wasmResult({ events: [{ NeedCoinSpend: request }] }));
      controller.flushDeferredWork();
      walletOperationService.restore([
        {
          tradeId: 'trade-restored',
          owner,
          purpose,
          stage: 'reserved',
          reason: 'created-before-reload',
        },
      ]);
      controller.attachTransactionCoordinator(lease);
      for (let i = 0; i < 20 && beginWalletOfferCancellation.mock.calls.length === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      expect(beginWalletOffer).not.toHaveBeenCalled();

      expect(beginWalletOfferCancellation).toHaveBeenCalledTimes(1);
      finishCancel();
      await walletOperationService.awaitOwner(owner);
      await controller.flushPendingWork();
      expect(beginWalletOfferCancellation).toHaveBeenCalledWith('trade-restored');
      expect(beginWalletOffer).toHaveBeenCalledTimes(1);
    } finally {
      controller.cleanup();
    }
  });

  it('retains uncertain failure without a tight loop and retries on reattach', async () => {
    const beginWalletOfferCancellation = jest
      .fn()
      .mockResolvedValueOnce({ status: 'unavailable', detail: 'wallet offline' });
    const { blockchain, controller } = setup(jest.fn(), { beginWalletOfferCancellation });
    const purpose = { kind: 'fee' as const, operationId: 'submission' };
    try {
      walletOperationService.restore([
        {
          tradeId: 'trade-reconnect',
          owner,
          purpose,
          stage: 'cancel-required',
          reason: 'wallet-outcome-finalized',
        },
      ]);
      await walletOperationService.awaitOwner(owner);
      expect(beginWalletOfferCancellation).toHaveBeenCalledTimes(1);
      expect(walletOperationService.entriesFor(owner)).toHaveLength(1);

      await Promise.resolve();
      expect(beginWalletOfferCancellation).toHaveBeenCalledTimes(1);
      beginWalletOfferCancellation.mockResolvedValue({ status: 'cancelled' });
      controller.attachBlockchain(blockchain);
      await walletOperationService.awaitOwner(owner);
      expect(beginWalletOfferCancellation).toHaveBeenCalledTimes(2);
      expect(walletOperationService.entriesFor(owner)).toEqual([]);
    } finally {
      controller.cleanup();
    }
  });

  it('treats an already-spent cancellation response as terminal success', async () => {
    const beginWalletOfferCancellation = jest
      .fn()
      .mockResolvedValue({ status: 'already-terminal', detail: 'offer already spent' });
    const { controller } = setup(jest.fn(), { beginWalletOfferCancellation });
    try {
      walletOperationService.restore([
        {
          tradeId: 'trade-spent',
          owner,
          purpose: { kind: 'fee', operationId: 'spent-submission' },
          stage: 'cancel-required',
          reason: 'wallet-outcome-finalized',
        },
      ]);
      await walletOperationService.awaitOwner(owner);
      expect(walletOperationService.entriesFor(owner)).toEqual([]);
    } finally {
      controller.cleanup();
    }
  });

  it('keeps terminal teardown blocked after a typed nonterminal cancellation outcome', async () => {
    const beginWalletOfferCancellation = jest
      .fn()
      .mockResolvedValue({ status: 'rejected', detail: 'wallet refused cancellation' });
    const { controller } = setup(jest.fn(), { beginWalletOfferCancellation });
    const lease = new ControlledLease();
    try {
      walletOperationService.restore([
        {
          tradeId: 'trade-rejected',
          owner,
          purpose: { kind: 'fee', operationId: 'rejected-submission' },
          stage: 'cancel-required',
          reason: 'wallet-outcome-finalized',
        },
      ]);
      controller.attachTransactionCoordinator(lease);

      await expect(controller.quiesceForTerminalFinalization()).rejects.toMatchObject({
        code: 'WALLET_OFFER_CLEANUP_PENDING',
      });
      expect(beginWalletOfferCancellation).toHaveBeenCalledTimes(1);
      expect(walletOperationService.entriesFor(owner)).toEqual([
        expect.objectContaining({ tradeId: 'trade-rejected', stage: 'cancel-required' }),
      ]);
    } finally {
      controller.cleanup();
    }
  });

  it('keeps terminal teardown blocked when cancellation API is missing', async () => {
    const { controller } = setup(jest.fn(), { beginWalletOfferCancellation: undefined });
    const lease = new ControlledLease();
    try {
      walletOperationService.restore([
        {
          tradeId: 'trade-no-api',
          owner,
          purpose: { kind: 'funding', operationId: 'funding-operation' },
          stage: 'cancel-required',
          reason: 'funding-rejected',
        },
      ]);
      controller.attachTransactionCoordinator(lease);
      await expect(controller.quiesceForTerminalFinalization()).rejects.toMatchObject({
        code: 'WALLET_OFFER_CLEANUP_PENDING',
      });
    } finally {
      controller.cleanup();
    }
  });

  it('blocks terminal teardown on the durable owner when another wallet scope is connected', async () => {
    const wrongCancel = jest.fn().mockResolvedValue({ status: 'cancelled' as const });
    const wrongScope = {
      provider: 'walletconnect' as const,
      fingerprint: '999',
      chainId: 'chia:testnet11',
    };
    const { controller } = setup(jest.fn(), {
      getWalletOfferProvider: () => ({
        capability: 'best-effort' as const,
        scope: wrongScope,
        beginCreation: jest.fn(),
        cancel: wrongCancel,
      }),
    });
    const lease = new ControlledLease();
    try {
      walletOperationService.restore([
        {
          tradeId: 'trade-original-wallet',
          owner,
          purpose: { kind: 'funding', operationId: 'original-wallet-funding' },
          stage: 'reserved',
          reason: 'created-before-wallet-switch',
        },
      ]);
      controller.attachTransactionCoordinator(lease);

      await expect(controller.quiesceForTerminalFinalization()).rejects.toMatchObject({
        code: 'WALLET_OFFER_CLEANUP_PENDING',
        entries: [
          expect.objectContaining({
            tradeId: 'trade-original-wallet',
            owner,
            stage: 'cancel-required',
          }),
        ],
      });
      expect(wrongCancel).not.toHaveBeenCalled();
      expect(walletOperationService.entriesFor(owner)).toHaveLength(1);
    } finally {
      controller.cleanup();
    }
  });

  it('allows stale cleanup and a newer active trade for one stable operation', () => {
    const purpose = { kind: 'funding' as const, operationId: 'conflicted-operation' };
    walletOperationService.registerReserved('trade-retry', owner, purpose);
    walletOperationService.routeStaleResult(
      'trade-stale',
      owner,
      purpose,
      'stale-createOffer-result',
    );

    expect(walletOperationService.entriesFor(owner)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tradeId: 'trade-retry', stage: 'reserved' }),
        expect.objectContaining({ tradeId: 'trade-stale', stage: 'cancel-required' }),
      ]),
    );
  });

  it('scopes terminal obligations by the complete owner tuple', () => {
    const otherPeer = { ...owner, peerSessionId: '11'.repeat(16) };
    walletOperationService.registerReserved('trade-first-session', owner, {
      kind: 'funding',
      operationId: 'same-operation',
    });
    walletOperationService.registerReserved('trade-second-session', otherPeer, {
      kind: 'funding',
      operationId: 'same-operation',
    });

    expect(walletOperationService.entriesFor(owner).map((entry) => entry.tradeId)).toEqual([
      'trade-first-session',
    ]);
    expect(walletOperationService.entriesFor(otherPeer).map((entry) => entry.tradeId)).toEqual([
      'trade-second-session',
    ]);
  });
});
