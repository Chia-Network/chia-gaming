import { isBenignTransactionSubmitError, SessionController } from '../../hooks/SessionController';
import type { ChiaGame, InternalBlockchainInterface, WasmResult } from '../../types/ChiaGaming';
import { BlockchainPoller } from '../../hooks/BlockchainPoller';
import {
  destroySessionController,
  getOrCreateSessionController,
  isTransactionPublishNerfed,
  setTransactionPublishNerfed,
  subscribeTransactionPublishNerfed,
} from '../../hooks/blobSingleton';
import {
  channelStatus,
  createReadyBlob,
  enc,
  flushPromiseJobs,
  makeMockCradle,
  makePeerConn,
  mockBlockchain,
  mockRpc,
  mockWasmConnection,
  setActiveBlob,
  submitTransaction,
  testSpendBundle,
  transactionSubmitQueue,
  wasmResult,
} from './message_protocol.harness';

describe('terminal protocol cleanup', () => {
  it('completes a restored cooperative terminal handoff', async () => {
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
    const cradle = {
      ...makeMockCradle(),
      pendingTerminalHandoff: jest.fn(() => ({ id: '1', message: enc('complete clean close') })),
      completeOutboundTerminalHandoff: jest.fn(
        () =>
          ({
            ...wasmResult(),
            disposition: { kind: 'terminal' },
            events: [
              {
                Notification: {
                  ChannelStatus: channelStatus({
                    state: 'ShutdownTransactionPending',
                    session_disposition: 'Abandoned',
                    zero_payout: true,
                  }),
                },
              },
            ],
          }) as WasmResult,
      ),
    } as unknown as ChiaGame;
    blob.loadWasm(mockWasmConnection);
    blob.onSaveNeeded = jest.fn();
    blob.markRestored();
    blob.setGameSession(cradle);
    blob.kickSystem(2);
    await blob.flushPendingWork();

    expect(cradle.completeOutboundTerminalHandoff as jest.Mock).not.toHaveBeenCalled();
    blob.receiveAck(1n);
    expect(cradle.completeOutboundTerminalHandoff as jest.Mock).toHaveBeenCalledTimes(1);
    expect((blob as any).lastChannelStatus).toMatchObject({
      state: 'ShutdownTransactionPending',
      session_disposition: 'Abandoned',
    });
  });

  it('does not complete a restored handoff when replaying its close message fails', () => {
    const blob = new SessionController(mockBlockchain, 'test', 100n, 100n, {
      ...makePeerConn([], []),
      sendMessage: () => false,
    });
    setActiveBlob(blob);
    const cradle = {
      ...makeMockCradle(),
      pendingTerminalHandoff: jest.fn(() => ({ id: '1', message: enc('complete clean close') })),
      completeOutboundTerminalHandoff: jest.fn(
        () =>
          ({
            ...wasmResult(),
            disposition: { kind: 'terminal' },
            events: [
              {
                Notification: {
                  ChannelStatus: channelStatus({
                    state: 'ShutdownTransactionPending',
                    session_disposition: 'Abandoned',
                    zero_payout: true,
                  }),
                },
              },
            ],
          }) as WasmResult,
      ),
    } as unknown as ChiaGame;
    blob.unackedMessages = [{ msgno: 1n, msg: enc('complete clean close') }];
    blob.loadWasm(mockWasmConnection);
    blob.markRestored();
    blob.setGameSession(cradle);
    blob.kickSystem(2);

    expect(cradle.completeOutboundTerminalHandoff as jest.Mock).not.toHaveBeenCalled();
    expect((blob as any).protocolStopped).toBe(false);
  });

  it('does not complete a terminal handoff before its message is acknowledged', () => {
    const { blob, cradle } = createReadyBlob();
    (cradle.completeOutboundTerminalHandoff as jest.Mock).mockReturnValue({
      ...wasmResult(),
      events: [],
    } as WasmResult);

    blob.processResult({
      ...wasmResult(),
      disposition: {
        kind: 'await-outbound-terminal',
        command: { id: '1', message: enc('complete clean close') },
      },
      events: [],
    });

    expect(cradle.completeOutboundTerminalHandoff as jest.Mock).not.toHaveBeenCalled();
    expect(() => blob.receiveAck(1n)).not.toThrow();
    expect((blob as any).terminalHandoff).toMatchObject({ id: '1', msgno: 1n });
  });

  it('requires a successful terminal close send before its ACK can complete Rust abandonment', async () => {
    const sentMessages: Array<{ msgno: number; msg: Uint8Array }> = [];
    const sentAcks: number[] = [];
    const sendMessage = jest.fn(() => false);
    const blob = new SessionController(mockBlockchain, 'test', 100n, 100n, {
      ...makePeerConn(sentMessages, sentAcks),
      sendMessage,
    });
    setActiveBlob(blob);
    const cradle = {
      ...makeMockCradle(),
      completeOutboundTerminalHandoff: jest.fn(
        () =>
          ({
            ...wasmResult(),
            disposition: { kind: 'terminal' },
            events: [],
          }) as WasmResult,
      ),
    } as unknown as ChiaGame;
    blob.loadWasm(mockWasmConnection);
    blob.setGameSession(cradle);
    blob.kickSystem(2);
    blob.onSaveNeeded = jest.fn();
    blob.processResult({
      ...wasmResult(),
      disposition: {
        kind: 'await-outbound-terminal',
        command: { id: '1', message: enc('complete clean close') },
      },
      events: [],
    });
    await (blob as any).flushDurabilityAndSend();

    blob.receiveAck(1n);

    expect(cradle.completeOutboundTerminalHandoff as jest.Mock).not.toHaveBeenCalled();
    expect((blob as any).terminalHandoff).toMatchObject({ sent: false, acknowledged: false });

    sendMessage.mockReturnValue(true);
    blob.resendUnacked();
    blob.receiveAck(1n);

    expect(cradle.completeOutboundTerminalHandoff as jest.Mock).toHaveBeenCalledTimes(1);
  });

  it('leaves a failed terminal completion recoverable without scheduling retries', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { blob, cradle } = createReadyBlob();
    (cradle.completeOutboundTerminalHandoff as jest.Mock)
      .mockImplementationOnce(() => {
        throw new Error('temporary completion failure');
      })
      .mockReturnValueOnce(wasmResult({ disposition: { kind: 'terminal' } }));
    blob.onSaveNeeded = jest.fn();
    blob.processResult({
      ...wasmResult(),
      disposition: {
        kind: 'await-outbound-terminal',
        command: { id: '1', message: enc('complete clean close') },
      },
      events: [],
    });
    await blob.flushPendingWork();

    blob.receiveAck(1n);

    expect(cradle.completeOutboundTerminalHandoff as jest.Mock).toHaveBeenCalledTimes(1);
    expect((blob as any).terminalCompletionRetryTimer).toBeUndefined();
    expect((blob as any).protocolStopped).toBe(false);

    blob.receiveAck(1n);

    expect(cradle.completeOutboundTerminalHandoff as jest.Mock).toHaveBeenCalledTimes(2);
    expect((blob as any).protocolStopped).toBe(true);
    errorSpy.mockRestore();
  });

  it('hands off the final clean-close message before Rust terminalizes locally', async () => {
    const { blob, cradle, sentMessages } = createReadyBlob();
    (cradle.completeOutboundTerminalHandoff as jest.Mock).mockReturnValue({
      ...wasmResult(),
      disposition: { kind: 'terminal' },
      events: [
        {
          Notification: {
            ChannelStatus: channelStatus({
              state: 'ShutdownTransactionPending',
              session_disposition: 'Abandoned',
              zero_payout: true,
            }),
          },
        },
      ],
    } as WasmResult);

    blob.processResult({
      ...wasmResult(),
      disposition: {
        kind: 'await-outbound-terminal',
        command: { id: '1', message: enc('complete clean close') },
      },
      events: [
        { OutboundMessage: enc('advisory before clean close') },
        {
          Notification: {
            ChannelStatus: channelStatus({
              state: 'ShutdownTransactionPending',
              zero_payout: true,
            }),
          },
        },
      ],
    });
    await blob.flushPendingWork();
    await blob.flushPendingSave();
    blob.resendUnacked();

    expect(sentMessages.map((message) => new TextDecoder().decode(message.msg))).toContain(
      'complete clean close',
    );
    expect(cradle.completeOutboundTerminalHandoff as jest.Mock).not.toHaveBeenCalled();
    blob.receiveAck(2n);
    expect(cradle.completeOutboundTerminalHandoff as jest.Mock).toHaveBeenCalledTimes(1);
    expect((blob as any).lastChannelStatus).toMatchObject({
      state: 'ShutdownTransactionPending',
      session_disposition: 'Abandoned',
      zero_payout: true,
    });
  });

  it('replaces queued protocol and presentation work with terminal notifications', () => {
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
      events: [
        { OutboundMessage: enc('stale protocol message') },
        { Notification: { ChannelStatus: channelStatus({ state: 'Active' }) } },
      ],
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
  it('routes controller nerfs through the singleton policy and notifies subscribers', () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const sentMessages: Array<{ msgno: number; msg: Uint8Array }> = [];
    const sentAcks: number[] = [];
    const updates: boolean[] = [];
    const unsubscribe = subscribeTransactionPublishNerfed((nerfed) => updates.push(nerfed));
    const { sessionController: blob } = getOrCreateSessionController(
      null,
      makePeerConn(sentMessages, sentAcks),
      () => {},
      'test',
      100n,
      100n,
      true,
    );

    expect(isTransactionPublishNerfed()).toBe(false);
    blob.nerf();
    expect(isTransactionPublishNerfed()).toBe(true);
    expect(blob.isTransactionPublishNerfed()).toBe(true);
    setTransactionPublishNerfed(false);
    expect(isTransactionPublishNerfed()).toBe(false);
    expect(blob.isTransactionPublishNerfed()).toBe(false);
    expect(updates).toEqual([false, true, false]);

    unsubscribe();
    destroySessionController();
    errorSpy.mockRestore();
  });

  it('drops queued publishes after nerfing and resumes newly queued publishes when re-enabled', async () => {
    const spend = jest.fn().mockResolvedValue('');
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
    const spend = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            resolveFirst = () => resolve('');
          }),
      )
      .mockResolvedValue('');
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

    submitTransaction(blob, testSpendBundle('09'));
    submitTransaction(blob, testSpendBundle('0a'));
    await flushPromiseJobs();
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
    await (blockchain as unknown as { pollOnce: () => Promise<void> }).pollOnce();

    expect(cradle.snapshot_watched_coins).not.toHaveBeenCalled();
    expect(queriedNames).toEqual([['aa']]);

    blob.processResult({
      ...wasmResult(),
      events: [],
      unwatchCoins: [{ coin_name: 'aa', coin_string: 'coin-a' }],
    });
    await (blockchain as unknown as { pollOnce: () => Promise<void> }).pollOnce();

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
    await (blockchain as unknown as { pollOnce: () => Promise<void> }).pollOnce();

    expect(cradle.snapshot_watched_coins).toHaveBeenCalledTimes(2);
    expect(queriedNames).toEqual([['bb']]);

    blob.attachBlockchain(blockchain);
    expect(cradle.snapshot_watched_coins).toHaveBeenCalledTimes(4);
    blob.detachBlockchain(blockchain);
  });

  it('hydrates without blockchain and replays retained submissions on later attach', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const spend = jest.fn().mockResolvedValue('');
    const blockchain = new BlockchainPoller(
      {
        ...mockRpc,
        spend,
        isConnected: () => true,
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
    );
    setActiveBlob(blob);
    blob.rewardPuzzleHash = '11'.repeat(32);
    const cradle = {
      ...makeMockCradle(),
      snapshot_watched_coins: jest.fn(() => [{ coin_name: 'cc', coin_string: 'coin-c' }]),
      drain_submissions: jest
        .fn()
        .mockReturnValueOnce([])
        .mockReturnValueOnce([testSpendBundle('05')]),
    } as unknown as ChiaGame;

    blob.loadWasm(mockWasmConnection);
    blob.setGameSession(cradle);
    blob.processResult(wasmResult());

    expect(cradle.drain_submissions).not.toHaveBeenCalled();
    expect(spend).not.toHaveBeenCalled();

    blob.attachBlockchain(blockchain);
    await (blockchain as unknown as { pollOnce: () => Promise<void> }).pollOnce();
    await transactionSubmitQueue(blob);

    expect(cradle.resubmit_submitted).toHaveBeenCalledTimes(1);
    expect(cradle.drain_submissions).toHaveBeenCalledTimes(3);
    expect(spend).toHaveBeenCalledTimes(1);
    blob.detachBlockchain(blockchain);
    errorSpy.mockRestore();
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
    expect(cradle.resubmit_submitted).not.toHaveBeenCalled();

    blob.reportCoinStates(1n, []);

    expect(cradle.resubmit_submitted).toHaveBeenCalledTimes(1);
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
    );
    setActiveBlob(blob);
    const cradle = makeMockCradle();

    blob.loadWasm(mockWasmConnection);
    blob.attachBlockchain(blockchain);
    blob.reportNewBlock(1n);
    blob.setGameSession(cradle);

    expect(cradle.resubmit_submitted).toHaveBeenCalledTimes(1);
    blob.detachBlockchain(blockchain);
  });

  it('submits drained transactions sequentially', async () => {
    let resolveFirst: (() => void) | null = null;
    const spend = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            resolveFirst = () => resolve('');
          }),
      )
      .mockResolvedValue('');
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
      drain_submissions: jest.fn(() => [testSpendBundle('01'), testSpendBundle('02')]),
    } as unknown as ChiaGame;

    blob.loadWasm(mockWasmConnection);
    blob.setGameSession(cradle);
    blob.processResult(wasmResult());

    await flushPromiseJobs();
    expect(spend).toHaveBeenCalledTimes(1);
    resolveFirst?.();
    await transactionSubmitQueue(blob);
    expect(spend).toHaveBeenCalledTimes(2);
  });

  it('submits transactions already queued when a manager result is terminal', async () => {
    const spend = jest.fn().mockResolvedValue('');
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
      drain_submissions: jest.fn(() => [testSpendBundle('06')]),
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

  it('does not emit user-facing errors for benign stale spend rejections', async () => {
    expect(
      isBenignTransactionSubmitError(
        'spend rejected: status=[3,9] Conflicting transaction: overlapping spends [CoinID(Hash(a))]',
      ),
    ).toBe(true);
    expect(
      isBenignTransactionSubmitError(
        'spend rejected: status=[3,5] Coin not found: CoinID(Hash(b))',
      ),
    ).toBe(true);
    expect(isBenignTransactionSubmitError('spend rejected: status=[3,99] something else')).toBe(
      false,
    );

    const spend = jest
      .fn()
      .mockRejectedValueOnce(
        new Error('spend rejected: status=[3,9] Conflicting transaction: overlapping spends []'),
      )
      .mockRejectedValueOnce(
        new Error('spend rejected: status=[3,5] Coin not found: CoinID(Hash(c))'),
      );
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
    blob.getObservable().subscribe((evt) => {
      if (evt.type === 'error') errors.push(evt.error);
    });
    const cradle = {
      ...makeMockCradle(),
      drain_submissions: jest.fn(() => [testSpendBundle('03'), testSpendBundle('04')]),
    } as unknown as ChiaGame;

    blob.loadWasm(mockWasmConnection);
    blob.setGameSession(cradle);
    blob.processResult(wasmResult());

    await transactionSubmitQueue(blob);
    expect(spend).toHaveBeenCalledTimes(2);
    expect(errors).toEqual([]);
  });
});
