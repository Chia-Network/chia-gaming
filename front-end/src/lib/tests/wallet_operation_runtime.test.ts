import { BlockchainPoller } from '../../hooks/BlockchainPoller';
import { SessionController } from '../../hooks/SessionController';
import { canonicalizeFundingRequest, fundingRequestKey } from '../session/fundingRequest';
import { WalletOperationRuntime, walletOperationRuntime } from '../session/walletOperationRuntime';
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

describe('durable wallet operation record', () => {
  const owner = {
    installationPlayerId: 'submission-handoff',
    peerSessionId: '00'.repeat(16),
    providerScope: { provider: 'simulator' as const, identity: 'submission-handoff' },
  };

  beforeEach(() => walletOperationRuntime.resetForTests());

  it('keeps a Rust funding request idle until an adapter establishes scope', async () => {
    const controller = new SessionController(
      null,
      'submission-handoff',
      100n,
      100n,
      makePeerConn([], []),
      walletOperationRuntime,
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
    'consumes the durable $label funding reservation and permits terminal quiescence',
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
        expect(walletOperationRuntime.entriesFor(owner)).toEqual([]);
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
      expect(walletOperationRuntime.entriesFor(owner)).toEqual([]);
    } finally {
      controller.cleanup();
    }
  });

  it('keeps a failed independent write dirty and recovers on a later checkpoint', async () => {
    const ledger = new WalletOperationRuntime();
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
    walletOperationRuntime.restore([
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
    const persistedLedgers: unknown[][] = [];
    walletOperationRuntime.configurePersistence(async (entries) => {
      persistedLedgers.push(structuredClone(entries));
    });
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
    let persistedLedger!: ReturnType<typeof walletOperationRuntime.snapshot>;
    try {
      first.controller.processResult(wasmResult({ events: [{ NeedCoinSpend: request }] }));
      first.controller.flushDeferredWork();
      commitRuntime(first.controller, new ControlledRuntime());
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
      persistedLedger = walletOperationRuntime.snapshot();
    } finally {
      first.controller.cleanup();
    }

    walletOperationRuntime.resetForTests();
    walletOperationRuntime.restore(persistedLedger);
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
      expect(walletOperationRuntime.entriesFor(owner)).toEqual([]);
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
      kind: 'created-ephemeral',
      material: { kind: 'bundle', bundle: testSpendBundle('restored-funding') },
    });
    const { controller } = setup(jest.fn(), { beginWalletOffer, beginWalletOfferCancellation });
    const lease = new ControlledRuntime();
    const request = canonicalizeFundingRequest({
      amount: '100',
      fee: '0',
      conditions: [{ opcode: 60n, args: ['launcher'] }],
    });
    const purpose = { kind: 'funding' as const, operationId: fundingRequestKey(request) };
    try {
      controller.processResult(wasmResult({ events: [{ NeedCoinSpend: request }] }));
      controller.flushDeferredWork();
      walletOperationRuntime.restore([
        {
          tradeId: 'trade-restored',
          owner,
          purpose,
          stage: 'reserved',
          reason: 'created-before-reload',
        },
      ]);
      commitRuntime(controller, lease);
      for (let i = 0; i < 20 && beginWalletOfferCancellation.mock.calls.length === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      expect(beginWalletOffer).not.toHaveBeenCalled();

      expect(beginWalletOfferCancellation).toHaveBeenCalledTimes(1);
      finishCancel();
      await walletOperationRuntime.awaitOwner(owner);
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
      walletOperationRuntime.restore([
        {
          tradeId: 'trade-reconnect',
          owner,
          purpose,
          stage: 'cancel-required',
          reason: 'wallet-outcome-finalized',
        },
      ]);
      await walletOperationRuntime.awaitOwner(owner);
      expect(beginWalletOfferCancellation).toHaveBeenCalledTimes(1);
      expect(walletOperationRuntime.entriesFor(owner)).toHaveLength(1);

      await Promise.resolve();
      expect(beginWalletOfferCancellation).toHaveBeenCalledTimes(1);
      beginWalletOfferCancellation.mockResolvedValue({ status: 'cancelled' });
      controller.attachBlockchain(blockchain);
      await walletOperationRuntime.awaitOwner(owner);
      expect(beginWalletOfferCancellation).toHaveBeenCalledTimes(2);
      expect(walletOperationRuntime.entriesFor(owner)).toEqual([]);
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
      walletOperationRuntime.restore([
        {
          tradeId: 'trade-spent',
          owner,
          purpose: { kind: 'fee', operationId: 'spent-submission' },
          stage: 'cancel-required',
          reason: 'wallet-outcome-finalized',
        },
      ]);
      await walletOperationRuntime.awaitOwner(owner);
      expect(walletOperationRuntime.entriesFor(owner)).toEqual([]);
    } finally {
      controller.cleanup();
    }
  });

  it('keeps terminal teardown blocked after a typed nonterminal cancellation outcome', async () => {
    const beginWalletOfferCancellation = jest
      .fn()
      .mockResolvedValue({ status: 'rejected', detail: 'wallet refused cancellation' });
    const { controller } = setup(jest.fn(), { beginWalletOfferCancellation });
    const lease = new ControlledRuntime();
    try {
      walletOperationRuntime.restore([
        {
          tradeId: 'trade-rejected',
          owner,
          purpose: { kind: 'fee', operationId: 'rejected-submission' },
          stage: 'cancel-required',
          reason: 'wallet-outcome-finalized',
        },
      ]);
      commitRuntime(controller, lease);

      await expect(controller.quiesceForTerminalFinalization()).rejects.toMatchObject({
        code: 'WALLET_OFFER_CLEANUP_PENDING',
      });
      expect(beginWalletOfferCancellation).toHaveBeenCalledTimes(1);
      expect(walletOperationRuntime.entriesFor(owner)).toEqual([
        expect.objectContaining({ tradeId: 'trade-rejected', stage: 'cancel-required' }),
      ]);
    } finally {
      controller.cleanup();
    }
  });

  it('keeps terminal teardown blocked when cancellation API is missing', async () => {
    const { controller } = setup(jest.fn(), { beginWalletOfferCancellation: undefined });
    const lease = new ControlledRuntime();
    try {
      walletOperationRuntime.restore([
        {
          tradeId: 'trade-no-api',
          owner,
          purpose: { kind: 'funding', operationId: 'funding-operation' },
          stage: 'cancel-required',
          reason: 'funding-rejected',
        },
      ]);
      commitRuntime(controller, lease);
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
      walletOperationRuntime.restore([
        {
          tradeId: 'trade-original-wallet',
          owner,
          purpose: { kind: 'funding', operationId: 'original-wallet-funding' },
          stage: 'reserved',
          reason: 'created-before-wallet-switch',
        },
      ]);
      commitRuntime(controller, lease);

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
      expect(walletOperationRuntime.entriesFor(owner)).toHaveLength(1);
    } finally {
      controller.cleanup();
    }
  });

  it('allows stale cleanup and a newer active trade for one stable operation', () => {
    const purpose = { kind: 'funding' as const, operationId: 'conflicted-operation' };
    walletOperationRuntime.registerReserved('trade-retry', owner, purpose);
    walletOperationRuntime.registerReserved('trade-stale', owner, purpose);
    walletOperationRuntime.settleTrade(
      'trade-stale',
      'cancel-required',
      'stale-createOffer-result',
    );

    expect(walletOperationRuntime.entriesFor(owner)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tradeId: 'trade-retry', stage: 'reserved' }),
        expect.objectContaining({ tradeId: 'trade-stale', stage: 'cancel-required' }),
      ]),
    );
  });

  it('scopes terminal obligations by the complete owner tuple', () => {
    const otherPeer = { ...owner, peerSessionId: '11'.repeat(16) };
    walletOperationRuntime.registerReserved('trade-first-session', owner, {
      kind: 'funding',
      operationId: 'same-operation',
    });
    walletOperationRuntime.registerReserved('trade-second-session', otherPeer, {
      kind: 'funding',
      operationId: 'same-operation',
    });

    expect(walletOperationRuntime.entriesFor(owner).map((entry) => entry.tradeId)).toEqual([
      'trade-first-session',
    ]);
    expect(walletOperationRuntime.entriesFor(otherPeer).map((entry) => entry.tradeId)).toEqual([
      'trade-second-session',
    ]);
  });
});
