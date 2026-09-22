import { createSessionModel } from '../session/model';
import { channelFundingRuntime } from '../session/channelFundingRuntime';
import { storageRepository } from '../session/storageRepository';
import { canonicalizeFundingRequest } from '../session/fundingRequest';
import { entriesForOwner } from '../session/channelFundingSelectors';
import { StorageAuthorityLostError, StorageAuthorityRequiredError } from '../session/indexedDb';
import { finalizeTerminalSession } from '../session/terminalFinalization';
import { wasmResult } from './message_protocol.harness';
import {
  bestEffortWalletRpc,
  commitRuntime,
  ControlledRuntime,
  recoverableWalletRpc,
  setup,
  submission,
} from './runtime_capability.harness';

async function waitForCall(mock: jest.Mock, count = 1): Promise<void> {
  for (let pass = 0; pass < 30 && mock.mock.calls.length < count; pass += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe('submission controller handoff and quiescence', () => {
  it('keeps terminal quiescence blocked on the delivery entry and queue job', async () => {
    let resolveSpend!: (value: { status: 'acknowledged' }) => void;
    const spend = jest.fn(
      () =>
        new Promise<{ status: 'acknowledged' }>((resolve) => {
          resolveSpend = resolve;
        }),
    );
    const { controller, submit } = setup(spend);
    const runtime = new ControlledRuntime();
    try {
      commitRuntime(controller, runtime);
      submit(submission('slow-wallet'));
      let quiesced = false;
      const quiescence = controller.quiesceForTerminalFinalization().then(() => {
        quiesced = true;
      });
      await Promise.resolve();
      expect(spend).not.toHaveBeenCalled();
      expect(quiesced).toBe(false);

      const launch = runtime.launch('submission:slow-wallet');
      for (let i = 0; i < 10 && spend.mock.calls.length === 0; i += 1) {
        await Promise.resolve();
      }

      expect(spend).toHaveBeenCalledTimes(1);
      expect(quiesced).toBe(false);

      resolveSpend({ status: 'acknowledged' });
      await launch;
      await quiescence;
      expect(quiesced).toBe(true);
    } finally {
      controller.cleanup();
    }
  });

  it('revalidates quiescence when the committed runtime changes during snapshot', async () => {
    const { controller } = setup(jest.fn());
    const firstModel = createSessionModel({ restore: { status: 'restoring' } });
    const replacementModel = createSessionModel({ restore: { status: 'restored' } });
    const replacementSnapshot = jest.fn(() => replacementModel);
    const replacement = new ControlledRuntime(undefined, undefined, replacementSnapshot);
    const firstSnapshot = jest.fn(() => {
      commitRuntime(controller, replacement);
      return firstModel;
    });
    const first = new ControlledRuntime(undefined, undefined, firstSnapshot);
    try {
      commitRuntime(controller, first);

      const snapshot = await controller.quiesceForTerminalFinalization();
      expect(snapshot).toEqual({ model: replacementModel, coinsOfInterest: [] });
      expect(snapshot.model).not.toBe(replacementModel);
      expect(firstSnapshot).toHaveBeenCalledTimes(1);
      expect(replacementSnapshot).toHaveBeenCalledTimes(1);
    } finally {
      controller.cleanup();
    }
  });

  it('captures and tears down terminal state after one ordinary checkpoint failure', async () => {
    const { controller } = setup(jest.fn());
    const authoritativeModel = createSessionModel({ restore: { status: 'restored' } });
    const runtime = new ControlledRuntime(undefined, undefined, () => authoritativeModel);
    const failure = new Error('terminal checkpoint failed');
    const reportDurabilityError = jest.spyOn(controller, 'reportDurabilityError');
    const flush = jest.spyOn(runtime, 'flush').mockImplementation(async () => {
      controller.reportDurabilityError(failure);
      throw failure;
    });
    const persistTerminal = jest.fn().mockResolvedValue(undefined);
    const teardown = jest.fn((terminalController) =>
      terminalController.cleanupAfterTerminalFlush(),
    );
    try {
      commitRuntime(controller, runtime);

      const result = await finalizeTerminalSession(
        {
          controller,
          identity: { myName: 'Alice', opponentName: 'Bob', iStarted: true },
        },
        {
          persistTerminal,
          updateMarker: jest.fn(),
          teardown,
        },
      );

      expect(result.model).toEqual(authoritativeModel);
      expect(persistTerminal).toHaveBeenCalledWith(
        expect.objectContaining({ model: authoritativeModel }),
      );
      expect(teardown).toHaveBeenCalledWith(controller);
      expect(flush).toHaveBeenCalledTimes(1);
      expect(reportDurabilityError).toHaveBeenCalledTimes(1);
    } finally {
      controller.cleanup();
    }
  });

  it.each([
    ['lost', new StorageAuthorityLostError()],
    ['required', new StorageAuthorityRequiredError()],
  ])('propagates storage authority %s from terminal quiescence', async (_kind, failure) => {
    const { controller } = setup(jest.fn());
    const runtime = new ControlledRuntime();
    jest.spyOn(runtime, 'flush').mockRejectedValue(failure);
    try {
      commitRuntime(controller, runtime);
      await expect(controller.quiesceForTerminalFinalization()).rejects.toBe(failure);
    } finally {
      controller.cleanup();
    }
  });

  it('fails terminal quiescence explicitly without an active runtime', async () => {
    const { controller } = setup(jest.fn());
    try {
      await expect(controller.quiesceForTerminalFinalization()).rejects.toThrow(
        'terminal finalization requires an active runtime',
      );
    } finally {
      controller.cleanup();
    }
  });

  it('fails terminal quiescence when the authoritative coin query fails', async () => {
    const { controller, cradle } = setup(jest.fn());
    const runtime = new ControlledRuntime();
    (cradle.coins_of_interest as jest.Mock).mockImplementation(() => {
      throw new Error('coin query failed');
    });
    try {
      commitRuntime(controller, runtime);
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
    const runtime = new ControlledRuntime();
    let finishEffect!: () => void;
    const effect = new Promise<void>((resolve) => {
      finishEffect = resolve;
    });
    (
      controller as unknown as {
        trackEffect(effect: Promise<void>): void;
      }
    ).trackEffect(effect);
    commitRuntime(controller, runtime);
    submit(submission('never-launched'));

    controller.cleanup();
    controller.cleanupAfterTerminalFlush();

    await expect(controller.flushTransactionSubmissions()).resolves.toBeUndefined();
    await expect(controller.flushPendingWork()).resolves.toBeUndefined();
    expect(spend).not.toHaveBeenCalled();
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
    const runtime = new ControlledRuntime();
    commitRuntime(controller, runtime);
    submit(submission('late-wallet'));
    const launch = runtime.launch('submission:late-wallet');
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
    expect(cradle.acknowledge_submission_attempt).not.toHaveBeenCalled();
    expect(cradle.reject_submission_attempt).not.toHaveBeenCalled();
    expect((controller as unknown as { cradle: unknown }).cradle).toBeUndefined();
  });

  it('cancels a late known funding reservation after cleanup without installing it', async () => {
    channelFundingRuntime.resetForTests();
    let resolveOffer!: (value: {
      kind: 'created-reserved';
      material: { kind: 'offer'; offer: string };
      tradeId: string;
    }) => void;
    const beginWalletOffer = jest.fn(
      () =>
        new Promise<{
          kind: 'created-reserved';
          material: { kind: 'offer'; offer: string };
          tradeId: string;
        }>((resolve) => {
          resolveOffer = resolve;
        }),
    );
    const beginWalletOfferCancellation = jest.fn().mockResolvedValue({ status: 'cancelled' });
    const { controller, cradle } = setup(
      jest.fn(),
      bestEffortWalletRpc(beginWalletOffer, beginWalletOfferCancellation),
    );
    const runtime = new ControlledRuntime();
    const request = canonicalizeFundingRequest({
      amount: '100',
      fee: '0',
      conditions: [{ opcode: 60n, args: ['launcher'] }],
    });
    controller.processResult(wasmResult({ events: [{ NeedCoinSpend: request }] }));
    controller.flushDeferredWork();
    commitRuntime(controller, runtime);
    await waitForCall(beginWalletOffer);
    expect(beginWalletOffer).toHaveBeenCalledTimes(1);

    controller.cleanup();
    resolveOffer({
      kind: 'created-reserved',
      material: { kind: 'offer', offer: 'offer1late' },
      tradeId: 'trade-late-funding',
    });
    const owner = {
      installationPlayerId: 'submission-handoff',
      peerSessionId: '00'.repeat(16),
      providerScope: { provider: 'simulator' as const, identity: 'submission-handoff' },
    };
    for (
      let pass = 0;
      pass < 20 &&
      entriesForOwner(storageRepository.channelFundingOperations(), owner).length === 0;
      pass += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await channelFundingRuntime.flush();

    expect(beginWalletOfferCancellation).toHaveBeenCalledTimes(1);
    expect(beginWalletOfferCancellation).toHaveBeenCalledWith('trade-late-funding');
    expect(entriesForOwner(storageRepository.channelFundingOperations(), owner)).toEqual([]);
    expect(cradle.provide_coin_spend_bundle).not.toHaveBeenCalled();
  });

  it('reconciles and cancels a late fee recovery without installing it', async () => {
    channelFundingRuntime.resetForTests();
    let finishBegin!: (value: { kind: 'pending'; recoveryId: string }) => void;
    const beginWalletOffer = jest.fn(
      () =>
        new Promise<{ kind: 'pending'; recoveryId: string }>((resolve) => {
          finishBegin = resolve;
        }),
    );
    const reconcileWalletOffer = jest.fn().mockResolvedValue({
      kind: 'created-reserved',
      material: { kind: 'offer', offer: 'offer1latefee' },
      tradeId: 'trade-late-fee',
    });
    const beginWalletOfferCancellation = jest.fn().mockResolvedValue({ status: 'cancelled' });
    const { controller, cradle, submit } = setup(
      jest.fn(),
      recoverableWalletRpc(beginWalletOffer, reconcileWalletOffer, beginWalletOfferCancellation),
    );
    const runtime = new ControlledRuntime();
    commitRuntime(controller, runtime);
    submit({
      ...submission('late-fee-recovery'),
      fee_request: { target: '22'.repeat(32), amount: '10' },
    });
    await runtime.launch('submission:late-fee-recovery');
    await waitForCall(beginWalletOffer);
    expect(beginWalletOffer).toHaveBeenCalledTimes(1);

    controller.cleanup();
    finishBegin({ kind: 'pending', recoveryId: 'SR_late_fee' });
    await waitForCall(reconcileWalletOffer);
    await waitForCall(beginWalletOfferCancellation);

    expect(beginWalletOffer).toHaveBeenCalledTimes(1);
    expect(reconcileWalletOffer).toHaveBeenCalledTimes(1);
    expect(reconcileWalletOffer).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'SR_late_fee',
    );
    expect(beginWalletOfferCancellation).toHaveBeenCalledTimes(1);
    expect(beginWalletOfferCancellation).toHaveBeenCalledWith('trade-late-fee');
    expect(storageRepository.feeAttachments()).toEqual([]);
    expect(cradle.finalize_submission_attempt).not.toHaveBeenCalled();
    expect(cradle.acknowledge_submission_attempt).not.toHaveBeenCalled();
    expect(cradle.reject_submission_attempt).not.toHaveBeenCalled();
  });
});
