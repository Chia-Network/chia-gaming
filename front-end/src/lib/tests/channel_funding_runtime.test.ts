import { configureSessionExecution } from './session_execution.harness';
import { expectConsoleError } from '../../../scripts/testSetup';
import type { InternalBlockchainInterface } from '../../types/ChiaGaming';
import { SessionController } from '../session/SessionController';
import { channelFundingRuntime } from '../session/channelFundingRuntime';
import { entriesForOwner } from '../session/channelFundingSelectors';
import type { ChannelFundingEntry } from '../session/channelFundingStore';
import { canonicalizeFundingRequest, fundingRequestKey } from '../session/fundingRequest';
import { createSessionModel } from '../session/model';
import { createSessionMachineState } from '../session/sessionMachine';

import { storageRepository } from '../session/storageRepository';
import { BlockchainPoller } from '../wallet/BlockchainPoller';
import { installAwaitingChannelFunding } from './channel_funding_test_helpers';
import {
  makeMockCradle,
  makePeerConn,
  mockRpc,
  mockWasmConnection,
  testSpendBundle,
  wasmResult,
} from './message_protocol.harness';
import {
  bestEffortWalletRpc,
  commitRuntime,
  ControlledRuntime,
  recoverableWalletRpc,
  setup,
} from './runtime_capability.harness';
import { activeSave } from './session_save_envelope.fixtures';

describe('durable channel funding record', () => {
  const owner = {
    installationPlayerId: 'submission-handoff',
    peerSessionId: '00'.repeat(16),
    providerScope: { provider: 'simulator' as const, identity: 'submission-handoff' },
  };

  beforeEach(() => channelFundingRuntime.resetForTests());

  function installAggregateWallet(entries: ChannelFundingEntry[]): void {
    storageRepository._replaceApplicationStateForTests({
      ...storageRepository.loadState(),
      walletContext: owner.providerScope,
      channelFundingOperations: entries,
      feeAttachments: [],
    });
    channelFundingRuntime.retryCancelRequired();
  }

  it('keeps a Rust funding request idle until an adapter establishes scope', async () => {
    const controller = new SessionController(
      null,
      'submission-handoff',
      100n,
      100n,
      makePeerConn([], []),
      channelFundingRuntime,
    );
    const cradle = makeMockCradle();
    controller.rewardPuzzleHash = '11'.repeat(32);
    controller.loadWasm(mockWasmConnection);
    controller.setGameSession(cradle);
    commitRuntime(controller, new ControlledRuntime());
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
      kind: 'created-ephemeral',
      material: { kind: 'bundle', bundle: testSpendBundle('restore-before-adapter') },
    });
    const blockchain = new BlockchainPoller(
      {
        ...mockRpc,
        ...bestEffortWalletRpc(beginWalletOffer),
      } as InternalBlockchainInterface,
      60_000,
    );
    controller.attachBlockchain(blockchain);
    await controller.flushPendingWork();

    expect(beginWalletOffer).toHaveBeenCalledTimes(1);
    expect(cradle.provide_coin_spend_bundle).toHaveBeenCalledTimes(1);
    controller.cleanup();
  });

  it('keeps the session while a replacement wallet resumes monitoring and funds new work', async () => {
    const { controller, blockchain, cradle } = setup(jest.fn());
    commitRuntime(controller, new ControlledRuntime());
    const originalReward = controller.rewardPuzzleHash;
    cradle.provide_offer_bech32 = jest.fn(() => wasmResult());
    installAggregateWallet([
      {
        owner,
        purpose: { kind: 'funding', operationId: 'prior-wallet-offer' },
        stage: 'awaiting-channel',
        providerReservationId: 'original-trade',
        request: { kind: 'funding', canonical: { amount: '50', fee: '0', conditions: [] } },
        reason: 'already-delivered',
      },
    ]);
    controller.detachBlockchain(blockchain);
    const request = canonicalizeFundingRequest({ amount: '100', fee: '0', conditions: [] });
    controller.processResult(wasmResult({ events: [{ NeedCoinSpend: request }] }));
    const beginCreation = jest.fn().mockResolvedValue({
      kind: 'created-reserved',
      material: { kind: 'offer', offer: 'offer1newwallet' },
      tradeId: 'new-trade',
    });
    const scope = { provider: 'cloud' as const, walletId: 'Wallet_replacement' };
    const cancel = jest.fn();
    const replacement = new BlockchainPoller(
      {
        ...mockRpc,
        getWalletOfferProvider: () => ({
          capability: 'best-effort' as const,
          scope,
          beginCreation,
          cancel,
        }),
      } as InternalBlockchainInterface,
      60_000,
    );
    replacement.refreshProviderReadiness();
    const snapshot = jest.spyOn(replacement, 'updateCoinInterest');
    try {
      controller.attachBlockchain(replacement);
      await controller.flushPendingWork();
      expect(controller.getWalletProviderScope()).toEqual(scope);
      expect(storageRepository.loadState().walletContext).toEqual(scope);
      expect(controller.rewardPuzzleHash).toBe(originalReward);
      expect(snapshot).toHaveBeenCalledWith(controller);
      expect(beginCreation).toHaveBeenCalledTimes(1);
      expect(cradle.provide_offer_bech32).toHaveBeenCalledTimes(1);
      expect(storageRepository.channelFundingOperations()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ owner, providerReservationId: 'original-trade' }),
          expect.objectContaining({
            owner: { ...owner, providerScope: scope },
            providerReservationId: 'new-trade',
          }),
        ]),
      );
      expect(cancel).not.toHaveBeenCalled();
    } finally {
      controller.cleanup();
      replacement.detachProvider();
    }
  });

  it.each([
    ['reserved', false],
    ['ephemeral', false],
    ['reserved', true],
    ['ephemeral', true],
  ])(
    'handles completed %s funding queued behind a checkpoint (timed out=%s)',
    async (kind, timedOut) => {
      let finishOffer!: (value: unknown) => void;
      const begin = jest.fn(
        () =>
          new Promise((resolve) => {
            finishOffer = resolve;
          }),
      );
      const cancel = jest.fn().mockResolvedValue({ status: 'cancelled' });
      const { controller, blockchain, cradle } = setup(
        jest.fn(),
        bestEffortWalletRpc(begin, cancel),
      );
      cradle.provide_offer_bech32 = jest.fn(() => wasmResult());
      let releaseCheckpoint!: () => void;
      let holdCheckpoint = false;
      const runtime = configureSessionExecution(createSessionMachineState(createSessionModel()), {
        controller,
        iStarted: true,
        restoring: false,
        getRestoreStatus: () => 'idle',
        getRestoreError: () => null,
        onError: (error) => {
          throw error;
        },
        persist: () =>
          holdCheckpoint
            ? new Promise<void>((resolve) => {
                releaseCheckpoint = resolve;
              })
            : Promise.resolve(),
      });
      const replacementBegin = jest
        .fn()
        .mockResolvedValue({ kind: 'unavailable', reason: 'unexpected replacement' });
      const replacement = new BlockchainPoller(
        {
          ...mockRpc,
          getWalletOfferProvider: () => ({
            capability: 'best-effort',
            scope: { provider: 'cloud', walletId: 'Wallet_queued_completion' },
            beginCreation: replacementBegin,
            cancel: jest.fn(),
          }),
        } as InternalBlockchainInterface,
        60_000,
      );
      try {
        runtime.activate();
        const request = canonicalizeFundingRequest({ amount: '100', fee: '0', conditions: [] });
        controller.processResult(wasmResult({ events: [{ NeedCoinSpend: request }] }));
        await runtime.flush();
        for (let n = 0; n < 30 && !begin.mock.calls.length; n++)
          await new Promise((resolve) => setTimeout(resolve, 0));
        expect(begin).toHaveBeenCalledTimes(1);
        holdCheckpoint = true;
        runtime.requestCommit();
        const checkpoint = runtime.flush();
        const timeout = timedOut
          ? controller.enqueueResult(() => {
              controller.processResult(wasmResult({ events: [{ ChannelCreationTimedOut: null }] }));
              controller.flushDeferredWork();
            })
          : Promise.resolve();
        finishOffer(
          kind === 'reserved'
            ? {
                kind: 'created-reserved',
                material: { kind: 'offer', offer: 'offer1queued' },
                tradeId: 'queued-trade',
              }
            : {
                kind: 'created-ephemeral',
                material: { kind: 'bundle', bundle: testSpendBundle('queued') },
              },
        );
        // Wait until the actual runtime has queued the authoritative completion.
        for (
          let n = 0;
          n < 30 &&
          (runtime as unknown as { pendingControllerWork: unknown[] }).pendingControllerWork
            .length < (timedOut ? 2 : 1);
          n++
        )
          await new Promise((resolve) => setTimeout(resolve, 0));
        expect(
          (runtime as unknown as { pendingControllerWork: unknown[] }).pendingControllerWork.length,
        ).toBe(timedOut ? 2 : 1);
        controller.detachBlockchain(blockchain);
        replacement.refreshProviderReadiness();
        controller.attachBlockchain(replacement);
        holdCheckpoint = false;
        releaseCheckpoint();
        await checkpoint;
        await timeout;
        await controller.flushPendingWork();
        expect(replacementBegin).not.toHaveBeenCalled();
        if (timedOut) {
          expect(cradle.provide_offer_bech32).not.toHaveBeenCalled();
          expect(cradle.provide_coin_spend_bundle).not.toHaveBeenCalled();
        } else if (kind === 'reserved') {
          expect(cancel).not.toHaveBeenCalled();
          expect(cradle.provide_offer_bech32).toHaveBeenCalledWith('offer1queued');
          expect(storageRepository.channelFundingOperations()).toEqual([
            expect.objectContaining({
              stage: 'awaiting-channel',
              providerReservationId: 'queued-trade',
              owner,
            }),
          ]);
        } else expect(cradle.provide_coin_spend_bundle).toHaveBeenCalledTimes(1);
      } finally {
        holdCheckpoint = false;
        releaseCheckpoint?.();
        runtime.retireExecution();
        controller.cleanup();
        replacement.detachProvider();
      }
    },
  );

  it('replaces a restored reservation without live material when its wallet is unreachable', async () => {
    const oldBegin = jest.fn();
    const { controller, blockchain, cradle } = setup(jest.fn(), bestEffortWalletRpc(oldBegin));
    cradle.provide_offer_bech32 = jest.fn(() => wasmResult());
    const request = canonicalizeFundingRequest({ amount: '100', fee: '0', conditions: [] });
    installAggregateWallet([
      {
        owner,
        purpose: { kind: 'funding', operationId: fundingRequestKey(request) },
        stage: 'awaiting-channel',
        providerReservationId: 'restored-no-material',
        request: { kind: 'funding', canonical: request },
        reason: 'restored',
      },
    ]);
    controller.processResult(wasmResult({ events: [{ NeedCoinSpend: request }] }));
    controller.flushDeferredWork();
    const gate = new ControlledRuntime(undefined, 'funding:');
    commitRuntime(controller, gate);
    controller.detachBlockchain(blockchain);
    blockchain.detachProvider();
    const beginCreation = jest.fn().mockResolvedValue({
      kind: 'created-reserved',
      material: { kind: 'offer', offer: 'offer1restoredreplacement' },
      tradeId: 'restored-replacement',
    });
    const replacement = new BlockchainPoller(
      {
        ...mockRpc,
        getWalletOfferProvider: () => ({
          capability: 'best-effort',
          scope: { provider: 'cloud', walletId: 'Wallet_restored_replacement' },
          beginCreation,
          cancel: jest.fn(),
        }),
      } as InternalBlockchainInterface,
      60_000,
    );
    try {
      replacement.refreshProviderReadiness();
      controller.attachBlockchain(replacement);
      await gate.launchAll('funding:');
      await controller.flushPendingWork();
      expect(oldBegin).not.toHaveBeenCalled();
      expect(beginCreation).toHaveBeenCalledTimes(1);
      expect(cradle.provide_offer_bech32).toHaveBeenCalledWith('offer1restoredreplacement');
    } finally {
      controller.cleanup();
      replacement.detachProvider();
    }
  });

  it.each([false, true])(
    'replaces an unreachable unmet funding flight (durable=%s) without waiting for cancellation',
    async (durable) => {
      let finishOld!: (value: unknown) => void;
      const oldBegin = jest.fn(
        () =>
          new Promise((resolve) => {
            finishOld = resolve;
          }),
      );
      const oldCancel = jest
        .fn()
        .mockResolvedValue({ status: 'unavailable', detail: 'old wallet gone' });
      const { controller, blockchain, cradle } = setup(
        jest.fn(),
        bestEffortWalletRpc(oldBegin, oldCancel),
      );
      cradle.provide_offer_bech32 = jest.fn(() => wasmResult());
      const request = canonicalizeFundingRequest({ amount: '100', fee: '0', conditions: [] });
      commitRuntime(controller, new ControlledRuntime());
      controller.processResult(wasmResult({ events: [{ NeedCoinSpend: request }] }));
      controller.flushDeferredWork();
      for (let n = 0; n < 30 && !oldBegin.mock.calls.length; n++)
        await new Promise((resolve) => setTimeout(resolve, 0));
      expect(oldBegin).toHaveBeenCalledTimes(1);
      if (durable)
        storageRepository.replaceChannelFunding([
          {
            owner,
            purpose: { kind: 'funding', operationId: fundingRequestKey(request) },
            stage: 'creating',
            disposition: 'active',
            recoveryId: 'old-recovery',
            request: { kind: 'funding', canonical: request },
            reason: 'pending',
          },
        ]);
      controller.detachBlockchain(blockchain);
      blockchain.detachProvider();
      const scope = { provider: 'cloud' as const, walletId: 'Wallet_new_funding' };
      const beginCreation = jest.fn().mockResolvedValue({
        kind: 'created-reserved',
        material: { kind: 'offer', offer: 'offer1replacement' },
        tradeId: 'new-funding',
      });
      const replacement = new BlockchainPoller(
        {
          ...mockRpc,
          getWalletOfferProvider: () => ({
            capability: 'best-effort',
            scope,
            beginCreation,
            cancel: jest.fn(),
          }),
        } as InternalBlockchainInterface,
        60_000,
      );
      try {
        replacement.refreshProviderReadiness();
        controller.attachBlockchain(replacement);
        for (
          let n = 0;
          n < 30 && !(cradle.provide_offer_bech32 as jest.Mock).mock.calls.length;
          n++
        )
          await new Promise((resolve) => setTimeout(resolve, 0));
        expect(beginCreation).toHaveBeenCalledTimes(1);
        expect(cradle.provide_offer_bech32).toHaveBeenCalledWith('offer1replacement');
        await controller.flushPendingWork();
        finishOld({
          kind: 'created-reserved',
          material: { kind: 'offer', offer: 'offer1obsolete' },
          tradeId: 'old-funding',
        });
        for (let n = 0; n < 30 && !oldCancel.mock.calls.length; n++)
          await new Promise((resolve) => setTimeout(resolve, 0));
        expect(oldCancel).toHaveBeenCalledWith('old-funding');
        const postFundingBegin = jest.fn();
        const postFunding = new BlockchainPoller(
          {
            ...mockRpc,
            getWalletOfferProvider: () => ({
              capability: 'best-effort',
              scope: { provider: 'cloud', walletId: 'Wallet_after_material' },
              beginCreation: postFundingBegin,
              cancel: jest.fn(),
            }),
          } as InternalBlockchainInterface,
          60_000,
        );
        postFunding.refreshProviderReadiness();
        controller.attachBlockchain(postFunding);
        await controller.flushPendingWork();
        expect(postFundingBegin).not.toHaveBeenCalled();
        postFunding.detachProvider();
        expect(cradle.provide_offer_bech32).toHaveBeenCalledTimes(1);
        expect(storageRepository.channelFundingOperations()).toEqual([
          expect.objectContaining({
            providerReservationId: 'new-funding',
            owner: { ...owner, providerScope: scope },
          }),
        ]);
      } finally {
        finishOld({ kind: 'unavailable', reason: 'test cleanup' });
        controller.cleanup();
        replacement.detachProvider();
      }
    },
  );

  it.each(['pending', 'same-id', 'recovery-id'])(
    'funds through a reconnected original scope and protects the current reservation (%s)',
    async (mode) => {
      const sameId = mode === 'same-id';
      const reuseRecovery = mode === 'recovery-id';
      let finishOld!: (value: unknown) => void;
      let finishNew!: (value: unknown) => void;
      let finishOther!: (value: unknown) => void;
      const begin = jest
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finishOld = resolve;
            }),
        )
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finishNew = resolve;
            }),
        );
      const oldCancel = jest.fn().mockResolvedValue({ status: 'unavailable', detail: 'offline' });
      const walletRpc = reuseRecovery
        ? recoverableWalletRpc(
            jest.fn().mockResolvedValue({ kind: 'pending', recoveryId: 'reused-recovery' }),
            begin,
            oldCancel,
          )
        : bestEffortWalletRpc(begin, oldCancel);
      const { controller, blockchain, cradle } = setup(jest.fn(), walletRpc);
      cradle.provide_offer_bech32 = jest.fn(() => wasmResult());
      commitRuntime(controller, new ControlledRuntime());
      const request = canonicalizeFundingRequest({ amount: '100', fee: '0', conditions: [] });
      controller.processResult(wasmResult({ events: [{ NeedCoinSpend: request }] }));
      controller.flushDeferredWork();
      for (let n = 0; n < 30 && !begin.mock.calls.length; n++)
        await new Promise((resolve) => setTimeout(resolve, 0));
      const oldEffect = (controller as unknown as { pendingFunding: { effect: Promise<void> } })
        .pendingFunding.effect;
      const otherBegin = jest.fn(
        () =>
          new Promise((resolve) => {
            finishOther = resolve;
          }),
      );
      const other = new BlockchainPoller(
        {
          ...mockRpc,
          getWalletOfferProvider: () => ({
            capability: 'best-effort',
            scope: { provider: 'cloud', walletId: 'Wallet_in_between' },
            beginCreation: otherBegin,
            cancel: jest.fn(),
          }),
        } as InternalBlockchainInterface,
        60_000,
      );
      const reconnected = new BlockchainPoller(
        { ...mockRpc, ...walletRpc } as InternalBlockchainInterface,
        60_000,
      );
      try {
        blockchain.detachProvider();
        other.refreshProviderReadiness();
        controller.attachBlockchain(other);
        for (let n = 0; n < 30 && !otherBegin.mock.calls.length; n++)
          await new Promise((resolve) => setTimeout(resolve, 0));
        expect(otherBegin).toHaveBeenCalledTimes(1);
        other.detachProvider();
        reconnected.refreshProviderReadiness();
        controller.attachBlockchain(reconnected);
        for (let n = 0; n < 30 && begin.mock.calls.length < 2; n++)
          await new Promise((resolve) => setTimeout(resolve, 0));
        expect(begin).toHaveBeenCalledTimes(2);
        const newOutcome = {
          kind: 'created-reserved',
          material: { kind: 'offer', offer: 'offer1current' },
          tradeId: 'current-cycle',
        };
        if (sameId) {
          finishNew(newOutcome);
          await controller.flushPendingWork();
        }
        finishOld({
          kind: 'created-reserved',
          material: { kind: 'offer', offer: 'offer1obsolete' },
          tradeId: sameId ? 'current-cycle' : 'old-cycle',
        });
        await oldEffect;
        expect(oldCancel).not.toHaveBeenCalled();
        if (reuseRecovery)
          expect(storageRepository.channelFundingOperations()).toEqual([
            expect.objectContaining({ stage: 'creating', recoveryId: 'reused-recovery' }),
          ]);
        if (!sameId) {
          expect(cradle.provide_offer_bech32).not.toHaveBeenCalled();
          finishNew(newOutcome);
          await controller.flushPendingWork();
        }
        expect(cradle.provide_offer_bech32).toHaveBeenCalledTimes(1);
        expect(cradle.provide_offer_bech32).toHaveBeenCalledWith('offer1current');
        expect(storageRepository.channelFundingOperations()).toEqual([
          expect.objectContaining({ providerReservationId: 'current-cycle' }),
        ]);
      } finally {
        finishOld?.({ kind: 'unavailable', reason: 'cleanup' });
        finishNew?.({ kind: 'unavailable', reason: 'cleanup' });
        finishOther?.({ kind: 'unavailable', reason: 'cleanup' });
        controller.cleanup();
        reconnected.detachProvider();
        other.detachProvider();
      }
    },
  );

  it.each([
    {
      label: 'offer',
      outcome: {
        kind: 'created-reserved' as const,
        material: { kind: 'offer' as const, offer: 'offer1funding' },
        tradeId: 'trade-offer-funding',
      },
      callback: 'provide_offer_bech32' as const,
    },
    {
      label: 'bundle',
      outcome: {
        kind: 'created-ephemeral' as const,
        material: {
          kind: 'bundle' as const,
          bundle: testSpendBundle('bundle-funding'),
        },
      },
      callback: 'provide_coin_spend_bundle' as const,
    },
  ])(
    'delivers $label funding material while known reservations await Rust channel facts',
    async ({ outcome, callback }) => {
      const beginWalletOffer = jest.fn().mockResolvedValue(outcome);
      const { controller, cradle } = setup(jest.fn(), bestEffortWalletRpc(beginWalletOffer));
      if (callback === 'provide_offer_bech32') {
        (
          cradle as typeof cradle & {
            provide_offer_bech32: jest.Mock;
          }
        ).provide_offer_bech32 = jest.fn(() => wasmResult());
      }
      const request = canonicalizeFundingRequest({
        amount: '100',
        fee: '0',
        conditions: [{ opcode: 60n, args: ['launcher'] }],
      });
      try {
        controller.processResult(wasmResult({ events: [{ NeedCoinSpend: request }] }));
        controller.flushDeferredWork();
        commitRuntime(controller, new ControlledRuntime());
        await controller.flushPendingWork();

        expect(beginWalletOffer).toHaveBeenCalledTimes(1);
        expect(cradle[callback]).toHaveBeenCalledTimes(1);
        expect(entriesForOwner(storageRepository.channelFundingOperations(), owner)).toEqual(
          outcome.kind === 'created-reserved'
            ? [
                expect.objectContaining({
                  stage: 'awaiting-channel',
                  providerReservationId: outcome.tradeId,
                  request: { kind: 'funding', canonical: request },
                }),
              ]
            : [],
        );
        await expect(controller.quiesceAndSealForTerminalFinalization()).resolves.toMatchObject({
          coinsOfInterest: [],
        });
      } finally {
        controller.cleanup();
      }
    },
  );

  it('does not cancel recoverable funding when creation-pending notifies subscribers', async () => {
    const beginWalletOffer = jest
      .fn()
      .mockResolvedValue({ kind: 'pending', recoveryId: 'SR_notification' });
    const reconcileWalletOffer = jest.fn().mockResolvedValue({
      kind: 'created-reserved',
      material: { kind: 'bundle', bundle: testSpendBundle('recoverable-notification') },
      tradeId: 'Offer_notification',
    });
    const beginWalletOfferCancellation = jest.fn();
    const { controller, cradle } = setup(
      jest.fn(),
      recoverableWalletRpc(beginWalletOffer, reconcileWalletOffer, beginWalletOfferCancellation),
    );
    const request = canonicalizeFundingRequest({
      amount: '100',
      fee: '0',
      conditions: [{ opcode: 60n, args: ['launcher'] }],
    });
    try {
      controller.processResult(wasmResult({ events: [{ NeedCoinSpend: request }] }));
      controller.flushDeferredWork();
      commitRuntime(controller, new ControlledRuntime());
      await controller.flushPendingWork();

      expect(beginWalletOffer).toHaveBeenCalledTimes(1);
      expect(reconcileWalletOffer).toHaveBeenCalledTimes(1);
      expect(cradle.provide_coin_spend_bundle).toHaveBeenCalledTimes(1);
      expect(beginWalletOfferCancellation).not.toHaveBeenCalled();
      expect(entriesForOwner(storageRepository.channelFundingOperations(), owner)).toEqual([
        expect.objectContaining({
          stage: 'awaiting-channel',
          providerReservationId: 'Offer_notification',
        }),
      ]);
    } finally {
      controller.cleanup();
    }
  });

  it('reconciles a scoped creating operation when Rust re-emits funding intent', async () => {
    const beginWalletOffer = jest.fn();
    const reconcileWalletOffer = jest.fn().mockResolvedValue({
      kind: 'created-reserved',
      material: { kind: 'bundle', bundle: testSpendBundle('ledger-only-funding') },
      tradeId: 'Offer_ledger_only',
    });
    const { controller, cradle } = setup(
      jest.fn(),
      recoverableWalletRpc(beginWalletOffer, reconcileWalletOffer),
    );
    const request = canonicalizeFundingRequest({
      amount: '100',
      fee: '0',
      conditions: [{ opcode: 60n, args: ['launcher'] }],
    });
    installAggregateWallet([
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
    const lease = new ControlledRuntime();
    controller.processResult(wasmResult({ events: [{ NeedCoinSpend: request }] }));
    controller.flushDeferredWork();
    commitRuntime(controller, lease);
    await controller.flushPendingWork();

    expect(beginWalletOffer).not.toHaveBeenCalled();
    expect(reconcileWalletOffer).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ kind: 'funding', offer: { '1': -100n } }),
      'SR_ledger_only',
    );
    expect(cradle.provide_coin_spend_bundle).toHaveBeenCalledTimes(1);
  });

  it('reconciles one persisted Cloud creation after restore without a new NeedCoinSpend', async () => {
    const beginWalletOffer = jest
      .fn()
      .mockResolvedValue({ kind: 'pending', recoveryId: 'SR_full_reload' });
    const reconcileWalletOffer = jest
      .fn()
      .mockResolvedValueOnce({ kind: 'unavailable', reason: 'cloud disconnected' })
      .mockResolvedValueOnce({
        kind: 'created-reserved',
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
    storageRepository._replaceApplicationStateForTests({
      ...storageRepository.loadState(),
      session: activeSave().session,
      walletContext: { provider: 'cloud', walletId: 'Wallet_1' },
    });
    try {
      first.controller.processResult(wasmResult({ events: [{ NeedCoinSpend: request }] }));
      first.controller.flushDeferredWork();
      commitRuntime(first.controller, new ControlledRuntime());
      await first.controller.flushPendingWork();

      expect(beginWalletOffer).toHaveBeenCalledTimes(1);
      expect(reconcileWalletOffer).toHaveBeenCalledTimes(1);
      expect(first.cradle.provide_coin_spend_bundle).not.toHaveBeenCalled();
      expect(storageRepository.channelFundingOperations()).toEqual([
        expect.objectContaining({
          stage: 'creating',
          recoveryId: 'SR_full_reload',
        }),
      ]);
    } finally {
      first.controller.cleanup();
    }

    storageRepository._resetForTests();
    channelFundingRuntime.resetForTests();
    await storageRepository.claimApplicationState();
    const restored = setup(jest.fn(), rpcOverrides);
    try {
      commitRuntime(restored.controller, new ControlledRuntime());
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
      expect(storageRepository.channelFundingOperations()).toEqual([
        expect.objectContaining({
          stage: 'awaiting-channel',
          providerReservationId: 'Offer_full_reload',
        }),
      ]);
    } finally {
      restored.controller.cleanup();
    }
  });

  it('forgets a restored awaiting-channel reservation on typed confirmation without cancellation', async () => {
    const beginWalletOfferCancellation = jest.fn();
    const { controller } = setup(
      jest.fn(),
      bestEffortWalletRpc(undefined, beginWalletOfferCancellation),
    );
    const request = canonicalizeFundingRequest({
      amount: '100',
      fee: '0',
      conditions: [{ opcode: 60n, args: ['launcher'] }],
    });
    const purpose = { kind: 'funding' as const, operationId: fundingRequestKey(request) };
    try {
      installAggregateWallet([
        {
          providerReservationId: 'trade-restored',
          owner,
          purpose,
          stage: 'awaiting-channel',
          request: { kind: 'funding', canonical: request },
          reason: 'created-before-reload',
        },
      ]);
      commitRuntime(controller, new ControlledRuntime());
      controller.processResult(wasmResult({ events: [{ ChannelCoinConfirmed: null }] }));
      await controller.flushPendingWork();
      expect(entriesForOwner(storageRepository.channelFundingOperations(), owner)).toEqual([]);
      expect(beginWalletOfferCancellation).not.toHaveBeenCalled();
    } finally {
      controller.cleanup();
    }
  });

  it('reloads awaiting-channel funding and cancels its exact reservation once on typed timeout', async () => {
    const request = canonicalizeFundingRequest({
      amount: '100',
      fee: '0',
      conditions: [{ opcode: 60n, args: ['launcher'] }],
    });
    const purpose = { kind: 'funding' as const, operationId: fundingRequestKey(request) };
    const reserved: ChannelFundingEntry = {
      providerReservationId: 'trade-before-material-delivery',
      owner,
      purpose,
      stage: 'awaiting-channel',
      request: { kind: 'funding', canonical: request },
      reason: 'wallet-reserved-before-delivery',
    };
    const persisted = {
      ...storageRepository.loadState(),
      session: activeSave().session,
      walletContext: owner.providerScope,
      channelFundingOperations: [reserved],
      feeAttachments: [],
    };
    storageRepository._replaceApplicationStateForTests(persisted);
    await storageRepository.write(storageRepository.patchApplicationState(() => persisted));

    const durableReservation = (await storageRepository.inspect()).applicationState
      ?.channelFundingOperations[0];
    expect(durableReservation).toEqual(reserved);
    expect(durableReservation).not.toHaveProperty('material');
    expect(durableReservation).not.toHaveProperty('offer');
    expect(durableReservation).not.toHaveProperty('bundle');

    storageRepository._resetForTests();
    channelFundingRuntime.resetForTests();
    await storageRepository.claimApplicationState();
    expect(storageRepository.channelFundingOperations()).toEqual([reserved]);

    const beginWalletOfferCancellation = jest
      .fn()
      .mockResolvedValue({ status: 'cancelled' as const });
    const { controller } = setup(
      jest.fn(),
      bestEffortWalletRpc(undefined, beginWalletOfferCancellation),
    );
    try {
      commitRuntime(controller, new ControlledRuntime());
      controller.processResult(
        wasmResult({
          events: [{ ChannelCreationTimedOut: null }],
          disposition: { kind: 'terminal' },
        }),
      );
      await controller.flushPendingWork();
      await channelFundingRuntime.flush();
      expect(beginWalletOfferCancellation).toHaveBeenCalledWith('trade-before-material-delivery');
      expect(beginWalletOfferCancellation).toHaveBeenCalledTimes(1);
      expect(storageRepository.channelFundingOperations()).toEqual([]);
    } finally {
      controller.cleanup();
    }
  });

  it('does not block terminal finalization on durable cancellation cleanup', async () => {
    const { controller } = setup(jest.fn(), bestEffortWalletRpc());
    const lease = new ControlledRuntime();
    try {
      installAggregateWallet([
        {
          providerReservationId: 'trade-no-api',
          owner,
          purpose: { kind: 'funding', operationId: 'funding-operation' },
          stage: 'cancel-required',
          reason: 'funding-rejected',
        },
      ]);
      commitRuntime(controller, lease);
      await expect(controller.quiesceAndSealForTerminalFinalization()).resolves.toMatchObject({
        coinsOfInterest: [],
      });
    } finally {
      controller.cleanup();
    }
  });

  it('keeps unknown pre-ID timeout recoverable without synthesizing cancellation', async () => {
    const cancel = jest.fn();
    const request = canonicalizeFundingRequest({
      amount: '100',
      fee: '0',
      conditions: [{ opcode: 60n, args: ['launcher'] }],
    });
    installAggregateWallet([
      {
        owner,
        purpose: { kind: 'funding', operationId: fundingRequestKey(request) },
        stage: 'best-effort-uncertain',
        disposition: 'active',
        request: { kind: 'funding', canonical: request },
        lastAttemptEpoch: 1n,
        orphanRisk: 'pre-id-response-lost',
        reason: 'walletconnect-response-unavailable',
      },
    ]);
    const { controller } = setup(jest.fn(), bestEffortWalletRpc(undefined, cancel));
    try {
      commitRuntime(controller, new ControlledRuntime());
      controller.processResult(wasmResult({ events: [{ ChannelCreationTimedOut: null }] }));
      await controller.flushPendingWork();
      await channelFundingRuntime.flush();

      expect(cancel).not.toHaveBeenCalled();
      expect(entriesForOwner(storageRepository.channelFundingOperations(), owner)).toEqual([
        expect.objectContaining({
          stage: 'best-effort-uncertain',
          disposition: 'cancel-on-create',
          orphanRisk: 'pre-id-response-lost',
        }),
      ]);
    } finally {
      controller.cleanup();
    }
  });

  it('channel timeout does not mutate the fee-attachment slice', async () => {
    const funding: ChannelFundingEntry = {
      providerReservationId: 'funding-timeout',
      owner,
      purpose: { kind: 'funding', operationId: 'funding-operation' },
      stage: 'awaiting-channel',
      request: {
        kind: 'funding',
        canonical: { amount: '100', fee: '0', conditions: [] },
      },
      reason: 'material-delivered',
    };
    const fee = {
      providerReservationId: 'fee-reservation',
      owner,
      submissionId: 'submission-1',
      stage: 'reserved' as const,
      reason: 'fee-attached',
    };
    storageRepository._replaceApplicationStateForTests({
      ...storageRepository.loadState(),
      walletContext: owner.providerScope,
      channelFundingOperations: [funding],
      feeAttachments: [fee],
    });
    channelFundingRuntime.channelCreationTimedOut(owner.installationPlayerId, owner.peerSessionId);
    expect(storageRepository.feeAttachments()).toEqual([fee]);
    expect(storageRepository.channelFundingOperations()).toEqual([
      expect.objectContaining({
        providerReservationId: 'funding-timeout',
        stage: 'cancel-required',
      }),
    ]);
  });

  it('terminal retirement forgets original funding without cancelling the connected different wallet', async () => {
    const wrongCancel = jest.fn().mockResolvedValue({ status: 'cancelled' as const });
    const wrongScope = {
      provider: 'walletconnect' as const,
      fingerprint: '999',
      chainId: 'chia:testnet11',
    };
    const { controller } = setup(
      jest.fn(),
      {
        getWalletOfferProvider: () => ({
          capability: 'best-effort' as const,
          scope: wrongScope,
          beginCreation: jest.fn(),
          cancel: wrongCancel,
        }),
      },
      owner.providerScope,
    );
    const lease = new ControlledRuntime();
    try {
      installAggregateWallet([
        {
          providerReservationId: 'trade-original-wallet',
          owner,
          purpose: { kind: 'funding', operationId: 'original-wallet-funding' },
          stage: 'awaiting-channel',
          request: {
            kind: 'funding',
            canonical: { amount: '100', fee: '0', conditions: [] },
          },
          reason: 'created-before-wallet-switch',
        },
      ]);
      commitRuntime(controller, lease);

      await expect(controller.quiesceAndSealForTerminalFinalization()).resolves.toMatchObject({
        coinsOfInterest: [],
      });
      expect(wrongCancel).not.toHaveBeenCalled();
      expect(entriesForOwner(storageRepository.channelFundingOperations(), owner)).toEqual([]);
    } finally {
      controller.cleanup();
    }
  });

  it('cancels the exact reservation when Rust rejects delivered funding material', async () => {
    const cancel = jest.fn().mockResolvedValue({ status: 'cancelled' });
    const beginWalletOffer = jest.fn().mockResolvedValue({
      kind: 'created-reserved',
      material: { kind: 'offer', offer: 'offer1rejected' },
      tradeId: 'trade-rejected-material',
    });
    const { controller, cradle } = setup(jest.fn(), bestEffortWalletRpc(beginWalletOffer, cancel));
    cradle.provide_offer_bech32 = jest.fn(() => {
      throw new Error('Rust rejected funding material');
    });
    const request = canonicalizeFundingRequest({
      amount: '100',
      fee: '0',
      conditions: [{ opcode: 60n, args: ['launcher'] }],
    });
    try {
      expectConsoleError('Rust rejected funding material');
      controller.processResult(wasmResult({ events: [{ NeedCoinSpend: request }] }));
      controller.flushDeferredWork();
      commitRuntime(controller, new ControlledRuntime());
      await controller.flushPendingWork();
      await channelFundingRuntime.flush();

      expect(cancel).toHaveBeenCalledWith('trade-rejected-material');
      expect(entriesForOwner(storageRepository.channelFundingOperations(), owner)).toEqual([]);
    } finally {
      controller.cleanup();
    }
  });

  it('retains an accepted reservation when host result processing fails', async () => {
    const cancel = jest.fn().mockResolvedValue({ status: 'cancelled' });
    const beginWalletOffer = jest.fn().mockResolvedValue({
      kind: 'created-reserved',
      material: { kind: 'offer', offer: 'offer1accepted' },
      tradeId: 'trade-accepted-material',
    });
    const { controller, cradle } = setup(jest.fn(), bestEffortWalletRpc(beginWalletOffer, cancel));
    cradle.provide_offer_bech32 = jest.fn(() => wasmResult({ events: [{} as never] }));
    cradle.wallet_callback_failed = jest.fn(() => wasmResult());
    const request = canonicalizeFundingRequest({
      amount: '100',
      fee: '0',
      conditions: [{ opcode: 60n, args: ['launcher'] }],
    });
    try {
      expectConsoleError('cradle returned a malformed GameSessionEvent');
      controller.processResult(wasmResult({ events: [{ NeedCoinSpend: request }] }));
      controller.flushDeferredWork();
      commitRuntime(controller, new ControlledRuntime());
      await controller.flushPendingWork();
      await channelFundingRuntime.flush();

      expect(cancel).not.toHaveBeenCalled();
      expect(cradle.wallet_callback_failed).not.toHaveBeenCalled();
      expect(entriesForOwner(storageRepository.channelFundingOperations(), owner)).toEqual([
        expect.objectContaining({
          providerReservationId: 'trade-accepted-material',
          stage: 'awaiting-channel',
        }),
      ]);
    } finally {
      controller.cleanup();
    }
  });

  it('scopes terminal obligations by the complete owner tuple', () => {
    storageRepository._replaceApplicationStateForTests({
      ...storageRepository.loadState(),
      walletContext: owner.providerScope,
    });
    const otherPeer = { ...owner, peerSessionId: '11'.repeat(16) };
    installAwaitingChannelFunding('trade-first-session', owner, {
      kind: 'funding',
      operationId: 'same-operation',
    });
    installAwaitingChannelFunding('trade-second-session', otherPeer, {
      kind: 'funding',
      operationId: 'same-operation',
    });

    expect(
      entriesForOwner(storageRepository.channelFundingOperations(), owner).map(
        (entry) => entry.providerReservationId,
      ),
    ).toEqual(['trade-first-session']);
    expect(
      entriesForOwner(storageRepository.channelFundingOperations(), otherPeer).map(
        (entry) => entry.providerReservationId,
      ),
    ).toEqual(['trade-second-session']);
  });
});
