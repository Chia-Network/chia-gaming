import { expectConsoleError } from '../../../scripts/testSetup';
import { BlockchainPoller } from '../../hooks/BlockchainPoller';
import { SessionController } from '../../hooks/SessionController';
import type { SessionRuntimeLease } from '../session/sessionRuntimeLease';
import { SessionRuntimeRetiredError } from '../session/sessionMachineRuntime';
import type { SessionModel } from '../session/types';
import { createSessionModel } from '../session/model';
import { canonicalizeFundingRequest, fundingRequestKey } from '../session/fundingRequest';
import {
  WalletReservationLedger,
  walletReservationLedger,
} from '../session/walletReservationLedger';
import type { InternalBlockchainInterface, TransactionSubmission } from '../../types/ChiaGaming';
import {
  makeMockCradle,
  makePeerConn,
  mockRpc,
  mockWasmConnection,
  submissionDrain,
  testSpendBundle,
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

function setup(spend: jest.Mock, rpcOverrides: Partial<InternalBlockchainInterface> = {}) {
  const blockchain = new BlockchainPoller(
    { ...mockRpc, spend, ...rpcOverrides } as InternalBlockchainInterface,
    60_000,
  );
  walletReservationLedger.attachRpc(blockchain.rpc);
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
  bundle: testSpendBundle(id),
  fee_request: null,
});

describe('submission delivery lease handoff', () => {
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
      expect(cradle.acknowledge_submission).toHaveBeenCalledWith('before-persistence');
    } finally {
      controller.cleanup();
    }
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
      for (let i = 0; i < 50 && !first.has('broadcast:finalized-broadcast-handoff'); i += 1) {
        await Promise.resolve();
      }

      expect(first.has('broadcast:finalized-broadcast-handoff')).toBe(true);
      expect(cradle.finalize_submission).toHaveBeenCalledTimes(1);
      expect(spend).not.toHaveBeenCalled();

      controller.attachTransactionCoordinator(replacement);
      await launch;
      await controller.flushPendingWork();

      expect(cradle.finalize_submission).toHaveBeenCalledTimes(1);
      expect(spend).toHaveBeenCalledTimes(1);
      expect(cradle.acknowledge_submission).toHaveBeenCalledTimes(1);
      expect(cradle.acknowledge_submission).toHaveBeenCalledWith('finalized-broadcast-handoff');
    } finally {
      controller.cleanup();
    }
  });

  it('cleans a finalized fee reservation independently of lease replacement', async () => {
    const spend = jest.fn().mockResolvedValue({ status: 'rejected', detail: 'wallet rejected' });
    const createFeeSpend = jest.fn().mockResolvedValue({
      kind: 'offer',
      offer: 'offer-fee',
      tradeId: 'trade-fee',
    });
    const cancelOffer = jest.fn().mockResolvedValue({ status: 'cancelled' });
    const { controller, cradle, submit } = setup(spend, { createFeeSpend, cancelOffer });
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
      for (let i = 0; i < 50 && cancelOffer.mock.calls.length === 0; i += 1) {
        await Promise.resolve();
      }
      expect(spend).toHaveBeenCalledTimes(1);
      expect(cradle.reject_submission).toHaveBeenCalledTimes(1);
      expect(cancelOffer).toHaveBeenCalledWith('trade-fee');

      controller.attachTransactionCoordinator(replacement);
      await launch;
      await controller.flushPendingWork();

      expect(spend).toHaveBeenCalledTimes(1);
      expect(cradle.reject_submission).toHaveBeenCalledTimes(1);
      expect(cancelOffer).toHaveBeenCalledTimes(1);
      expect(cancelOffer).toHaveBeenCalledWith('trade-fee');
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
      expect(cradle.acknowledge_submission).toHaveBeenCalledWith('acknowledged-handoff');
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
            pendingSubmissionDeliveries: Map<string, unknown>;
          }
        ).pendingSubmissionDeliveries.has('release-failure');
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
            pendingSubmissionDeliveries: Map<string, unknown>;
          }
        ).pendingSubmissionDeliveries.has('release-failure'),
      ).toBe(false);
    } finally {
      subscription.unsubscribe();
      controller.cleanup();
    }
  });

  it('keeps network rejection authoritative when durable fee cleanup fails', async () => {
    const spend = jest.fn().mockResolvedValue({ status: 'rejected', detail: 'invalid spend' });
    const createFeeSpend = jest.fn().mockResolvedValue({
      kind: 'offer',
      offer: 'offer-fee',
      tradeId: 'trade-cleanup-fails',
    });
    const cancelOffer = jest
      .fn()
      .mockResolvedValue({ status: 'rejected', detail: 'wallet cleanup failed' });
    const { controller, cradle, submit } = setup(spend, { createFeeSpend, cancelOffer });
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
      await controller.flushPendingWork();

      expect(cradle.reject_submission).toHaveBeenCalledWith('network-rejected-cleanup-fails');
      expect(cradle.acknowledge_submission).not.toHaveBeenCalled();
      expect(cancelOffer).toHaveBeenCalledTimes(1);
      expect(walletReservationLedger.snapshot()).toEqual([
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
    const createFeeSpend = jest.fn().mockResolvedValue({
      kind: 'offer',
      offer: 'offer-fee',
      tradeId: 'trade-finalize-rejected',
    });
    const cancelOffer = jest.fn().mockResolvedValue({ status: 'cancelled' });
    const { controller, cradle, submit } = setup(spend, { createFeeSpend, cancelOffer });
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

      expect(cancelOffer).not.toHaveBeenCalled();
      await lease.launch('wallet-offer-cancellation:trade-finalize-rejected');
      await controller.flushPendingWork();

      expect(spend).not.toHaveBeenCalled();
      expect(cancelOffer).toHaveBeenCalledWith('trade-finalize-rejected');
      expect(walletReservationLedger.snapshot()).toEqual([]);
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
      const launch = lease.launch('submission:slow-wallet');
      let quiesced = false;
      const quiescence = controller.quiesceForTerminalFinalization().then(() => {
        quiesced = true;
      });
      for (let i = 0; i < 10 && spend.mock.calls.length === 0; i += 1) {
        await Promise.resolve();
      }

      expect(spend).toHaveBeenCalledTimes(1);
      expect(quiesced).toBe(false);
      expect(
        (
          controller as unknown as {
            pendingSubmissionDeliveries: Map<string, unknown>;
          }
        ).pendingSubmissionDeliveries.has('slow-wallet'),
      ).toBe(true);

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
          pendingSubmissionDeliveries: Map<string, unknown>;
        }
      ).pendingSubmissionDeliveries.size,
    ).toBe(0);
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
    walletReservationLedger.resetForTests();
    let resolveOffer!: (value: { offer: string; tradeId: string }) => void;
    const createOfferForIds = jest.fn(
      () =>
        new Promise<{ offer: string; tradeId: string }>((resolve) => {
          resolveOffer = resolve;
        }),
    );
    const cancelOffer = jest.fn().mockResolvedValue({ status: 'cancelled' });
    const { controller, cradle } = setup(jest.fn(), { createOfferForIds, cancelOffer });
    const lease = new ControlledLease();
    const request = canonicalizeFundingRequest({
      amount: '100',
      fee: '0',
      conditions: [{ opcode: 60n, args: ['launcher'] }],
    });
    controller.restoreFundingOutbox([{ key: fundingRequestKey(request), request }]);
    controller.attachTransactionCoordinator(lease);
    for (let pass = 0; pass < 20 && createOfferForIds.mock.calls.length === 0; pass += 1) {
      await Promise.resolve();
    }
    expect(createOfferForIds).toHaveBeenCalledTimes(1);

    controller.cleanup();
    resolveOffer({ offer: 'offer1late', tradeId: 'trade-late-funding' });
    for (let pass = 0; pass < 50 && cancelOffer.mock.calls.length === 0; pass += 1) {
      await Promise.resolve();
    }
    const owner = {
      installationPlayerId: 'submission-handoff',
      peerSessionId: '00'.repeat(16),
    };
    await walletReservationLedger.awaitOwner(owner);

    expect(cancelOffer).toHaveBeenCalledWith('trade-late-funding');
    expect(walletReservationLedger.entriesFor(owner)).toEqual([]);
    expect(cradle.provide_coin_spend_bundle).not.toHaveBeenCalled();
  });
});

describe('durable wallet reservation ledger', () => {
  const owner = {
    installationPlayerId: 'submission-handoff',
    peerSessionId: '00'.repeat(16),
  };

  beforeEach(() => walletReservationLedger.resetForTests());

  it('keeps a failed independent write dirty and recovers on a later checkpoint', async () => {
    const ledger = new WalletReservationLedger();
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

  it('blocks replacement funding until a restored reservation is cancelled', async () => {
    let finishCancel!: () => void;
    const cancelOffer = jest.fn(
      () =>
        new Promise<{ status: 'cancelled' }>((resolve) => {
          finishCancel = () => resolve({ status: 'cancelled' });
        }),
    );
    const createOfferForIds = jest.fn().mockResolvedValue(testSpendBundle('restored-funding'));
    const { controller } = setup(jest.fn(), { createOfferForIds, cancelOffer });
    const lease = new ControlledLease();
    const request = canonicalizeFundingRequest({
      amount: '100',
      fee: '0',
      conditions: [{ opcode: 60n, args: ['launcher'] }],
    });
    const purpose = { kind: 'funding' as const, operationId: fundingRequestKey(request) };
    try {
      controller.restoreFundingOutbox([{ key: purpose.operationId, request }]);
      walletReservationLedger.restore([
        {
          tradeId: 'trade-restored',
          owner,
          purpose,
          stage: 'reserved',
          reason: 'created-before-reload',
        },
      ]);
      controller.attachTransactionCoordinator(lease);
      for (let i = 0; i < 20 && cancelOffer.mock.calls.length === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      expect(createOfferForIds).not.toHaveBeenCalled();

      expect(cancelOffer).toHaveBeenCalledTimes(1);
      finishCancel();
      await walletReservationLedger.awaitOwner(owner);
      await controller.flushPendingWork();
      expect(cancelOffer).toHaveBeenCalledWith('trade-restored');
      expect(createOfferForIds).toHaveBeenCalledTimes(1);
    } finally {
      controller.cleanup();
    }
  });

  it('retains uncertain failure without a tight loop and retries on reattach', async () => {
    const cancelOffer = jest
      .fn()
      .mockResolvedValueOnce({ status: 'unavailable', detail: 'wallet offline' });
    const { blockchain, controller } = setup(jest.fn(), { cancelOffer });
    const purpose = { kind: 'fee' as const, operationId: 'submission' };
    try {
      walletReservationLedger.restore([
        {
          tradeId: 'trade-reconnect',
          owner,
          purpose,
          stage: 'cancel-required',
          reason: 'wallet-outcome-finalized',
        },
      ]);
      await walletReservationLedger.awaitOwner(owner);
      expect(cancelOffer).toHaveBeenCalledTimes(1);
      expect(walletReservationLedger.entriesFor(owner)).toHaveLength(1);

      await Promise.resolve();
      expect(cancelOffer).toHaveBeenCalledTimes(1);
      cancelOffer.mockResolvedValue({ status: 'cancelled' });
      controller.attachBlockchain(blockchain);
      await walletReservationLedger.awaitOwner(owner);
      expect(cancelOffer).toHaveBeenCalledTimes(2);
      expect(walletReservationLedger.entriesFor(owner)).toEqual([]);
    } finally {
      controller.cleanup();
    }
  });

  it('treats an already-spent cancellation response as terminal success', async () => {
    const cancelOffer = jest
      .fn()
      .mockResolvedValue({ status: 'already-terminal', detail: 'offer already spent' });
    const { controller } = setup(jest.fn(), { cancelOffer });
    try {
      walletReservationLedger.restore([
        {
          tradeId: 'trade-spent',
          owner,
          purpose: { kind: 'fee', operationId: 'spent-submission' },
          stage: 'cancel-required',
          reason: 'wallet-outcome-finalized',
        },
      ]);
      await walletReservationLedger.awaitOwner(owner);
      expect(walletReservationLedger.entriesFor(owner)).toEqual([]);
    } finally {
      controller.cleanup();
    }
  });

  it('keeps terminal teardown blocked after a typed nonterminal cancellation outcome', async () => {
    const cancelOffer = jest
      .fn()
      .mockResolvedValue({ status: 'rejected', detail: 'wallet refused cancellation' });
    const { controller } = setup(jest.fn(), { cancelOffer });
    const lease = new ControlledLease();
    try {
      walletReservationLedger.restore([
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
      expect(cancelOffer).toHaveBeenCalledTimes(1);
      expect(walletReservationLedger.entriesFor(owner)).toEqual([
        expect.objectContaining({ tradeId: 'trade-rejected', stage: 'cancel-required' }),
      ]);
    } finally {
      controller.cleanup();
    }
  });

  it('keeps terminal teardown blocked when cancellation API is missing', async () => {
    const { controller } = setup(jest.fn(), { cancelOffer: undefined });
    const lease = new ControlledLease();
    try {
      walletReservationLedger.restore([
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

  it('allows stale cleanup and a newer active trade for one stable operation', () => {
    const purpose = { kind: 'funding' as const, operationId: 'conflicted-operation' };
    walletReservationLedger.registerReserved('trade-retry', owner, purpose);
    walletReservationLedger.routeStaleResult(
      'trade-stale',
      owner,
      purpose,
      'stale-createOffer-result',
    );

    expect(walletReservationLedger.entriesFor(owner)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tradeId: 'trade-retry', stage: 'reserved' }),
        expect.objectContaining({ tradeId: 'trade-stale', stage: 'cancel-required' }),
      ]),
    );
  });

  it('scopes terminal obligations by the complete owner tuple', () => {
    const otherPeer = { ...owner, peerSessionId: '11'.repeat(16) };
    walletReservationLedger.registerReserved('trade-first-session', owner, {
      kind: 'funding',
      operationId: 'same-operation',
    });
    walletReservationLedger.registerReserved('trade-second-session', otherPeer, {
      kind: 'funding',
      operationId: 'same-operation',
    });

    expect(walletReservationLedger.entriesFor(owner).map((entry) => entry.tradeId)).toEqual([
      'trade-first-session',
    ]);
    expect(walletReservationLedger.entriesFor(otherPeer).map((entry) => entry.tradeId)).toEqual([
      'trade-second-session',
    ]);
  });
});
