import { BlockchainPoller, PollingGameSession } from '../../hooks/BlockchainPoller';
import { InternalBlockchainInterface } from '../../types/ChiaGaming';
import { CoinRecord } from '../../types/rpc/CoinRecord';
import { coinRecordToName } from '../../util/coinWatch';

function makeRpc(heights: bigint[]): InternalBlockchainInterface {
  return new Proxy(
    {
      getHeightInfo: () => Promise.resolve(heights.shift() ?? 0n),
      registerCoins: () => Promise.resolve(),
      getCoinRecordsByNames: () => Promise.resolve([]),
    } as unknown as InternalBlockchainInterface,
    {
      get: (target, prop) =>
        (target as Record<string, unknown>)[prop as string] ?? (() => Promise.resolve(undefined)),
    },
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function advanceLane(ms = 50): Promise<void> {
  await jest.advanceTimersByTimeAsync(ms);
}

function hexByte(byte: number): string {
  return byte.toString(16).padStart(2, '0').repeat(32);
}

function makeCoinRecord(index: number): CoinRecord {
  return {
    coin: {
      parentCoinInfo: `0x${hexByte(index)}`,
      puzzleHash: `0x${hexByte(index + 16)}`,
      amount: BigInt(index),
    },
    confirmedBlockIndex: 10n,
    spentBlockIndex: 0n,
    spent: false,
    coinbase: false,
    timestamp: 0n,
  };
}

describe('BlockchainPoller', () => {
  it('reports a decreased height to the cradle (reorg signal not clamped)', async () => {
    // Height goes up then drops: a reorg.  The poller must forward the lower
    // height so the transaction manager can detect the rollback.
    const rpc = makeRpc([100n, 90n]);
    const reportedPeaks: bigint[] = [];
    const cradle: PollingGameSession = {
      snapshotWatchedCoins: () => [{ coin_name: 'aabb', coin_string: 'coin-1' }],
      reportNewBlock: () => {},
      reportCoinStates: (peak) => {
        reportedPeaks.push(peak);
      },
    };

    const poller = new BlockchainPoller(rpc, 1000);
    poller.attachGameSession(cradle);

    // Drive the poll loop directly, twice, without the setTimeout backoff.
    await (poller as unknown as { pollOnce: () => Promise<void> }).pollOnce();
    await (poller as unknown as { pollOnce: () => Promise<void> }).pollOnce();

    expect(reportedPeaks).toEqual([100n, 90n]);
    expect(poller.getPeak()).toEqual(90n);
  });

  it('skips reporting a cradle until all of its coins are registered', async () => {
    // While a coin is still pending registration we cannot query it; reporting a
    // snapshot without it would look like a deletion to the manager.  The cradle
    // must be skipped until registration succeeds (retried each tick).
    let registerOk = false;
    const rpc = new Proxy(
      {
        getHeightInfo: () => Promise.resolve(100n),
        registerCoins: () =>
          registerOk ? Promise.resolve() : Promise.reject(new Error('register failed')),
        getCoinRecordsByNames: () => Promise.resolve([]),
      } as unknown as InternalBlockchainInterface,
      {
        get: (target, prop) =>
          (target as Record<string, unknown>)[prop as string] ?? (() => Promise.resolve(undefined)),
      },
    );
    const reportedPeaks: bigint[] = [];
    const heightOnlyPeaks: bigint[] = [];
    const cradle: PollingGameSession = {
      snapshotWatchedCoins: () => [{ coin_name: 'aabb', coin_string: 'coin-1' }],
      reportCoinStates: (peak) => {
        reportedPeaks.push(peak);
      },
      reportNewBlock: (peak) => {
        heightOnlyPeaks.push(peak);
      },
    };

    const poller = new BlockchainPoller(rpc, 1000);
    poller.attachGameSession(cradle);

    // Registration fails: no report (a partial snapshot would be misread).
    await (poller as unknown as { pollOnce: () => Promise<void> }).pollOnce();
    expect(reportedPeaks).toEqual([]);
    expect(heightOnlyPeaks).toEqual([100n]);

    // Registration succeeds on the retry: the cradle is reported.
    registerOk = true;
    await (poller as unknown as { pollOnce: () => Promise<void> }).pollOnce();
    expect(reportedPeaks).toEqual([100n]);
    expect(heightOnlyPeaks).toEqual([100n, 100n]);
  });

  it('advances a session with no watched coins through height-only observations', async () => {
    const rpc = makeRpc([100n]);
    const heightOnlyPeaks: bigint[] = [];
    const cradle: PollingGameSession = {
      snapshotWatchedCoins: () => [],
      reportNewBlock: (peak) => {
        heightOnlyPeaks.push(peak);
      },
      reportCoinStates: () => {},
    };
    const poller = new BlockchainPoller(rpc, 1000);
    poller.attachGameSession(cradle);

    await (poller as unknown as { pollOnce: () => Promise<void> }).pollOnce();

    expect(heightOnlyPeaks).toEqual([100n]);
  });

  it('uses attach-time snapshots and runtime watch deltas instead of resampling every sweep', async () => {
    let interests = [{ coin_name: 'aa', coin_string: 'coin-a' }];
    let snapshotCalls = 0;
    const queriedNames: string[][] = [];
    const rpc = new Proxy(
      {
        getHeightInfo: () => Promise.resolve(100n),
        registerCoins: () => Promise.resolve(),
        getCoinRecordsByNames: (names: string[]) => {
          queriedNames.push(names);
          return Promise.resolve([]);
        },
      } as unknown as InternalBlockchainInterface,
      {
        get: (target, prop) =>
          (target as Record<string, unknown>)[prop as string] ?? (() => Promise.resolve(undefined)),
      },
    );
    const cradle: PollingGameSession = {
      snapshotWatchedCoins: () => {
        snapshotCalls++;
        return interests;
      },
      reportCoinStates: () => {},
      reportNewBlock: () => {},
    };

    const poller = new BlockchainPoller(rpc, 1000);
    poller.attachGameSession(cradle);
    expect(snapshotCalls).toBe(1);

    await (poller as unknown as { pollOnce: () => Promise<void> }).pollOnce();
    interests = [{ coin_name: 'bb', coin_string: 'coin-b' }];
    await (poller as unknown as { pollOnce: () => Promise<void> }).pollOnce();
    expect(snapshotCalls).toBe(1);
    expect(queriedNames).toEqual([['aa'], ['aa']]);

    poller.watchCoin(cradle, { coin_name: 'bb', coin_string: 'coin-b' });
    expect(snapshotCalls).toBe(1);
    await (poller as unknown as { pollOnce: () => Promise<void> }).pollOnce();
    expect(queriedNames).toEqual([['aa'], ['aa'], ['aa', 'bb']]);
  });

  it('serializes public RPC calls through the coordinator lane', async () => {
    jest.useFakeTimers();
    const first = deferred<bigint>();
    const second = deferred<bigint>();
    const calls: string[] = [];
    const rpc = new Proxy(
      {
        requestGapMs: 50,
        getHeightInfo: () => {
          calls.push('height');
          return first.promise;
        },
        getBalance: () => {
          calls.push('balance');
          return second.promise;
        },
      } as unknown as InternalBlockchainInterface,
      {
        get: (target, prop) =>
          (target as Record<string, unknown>)[prop as string] ?? (() => Promise.resolve(undefined)),
      },
    );
    const poller = new BlockchainPoller(rpc, 1000);

    const p1 = poller.rpc.getHeightInfo();
    const p2 = poller.rpc.getBalance();

    await advanceLane();
    expect(calls).toEqual(['height']);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(calls).toEqual(['height']);

    first.resolve(7n);
    await advanceLane();
    expect(calls).toEqual(['height', 'balance']);

    second.resolve(11n);
    await expect(p1).resolves.toBe(7n);
    await expect(p2).resolves.toBe(11n);
    jest.useRealTimers();
  });

  it('prioritizes foreground wallet actions ahead of queued background RPCs', async () => {
    jest.useFakeTimers();
    const first = deferred<bigint>();
    const createOffer = deferred<unknown>();
    const selectCoins = deferred<string | null>();
    const spend = deferred<string>();
    const balance = deferred<bigint>();
    const calls: string[] = [];
    const rpc = new Proxy(
      {
        requestGapMs: 50,
        getHeightInfo: () => {
          calls.push('height');
          return first.promise;
        },
        getBalance: () => {
          calls.push('balance');
          return balance.promise;
        },
        createOfferForIds: () => {
          calls.push('createOfferForIds');
          return createOffer.promise;
        },
        selectCoins: () => {
          calls.push('selectCoins');
          return selectCoins.promise;
        },
        spend: () => {
          calls.push('spend');
          return spend.promise;
        },
      } as unknown as InternalBlockchainInterface,
      {
        get: (target, prop) =>
          (target as Record<string, unknown>)[prop as string] ?? (() => Promise.resolve(undefined)),
      },
    );
    const poller = new BlockchainPoller(rpc, 1000);

    const p1 = poller.rpc.getHeightInfo();
    await advanceLane();
    const p2 = poller.rpc.getBalance();
    const p3 = poller.rpc.createOfferForIds('u', {});
    const p4 = poller.rpc.selectCoins('u', 1n);
    const p5 = poller.rpc.spend('blob', {}, '11'.repeat(32), 'submitTransaction', 0n);

    first.resolve(7n);
    await advanceLane();
    expect(calls).toEqual(['height', 'createOfferForIds']);
    createOffer.resolve({});
    await advanceLane();
    expect(calls).toEqual(['height', 'createOfferForIds', 'selectCoins']);
    selectCoins.resolve(null);
    await advanceLane();
    expect(calls).toEqual(['height', 'createOfferForIds', 'selectCoins', 'spend']);
    spend.resolve('');
    await advanceLane();
    expect(calls).toEqual(['height', 'createOfferForIds', 'selectCoins', 'spend', 'balance']);

    balance.resolve(11n);
    await expect(p1).resolves.toBe(7n);
    await expect(p2).resolves.toBe(11n);
    await expect(p3).resolves.toEqual({});
    await expect(p4).resolves.toBeNull();
    await expect(p5).resolves.toBe('');
    jest.useRealTimers();
  });

  it('polls balance through the common coordinator loop', async () => {
    jest.useFakeTimers();
    const balance = deferred<bigint>();
    const balances: bigint[] = [];
    const rpc = new Proxy(
      {
        getBalance: jest.fn(() => balance.promise),
      } as unknown as InternalBlockchainInterface,
      {
        get: (target, prop) =>
          (target as Record<string, unknown>)[prop as string] ?? (() => Promise.resolve(undefined)),
      },
    );
    const poller = new BlockchainPoller(rpc, 1000);
    poller.startBalanceInterest(1000, { onBalance: (value) => balances.push(value) });
    poller.startBalanceInterest(1000, { onBalance: (value) => balances.push(value) });

    await jest.advanceTimersByTimeAsync(0);
    expect(rpc.getBalance).toHaveBeenCalledTimes(1);
    balance.resolve(23n);
    await jest.advanceTimersByTimeAsync(0);
    expect(balances).toEqual([23n]);
    jest.useRealTimers();
  });

  it('keeps balance interest alive across game-session stop()', async () => {
    jest.useFakeTimers();
    const balances: bigint[] = [];
    const rpc = new Proxy(
      {
        getBalance: jest.fn().mockResolvedValueOnce(10n).mockResolvedValueOnce(20n),
      } as unknown as InternalBlockchainInterface,
      {
        get: (target, prop) =>
          (target as Record<string, unknown>)[prop as string] ?? (() => Promise.resolve(undefined)),
      },
    );
    const poller = new BlockchainPoller(rpc, 1000);
    poller.start();
    poller.startBalanceInterest(1000, { onBalance: (value) => balances.push(value) });

    await jest.advanceTimersByTimeAsync(0);
    expect(balances).toEqual([10n]);

    // SessionController calls stop() on cradle terminal — wallet balance must continue.
    poller.stop();
    await jest.advanceTimersByTimeAsync(1000);
    expect(balances).toEqual([10n, 20n]);
    jest.useRealTimers();
  });

  it('pauses routine wallet queries while disconnected and resumes on reconnect', async () => {
    jest.useFakeTimers();
    let connected = true;
    let onConnectionChange: ((next: boolean) => void) | undefined;
    const rpc = {
      getHeightInfo: jest.fn().mockResolvedValue(100n),
      registerCoins: jest.fn().mockResolvedValue(undefined),
      getCoinRecordsByNames: jest.fn().mockResolvedValue([]),
      getBalance: jest.fn().mockResolvedValue(10n),
      isConnected: () => connected,
      onConnectionChange: (callback: (next: boolean) => void) => {
        onConnectionChange = callback;
        return () => {
          onConnectionChange = undefined;
        };
      },
    } as unknown as InternalBlockchainInterface;
    const cradle: PollingGameSession = {
      snapshotWatchedCoins: () => [{ coin_name: 'aa', coin_string: 'coin-a' }],
      reportCoinStates: () => {},
      reportNewBlock: () => {},
    };
    const poller = new BlockchainPoller(rpc, 1000);
    poller.attachGameSession(cradle);
    poller.start();
    poller.startBalanceInterest(1000, { onBalance: () => {} });

    await jest.advanceTimersByTimeAsync(0);
    expect(rpc.getHeightInfo).toHaveBeenCalledTimes(1);
    expect(rpc.registerCoins).toHaveBeenCalledTimes(1);
    expect(rpc.getCoinRecordsByNames).toHaveBeenCalledTimes(1);
    expect(rpc.getBalance).toHaveBeenCalledTimes(1);

    connected = false;
    onConnectionChange?.(false);
    await jest.advanceTimersByTimeAsync(5000);
    expect(rpc.getHeightInfo).toHaveBeenCalledTimes(1);
    expect(rpc.registerCoins).toHaveBeenCalledTimes(1);
    expect(rpc.getCoinRecordsByNames).toHaveBeenCalledTimes(1);
    expect(rpc.getBalance).toHaveBeenCalledTimes(1);

    connected = true;
    onConnectionChange?.(true);
    await jest.advanceTimersByTimeAsync(0);
    expect(rpc.getHeightInfo).toHaveBeenCalledTimes(2);
    expect(rpc.registerCoins).toHaveBeenCalledTimes(2);
    expect(rpc.getCoinRecordsByNames).toHaveBeenCalledTimes(2);
    expect(rpc.getBalance).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });

  it('restarts a poll that was in flight during reconnect', async () => {
    jest.useFakeTimers();
    let connected = true;
    let onConnectionChange: ((next: boolean) => void) | undefined;
    const firstHeight = deferred<bigint>();
    const getHeightInfo = jest
      .fn()
      .mockReturnValueOnce(firstHeight.promise)
      .mockResolvedValueOnce(101n);
    const rpc = {
      getHeightInfo,
      isConnected: () => connected,
      onConnectionChange: (callback: (next: boolean) => void) => {
        onConnectionChange = callback;
        return () => {
          onConnectionChange = undefined;
        };
      },
    } as unknown as InternalBlockchainInterface;
    const poller = new BlockchainPoller(rpc, 1000);
    poller.start();

    await advanceLane(0);
    expect(getHeightInfo).toHaveBeenCalledTimes(1);

    connected = false;
    onConnectionChange?.(false);
    connected = true;
    onConnectionChange?.(true);
    firstHeight.resolve(100n);

    await advanceLane(0);
    expect(getHeightInfo).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });

  it('discards a stale coin registration before reconnect polling resumes', async () => {
    jest.useFakeTimers();
    let connected = true;
    let onConnectionChange: ((next: boolean) => void) | undefined;
    const firstRegistration = deferred<void>();
    const registerCoins = jest
      .fn()
      .mockReturnValueOnce(firstRegistration.promise)
      .mockResolvedValueOnce(undefined);
    const rpc = {
      getHeightInfo: jest.fn().mockResolvedValue(100n),
      registerCoins,
      getCoinRecordsByNames: jest.fn().mockResolvedValue([]),
      isConnected: () => connected,
      onConnectionChange: (callback: (next: boolean) => void) => {
        onConnectionChange = callback;
        return () => {
          onConnectionChange = undefined;
        };
      },
    } as unknown as InternalBlockchainInterface;
    const cradle: PollingGameSession = {
      snapshotWatchedCoins: () => [{ coin_name: 'aa', coin_string: 'coin-a' }],
      reportCoinStates: () => {},
      reportNewBlock: () => {},
    };
    const poller = new BlockchainPoller(rpc, 1000);
    poller.attachGameSession(cradle);
    poller.start();

    await advanceLane(0);
    expect(registerCoins).toHaveBeenCalledTimes(1);

    connected = false;
    onConnectionChange?.(false);
    connected = true;
    onConnectionChange?.(true);
    firstRegistration.resolve();

    await advanceLane(0);
    expect(registerCoins).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });

  it('does not resume coin polling while the wallet session is disconnected', async () => {
    jest.useFakeTimers();
    let onConnectionChange: ((next: boolean) => void) | undefined;
    const rpc = {
      getHeightInfo: jest.fn().mockResolvedValue(100n),
      registerCoins: jest.fn().mockResolvedValue(undefined),
      getCoinRecordsByNames: jest.fn().mockResolvedValue([]),
      isConnected: () => true,
      onConnectionChange: (callback: (next: boolean) => void) => {
        onConnectionChange = callback;
        return () => {
          onConnectionChange = undefined;
        };
      },
    } as unknown as InternalBlockchainInterface;
    const cradle: PollingGameSession = {
      snapshotWatchedCoins: () => [{ coin_name: 'aa', coin_string: 'coin-a' }],
      reportCoinStates: () => {},
      reportNewBlock: () => {},
    };
    const poller = new BlockchainPoller(rpc, 1000);
    poller.attachGameSession(cradle);
    poller.start();

    await advanceLane(0);
    expect(rpc.registerCoins).toHaveBeenCalledTimes(1);

    onConnectionChange?.(false);
    poller.watchCoin(cradle, { coin_name: 'bb', coin_string: 'coin-b' });
    await advanceLane(0);
    expect(rpc.registerCoins).toHaveBeenCalledTimes(1);

    onConnectionChange?.(true);
    await advanceLane(0);
    expect(rpc.registerCoins).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });

  it('rejects queued wallet RPCs when the wallet disconnects', async () => {
    jest.useFakeTimers();
    let connected = true;
    let onConnectionChange: ((next: boolean) => void) | undefined;
    const height = deferred<bigint>();
    const selectCoins = jest.fn();
    const rpc = {
      getHeightInfo: () => height.promise,
      selectCoins,
      isConnected: () => connected,
      onConnectionChange: (callback: (next: boolean) => void) => {
        onConnectionChange = callback;
        return () => {
          onConnectionChange = undefined;
        };
      },
    } as unknown as InternalBlockchainInterface;
    const poller = new BlockchainPoller(rpc, 1000);
    poller.start();

    await advanceLane(0);
    const walletRequest = poller.rpc.selectCoins('wallet', 1n);

    connected = false;
    onConnectionChange?.(false);
    await expect(walletRequest).rejects.toThrow(
      'RPC request discarded during disconnect: selectCoins',
    );
    await expect(poller.rpc.selectCoins('wallet', 1n)).rejects.toThrow(
      'RPC request discarded during disconnect: selectCoins',
    );
    expect(selectCoins).not.toHaveBeenCalled();

    height.resolve(100n);
    await advanceLane(0);
    jest.useRealTimers();
  });

  it('clears registered coin cache when the adapter registration scope changes', async () => {
    let scope = '99';
    const registered: string[][] = [];
    const rpc = new Proxy(
      {
        getRegistrationScopeKey: () => scope,
        getHeightInfo: () => Promise.resolve(100n),
        registerCoins: (names: string[]) => {
          registered.push(names);
          return Promise.resolve();
        },
        getCoinRecordsByNames: () => Promise.resolve([]),
      } as unknown as InternalBlockchainInterface,
      {
        get: (target, prop) =>
          (target as Record<string, unknown>)[prop as string] ?? (() => Promise.resolve(undefined)),
      },
    );
    const cradle: PollingGameSession = {
      snapshotWatchedCoins: () => [{ coin_name: 'aa', coin_string: 'coin-a' }],
      reportCoinStates: () => {},
      reportNewBlock: () => {},
    };
    const poller = new BlockchainPoller(rpc, 1000);
    poller.attachGameSession(cradle);

    await (poller as unknown as { pollOnce: () => Promise<void> }).pollOnce();
    scope = '100';
    await (poller as unknown as { pollOnce: () => Promise<void> }).pollOnce();

    expect(registered).toEqual([['aa'], ['aa']]);
  });

  it('keeps reporting spent coins for the transaction manager to retain or release', async () => {
    const record = makeCoinRecord(9);
    record.spent = true;
    record.spentBlockIndex = 10n;
    const name = await coinRecordToName(record);
    if (!name) {
      throw new Error('coinRecordToName returned undefined');
    }
    const queriedNames: string[][] = [];
    const rpc = new Proxy(
      {
        getHeightInfo: () => Promise.resolve(100n),
        registerCoins: () => Promise.resolve(),
        getCoinRecordsByNames: (names: string[]) => {
          queriedNames.push(names);
          return Promise.resolve([record]);
        },
      } as unknown as InternalBlockchainInterface,
      {
        get: (target, prop) =>
          (target as Record<string, unknown>)[prop as string] ?? (() => Promise.resolve(undefined)),
      },
    );
    const reports: Array<{
      peak: bigint;
      records: Array<{ coin: string; created_height: bigint | null; spent_height: bigint | null }>;
    }> = [];
    const heightOnlyPeaks: bigint[] = [];
    const cradle: PollingGameSession = {
      snapshotWatchedCoins: () => [{ coin_name: name, coin_string: 'coin-buried' }],
      reportCoinStates: (peak, records) => {
        reports.push({ peak, records });
      },
      reportNewBlock: (peak) => {
        heightOnlyPeaks.push(peak);
      },
    };
    const poller = new BlockchainPoller(rpc, 1000);
    poller.attachGameSession(cradle);

    await (poller as unknown as { pollOnce: () => Promise<void> }).pollOnce();
    await (poller as unknown as { pollOnce: () => Promise<void> }).pollOnce();

    expect(reports).toEqual([
      {
        peak: 100n,
        records: [{ coin: 'coin-buried', created_height: 10n, spent_height: 10n }],
      },
      {
        peak: 100n,
        records: [{ coin: 'coin-buried', created_height: 10n, spent_height: 10n }],
      },
    ]);
    expect(heightOnlyPeaks).toEqual([100n, 100n]);
    expect(queriedNames).toEqual([[name], [name]]);
  });

  it('skips transient partial snapshots for coins that were previously observed', async () => {
    const recordA = makeCoinRecord(1);
    const recordB = makeCoinRecord(2);
    const nameA = await coinRecordToName(recordA);
    const nameB = await coinRecordToName(recordB);
    if (!nameA || !nameB) {
      throw new Error('coinRecordToName returned undefined');
    }
    expect(nameA).toBeDefined();
    expect(nameB).toBeDefined();

    const responses = [[recordA, recordB], [recordA]];
    const rpc = new Proxy(
      {
        getHeightInfo: () => Promise.resolve(100n),
        registerCoins: () => Promise.resolve(),
        getCoinRecordsByNames: () => Promise.resolve(responses.shift() ?? []),
      } as unknown as InternalBlockchainInterface,
      {
        get: (target, prop) =>
          (target as Record<string, unknown>)[prop as string] ?? (() => Promise.resolve(undefined)),
      },
    );
    const reports: Array<{
      peak: bigint;
      records: Array<{ coin: string; created_height: bigint | null; spent_height: bigint | null }>;
    }> = [];
    const heightOnlyPeaks: bigint[] = [];
    const cradle: PollingGameSession = {
      snapshotWatchedCoins: () => [
        { coin_name: nameA!, coin_string: 'coin-a' },
        { coin_name: nameB!, coin_string: 'coin-b' },
      ],
      reportCoinStates: (peak, records) => {
        reports.push({ peak, records });
      },
      reportNewBlock: (peak) => {
        heightOnlyPeaks.push(peak);
      },
    };

    const poller = new BlockchainPoller(rpc, 1000);
    poller.attachGameSession(cradle);

    await (poller as unknown as { pollOnce: () => Promise<void> }).pollOnce();
    await (poller as unknown as { pollOnce: () => Promise<void> }).pollOnce();

    const expectedReports = [
      {
        peak: 100n,
        records: [
          { coin: 'coin-a', created_height: 10n, spent_height: null },
          { coin: 'coin-b', created_height: 10n, spent_height: null },
        ],
      },
    ];
    expect(reports).toEqual(expectedReports);
    expect(heightOnlyPeaks).toEqual([100n, 100n]);
  });

  it('skips snapshots when returned records cannot be mapped to coin names', async () => {
    const recordA = makeCoinRecord(1);
    const nameA = await coinRecordToName(recordA);
    if (!nameA) {
      throw new Error('coinRecordToName returned undefined');
    }

    const malformedRecord = {
      ...recordA,
      coin: {
        ...recordA.coin,
        parentCoinInfo: '0x0',
      },
    };
    const rpc = new Proxy(
      {
        getHeightInfo: () => Promise.resolve(100n),
        registerCoins: () => Promise.resolve(),
        getCoinRecordsByNames: () => Promise.resolve([malformedRecord]),
      } as unknown as InternalBlockchainInterface,
      {
        get: (target, prop) =>
          (target as Record<string, unknown>)[prop as string] ?? (() => Promise.resolve(undefined)),
      },
    );
    const reports: Array<{
      peak: bigint;
      records: Array<{ coin: string; created_height: bigint | null; spent_height: bigint | null }>;
    }> = [];
    const cradle: PollingGameSession = {
      snapshotWatchedCoins: () => [{ coin_name: nameA, coin_string: 'coin-a' }],
      reportCoinStates: (peak, records) => {
        reports.push({ peak, records });
      },
      reportNewBlock: () => {},
    };

    const poller = new BlockchainPoller(rpc, 1000);
    poller.attachGameSession(cradle);

    await (poller as unknown as { pollOnce: () => Promise<void> }).pollOnce();

    expect(reports).toEqual([]);
  });

  it('reports a coin spent via spentBlockIndex even when the spent flag is false', async () => {
    // The WalletConnect bridge can return a spent coin with `spent:false` but a
    // real spentBlockIndex.  Spend detection must honor spentBlockIndex, or
    // channel/unroll/clean-shutdown spends are silently missed (which broke
    // clean-shutdown completion detection).
    const record = makeCoinRecord(7);
    record.spent = false;
    record.spentBlockIndex = 42n;
    const name = await coinRecordToName(record);
    if (!name) {
      throw new Error('coinRecordToName returned undefined');
    }

    const rpc = new Proxy(
      {
        getHeightInfo: () => Promise.resolve(100n),
        registerCoins: () => Promise.resolve(),
        getCoinRecordsByNames: () => Promise.resolve([record]),
      } as unknown as InternalBlockchainInterface,
      {
        get: (target, prop) =>
          (target as Record<string, unknown>)[prop as string] ?? (() => Promise.resolve(undefined)),
      },
    );
    const reports: Array<{
      peak: bigint;
      records: Array<{ coin: string; created_height: bigint | null; spent_height: bigint | null }>;
    }> = [];
    const cradle: PollingGameSession = {
      snapshotWatchedCoins: () => [{ coin_name: name, coin_string: 'coin-spent' }],
      reportCoinStates: (peak, records) => {
        reports.push({ peak, records });
      },
      reportNewBlock: () => {},
    };

    const poller = new BlockchainPoller(rpc, 1000);
    poller.attachGameSession(cradle);

    await (poller as unknown as { pollOnce: () => Promise<void> }).pollOnce();

    expect(reports).toEqual([
      {
        peak: 100n,
        records: [{ coin: 'coin-spent', created_height: 10n, spent_height: 42n }],
      },
    ]);
  });
});
