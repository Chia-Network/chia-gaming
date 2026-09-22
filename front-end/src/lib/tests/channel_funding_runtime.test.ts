import { expectConsoleError } from '../../../scripts/testSetup';
import { BlockchainPoller } from '../../hooks/BlockchainPoller';
import { SessionController } from '../../hooks/SessionController';
import { canonicalizeFundingRequest, fundingRequestKey } from '../session/fundingRequest';
import { channelFundingRuntime } from '../session/channelFundingRuntime';
import type { InternalBlockchainInterface } from '../../types/ChiaGaming';
import {
  makeMockCradle,
  makePeerConn,
  mockRpc,
  mockWasmConnection,
  testSpendBundle,
  wasmResult,
} from './message_protocol.harness';
import { commitRuntime, ControlledRuntime, setup } from './runtime_capability.harness';
import { storageRepository } from '../session/storageRepository';
import type { ChannelFundingEntry } from '../session/channelFundingStore';
import { entriesForOwner } from '../session/channelFundingSelectors';
import { installAwaitingChannelFunding } from './channel_funding_test_helpers';

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
      { ...mockRpc, beginWalletOffer } as InternalBlockchainInterface,
      60_000,
    );
    controller.attachBlockchain(blockchain);
    await controller.flushPendingWork();

    expect(beginWalletOffer).toHaveBeenCalledTimes(1);
    expect(cradle.provide_coin_spend_bundle).toHaveBeenCalledTimes(1);
    controller.cleanup();
  });

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
      const { controller, cradle } = setup(jest.fn(), { beginWalletOffer });
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
        await expect(controller.quiesceForTerminalFinalization()).resolves.toMatchObject({
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
    const { controller, cradle } = setup(jest.fn(), {
      beginWalletOffer,
      reconcileWalletOffer,
      beginWalletOfferCancellation,
    });
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
    const { controller, cradle } = setup(jest.fn(), {
      beginWalletOffer,
      reconcileWalletOffer,
    });
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
    const { controller } = setup(jest.fn(), { beginWalletOfferCancellation });
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
      walletContext: owner.providerScope,
      channelFundingOperations: [reserved],
      feeAttachments: [],
    };
    storageRepository._replaceApplicationStateForTests(persisted);
    await storageRepository.checkpointApplicationState(persisted);

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
    const { controller } = setup(jest.fn(), { beginWalletOfferCancellation });
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
    const { controller } = setup(jest.fn(), { beginWalletOfferCancellation: undefined });
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
      await expect(controller.quiesceForTerminalFinalization()).resolves.toMatchObject({
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
    const { controller } = setup(jest.fn(), { beginWalletOfferCancellation: cancel });
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

  it('does not broadly cancel awaiting funding during terminal cleanup or wallet mismatch', async () => {
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

      await expect(controller.quiesceForTerminalFinalization()).resolves.toMatchObject({
        coinsOfInterest: [],
      });
      expect(wrongCancel).not.toHaveBeenCalled();
      expect(entriesForOwner(storageRepository.channelFundingOperations(), owner)).toEqual([
        expect.objectContaining({
          providerReservationId: 'trade-original-wallet',
          stage: 'awaiting-channel',
        }),
      ]);
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
    const { controller, cradle } = setup(jest.fn(), {
      beginWalletOffer,
      beginWalletOfferCancellation: cancel,
    });
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
    const { controller, cradle } = setup(jest.fn(), {
      beginWalletOffer,
      beginWalletOfferCancellation: cancel,
    });
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
