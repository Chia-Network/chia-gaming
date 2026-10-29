import { observeWasmEvents } from './session_execution.harness';
import { expectConsoleError } from '../../../scripts/testSetup';
import type { ChiaGame, InternalBlockchainInterface } from '../../types/ChiaGaming';
import { channelFundingRuntime } from '../session/channelFundingRuntime';
import { rewriteFeeRateRejection, SessionController } from '../session/SessionController';
import { createSessionController } from '../session/sessionHost';
import { BlockchainPoller } from '../wallet/BlockchainPoller';
import { pollOnce } from './blockchain_poller.driver';
import {
  attachTestCommitCoordinator,
  channelStatus,
  createReadyBlob,
  makeMockCradle,
  makePeerConn,
  mockBlockchain,
  mockRpc,
  mockWasmConnection,
  setActiveBlob,
  submissionDrain,
  submitTransaction,
  testSpendBundle,
  transactionSubmitQueue,
  wasmResult,
} from './message_protocol.harness';

describe('terminal protocol cleanup', () => {
  // Reliable terminal handoff permutations are covered by peer_session::session::tests.
  it('replaces queued presentation work with terminal notifications', () => {
    const sentMessages: Array<{ msgno: number; msg: Uint8Array }> = [];
    const sentAcks: number[] = [];
    const blob = new SessionController(
      mockBlockchain,
      'test',
      100n,
      100n,
      makePeerConn(sentMessages, sentAcks),
    );
    setActiveBlob(blob);
    const cradle = makeMockCradle();
    blob.loadWasm(mockWasmConnection);
    blob.setGameSession(cradle);

    blob.processResult({
      ...wasmResult(),
      events: [{ Notification: { ChannelStatus: channelStatus({ state: 'Active' }) } }],
    });
    blob.processResult({
      ...wasmResult(),
      disposition: { kind: 'terminal' },
      events: [
        {
          Notification: {
            ChannelStatus: channelStatus({
              state: 'Active',
              session_disposition: 'Abandoned',
            }),
          },
        },
      ],
    });

    expect(sentMessages).toEqual([]);
    expect((blob as any).lastChannelStatus).toMatchObject({
      state: 'Active',
      session_disposition: 'Abandoned',
    });

    blob.processResult({
      ...wasmResult(),
      events: [{ Notification: { ChannelStatus: channelStatus({ state: 'Active' }) } }],
      watchCoins: [{ coin_name: 'late', coin_string: 'late-coin' }],
    });

    expect((blob as any).lastChannelStatus).toMatchObject({
      state: 'Active',
      session_disposition: 'Abandoned',
    });
  });

  it('persists canonical timeout-submission channel progress from WASM', async () => {
    const { blob } = createReadyBlob();
    blob.processResult({
      ...wasmResult(),
      events: [
        {
          Notification: {
            ChannelStatus: channelStatus({
              state: 'Unrolling',
              unroll_initiator: 'opponent',
              semantic_phase: 'finishing_spending',
            }),
          },
        },
      ],
    });
    await blob.flushPendingWork();

    expect((blob as any).lastChannelStatus).toMatchObject({
      state: 'Unrolling',
      unroll_initiator: 'opponent',
      semantic_phase: 'finishing_spending',
    });
  });
});

describe('transaction submission', () => {
  it('publishes controller nerfs through the ordered session event pipe', () => {
    const sentMessages: Array<{ msgno: number; msg: Uint8Array }> = [];
    const sentAcks: number[] = [];
    const updates: boolean[] = [];
    const blob = createSessionController(
      null,
      makePeerConn(sentMessages, sentAcks),
      'test',
      100n,
      100n,
      true,
    );

    const unsubscribe = blob.frontend.subscribe((event) => {
      if (event.type === 'publishing-policy') updates.push(event.nerfed);
    });
    blob.nerf();
    expect(blob.isTransactionPublishNerfed()).toBe(true);
    blob.setTransactionPublishNerfed(false);
    expect(blob.isTransactionPublishNerfed()).toBe(false);
    expect(updates).toEqual([true, false]);

    unsubscribe();
    blob.cleanup();
  });

  it('drops queued publishes after nerfing and resumes newly queued publishes when re-enabled', async () => {
    const spend = jest.fn().mockResolvedValue({ status: 'acknowledged' });
    const blockchain = new BlockchainPoller(
      {
        ...mockRpc,
        spend,
      } as InternalBlockchainInterface,
      60000,
    );
    const sentMessages: Array<{ msgno: number; msg: Uint8Array }> = [];
    const sentAcks: number[] = [];
    const blob = new SessionController(
      blockchain,
      'test',
      100n,
      100n,
      makePeerConn(sentMessages, sentAcks),
    );
    setActiveBlob(blob);
    blob.loadWasm(mockWasmConnection);
    blob.setGameSession(makeMockCradle());

    submitTransaction(blob, testSpendBundle('07'));
    blob.setTransactionPublishNerfed(true);
    await transactionSubmitQueue(blob);
    expect(spend).not.toHaveBeenCalled();

    blob.setTransactionPublishNerfed(false);
    submitTransaction(blob, testSpendBundle('08'));
    await transactionSubmitQueue(blob);
    expect(spend).toHaveBeenCalledTimes(1);
  });

  it('drops queued publishes after controller cleanup without cancelling an in-flight publish', async () => {
    let resolveFirst: (() => void) | null = null;
    let markFirstStarted: (() => void) | null = null;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const spend = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = () => resolve({ status: 'acknowledged' });
            markFirstStarted?.();
          }),
      )
      .mockResolvedValue({ status: 'acknowledged' });
    const blockchain = new BlockchainPoller(
      {
        ...mockRpc,
        spend,
      } as InternalBlockchainInterface,
      60000,
    );
    const sentMessages: Array<{ msgno: number; msg: Uint8Array }> = [];
    const sentAcks: number[] = [];
    const blob = new SessionController(
      blockchain,
      'test',
      100n,
      100n,
      makePeerConn(sentMessages, sentAcks),
    );
    setActiveBlob(blob);
    blob.loadWasm(mockWasmConnection);
    blob.setGameSession(makeMockCradle());

    submitTransaction(blob, testSpendBundle('09'));
    submitTransaction(blob, testSpendBundle('0a'));
    await firstStarted;
    expect(spend).toHaveBeenCalledTimes(1);

    blob.cleanup();
    resolveFirst?.();
    await transactionSubmitQueue(blob);
    expect(spend).toHaveBeenCalledTimes(1);
    setActiveBlob(null);
  });

  it('applies watch and unwatch deltas without resampling the cradle snapshot', async () => {
    const queriedNames: string[][] = [];
    const blockchain = new BlockchainPoller(
      new Proxy(
        {
          getHeightInfo: () => Promise.resolve(1n),
          getWalletOfferProvider: () => null,
          registerCoins: () => Promise.resolve(),
          getCoinRecordsByNames: (names: string[]) => {
            queriedNames.push(names);
            return Promise.resolve([]);
          },
        } as unknown as InternalBlockchainInterface,
        {
          get: (target, prop) =>
            (target as Record<string, unknown>)[prop as string] ??
            (() => Promise.resolve(undefined)),
        },
      ),
      60000,
    );
    const sentMessages: Array<{ msgno: number; msg: Uint8Array }> = [];
    const sentAcks: number[] = [];
    const blob = new SessionController(
      blockchain,
      'test',
      100n,
      100n,
      makePeerConn(sentMessages, sentAcks),
    );
    setActiveBlob(blob);
    const cradle = makeMockCradle();

    blob.loadWasm(mockWasmConnection);
    blob.setGameSession(cradle);
    blob.attachBlockchain(blockchain);
    (cradle.snapshot_watched_coins as jest.Mock).mockClear();

    blob.processResult({
      ...wasmResult(),
      events: [],
      watchCoins: [{ coin_name: 'aa', coin_string: 'coin-a' }],
    });
    await pollOnce(blockchain);

    expect(cradle.snapshot_watched_coins).not.toHaveBeenCalled();
    expect(queriedNames).toEqual([['aa']]);

    blob.processResult({
      ...wasmResult(),
      events: [],
      unwatchCoins: [{ coin_name: 'aa', coin_string: 'coin-a' }],
    });
    await pollOnce(blockchain);

    expect(cradle.snapshot_watched_coins).not.toHaveBeenCalled();
    expect(queriedNames).toEqual([['aa']]);
    blob.detachBlockchain(blockchain);
  });

  it('refreshes watched coins when a hydrated cradle receives a later blockchain attach', async () => {
    const queriedNames: string[][] = [];
    const blockchain = new BlockchainPoller(
      new Proxy(
        {
          getHeightInfo: () => Promise.resolve(1n),
          getWalletOfferProvider: () => null,
          registerCoins: () => Promise.resolve(),
          getCoinRecordsByNames: (names: string[]) => {
            queriedNames.push(names);
            return Promise.resolve([]);
          },
        } as unknown as InternalBlockchainInterface,
        {
          get: (target, prop) =>
            (target as Record<string, unknown>)[prop as string] ??
            (() => Promise.resolve(undefined)),
        },
      ),
      60000,
    );
    const sentMessages: Array<{ msgno: number; msg: Uint8Array }> = [];
    const sentAcks: number[] = [];
    const blob = new SessionController(
      null,
      'test',
      100n,
      100n,
      makePeerConn(sentMessages, sentAcks),
      channelFundingRuntime,
    );
    setActiveBlob(blob);
    const cradle = {
      ...makeMockCradle(),
      snapshot_watched_coins: jest.fn(() => [{ coin_name: 'bb', coin_string: 'coin-b' }]),
    } as unknown as ChiaGame;

    blob.loadWasm(mockWasmConnection);
    blob.setGameSession(cradle);
    expect(queriedNames).toEqual([]);

    blob.attachBlockchain(blockchain);
    await pollOnce(blockchain);

    expect(cradle.snapshot_watched_coins).toHaveBeenCalledTimes(1);
    expect(queriedNames).toEqual([['bb']]);

    blob.attachBlockchain(blockchain);
    expect(cradle.snapshot_watched_coins).toHaveBeenCalledTimes(2);
    blob.detachBlockchain(blockchain);
  });

  it('hydrates without blockchain and replays retained submissions on later attach', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const spend = jest.fn().mockResolvedValue({ status: 'acknowledged' });
    const blockchain = new BlockchainPoller(
      {
        ...mockRpc,
        spend,
        isConnected: () => true,
        isReadyForPlay: () => true,
        getHeightInfo: () => Promise.resolve(1n),
        registerCoins: () => Promise.resolve(),
        getCoinRecordsByNames: () => Promise.resolve([]),
      } as InternalBlockchainInterface,
      60000,
    );
    const sentMessages: Array<{ msgno: number; msg: Uint8Array }> = [];
    const sentAcks: number[] = [];
    const blob = new SessionController(
      null,
      'test',
      100n,
      100n,
      makePeerConn(sentMessages, sentAcks),
      channelFundingRuntime,
    );
    setActiveBlob(blob);
    blob.rewardPuzzleHash = '11'.repeat(32);
    const cradle = {
      ...makeMockCradle(),
      snapshot_watched_coins: jest.fn(() => [{ coin_name: 'cc', coin_string: 'coin-c' }]),
      drain_submissions: jest
        .fn()
        .mockReturnValueOnce(
          submissionDrain([{ id: '5', bundle: testSpendBundle('05'), fee_request: null }]),
        )
        .mockReturnValue(submissionDrain()),
    } as unknown as ChiaGame;

    blob.loadWasm(mockWasmConnection);
    blob.setGameSession(cradle);
    blob.processResult(wasmResult());

    expect(cradle.drain_submissions).toHaveBeenCalledTimes(1);
    expect(spend).not.toHaveBeenCalled();

    blob.attachBlockchain(blockchain);
    await pollOnce(blockchain);
    await transactionSubmitQueue(blob);

    expect(cradle.chain_snapshot_ready).toHaveBeenCalledTimes(1);
    expect(cradle.drain_submissions).toHaveBeenCalledTimes(5);
    expect(spend).toHaveBeenCalledTimes(1);
    blob.detachBlockchain(blockchain);
    errorSpy.mockRestore();
  });

  it('keeps a global drain invariant failure fatal without a blockchain', () => {
    const blob = new SessionController(
      null,
      'test',
      100n,
      100n,
      makePeerConn([], []),
      channelFundingRuntime,
    );
    attachTestCommitCoordinator(blob);
    const recoverableErrors: string[] = [];
    observeWasmEvents(blob).subscribe((event) => {
      if (event.type === 'recoverable-internal-error') recoverableErrors.push(event.error);
    });
    const cradle = {
      ...makeMockCradle(),
      drain_submissions: jest.fn(() => {
        throw new Error('transaction submission drain invariant failed');
      }),
    } as unknown as ChiaGame;

    blob.loadWasm(mockWasmConnection);
    blob.setGameSession(cradle);
    expect(() => blob.processResult(wasmResult())).toThrow(
      'transaction submission drain invariant failed',
    );

    expect(cradle.drain_submissions).toHaveBeenCalledTimes(1);
    expect(recoverableErrors).toEqual([]);
    blob.cleanup();
  });

  it('waits for the restored manager coin snapshot before resubmitting after early attach', () => {
    const blockchain = new BlockchainPoller(mockRpc, 60000);
    const sentMessages: Array<{ msgno: number; msg: Uint8Array }> = [];
    const sentAcks: number[] = [];
    const blob = new SessionController(
      null,
      'test',
      100n,
      100n,
      makePeerConn(sentMessages, sentAcks),
      channelFundingRuntime,
    );
    setActiveBlob(blob);
    const cradle = {
      ...makeMockCradle(),
      snapshot_watched_coins: jest.fn(() => [
        { coin_name: 'restored', coin_string: 'coin-restored' },
      ]),
    } as unknown as ChiaGame;

    blob.loadWasm(mockWasmConnection);
    // Blockchain attachment can complete while restore is still deserializing
    // the cradle, so this height must remain buffered.
    blob.attachBlockchain(blockchain);
    blob.reportNewBlock(1n);
    blob.setGameSession(cradle);

    expect(cradle.report_height).toHaveBeenCalledWith(1n);
    expect(cradle.chain_snapshot_ready).not.toHaveBeenCalled();

    blob.reportCoinStates(1n, []);
    blob.reportChainSnapshotReady(1n);

    expect(cradle.chain_snapshot_ready).toHaveBeenCalledTimes(1);
    blob.detachBlockchain(blockchain);
  });

  it('uses height-only sync to resubmit only restored sessions with no watches', () => {
    const blockchain = new BlockchainPoller(mockRpc, 60000);
    const sentMessages: Array<{ msgno: number; msg: Uint8Array }> = [];
    const sentAcks: number[] = [];
    const blob = new SessionController(
      null,
      'test',
      100n,
      100n,
      makePeerConn(sentMessages, sentAcks),
      channelFundingRuntime,
    );
    setActiveBlob(blob);
    const cradle = makeMockCradle();

    blob.loadWasm(mockWasmConnection);
    blob.attachBlockchain(blockchain);
    blob.reportNewBlock(1n);
    blob.setGameSession(cradle);
    blob.reportChainSnapshotReady(1n);

    expect(cradle.chain_snapshot_ready).toHaveBeenCalledTimes(1);
    blob.detachBlockchain(blockchain);
  });

  it('suppresses a same-stack fresh-sync duplicate while its submission is queued', async () => {
    const beginWalletOffer = jest.fn().mockResolvedValue({
      kind: 'created-reserved',
      material: {
        kind: 'bundle',
        bundle: { coin_spends: [], aggregated_signature: '0x' },
      },
    });
    const spend = jest.fn().mockResolvedValue({ status: 'acknowledged' });
    const blockchain = new BlockchainPoller(
      {
        ...mockRpc,
        beginWalletOffer,
        spend,
        isReadyForPlay: () => true,
      } as InternalBlockchainInterface,
      60000,
    );
    const blob = new SessionController(
      null,
      'test',
      100n,
      100n,
      makePeerConn([], []),
      channelFundingRuntime,
    );
    attachTestCommitCoordinator(blob);
    blob.rewardPuzzleHash = '11'.repeat(32);
    const submission = {
      id: 'same-id',
      bundle: testSpendBundle('01'),
      fee_request: { target: '22'.repeat(32), amount: '10' },
    };
    const finalizeSubmission = jest.fn(() => ({
      protocol_bundle: testSpendBundle('01'),
      bundle: {},
      applied_fee: '10',
      warning: null,
      fee_source_disposition: 'attached',
      variant_fingerprint: 'bb'.repeat(32),
      should_broadcast: true,
    }));
    const cradle = {
      ...makeMockCradle(),
      drain_submissions: jest
        .fn()
        .mockReturnValueOnce(submissionDrain([submission]))
        .mockReturnValueOnce(submissionDrain([submission]))
        .mockReturnValue(submissionDrain()),
      finalize_submission_attempt: finalizeSubmission,
    } as unknown as ChiaGame;

    blob.loadWasm(mockWasmConnection);
    blob.setGameSession(cradle);
    blob.attachBlockchain(blockchain);

    // report_coin_states queues the first copy in processResult, then the
    // fresh-sync resubmit drains the same retained ID before promise jobs run.
    blob.reportCoinStates(1n, []);
    blob.reportChainSnapshotReady(1n);
    await transactionSubmitQueue(blob);

    expect(cradle.chain_snapshot_ready).toHaveBeenCalledTimes(1);
    expect(beginWalletOffer).toHaveBeenCalledTimes(1);
    expect(finalizeSubmission).toHaveBeenCalledTimes(1);
    expect(spend).toHaveBeenCalledTimes(1);
    expect(cradle.acknowledge_submission_attempt).toHaveBeenCalledTimes(1);
    expect(cradle.acknowledge_submission_attempt).toHaveBeenCalledWith(submission.id);
    blob.detachBlockchain(blockchain);
  });

  it('submits drained transactions sequentially', async () => {
    let resolveFirst: (() => void) | null = null;
    let markFirstStarted: (() => void) | null = null;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const spend = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = () => resolve({ status: 'acknowledged' });
            markFirstStarted?.();
          }),
      )
      .mockResolvedValue({ status: 'acknowledged' });
    const blockchain = new BlockchainPoller(
      {
        ...mockRpc,
        spend,
        isConnected: () => true,
      } as InternalBlockchainInterface,
      60000,
    );
    const sentMessages: Array<{ msgno: number; msg: Uint8Array }> = [];
    const sentAcks: number[] = [];
    const blob = new SessionController(
      blockchain,
      'test',
      100n,
      100n,
      makePeerConn(sentMessages, sentAcks),
    );
    setActiveBlob(blob);
    blob.rewardPuzzleHash = '11'.repeat(32);
    const cradle = {
      ...makeMockCradle(),
      drain_submissions: jest.fn(() =>
        submissionDrain([
          { id: '1', bundle: testSpendBundle('01'), fee_request: null },
          { id: '2', bundle: testSpendBundle('02'), fee_request: null },
        ]),
      ),
    } as unknown as ChiaGame;

    blob.loadWasm(mockWasmConnection);
    blob.setGameSession(cradle);
    blob.processResult(wasmResult());

    await firstStarted;
    expect(spend).toHaveBeenCalledTimes(1);
    resolveFirst?.();
    await transactionSubmitQueue(blob);
    expect(spend).toHaveBeenCalledTimes(2);
  });

  it('lets an urgent submission pass an unavailable one and replays awaiting delivery once', async () => {
    const spend = jest
      .fn()
      .mockResolvedValueOnce({ status: 'unavailable', detail: 'wallet syncing' })
      .mockResolvedValue({ status: 'acknowledged' });
    const blockchain = new BlockchainPoller(
      {
        ...mockRpc,
        spend,
        isConnected: () => true,
        isReadyForPlay: () => true,
      } as InternalBlockchainInterface,
      60000,
    );
    const blob = new SessionController(blockchain, 'test', 100n, 100n, makePeerConn([], []));
    attachTestCommitCoordinator(blob);
    blob.rewardPuzzleHash = '11'.repeat(32);
    const first = { id: 'awaiting', bundle: testSpendBundle('01'), fee_request: null };
    const urgent = { id: 'urgent', bundle: testSpendBundle('02'), fee_request: null };
    const cradle = {
      ...makeMockCradle(),
      drain_submissions: jest
        .fn()
        .mockReturnValueOnce(submissionDrain([first, urgent]))
        .mockReturnValueOnce(submissionDrain())
        .mockReturnValueOnce(submissionDrain([first]))
        .mockReturnValue(submissionDrain()),
    } as unknown as ChiaGame;

    blob.loadWasm(mockWasmConnection);
    blob.setGameSession(cradle);
    blob.processResult(wasmResult());
    await transactionSubmitQueue(blob);

    expect(spend).toHaveBeenCalledTimes(2);
    expect(cradle.acknowledge_submission_attempt).toHaveBeenCalledWith('urgent');
    expect(cradle.acknowledge_submission_attempt).not.toHaveBeenCalledWith('awaiting');

    blob.reportNewBlock(2n);
    blob.reportChainSnapshotReady(2n);
    await transactionSubmitQueue(blob);

    expect(cradle.chain_snapshot_ready).toHaveBeenCalledTimes(1);
    expect(spend).toHaveBeenCalledTimes(3);
    expect(cradle.acknowledge_submission_attempt).toHaveBeenCalledWith('awaiting');
  });

  it('retains a locally failed submission and advances to the urgent next submission', async () => {
    expectConsoleError('finalization exploded');
    const spend = jest.fn().mockResolvedValue({ status: 'acknowledged' });
    const blockchain = new BlockchainPoller(
      {
        ...mockRpc,
        spend,
        isConnected: () => true,
        isReadyForPlay: () => true,
      } as InternalBlockchainInterface,
      60000,
    );
    const blob = new SessionController(blockchain, 'test', 100n, 100n, makePeerConn([], []));
    attachTestCommitCoordinator(blob);
    blob.rewardPuzzleHash = '11'.repeat(32);
    const errors: string[] = [];
    observeWasmEvents(blob).subscribe((event) => {
      if (event.type === 'error') errors.push(event.error);
    });
    const cradle = {
      ...makeMockCradle(),
      drain_submissions: jest.fn(() =>
        submissionDrain([
          { id: 'local-failure', bundle: testSpendBundle('01'), fee_request: null },
          { id: 'urgent', bundle: testSpendBundle('02'), fee_request: null },
        ]),
      ),
      finalize_submission_attempt: jest.fn((id: string) => {
        if (id === 'local-failure') throw new Error('finalization exploded');
        return {
          protocol_bundle: testSpendBundle('02'),
          bundle: {},
          applied_fee: '0',
          warning: null,
          fee_source_disposition: 'not-requested',
          variant_fingerprint: 'bb'.repeat(32),
          should_broadcast: true,
        };
      }),
    } as unknown as ChiaGame;

    blob.loadWasm(mockWasmConnection);
    blob.setGameSession(cradle);
    blob.processResult(wasmResult());
    await transactionSubmitQueue(blob);

    expect(cradle.reject_submission_attempt).not.toHaveBeenCalled();
    expect(cradle.acknowledge_submission_attempt).toHaveBeenCalledWith('urgent');
    expect(spend).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([
      expect.stringMatching(/local-failure.*retained for retry.*finalization exploded/i),
    ]);
  });

  it('retires rejected submissions and emits an actionable wallet error', async () => {
    const spend = jest.fn().mockResolvedValue({
      status: 'rejected',
      detail: 'INVALID_FEE_TOO_CLOSE_TO_ZERO',
    });
    const blockchain = new BlockchainPoller(
      { ...mockRpc, spend, isConnected: () => true } as InternalBlockchainInterface,
      60000,
    );
    const blob = new SessionController(blockchain, 'test', 100n, 100n, makePeerConn([], []));
    attachTestCommitCoordinator(blob);
    blob.rewardPuzzleHash = '11'.repeat(32);
    const errors: string[] = [];
    observeWasmEvents(blob).subscribe((event) => {
      if (event.type === 'error') errors.push(event.error);
    });
    const cradle = {
      ...makeMockCradle(),
      drain_submissions: jest
        .fn()
        .mockReturnValueOnce(
          submissionDrain([{ id: 'rejected', bundle: testSpendBundle('03'), fee_request: null }]),
        )
        .mockReturnValue(submissionDrain()),
    } as unknown as ChiaGame;

    blob.loadWasm(mockWasmConnection);
    blob.setGameSession(cradle);
    blob.processResult(wasmResult());
    await transactionSubmitQueue(blob);

    expect(cradle.reject_submission_attempt).toHaveBeenCalledTimes(1);
    expect(cradle.reject_submission_attempt).toHaveBeenCalledWith('rejected');
    expect(cradle.chain_snapshot_ready).not.toHaveBeenCalled();
    expect(errors).toEqual([expect.stringMatching(/Wallet rejected transaction rejected/)]);
    expect(errors[0]).toMatch(/effectively zero/i);
  });

  it('submits transactions already queued when a manager result is terminal', async () => {
    const spend = jest.fn().mockResolvedValue({ status: 'acknowledged' });
    const blockchain = new BlockchainPoller(
      {
        ...mockRpc,
        spend,
      } as InternalBlockchainInterface,
      60000,
    );
    const sentMessages: Array<{ msgno: number; msg: Uint8Array }> = [];
    const sentAcks: number[] = [];
    const blob = new SessionController(
      blockchain,
      'test',
      100n,
      100n,
      makePeerConn(sentMessages, sentAcks),
    );
    setActiveBlob(blob);
    blob.rewardPuzzleHash = '11'.repeat(32);
    const cradle = {
      ...makeMockCradle(),
      drain_submissions: jest.fn(() =>
        submissionDrain([{ id: '6', bundle: testSpendBundle('06'), fee_request: null }]),
      ),
    } as unknown as ChiaGame;

    blob.loadWasm(mockWasmConnection);
    blob.setGameSession(cradle);
    blob.processResult({
      ...wasmResult(),
      disposition: { kind: 'terminal' },
      events: [{ Notification: { ChannelStatus: channelStatus({ state: 'ResolvedClean' }) } }],
    });
    await transactionSubmitQueue(blob);

    expect(cradle.drain_submissions).toHaveBeenCalledTimes(1);
    expect(spend).toHaveBeenCalledTimes(1);
    blob.detachBlockchain(blockchain);
  });

  it('retains unavailable submissions and silently acknowledges an exact duplicate', async () => {
    const spend = jest
      .fn()
      .mockResolvedValueOnce({ status: 'unavailable', detail: 'input coin already spent' })
      .mockResolvedValueOnce({
        status: 'acknowledged',
        detail: 'duplicate transaction already in mempool',
      });
    const blockchain = new BlockchainPoller(
      {
        ...mockRpc,
        spend,
        isConnected: () => true,
      } as InternalBlockchainInterface,
      60000,
    );
    const sentMessages: Array<{ msgno: number; msg: Uint8Array }> = [];
    const sentAcks: number[] = [];
    const blob = new SessionController(
      blockchain,
      'test',
      100n,
      100n,
      makePeerConn(sentMessages, sentAcks),
    );
    setActiveBlob(blob);
    blob.rewardPuzzleHash = '11'.repeat(32);
    const errors: string[] = [];
    observeWasmEvents(blob).subscribe((evt) => {
      if (evt.type === 'error') errors.push(evt.error);
    });
    const cradle = {
      ...makeMockCradle(),
      drain_submissions: jest.fn(() =>
        submissionDrain([
          { id: '3', bundle: testSpendBundle('03'), fee_request: null },
          { id: '4', bundle: testSpendBundle('04'), fee_request: null },
        ]),
      ),
    } as unknown as ChiaGame;

    blob.loadWasm(mockWasmConnection);
    blob.setGameSession(cradle);
    blob.processResult(wasmResult());

    await transactionSubmitQueue(blob);
    expect(spend).toHaveBeenCalledTimes(2);
    expect(cradle.acknowledge_submission_attempt).toHaveBeenCalledTimes(1);
    expect(cradle.acknowledge_submission_attempt).toHaveBeenCalledWith('4');
    expect(cradle.reject_submission_attempt).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
  });

  it('rewrites fee-rate rejections into an actionable message and passes others through', () => {
    const rewritten = rewriteFeeRateRejection('Err.INVALID_FEE_TOO_CLOSE_TO_ZERO');
    expect(rewritten).toMatch(/effectively zero/i);
    expect(rewritten).toMatch(/100,000,000/);
    // Original text is retained for diagnosis.
    expect(rewritten).toMatch(/INVALID_FEE_TOO_CLOSE_TO_ZERO/);

    expect(rewriteFeeRateRejection('Err.INVALID_FEE_LOW_FEE')).toMatch(/effectively zero/i);

    // Unrelated errors are returned unchanged.
    const unrelated = 'spend rejected: status=[3,99] something else';
    expect(rewriteFeeRateRejection(unrelated)).toBe(unrelated);
  });
});
