import 'fake-indexeddb/auto';
import type { WalletOfferProvider } from '../../types/ChiaGaming';
import { channelFundingRuntime } from '../session/channelFundingRuntime';
import { FeeAttachmentRuntime } from '../session/feeAttachmentRuntime';
import type { FeeAttachment } from '../session/feeAttachmentStore';
import { storageRepository } from '../session/storageRepository';
import { walletProviderRegistry } from '../session/walletProviderRegistry';
import { readApplicationState } from '../session/indexedDb';
import { activeSave, baseSave } from './session_save_envelope.fixtures';
import { commitRuntime, ControlledRuntime, setup } from './runtime_capability.harness';

const scope = { provider: 'walletconnect' as const, fingerprint: '123', chainId: 'chia:testnet11' };
const owner = { installationPlayerId: 'player', peerSessionId: 'session', providerScope: scope };
const fee: FeeAttachment = {
  owner,
  submissionId: 'submission',
  stage: 'retained-for-replay',
  providerReservationId: 'trade',
  reason: 'replay',
};
const ports = {
  isRetired: () => false,
  getOwner: () => owner,
  requestCommit: jest.fn(),
  reportWarning: jest.fn(),
};
const provider = (
  cancel = jest.fn().mockResolvedValue({ status: 'cancelled' }),
): WalletOfferProvider => ({
  scope,
  capability: 'best-effort',
  beginCreation: jest.fn(),
  cancel,
});
const install = (fees: FeeAttachment[] = [fee]) =>
  storageRepository._replaceApplicationStateForTests({
    ...storageRepository.loadState(),
    walletContext: scope,
    session: activeSave().session,
    feeAttachments: fees,
  });
async function waitForCall(mock: jest.Mock): Promise<void> {
  for (let attempt = 0; attempt < 30 && mock.mock.calls.length === 0; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(mock).toHaveBeenCalled();
}

async function flush() {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('wallet reservation retirement', () => {
  afterEach(() => walletProviderRegistry.clear());

  it('terminal sealing forgets fees even while original wallet cancellation is unavailable', async () => {
    const { controller } = setup(jest.fn());
    const sessionId = controller.getWasmFields()!.gameSessionId;
    let complete!: (value: { status: 'unavailable'; reason: string }) => void;
    const cancel = jest.fn(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    walletProviderRegistry.attach(provider(cancel));
    install([{ ...fee, owner: { ...owner, peerSessionId: sessionId } }]);
    commitRuntime(controller, new ControlledRuntime());
    try {
      await controller.quiesceAndSealForTerminalFinalization();
      expect(cancel).toHaveBeenCalledWith('trade');
      expect(storageRepository.feeAttachments()).toEqual([]);
      complete({ status: 'unavailable', reason: 'old wallet unreachable' });
      await flush();
      expect(storageRepository.feeAttachments()).toEqual([]);
    } finally {
      controller.cleanup();
    }
  });

  it.each(['terminal', 'none'])(
    'cold %s restore drops old cleanup without using the new account',
    async (phase) => {
      const cancel = jest.fn().mockResolvedValue({ status: 'cancelled' });
      walletProviderRegistry.attach({
        ...provider(cancel),
        scope: { ...scope, fingerprint: 'different' },
      });
      install([
        { ...fee, stage: 'cancel-required' },
        {
          owner,
          submissionId: 'pending',
          stage: 'creating',
          disposition: 'cancel-on-create',
          recoveryId: 'request',
          request: {
            kind: 'fee',
            uniqueId: 'pending',
            fee: 1n,
            concurrentSpendCoinId: '11'.repeat(32),
          },
          reason: 'pending',
        },
      ]);
      const state = storageRepository.loadState();
      await storageRepository.write({
        ...state,
        session:
          phase === 'none'
            ? null
            : baseSave({
                channelStatus: {
                  state: 'ResolvedClean',
                  advisory: null,
                  coin: null,
                  our_balance: 0n,
                  their_balance: 0n,
                  game_allocated: 0n,
                },
                coinsOfInterest: [],
              }).session,
        channelFundingOperations: [
          {
            owner,
            purpose: { kind: 'funding', operationId: 'funding' },
            stage: 'cancel-required',
            providerReservationId: 'funding-trade',
            reason: 'abandoned',
          },
        ],
      });
      storageRepository.loseAuthority('takeover');
      await storageRepository.claimApplicationState();
      expect(storageRepository.feeAttachments()).toEqual([]);
      expect(storageRepository.channelFundingOperations()).toEqual([]);
      expect(cancel).not.toHaveBeenCalled();
      expect((await readApplicationState())?.feeAttachments).toEqual([]);
    },
  );

  it('explicit discard cancels original reservations once and persists no recovery debt', async () => {
    const cancel = jest.fn().mockResolvedValue({ status: 'unavailable', reason: 'offline' });
    walletProviderRegistry.attach(provider(cancel));
    install();
    await storageRepository.clearSession();
    await flush();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect((await readApplicationState())?.feeAttachments).toEqual([]);
    walletProviderRegistry.reconnectReady(provider(cancel));
    await flush();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('session retirement preserves the checkpoint and reservations owned by another session', async () => {
    const other: FeeAttachment = {
      ...fee,
      owner: { ...owner, peerSessionId: 'other-session' },
      submissionId: 'other-submission',
      providerReservationId: 'other-trade',
    };
    install([fee, other]);
    const session = structuredClone(storageRepository.loadState().session);
    storageRepository.retireSessionWalletReservations(owner.peerSessionId);
    await storageRepository.write(structuredClone(storageRepository.loadState()));
    const saved = await readApplicationState();
    expect(saved?.session).toEqual(session);
    expect(saved?.feeAttachments).toEqual([other]);
  });

  it('ordinary controller cleanup preserves replay and does not cancel it', () => {
    const { controller } = setup(jest.fn());
    const cancel = jest.fn().mockResolvedValue({ status: 'cancelled' });
    walletProviderRegistry.attach(provider(cancel));
    install();
    controller.cleanup();
    expect(storageRepository.feeAttachments()).toEqual([fee]);
    expect(cancel).not.toHaveBeenCalled();
  });

  it('retired identified creation uses exact recovery without creating a replacement offer', async () => {
    const reconcileCreation = jest.fn().mockResolvedValue({
      kind: 'created-reserved',
      material: { kind: 'offer', offer: 'offer1' },
      tradeId: 'identified-trade',
    });
    const beginCancellation = jest.fn().mockResolvedValue({ status: 'cancelled' });
    const original: WalletOfferProvider = {
      scope,
      capability: 'recoverable-after-begin',
      beginCreation: jest.fn(),
      reconcileCreation,
      beginCancellation,
      reconcileCancellation: jest.fn(),
    };
    walletProviderRegistry.attach(original);
    install([
      {
        owner,
        submissionId: 'pending',
        stage: 'creating',
        disposition: 'cancel-on-create',
        recoveryId: 'exact-request',
        request: {
          kind: 'fee',
          uniqueId: 'pending',
          fee: 1n,
          concurrentSpendCoinId: '11'.repeat(32),
        },
        reason: 'pending',
      },
    ]);
    await storageRepository.clearSession();
    await flush();
    expect(reconcileCreation).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'exact-request',
    );
    expect(original.beginCreation).not.toHaveBeenCalled();
    expect(beginCancellation).toHaveBeenCalledWith('identified-trade');
    expect(storageRepository.feeAttachments()).toEqual([]);
  });

  it('late uncertainty replacement cannot recreate a retired funding operation', async () => {
    let complete!: (value: unknown) => void;
    const beginCreation = jest.fn(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const cancel = jest.fn().mockResolvedValue({ status: 'unavailable', reason: 'offline' });
    install([]);
    storageRepository.replaceChannelFunding([
      {
        owner,
        purpose: { kind: 'funding', operationId: 'funding' },
        stage: 'best-effort-uncertain',
        disposition: 'active',
        request: { kind: 'funding', canonical: { amount: '100', fee: '0', conditions: [] } },
        lastAttemptEpoch: 0n,
        reason: 'lost response',
      },
    ]);
    channelFundingRuntime.attachProvider({
      scope,
      capability: 'best-effort',
      beginCreation,
      cancel,
    });
    await waitForCall(beginCreation);
    expect(beginCreation).toHaveBeenCalledTimes(1);
    storageRepository.retireSessionWalletReservations(owner.peerSessionId);
    complete({
      kind: 'created-reserved',
      material: { kind: 'offer', offer: 'late-offer' },
      tradeId: 'late-trade',
    });
    await channelFundingRuntime.flush();
    await flush();
    expect(cancel).toHaveBeenCalledWith('late-trade');
    expect(storageRepository.channelFundingOperations()).toEqual([]);
  });

  it('late funding cancellation cannot recreate explicitly retired debt', async () => {
    let complete!: (value: { status: 'unavailable'; reason: string }) => void;
    const beginCancellation = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
      )
      .mockResolvedValue({ status: 'unavailable', reason: 'offline' });
    const original: WalletOfferProvider = {
      scope,
      capability: 'recoverable-after-begin',
      beginCreation: jest.fn(),
      reconcileCreation: jest.fn(),
      beginCancellation,
      reconcileCancellation: jest.fn(),
    };
    channelFundingRuntime.attachProvider(original);
    install([]);
    storageRepository.replaceChannelFunding([
      {
        owner,
        purpose: { kind: 'funding', operationId: 'funding' },
        stage: 'cancel-required',
        providerReservationId: 'funding-trade',
        reason: 'cancel',
      },
    ]);
    channelFundingRuntime.retryCancelRequired(owner);
    await waitForCall(beginCancellation);
    storageRepository.retireSessionWalletReservations(owner.peerSessionId);
    complete({ status: 'unavailable', reason: 'offline' });
    await channelFundingRuntime.flush();
    expect(storageRepository.channelFundingOperations()).toEqual([]);
  });

  it.each([
    { engine: 'funding', status: 'unavailable' },
    { engine: 'fee', status: 'unavailable' },
    { engine: 'fee', status: 'cancelled' },
  ])(
    'old $engine cancellation $status cannot replace a fresh active reservation with the same ID',
    async ({ engine, status }) => {
      let complete!: (value: unknown) => void;
      const beginCancellation = jest.fn(
        () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
      );
      const original: WalletOfferProvider = {
        scope,
        capability: 'recoverable-after-begin',
        beginCreation: jest.fn(),
        reconcileCreation: jest.fn(),
        beginCancellation,
        reconcileCancellation: jest.fn(),
      };
      channelFundingRuntime.attachProvider(original);
      install(engine === 'fee' ? [fee] : []);
      const runtime = engine === 'fee' ? new FeeAttachmentRuntime(ports) : null;
      const funding = {
        owner,
        purpose: { kind: 'funding' as const, operationId: 'funding' },
        providerReservationId: 'trade',
        reason: 'old cancellation',
      };
      if (runtime) runtime.cancel(owner, 'submission', 'old');
      else {
        storageRepository.replaceChannelFunding([{ ...funding, stage: 'cancel-required' }]);
        channelFundingRuntime.retryCancelRequired(owner);
      }
      await waitForCall(beginCancellation);
      expect(beginCancellation).toHaveBeenCalledTimes(1);
      const newFee: FeeAttachment = { ...fee, reason: 'fresh replay source' };
      const newFunding = {
        ...funding,
        stage: 'awaiting-channel' as const,
        request: {
          kind: 'funding' as const,
          canonical: { amount: '100', fee: '0', conditions: [] },
        },
        reason: 'fresh funding source',
      };
      if (runtime) storageRepository.replaceFeeAttachments([newFee]);
      else storageRepository.replaceChannelFunding([newFunding]);
      complete(status === 'cancelled' ? { status } : { status, reason: 'offline' });
      if (runtime) await runtime.awaitIdle();
      else await channelFundingRuntime.flush();
      expect(
        runtime ? storageRepository.feeAttachments() : storageRepository.channelFundingOperations(),
      ).toEqual([runtime ? newFee : newFunding]);
      runtime?.detach();
    },
  );

  it('an in-flight unavailable cancellation cannot recreate explicitly retired debt', async () => {
    let complete!: (value: { status: 'unavailable'; reason: string }) => void;
    const beginCancellation = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
      )
      .mockResolvedValue({ status: 'unavailable', reason: 'offline' });
    const original: WalletOfferProvider = {
      scope,
      capability: 'recoverable-after-begin',
      beginCreation: jest.fn(),
      reconcileCreation: jest.fn(),
      beginCancellation,
      reconcileCancellation: jest.fn(),
    };
    walletProviderRegistry.attach(original);
    install();
    const runtime = new FeeAttachmentRuntime(ports);
    runtime.cancel(owner, 'submission', 'discard');
    await waitForCall(beginCancellation);
    storageRepository.retireSessionWalletReservations(owner.peerSessionId);
    complete({ status: 'unavailable', reason: 'offline' });
    await runtime.awaitIdle();
    expect(storageRepository.feeAttachments()).toEqual([]);
    runtime.detach();
  });
});
