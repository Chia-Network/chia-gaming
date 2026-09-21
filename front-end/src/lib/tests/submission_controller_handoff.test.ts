import { createSessionModel } from '../session/model';
import { walletOperationRuntime } from '../session/walletOperationRuntime';
import { storageRepository } from '../session/storageRepository';
import { canonicalizeFundingRequest } from '../session/fundingRequest';
import { wasmResult } from './message_protocol.harness';
import { commitRuntime, ControlledRuntime, setup, submission } from './runtime_capability.harness';

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
      expect((controller as any).submissionPump.isQuiescent()).toBe(false);

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
    expect(
      (
        controller as unknown as {
          submissionPump: { isQuiescent(): boolean };
        }
      ).submissionPump.isQuiescent(),
    ).toBe(true);
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
    expect(cradle.acknowledge_submission).not.toHaveBeenCalled();
    expect(cradle.reject_submission).not.toHaveBeenCalled();
    expect((controller as unknown as { cradle: unknown }).cradle).toBeUndefined();
  });

  it('routes a late funding offer through the global ledger after cleanup', async () => {
    walletOperationRuntime.resetForTests();
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
    const { controller, cradle } = setup(jest.fn(), {
      beginWalletOffer,
      beginWalletOfferCancellation,
    });
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
    await waitForCall(beginWalletOfferCancellation);
    const owner = {
      installationPlayerId: 'submission-handoff',
      peerSessionId: '00'.repeat(16),
      providerScope: { provider: 'simulator' as const, identity: 'submission-handoff' },
    };
    await walletOperationRuntime.awaitOwner(owner);

    expect(beginWalletOfferCancellation).toHaveBeenCalledWith('trade-late-funding');
    expect(walletOperationRuntime.entriesFor(owner)).toEqual([]);
    expect(cradle.provide_coin_spend_bundle).not.toHaveBeenCalled();
  });

  it('retires a fee creation whose recovery id arrives after controller cleanup', async () => {
    walletOperationRuntime.resetForTests();
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
        kind: 'created-reserved',
        material: { kind: 'offer', offer: 'offer1latefee' },
        tradeId: 'trade-late-fee',
      });
    const beginWalletOfferCancellation = jest.fn().mockResolvedValue({ status: 'cancelled' });
    const { blockchain, controller, cradle, submit } = setup(jest.fn(), {
      beginWalletOffer,
      reconcileWalletOffer,
      beginWalletOfferCancellation,
    });
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
    const owner = storageRepository.walletObligations()[0]!.owner;
    await walletOperationRuntime.awaitOwner(owner);
    expect(storageRepository.walletObligations()).toEqual([
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
    walletOperationRuntime.providerReady(provider!);
    await walletOperationRuntime.awaitOwner(owner);

    expect(beginWalletOffer).toHaveBeenCalledTimes(1);
    expect(reconcileWalletOffer).toHaveBeenCalledTimes(2);
    expect(beginWalletOfferCancellation).toHaveBeenCalledWith('trade-late-fee');
    expect(walletOperationRuntime.entriesFor(owner)).toEqual([]);
    expect(cradle.finalize_submission).not.toHaveBeenCalled();
    expect(cradle.acknowledge_submission).not.toHaveBeenCalled();
    expect(cradle.reject_submission).not.toHaveBeenCalled();
  });
});
