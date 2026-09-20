import { expectConsoleError } from '../../../scripts/testSetup';
import { BlockchainPoller } from '../../hooks/BlockchainPoller';
import { SessionController } from '../../hooks/SessionController';
import type { SessionRuntimeLease } from '../session/sessionRuntimeLease';
import { SessionRuntimeRetiredError } from '../session/sessionMachineRuntime';
import type { SessionModel } from '../session/types';
import { createSessionModel } from '../session/model';
import { canonicalizeFundingRequest, fundingRequestKey } from '../session/fundingRequest';
import type { InternalBlockchainInterface, TransactionSubmission } from '../../types/ChiaGaming';
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

  it('hands an unlaunched fee release to the replacement lease', async () => {
    const spend = jest.fn().mockResolvedValue({ status: 'rejected', detail: 'wallet rejected' });
    const createFeeSpend = jest.fn().mockResolvedValue({
      kind: 'offer',
      offer: 'offer-fee',
      tradeId: 'trade-fee',
    });
    const cancelOffer = jest.fn().mockResolvedValue(undefined);
    const { controller, cradle, submit } = setup(spend, { createFeeSpend, cancelOffer });
    const first = new ControlledLease(undefined, 'wallet-offer-cleanup:');
    const replacement = new ControlledLease();
    try {
      controller.attachTransactionCoordinator(first);
      submit({
        ...submission('fee-release-handoff'),
        fee_request: { target: '22'.repeat(32), amount: '10' },
      });
      const launch = first.launch('submission:fee-release-handoff');
      for (let i = 0; i < 50 && !first.has('wallet-offer-cleanup:trade-fee'); i += 1) {
        await Promise.resolve();
      }

      expect(first.has('wallet-offer-cleanup:trade-fee')).toBe(true);
      expect(spend).toHaveBeenCalledTimes(1);
      expect(cradle.reject_submission).toHaveBeenCalledTimes(1);
      expect(cancelOffer).not.toHaveBeenCalled();

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
    const cancelOffer = jest.fn().mockRejectedValue(new Error('wallet cleanup failed'));
    const { controller, cradle, submit } = setup(spend, { createFeeSpend, cancelOffer });
    const lease = new ControlledLease();
    try {
      controller.attachTransactionCoordinator(lease);
      submit({
        ...submission('network-rejected-cleanup-fails'),
        fee_request: { target: '22'.repeat(32), amount: '10' },
      });
      await lease.launch('submission:network-rejected-cleanup-fails');
      await controller.flushPendingWork();

      expect(cradle.reject_submission).toHaveBeenCalledWith('network-rejected-cleanup-fails');
      expect(cradle.acknowledge_submission).not.toHaveBeenCalled();
      expect(cancelOffer).toHaveBeenCalledTimes(1);
      expect(controller.getWasmFields()?.walletOfferCleanup).toEqual([
        { tradeId: 'trade-cleanup-fails', source: 'fee-network-rejected' },
      ]);
    } finally {
      controller.cleanup();
    }
  });

  it('durably cleans up a fee offer rejected during finalization', async () => {
    expectConsoleError('fee source rejected by Rust');
    const spend = jest.fn();
    const createFeeSpend = jest.fn().mockResolvedValue({
      kind: 'offer',
      offer: 'offer-fee',
      tradeId: 'trade-finalize-rejected',
    });
    const cancelOffer = jest.fn().mockResolvedValue(undefined);
    const { controller, cradle, submit } = setup(spend, { createFeeSpend, cancelOffer });
    (cradle.finalize_submission as jest.Mock).mockImplementation(() => {
      throw new Error('fee source rejected by Rust');
    });
    const lease = new ControlledLease();
    try {
      controller.attachTransactionCoordinator(lease);
      submit({
        ...submission('finalize-rejected'),
        fee_request: { target: '22'.repeat(32), amount: '10' },
      });
      await lease.launch('submission:finalize-rejected');
      await controller.flushPendingWork();

      expect(spend).not.toHaveBeenCalled();
      expect(cancelOffer).toHaveBeenCalledWith('trade-finalize-rejected');
      expect(controller.getWasmFields()?.walletOfferCleanup).toEqual([]);
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
      expect(snapshot).toEqual(replacementModel);
      expect(snapshot).not.toBe(replacementModel);
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
});

describe('durable wallet offer cleanup', () => {
  it('does not block restored funding on stale cleanup source', async () => {
    const createOfferForIds = jest.fn().mockResolvedValue(testSpendBundle('restored-funding'));
    const cancelOffer = jest.fn().mockResolvedValue(undefined);
    const { controller } = setup(jest.fn(), { createOfferForIds, cancelOffer });
    const lease = new ControlledLease(undefined, 'wallet-offer-cleanup:');
    const request = canonicalizeFundingRequest({
      amount: '100',
      fee: '0',
      conditions: [{ opcode: 60n, args: ['launcher'] }],
    });
    try {
      controller.restoreFundingOutbox([{ key: fundingRequestKey(request), request }]);
      controller.restoreWalletOfferCleanup([
        { tradeId: 'trade-stale-restored', source: 'funding-offer-stale' },
      ]);
      controller.attachTransactionCoordinator(lease);
      for (let i = 0; i < 10 && createOfferForIds.mock.calls.length === 0; i += 1) {
        await Promise.resolve();
      }

      expect(createOfferForIds).toHaveBeenCalledTimes(1);
      expect(cancelOffer).not.toHaveBeenCalled();
      await lease.launch('wallet-offer-cleanup:trade-stale-restored');
      await controller.flushPendingWork();
    } finally {
      controller.cleanup();
    }
  });

  it('persists the entry before launching cancellation', async () => {
    const cancelOffer = jest.fn().mockResolvedValue(undefined);
    const { controller } = setup(jest.fn(), { cancelOffer });
    const lease = new ControlledLease(undefined, 'wallet-offer-cleanup:');
    try {
      controller.restoreWalletOfferCleanup([
        { tradeId: 'trade-persist-first', source: 'funding-offer-rejected' },
      ]);
      controller.attachTransactionCoordinator(lease);

      expect(controller.getWasmFields()?.walletOfferCleanup).toEqual([
        { tradeId: 'trade-persist-first', source: 'funding-offer-rejected' },
      ]);
      expect(cancelOffer).not.toHaveBeenCalled();

      await lease.launch('wallet-offer-cleanup:trade-persist-first');
      await controller.flushPendingWork();
      expect(cancelOffer).toHaveBeenCalledWith('trade-persist-first');
      expect(controller.getWasmFields()?.walletOfferCleanup).toEqual([]);
    } finally {
      controller.cleanup();
    }
  });

  it('retains a failed cleanup without a retry loop and retries on reconnect', async () => {
    const cancelOffer = jest.fn().mockRejectedValueOnce(new Error('wallet offline'));
    const { blockchain, controller } = setup(jest.fn(), { cancelOffer });
    const lease = new ControlledLease(undefined, 'wallet-offer-cleanup:');
    const errors: string[] = [];
    const subscription = controller.getObservable().subscribe((event) => {
      if (event.type === 'error') errors.push(event.error);
    });
    try {
      controller.restoreWalletOfferCleanup([
        { tradeId: 'trade-reconnect', source: 'fee-network-rejected' },
      ]);
      controller.attachTransactionCoordinator(lease);
      await lease.launch('wallet-offer-cleanup:trade-reconnect');
      await controller.flushPendingWork();

      expect(cancelOffer).toHaveBeenCalledTimes(1);
      expect(controller.getWasmFields()?.walletOfferCleanup).toHaveLength(1);
      expect(errors).toHaveLength(1);

      cancelOffer.mockResolvedValue(undefined);
      controller.attachBlockchain(blockchain);
      expect(lease.has('wallet-offer-cleanup:trade-reconnect')).toBe(true);
      await lease.launch('wallet-offer-cleanup:trade-reconnect');
      await controller.flushPendingWork();

      expect(cancelOffer).toHaveBeenCalledTimes(2);
      expect(controller.getWasmFields()?.walletOfferCleanup).toEqual([]);
    } finally {
      subscription.unsubscribe();
      controller.cleanup();
    }
  });

  it('lets launched cancellation finish and hands removal to the replacement lease', async () => {
    let resolveCancellation!: () => void;
    const cancellationGate = new Promise<void>((resolve) => {
      resolveCancellation = resolve;
    });
    const cancelOffer = jest.fn(() => cancellationGate);
    const { controller } = setup(jest.fn(), { cancelOffer });
    const first = new ControlledLease(undefined, 'wallet-offer-cleanup:');
    const replacement = new ControlledLease();
    try {
      controller.restoreWalletOfferCleanup([
        { tradeId: 'trade-launched-handoff', source: 'fee-finalization-rejected' },
      ]);
      controller.attachTransactionCoordinator(first);
      const launched = first.launch('wallet-offer-cleanup:trade-launched-handoff');
      for (let i = 0; i < 10 && cancelOffer.mock.calls.length === 0; i += 1) {
        await Promise.resolve();
      }

      controller.attachTransactionCoordinator(replacement);
      expect(replacement.has('wallet-offer-cleanup:trade-launched-handoff')).toBe(false);
      resolveCancellation();
      await launched;
      await controller.flushPendingWork();

      expect(cancelOffer).toHaveBeenCalledTimes(1);
      expect(controller.getWasmFields()?.walletOfferCleanup).toEqual([]);
    } finally {
      controller.cleanup();
    }
  });

  it('blocks terminal teardown after one failed retry, then succeeds explicitly', async () => {
    const cancelOffer = jest.fn().mockRejectedValue(new Error('wallet locked'));
    const { controller } = setup(jest.fn(), { cancelOffer });
    const snapshot = jest.fn(() => createSessionModel());
    const lease = new ControlledLease(undefined, undefined, snapshot);
    try {
      controller.restoreWalletOfferCleanup([
        { tradeId: 'trade-terminal', source: 'fee-finalization-warning' },
      ]);
      controller.attachTransactionCoordinator(lease);
      await controller.flushPendingWork();
      expect(cancelOffer).toHaveBeenCalledTimes(1);

      await expect(controller.quiesceForTerminalFinalization()).rejects.toMatchObject({
        code: 'WALLET_OFFER_CLEANUP_PENDING',
      });
      expect(cancelOffer).toHaveBeenCalledTimes(2);
      expect(snapshot).not.toHaveBeenCalled();

      cancelOffer.mockResolvedValue(undefined);
      await controller.quiesceForTerminalFinalization();
      expect(cancelOffer).toHaveBeenCalledTimes(3);
      expect(snapshot).toHaveBeenCalledTimes(1);
      expect(controller.getWasmFields()?.walletOfferCleanup).toEqual([]);
    } finally {
      controller.cleanup();
    }
  });

  it('retains cleanup and reports one actionable error when cancelOffer is missing', async () => {
    const { controller } = setup(jest.fn(), { cancelOffer: undefined });
    const lease = new ControlledLease();
    const errors: string[] = [];
    const subscription = controller.getObservable().subscribe((event) => {
      if (event.type === 'error') errors.push(event.error);
    });
    try {
      controller.restoreWalletOfferCleanup([
        { tradeId: 'trade-no-api', source: 'funding-cradle-unavailable' },
      ]);
      controller.attachTransactionCoordinator(lease);
      await controller.flushPendingWork();

      expect(controller.getWasmFields()?.walletOfferCleanup).toHaveLength(1);
      expect(errors).toEqual([
        expect.stringMatching(/trade-no-api.*reconnect the wallet.*cancelOffer/i),
      ]);
    } finally {
      subscription.unsubscribe();
      controller.cleanup();
    }
  });
});
