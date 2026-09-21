import { expectConsoleError } from '../../../scripts/testSetup';
import { SessionController } from '../../hooks/SessionController';
import { storageRepository } from '../session/storageRepository';
import type { TransactionSubmission } from '../../types/ChiaGaming';
import { submissionDrain, wasmResult } from './message_protocol.harness';
import {
  commitRuntime,
  ControlledRuntime,
  nextAttempt,
  setup,
  submission,
} from './runtime_capability.harness';

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50 && !check(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe('submission pump delivery and runtime replacement', () => {
  it('retires a delivery before persistence-gated launch', async () => {
    const spend = jest.fn().mockResolvedValue({ status: 'acknowledged' });
    const { controller, cradle, submit } = setup(spend);
    const lease = new ControlledRuntime();
    try {
      commitRuntime(controller, lease);
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
    const lease = new ControlledRuntime();
    try {
      commitRuntime(controller, lease);
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

  it('reschedules an unlaunched delivery on the replacement runtime exactly once', async () => {
    const spend = jest.fn().mockResolvedValue({ status: 'acknowledged' });
    const { controller, cradle, submit } = setup(spend);
    const first = new ControlledRuntime();
    const replacement = new ControlledRuntime();
    try {
      commitRuntime(controller, first);
      submit(submission('before-persistence'));
      expect(first.has('submission:before-persistence')).toBe(true);

      commitRuntime(controller, replacement);
      await Promise.resolve();
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
    const lease = new ControlledRuntime(undefined, 'submission-relinquishment:');
    const first = submission('prelaunch-successor');
    const successor = nextAttempt(first, 'prelaunch-successor-attempt-2');
    try {
      commitRuntime(controller, lease);
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
    const lease = new ControlledRuntime(undefined, 'submission-relinquishment:');
    try {
      commitRuntime(controller, lease);
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
            submissionPump: { isQuiescent(): boolean };
          }
        ).submissionPump.isQuiescent(),
      ).toBe(false);

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
            submissionPump: { isQuiescent(): boolean };
          }
        ).submissionPump.isQuiescent(),
      ).toBe(true);
    } finally {
      controller.cleanup();
    }
  });

  it('preserves a successor that arrives during launched-attempt relinquishment', async () => {
    const spend = jest.fn().mockResolvedValue({ status: 'acknowledged' });
    const { controller, cradle, submit } = setup(spend);
    const lease = new ControlledRuntime(undefined, 'submission-relinquishment:');
    const first = submission('successor-during-relinquishment');
    const successor = nextAttempt(first, 'successor-during-relinquishment-attempt-2');
    const firstRelinquishment =
      'submission-relinquishment:successor-during-relinquishment:successor-during-relinquishment-attempt-1';
    const successorRelinquishment =
      'submission-relinquishment:successor-during-relinquishment:successor-during-relinquishment-attempt-2';
    try {
      commitRuntime(controller, lease);
      submit(first);
      await lease.launch('submission:successor-during-relinquishment');
      for (let pass = 0; pass < 20 && !lease.has(firstRelinquishment); pass += 1) {
        await Promise.resolve();
      }

      submit(successor);
      await lease.launch(firstRelinquishment);
      for (
        let pass = 0;
        pass < 20 && !lease.has('submission:successor-during-relinquishment');
        pass += 1
      ) {
        await Promise.resolve();
      }

      expect(lease.has('submission:successor-during-relinquishment')).toBe(true);
      await lease.launch('submission:successor-during-relinquishment');
      for (let pass = 0; pass < 20 && !lease.has(successorRelinquishment); pass += 1) {
        await Promise.resolve();
      }
      await lease.launch(successorRelinquishment);
      await controller.flushPendingWork();

      expect(spend).toHaveBeenCalledTimes(2);
      expect(cradle.acknowledge_submission_attempt).toHaveBeenCalledWith(successor.attempt_token);
    } finally {
      controller.cleanup();
    }
  });

  it('keeps a launched delivery queue-owned across runtime replacement', async () => {
    let resolveSpend!: (value: { status: 'acknowledged' }) => void;
    const spendGate = new Promise<{ status: 'acknowledged' }>((resolve) => {
      resolveSpend = resolve;
    });
    const spend = jest.fn(() => spendGate);
    const { controller, cradle, submit } = setup(spend);
    const first = new ControlledRuntime();
    const replacement = new ControlledRuntime();
    try {
      commitRuntime(controller, first);
      submit(submission('after-launch'));
      const launch = first.launch('submission:after-launch');
      for (let i = 0; i < 10 && spend.mock.calls.length === 0; i += 1) {
        await Promise.resolve();
      }
      expect(spend).toHaveBeenCalledTimes(1);

      commitRuntime(controller, replacement);
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

  it('hands an unlaunched finalized broadcast to the replacement runtime', async () => {
    const spend = jest.fn().mockResolvedValue({ status: 'acknowledged' });
    const { controller, cradle, submit } = setup(spend);
    const first = new ControlledRuntime(undefined, 'broadcast:');
    const replacement = new ControlledRuntime();
    try {
      commitRuntime(controller, first);
      submit(submission('finalized-broadcast-handoff'));
      const launch = first.launch('submission:finalized-broadcast-handoff');
      const broadcastKey = `broadcast:finalized-broadcast-handoff:${'bb'.repeat(32)}`;
      for (let i = 0; i < 50 && !first.has(broadcastKey); i += 1) {
        await Promise.resolve();
      }

      expect(first.has(broadcastKey)).toBe(true);
      expect(cradle.finalize_submission).toHaveBeenCalledTimes(1);
      expect(spend).not.toHaveBeenCalled();

      commitRuntime(controller, replacement);
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

  it('cleans a finalized fee reservation independently of runtime replacement', async () => {
    const spend = jest.fn().mockResolvedValue({ status: 'rejected', detail: 'wallet rejected' });
    const beginWalletOffer = jest.fn().mockResolvedValue({
      kind: 'created-reserved',
      material: { kind: 'offer', offer: 'offer-fee' },
      tradeId: 'trade-fee',
    });
    const beginWalletOfferCancellation = jest.fn().mockResolvedValue({ status: 'cancelled' });
    const { controller, cradle, submit } = setup(spend, {
      beginWalletOffer,
      beginWalletOfferCancellation,
    });
    const first = new ControlledRuntime();
    const replacement = new ControlledRuntime();
    try {
      commitRuntime(controller, first);
      (cradle.drain_submissions as jest.Mock).mockReturnValueOnce(
        submissionDrain([], ['fee-release-handoff']),
      );
      submit({
        ...submission('fee-release-handoff'),
        fee_request: { target: '22'.repeat(32), amount: '10' },
      });
      const launch = first.launch('submission:fee-release-handoff');
      await waitFor(() => spend.mock.calls.length === 1);
      expect(spend).toHaveBeenCalledTimes(1);
      expect(cradle.reject_submission).toHaveBeenCalledTimes(1);
      expect(beginWalletOfferCancellation).not.toHaveBeenCalled();

      commitRuntime(controller, replacement);
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

  it('hands an acknowledged wallet outcome to the replacement runtime without rebroadcasting', async () => {
    const spend = jest.fn().mockResolvedValue({ status: 'acknowledged' });
    const { controller, cradle, submit } = setup(spend);
    const first = new ControlledRuntime(2);
    const replacement = new ControlledRuntime();
    try {
      commitRuntime(controller, first);
      submit(submission('acknowledged-handoff'));
      const launch = first.launch('submission:acknowledged-handoff');
      for (let i = 0; i < 50 && !first.hasPendingMutation(); i += 1) {
        await Promise.resolve();
      }
      expect(spend).toHaveBeenCalledTimes(1);
      expect(first.hasPendingMutation()).toBe(true);
      expect(cradle.acknowledge_submission).not.toHaveBeenCalled();

      commitRuntime(controller, replacement);
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
    'hands %s to a replacement runtime exactly once',
    async (_label, deliver, cradleMethod, expectedArguments) => {
      const { controller, cradle } = setup(jest.fn());
      const first = new ControlledRuntime(1);
      const replacement = new ControlledRuntime();
      try {
        commitRuntime(controller, first);
        const completion = deliver(controller);
        expect(first.hasPendingMutation()).toBe(true);

        commitRuntime(controller, replacement);
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
    'queues a %s until a committed runtime exists',
    async (_label, deliver, cradleMethod, expectedArguments) => {
      const { controller, cradle } = setup(jest.fn());
      const lease = new ControlledRuntime();
      try {
        await deliver(controller);
        const callback = cradle[cradleMethod] as jest.Mock;
        expect(callback).not.toHaveBeenCalled();

        commitRuntime(controller, lease);
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
      const lease = new ControlledRuntime();
      const errors: string[] = [];
      const subscription = controller.getObservable().subscribe((event) => {
        if (event.type === 'error') errors.push(event.error);
      });
      (cradle[cradleMethod] as jest.Mock).mockImplementation(() => {
        throw new Error('authoritative callback failed');
      });
      try {
        commitRuntime(controller, lease);
        await expect(deliver(controller)).rejects.toThrow('authoritative callback failed');
        expect(errors).toEqual(['authoritative callback failed']);
      } finally {
        subscription.unsubscribe();
        controller.cleanup();
      }
    },
  );

  it('hands wallet failure recording to the replacement runtime without retrying the wallet', async () => {
    expectConsoleError('wallet failed after broadcast');
    const spend = jest.fn().mockRejectedValue(new Error('wallet failed after broadcast'));
    const { controller, cradle, submit } = setup(spend);
    const first = new ControlledRuntime(2);
    const replacement = new ControlledRuntime();
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
      commitRuntime(controller, first);
      submit(submission('failure-handoff'));
      const launch = first.launch('submission:failure-handoff');
      for (let i = 0; i < 50 && !first.hasPendingMutation(); i += 1) {
        await Promise.resolve();
      }
      expect(spend).toHaveBeenCalledTimes(1);
      expect(first.hasPendingMutation()).toBe(true);
      expect(errors).toEqual([]);

      commitRuntime(controller, replacement);
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

  it('does not duplicate scheduling when the same runtime commits repeatedly', async () => {
    const spend = jest.fn().mockResolvedValue({ status: 'acknowledged' });
    const { controller, submit } = setup(spend);
    const lease = new ControlledRuntime();
    try {
      commitRuntime(controller, lease);
      submit(submission('repeated-attach'));
      commitRuntime(controller, lease);
      commitRuntime(controller, lease);

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
    const lease = new ControlledRuntime();
    const first = submission('variant-upgrade');
    const upgrade = nextAttempt(first, 'variant-upgrade-attempt-2');
    try {
      commitRuntime(controller, lease);
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
    const lease = new ControlledRuntime();
    const first = submission('superseded-wallet-result');
    const intermediate = nextAttempt(first, 'superseded-wallet-result-attempt-2');
    const successor = nextAttempt(intermediate, 'superseded-wallet-result-attempt-3');
    try {
      commitRuntime(controller, lease);
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
    const { controller, submit } = setup(spend);
    const firstLease = new ControlledRuntime();
    const replacementLease = new ControlledRuntime();
    const first = submission('exact-successor');
    const successor = nextAttempt(first, 'exact-successor-attempt-2');
    try {
      commitRuntime(controller, firstLease);
      submit(first);
      const launch = firstLease.launch('submission:exact-successor');
      for (let pass = 0; pass < 20 && spend.mock.calls.length === 0; pass += 1) {
        await Promise.resolve();
      }
      submit(successor);
      resolveSpend({ status: 'unavailable', detail: 'wallet syncing' });
      await launch;
      await controller.flushTransactionSubmissions();

      expect(firstLease.has('submission:exact-successor')).toBe(false);

      commitRuntime(controller, replacementLease);
      await controller.reportChainSnapshotReady(2n);
      expect(replacementLease.has('submission:exact-successor')).toBe(true);
    } finally {
      controller.cleanup();
    }
  });

  it('parks a coherent snapshot while the provider is not ready and launches on readiness', async () => {
    let readinessChanged: ((ready: boolean) => void) | undefined;
    let providerReady = false;
    const spend = jest.fn().mockResolvedValue({ status: 'acknowledged' });
    const { blockchain, controller, cradle, submit } = setup(spend, {
      isReadyForPlay: () => providerReady,
      onPlayReadinessChange: (listener) => {
        readinessChanged = listener;
        return () => {};
      },
    });
    const lease = new ControlledRuntime();
    try {
      controller.attachBlockchain(blockchain);
      commitRuntime(controller, lease);
      submit(submission('provider-gated'));

      await controller.reportChainSnapshotReady(3n);
      expect(cradle.chain_snapshot_ready).toHaveBeenCalledTimes(1);
      expect(lease.has('submission:provider-gated')).toBe(false);
      expect(spend).not.toHaveBeenCalled();
      expect(cradle.submission_attempt_unavailable).not.toHaveBeenCalled();

      providerReady = true;
      readinessChanged?.(true);
      expect(lease.has('submission:provider-gated')).toBe(true);
      await lease.launch('submission:provider-gated');
      await controller.flushPendingWork();

      expect(cradle.chain_snapshot_ready).toHaveBeenCalledTimes(1);
      expect(spend).toHaveBeenCalledTimes(1);
    } finally {
      controller.cleanup();
    }
  });

  it('launches a Rust-issued newer fee-bearing successor without fresh sync', async () => {
    let resolveSpend!: (value: { status: 'unavailable'; detail: string }) => void;
    const spend = jest.fn(
      () =>
        new Promise<{ status: 'unavailable'; detail: string }>((resolve) => {
          resolveSpend = resolve;
        }),
    );
    const { controller, cradle, submit } = setup(spend);
    const lease = new ControlledRuntime();
    const first = submission('fee-successor');
    const successor = {
      ...nextAttempt(first, 'fee-successor-attempt-2', 'newer-fee-bearing'),
      fee_request: { target: '22'.repeat(32), amount: '10' },
    };
    try {
      commitRuntime(controller, lease);
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
    const lease = new ControlledRuntime();
    const first = submission('snapshot-gated');
    const successor = nextAttempt(first, 'snapshot-gated-attempt-2');
    const unrelated = submission('unrelated-urgent');
    try {
      commitRuntime(controller, lease);
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

  it('fails a duplicate stable id with invalid Rust lineage before wallet side effects', () => {
    const spend = jest.fn().mockResolvedValue({ status: 'acknowledged' });
    const { controller, cradle, submit } = setup(spend);
    const lease = new ControlledRuntime();
    try {
      commitRuntime(controller, lease);
      submit(submission('intent-mismatch'));

      expect(() =>
        submit({
          ...submission('intent-mismatch'),
          attempt_token: 'intent-mismatch-attempt-2',
          predecessor_attempt_token: 'unrelated-attempt',
          relationship: 'exact',
        }),
      ).toThrow('does not name active predecessor');
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
    const lease = new ControlledRuntime();
    const errors: string[] = [];
    const subscription = controller.getObservable().subscribe((event) => {
      if (event.type === 'error') errors.push(event.error);
    });
    try {
      commitRuntime(controller, lease);
      submit(submission('release-failure'));
      lease.reject('submission:release-failure', new Error('release exploded'));
      for (let i = 0; i < 10 && errors.length === 0; i += 1) {
        await Promise.resolve();
      }

      expect(spend).not.toHaveBeenCalled();
      expect(errors).toEqual([
        expect.stringMatching(/release-failure.*retained for retry.*release exploded/i),
      ]);
    } finally {
      subscription.unsubscribe();
      controller.cleanup();
    }
  });

  it('preserves a successor that arrives during release-failure relinquishment', async () => {
    expectConsoleError('release exploded');
    const spend = jest.fn().mockResolvedValue({ status: 'acknowledged' });
    const { controller, cradle, submit } = setup(spend);
    const lease = new ControlledRuntime(undefined, 'submission-relinquishment:');
    const first = submission('release-failure-successor');
    const successor = nextAttempt(first, 'release-failure-successor-attempt-2');
    const firstRelinquishment =
      'submission-relinquishment:release-failure-successor:release-failure-successor-attempt-1';
    const successorRelinquishment =
      'submission-relinquishment:release-failure-successor:release-failure-successor-attempt-2';
    try {
      commitRuntime(controller, lease);
      submit(first);
      lease.reject('submission:release-failure-successor', new Error('release exploded'));
      for (let pass = 0; pass < 20 && !lease.has(firstRelinquishment); pass += 1) {
        await Promise.resolve();
      }

      submit(successor);
      await lease.launch(firstRelinquishment);
      for (
        let pass = 0;
        pass < 20 && !lease.has('submission:release-failure-successor');
        pass += 1
      ) {
        await Promise.resolve();
      }
      expect(lease.has('submission:release-failure-successor')).toBe(true);

      for (let pass = 0; pass < 20; pass += 1) {
        if (lease.has(firstRelinquishment)) await lease.launch(firstRelinquishment);
        await Promise.resolve();
      }
      await lease.launch('submission:release-failure-successor');
      for (let pass = 0; pass < 20 && !lease.has(successorRelinquishment); pass += 1) {
        await Promise.resolve();
      }
      await lease.launch(successorRelinquishment);
      await controller.flushPendingWork();

      expect(spend).toHaveBeenCalledTimes(1);
      expect(cradle.acknowledge_submission_attempt).toHaveBeenCalledWith(successor.attempt_token);
    } finally {
      controller.cleanup();
    }
  });

  it('keeps network rejection authoritative when durable fee cleanup fails', async () => {
    const spend = jest.fn().mockResolvedValue({ status: 'rejected', detail: 'invalid spend' });
    const beginWalletOffer = jest.fn().mockResolvedValue({
      kind: 'created-reserved',
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
    const lease = new ControlledRuntime();
    try {
      commitRuntime(controller, lease);
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
      expect(storageRepository.walletObligations()).toEqual([
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
      kind: 'created-reserved',
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
    const lease = new ControlledRuntime(undefined, 'wallet-offer-cancellation:');
    try {
      commitRuntime(controller, lease);
      submit({
        ...submission('finalize-rejected'),
        fee_request: { target: '22'.repeat(32), amount: '10' },
      });
      await lease.launch('submission:finalize-rejected');
      await waitFor(() => lease.has('wallet-offer-cancellation:trade-finalize-rejected'));

      expect(beginWalletOfferCancellation).not.toHaveBeenCalled();
      await lease.launch('wallet-offer-cancellation:trade-finalize-rejected');
      await controller.flushPendingWork();

      expect(spend).not.toHaveBeenCalled();
      expect(beginWalletOfferCancellation).toHaveBeenCalledWith('trade-finalize-rejected');
      expect(storageRepository.walletObligations()).toEqual([]);
    } finally {
      controller.cleanup();
    }
  });
});
