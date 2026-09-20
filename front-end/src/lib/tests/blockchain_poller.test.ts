import { BlockchainPoller, PollingGameSession } from '../../hooks/BlockchainPoller';
import { activate, deactivate } from '../../hooks/activeBlockchain';
import { InternalBlockchainInterface, WalletSubmitOutcome } from '../../types/ChiaGaming';
import { CoinRecord } from '../../types/rpc/CoinRecord';
import { coinRecordToName } from '../../util/coinWatch';
import { ensureConnectionListener, pollOnce } from './blockchain_poller.driver';
import { walletReservationLedger } from '../session/walletReservationLedger';

const walletOperation = {
  owner: {
    installationPlayerId: 'installation',
    peerSessionId: 'peer-session',
    providerScope: { provider: 'simulator' as const, identity: 'installation' },
  },
  purpose: { kind: 'funding' as const, operationId: 'funding-operation' },
};
const walletRequest = {
  kind: 'funding' as const,
  uniqueId: 'wallet',
  offer: { '1': -1n },
};

function makeRpc(heights: bigint[]): InternalBlockchainInterface {
  let lastHeight = heights[0] ?? 0n;
  return new Proxy(
    {
      getHeightInfo: () => {
        lastHeight = heights.shift() ?? lastHeight;
        return Promise.resolve(lastHeight);
      },
      registerCoins: () => Promise.resolve(),
      getCoinRecordsByNames: () => Promise.resolve([]),
      getWalletOfferProvider(this: Record<string, any>) {
        return {
          capability: 'best-effort' as const,
          scope: walletOperation.owner.providerScope,
          beginCreation: (operation, request) => this.beginWalletOffer(operation, request),
          cancel: (tradeId) => this.beginWalletOfferCancellation(tradeId),
        };
      },
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
    const rpc = makeRpc([100n, 100n, 90n, 90n]);
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
    await pollOnce(poller);
    await pollOnce(poller);

    expect(reportedPeaks).toEqual([100n, 90n]);
    expect(poller.getPeak()).toEqual(90n);
  });

  it('isolates a failing session from healthy height and snapshot delivery', async () => {
    const rpc = makeRpc([100n, 100n, 101n, 101n]);
    const failing: PollingGameSession = {
      snapshotWatchedCoins: () => [{ coin_name: 'bad', coin_string: 'bad-coin' }],
      reportNewBlock: () => Promise.reject(new Error('session-owned height failure')),
      reportCoinStates: () => Promise.reject(new Error('session-owned snapshot failure')),
    };
    const healthyHeights: bigint[] = [];
    const healthySnapshots: bigint[] = [];
    const healthy: PollingGameSession = {
      snapshotWatchedCoins: () => [{ coin_name: 'good', coin_string: 'good-coin' }],
      reportNewBlock: (height) => {
        healthyHeights.push(height);
      },
      reportCoinStates: (height) => {
        healthySnapshots.push(height);
      },
    };
    const poller = new BlockchainPoller(rpc, 1000);
    poller.attachGameSession(failing);
    poller.attachGameSession(healthy);

    await pollOnce(poller);
    await pollOnce(poller);

    expect(healthyHeights).toEqual([100n, 101n]);
    expect(healthySnapshots).toEqual([100n, 101n]);
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
    await pollOnce(poller);
    expect(reportedPeaks).toEqual([]);
    expect(heightOnlyPeaks).toEqual([100n]);

    // Registration succeeds on the retry: the cradle is reported.
    registerOk = true;
    await pollOnce(poller);
    expect(reportedPeaks).toEqual([100n]);
    expect(heightOnlyPeaks).toEqual([100n, 100n]);
  });

  it('does not report an authoritative snapshot when the wallet batch fails', async () => {
    const rpc = new Proxy(
      {
        getHeightInfo: () => Promise.resolve(100n),
        registerCoins: () => Promise.resolve(),
        getCoinRecordsByNames: () => Promise.reject(new Error('wallet unavailable')),
      } as unknown as InternalBlockchainInterface,
      {
        get: (target, prop) =>
          (target as Record<string, unknown>)[prop as string] ?? (() => Promise.resolve(undefined)),
      },
    );
    const reportCoinStates = jest.fn();
    const reportNewBlock = jest.fn();
    const cradle: PollingGameSession = {
      snapshotWatchedCoins: () => [{ coin_name: 'restored', coin_string: 'restored-coin' }],
      reportCoinStates,
      reportNewBlock,
    };
    const poller = new BlockchainPoller(rpc, 1000);
    poller.attachGameSession(cradle);

    await pollOnce(poller);

    expect(reportCoinStates).not.toHaveBeenCalled();
    expect(reportNewBlock).toHaveBeenCalledWith(100n);
  });

  it('retries when the chain advances between the coin and closing-peak reads', async () => {
    const record = makeCoinRecord(3);
    record.confirmedBlockIndex = 101n;
    const name = await coinRecordToName(record);
    if (!name) {
      throw new Error('coinRecordToName returned undefined');
    }
    const getCoinRecordsByNames = jest.fn().mockResolvedValue([record]);
    const rpc = new Proxy(
      {
        getHeightInfo: jest.fn().mockResolvedValueOnce(100n).mockResolvedValue(101n),
        registerCoins: () => Promise.resolve(),
        getCoinRecordsByNames,
      } as unknown as InternalBlockchainInterface,
      {
        get: (target, prop) =>
          (target as Record<string, unknown>)[prop as string] ?? (() => Promise.resolve(undefined)),
      },
    );
    const reportCoinStates = jest.fn();
    const cradle: PollingGameSession = {
      snapshotWatchedCoins: () => [{ coin_name: name, coin_string: 'coin-advanced' }],
      reportCoinStates,
      reportNewBlock: () => {},
    };
    const poller = new BlockchainPoller(rpc, 1000);
    poller.attachGameSession(cradle);

    await pollOnce(poller);

    expect(getCoinRecordsByNames).toHaveBeenCalledTimes(2);
    expect(reportCoinStates).toHaveBeenCalledWith(101n, [
      { coin: 'coin-advanced', created_height: 101n, spent_height: null },
    ]);
    expect(poller.getPeak()).toBe(101n);
  });

  it('never reports a record whose confirmed or spent height exceeds the snapshot peak', async () => {
    const record = makeCoinRecord(4);
    record.confirmedBlockIndex = 101n;
    record.spentBlockIndex = 102n;
    record.spent = true;
    const name = await coinRecordToName(record);
    if (!name) {
      throw new Error('coinRecordToName returned undefined');
    }
    const getCoinRecordsByNames = jest.fn().mockResolvedValue([record]);
    const rpc = new Proxy(
      {
        getHeightInfo: jest.fn().mockResolvedValue(100n),
        registerCoins: () => Promise.resolve(),
        getCoinRecordsByNames,
      } as unknown as InternalBlockchainInterface,
      {
        get: (target, prop) =>
          (target as Record<string, unknown>)[prop as string] ?? (() => Promise.resolve(undefined)),
      },
    );
    const reportCoinStates = jest.fn();
    const cradle: PollingGameSession = {
      snapshotWatchedCoins: () => [{ coin_name: name, coin_string: 'coin-future' }],
      reportCoinStates,
      reportNewBlock: () => {},
    };
    const poller = new BlockchainPoller(rpc, 1000);
    poller.attachGameSession(cradle);

    await pollOnce(poller);

    expect(getCoinRecordsByNames).toHaveBeenCalledTimes(3);
    expect(reportCoinStates).not.toHaveBeenCalled();
  });

  it('does not report records when the closing peak request fails', async () => {
    const record = makeCoinRecord(5);
    const name = await coinRecordToName(record);
    if (!name) {
      throw new Error('coinRecordToName returned undefined');
    }
    const getHeightInfo = jest
      .fn()
      .mockResolvedValueOnce(100n)
      .mockRejectedValueOnce(new Error('peak unavailable'));
    const rpc = new Proxy(
      {
        getHeightInfo,
        registerCoins: () => Promise.resolve(),
        getCoinRecordsByNames: () => Promise.resolve([record]),
      } as unknown as InternalBlockchainInterface,
      {
        get: (target, prop) =>
          (target as Record<string, unknown>)[prop as string] ?? (() => Promise.resolve(undefined)),
      },
    );
    const reportCoinStates = jest.fn();
    const cradle: PollingGameSession = {
      snapshotWatchedCoins: () => [{ coin_name: name, coin_string: 'coin-provider-failure' }],
      reportCoinStates,
      reportNewBlock: () => {},
    };
    const poller = new BlockchainPoller(rpc, 1000);
    poller.attachGameSession(cradle);

    await pollOnce(poller);

    expect(getHeightInfo).toHaveBeenCalledTimes(2);
    expect(reportCoinStates).not.toHaveBeenCalled();
  });

  it('reports coherent lower and equal-tip replacement snapshots without clamping', async () => {
    const initial = makeCoinRecord(6);
    const replacement = { ...initial, confirmedBlockIndex: 20n };
    const name = await coinRecordToName(initial);
    if (!name) {
      throw new Error('coinRecordToName returned undefined');
    }
    const responses: CoinRecord[][] = [[initial], [replacement], []];
    const rpc = new Proxy(
      {
        getHeightInfo: jest
          .fn()
          .mockResolvedValueOnce(100n)
          .mockResolvedValueOnce(100n)
          .mockResolvedValueOnce(90n)
          .mockResolvedValueOnce(90n)
          .mockResolvedValue(90n),
        registerCoins: () => Promise.resolve(),
        getCoinRecordsByNames: () => Promise.resolve(responses.shift() ?? []),
      } as unknown as InternalBlockchainInterface,
      {
        get: (target, prop) =>
          (target as Record<string, unknown>)[prop as string] ?? (() => Promise.resolve(undefined)),
      },
    );
    const reports: Array<{ peak: bigint; records: CoinStateRecord[] }> = [];
    const cradle: PollingGameSession = {
      snapshotWatchedCoins: () => [{ coin_name: name, coin_string: 'coin-replaced' }],
      reportCoinStates: (peak, records) => reports.push({ peak, records }),
      reportNewBlock: () => {},
    };
    const poller = new BlockchainPoller(rpc, 1000);
    poller.attachGameSession(cradle);

    await pollOnce(poller);
    await pollOnce(poller);
    await pollOnce(poller);

    expect(reports).toEqual([
      {
        peak: 100n,
        records: [{ coin: 'coin-replaced', created_height: 10n, spent_height: null }],
      },
      {
        peak: 90n,
        records: [{ coin: 'coin-replaced', created_height: 20n, spent_height: null }],
      },
      {
        peak: 90n,
        records: [{ coin: 'coin-replaced', created_height: null, spent_height: null }],
      },
    ]);
  });

  it('does not report an in-flight coin snapshot to a detached session', async () => {
    const record = makeCoinRecord(7);
    const name = await coinRecordToName(record);
    if (!name) {
      throw new Error('coinRecordToName returned undefined');
    }
    const recordsRequested = deferred<void>();
    const records = deferred<CoinRecord[]>();
    const rpc = new Proxy(
      {
        getHeightInfo: () => Promise.resolve(100n),
        registerCoins: () => Promise.resolve(),
        getCoinRecordsByNames: () => {
          recordsRequested.resolve();
          return records.promise;
        },
      } as unknown as InternalBlockchainInterface,
      {
        get: (target, prop) =>
          (target as Record<string, unknown>)[prop as string] ?? (() => Promise.resolve(undefined)),
      },
    );
    const reportCoinStates = jest.fn();
    const cradle: PollingGameSession = {
      snapshotWatchedCoins: () => [{ coin_name: name, coin_string: 'detached-coin' }],
      reportCoinStates,
      reportNewBlock: () => {},
    };
    const poller = new BlockchainPoller(rpc, 1000);
    poller.attachGameSession(cradle);

    const poll = pollOnce(poller);
    await recordsRequested.promise;
    poller.detachGameSession(cradle);
    records.resolve([record]);
    await poll;

    expect(reportCoinStates).not.toHaveBeenCalled();
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

    await pollOnce(poller);

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

    await pollOnce(poller);
    interests = [{ coin_name: 'bb', coin_string: 'coin-b' }];
    await pollOnce(poller);
    expect(snapshotCalls).toBe(1);
    expect(queriedNames).toEqual([['aa'], ['aa']]);

    poller.watchCoin(cradle, { coin_name: 'bb', coin_string: 'coin-b' });
    expect(snapshotCalls).toBe(1);
    await pollOnce(poller);
    expect(queriedNames).toEqual([['aa'], ['aa'], ['aa', 'bb']]);
  });

  it('preserves prior interests when an authoritative resnapshot fails', () => {
    let fail = false;
    const cradle: PollingGameSession = {
      snapshotWatchedCoins: () => {
        if (fail) throw new Error('WASM watch query failed');
        return [{ coin_name: 'aa', coin_string: 'coin-a' }];
      },
      reportCoinStates: () => {},
      reportNewBlock: () => {},
    };
    const poller = new BlockchainPoller(makeRpc([100n]), 1000);
    poller.attachGameSession(cradle);

    fail = true;
    expect(() => poller.snapshotGameSessionCoinInterest(cradle)).toThrow('WASM watch query failed');
    expect(
      (
        poller as unknown as {
          sessionCoins: Map<PollingGameSession, Array<{ coin_name: string; coin_string: string }>>;
        }
      ).sessionCoins.get(cradle),
    ).toEqual([{ coin_name: 'aa', coin_string: 'coin-a' }]);
  });

  it('serializes public read RPC calls through the read lane', async () => {
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

  it('serializes explicit polls behind active read work', async () => {
    jest.useFakeTimers();
    const activeRead = deferred<bigint>();
    const calls: string[] = [];
    let heightCalls = 0;
    const rpc = new Proxy(
      {
        getHeightInfo: () => {
          calls.push('height');
          heightCalls += 1;
          return heightCalls === 1 ? activeRead.promise : Promise.resolve(7n);
        },
      } as unknown as InternalBlockchainInterface,
      {
        get: (target, prop) =>
          (target as Record<string, unknown>)[prop as string] ?? (() => Promise.resolve(undefined)),
      },
    );
    const poller = new BlockchainPoller(rpc, 1000);

    const read = poller.rpc.getHeightInfo();
    await advanceLane();
    const explicitPoll = pollOnce(poller);
    await advanceLane();
    expect(calls).toEqual(['height']);

    activeRead.resolve(6n);
    await expect(read).resolves.toBe(6n);
    await expect(explicitPoll).resolves.toBeUndefined();
    expect(calls).toEqual(['height', 'height', 'height']);
    jest.useRealTimers();
  });

  it('spaces starts across lanes without waiting for read completion', async () => {
    jest.useFakeTimers();
    const read = deferred<bigint>();
    const mutation = deferred<string | null>();
    const starts: Array<{ label: string; at: number }> = [];
    const rpc = new Proxy(
      {
        requestGapMs: 50,
        getHeightInfo: () => {
          starts.push({ label: 'read', at: performance.now() });
          return read.promise;
        },
        selectCoins: () => {
          starts.push({ label: 'mutation', at: performance.now() });
          return mutation.promise;
        },
      } as unknown as InternalBlockchainInterface,
      {
        get: (target, prop) =>
          (target as Record<string, unknown>)[prop as string] ?? (() => Promise.resolve(undefined)),
      },
    );
    const poller = new BlockchainPoller(rpc, 1000);

    const readResult = poller.rpc.getHeightInfo();
    await advanceLane(0);
    expect(starts).toEqual([{ label: 'read', at: 0 }]);

    const mutationResult = poller.rpc.selectCoins('wallet', 1n);
    await advanceLane(49);
    expect(starts).toHaveLength(1);
    await advanceLane(1);
    expect(starts).toEqual([
      { label: 'read', at: 0 },
      { label: 'mutation', at: 50 },
    ]);

    read.resolve(7n);
    mutation.resolve(null);
    await expect(readResult).resolves.toBe(7n);
    await expect(mutationResult).resolves.toBeNull();
    jest.useRealTimers();
  });

  it('runs serialized wallet mutations independently of queued reads', async () => {
    jest.useFakeTimers();
    const first = deferred<bigint>();
    const createOffer = deferred<unknown>();
    const selectCoins = deferred<string | null>();
    const spend = deferred<WalletSubmitOutcome>();
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
        beginWalletOffer: () => {
          calls.push('beginWalletOffer');
          return createOffer.promise;
        },
        getWalletOfferProvider() {
          return {
            capability: 'best-effort' as const,
            scope: walletOperation.owner.providerScope,
            beginCreation: () => {
              calls.push('beginWalletOffer');
              return createOffer.promise as any;
            },
            cancel: jest.fn(),
          };
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
    const p3 = poller.rpc
      .getWalletOfferProvider(walletOperation.owner)!
      .beginCreation(walletOperation, walletRequest);
    const p4 = poller.rpc.selectCoins('u', 1n);
    const p5 = poller.rpc.spend('blob', {}, '11'.repeat(32), 'submitTransaction', 0n);

    await advanceLane();
    expect(calls).toEqual(['height', 'beginWalletOffer']);
    createOffer.resolve({});
    await advanceLane();
    expect(calls).toEqual(['height', 'beginWalletOffer', 'selectCoins']);
    selectCoins.resolve(null);
    await advanceLane();
    expect(calls).toEqual(['height', 'beginWalletOffer', 'selectCoins', 'spend']);
    spend.resolve({ status: 'acknowledged' });
    await advanceLane();
    expect(calls).toEqual(['height', 'beginWalletOffer', 'selectCoins', 'spend']);

    first.resolve(7n);
    await advanceLane();
    expect(calls).toEqual(['height', 'beginWalletOffer', 'selectCoins', 'spend', 'balance']);
    balance.resolve(11n);
    await expect(p1).resolves.toBe(7n);
    await expect(p2).resolves.toBe(11n);
    await expect(p3).resolves.toEqual({});
    await expect(p4).resolves.toBeNull();
    await expect(p5).resolves.toEqual({ status: 'acknowledged' });
    jest.useRealTimers();
  });

  it('starts reads immediately but waits for successful ledger hydration before wallet mutation', async () => {
    walletReservationLedger.resetForTests(false);
    const getHeightInfo = jest.fn().mockResolvedValue(7n);
    const beginWalletOffer = jest.fn().mockResolvedValue({
      kind: 'created',
      material: { kind: 'offer', offer: 'offer-ready' },
      tradeId: 'trade-ready',
    });
    const poller = new BlockchainPoller(
      {
        getHeightInfo,
        getWalletOfferProvider: () => ({
          capability: 'best-effort' as const,
          scope: walletOperation.owner.providerScope,
          beginCreation: beginWalletOffer,
          cancel: jest.fn(),
        }),
        isConnected: () => true,
      } as unknown as InternalBlockchainInterface,
      1000,
    );

    const read = poller.rpc.getHeightInfo();
    const mutation = poller.rpc
      .getWalletOfferProvider(walletOperation.owner)!
      .beginCreation(walletOperation, walletRequest);
    await Promise.resolve();
    await expect(read).resolves.toBe(7n);
    expect(beginWalletOffer).not.toHaveBeenCalled();

    walletReservationLedger.hydrateFromDisk(null);
    await expect(mutation).resolves.toEqual({
      kind: 'created',
      material: { kind: 'offer', offer: 'offer-ready' },
      tradeId: 'trade-ready',
    });
    expect(beginWalletOffer).toHaveBeenCalledTimes(1);
    walletReservationLedger.resetForTests();
  });

  it('fails wallet mutation closed when ledger hydration is malformed', async () => {
    walletReservationLedger.resetForTests(false);
    const beginWalletOffer = jest.fn().mockResolvedValue({
      kind: 'created',
      material: { kind: 'offer', offer: 'must-not-launch' },
    });
    const poller = new BlockchainPoller(
      {
        getWalletOfferProvider: () => ({
          capability: 'best-effort' as const,
          scope: walletOperation.owner.providerScope,
          beginCreation: beginWalletOffer,
          cancel: jest.fn(),
        }),
        isConnected: () => true,
      } as unknown as InternalBlockchainInterface,
      1000,
    );

    const mutation = poller.rpc
      .getWalletOfferProvider(walletOperation.owner)!
      .beginCreation(walletOperation, walletRequest);
    expect(() => walletReservationLedger.hydrateFromDisk({ version: 2n })).toThrow();
    await expect(mutation).rejects.toThrow();
    expect(beginWalletOffer).not.toHaveBeenCalled();
    walletReservationLedger.resetForTests();
  });

  it('revalidates the connection epoch after waiting at the shared gate', async () => {
    jest.useFakeTimers();
    let connected = true;
    let onConnectionChange: ((next: boolean) => void) | undefined;
    const selected = deferred<string | null>();
    const selectCoins = jest.fn(() => selected.promise);
    const getHeightInfo = jest.fn().mockResolvedValue(100n);
    const rpc = {
      requestGapMs: 50,
      selectCoins,
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
    ensureConnectionListener(poller);

    const mutation = poller.rpc.selectCoins('wallet', 1n);
    const mutationRejection = expect(mutation).rejects.toThrow(
      'RPC request discarded during disconnect: selectCoins',
    );
    await advanceLane(0);
    expect(selectCoins).toHaveBeenCalledTimes(1);

    const staleRead = poller.rpc.getHeightInfo();
    const staleReadRejection = expect(staleRead).rejects.toThrow(
      'RPC request discarded during disconnect: getHeightInfo',
    );
    await advanceLane(25);
    connected = false;
    onConnectionChange?.(false);
    await staleReadRejection;

    connected = true;
    onConnectionChange?.(true);
    const freshRead = poller.rpc.getHeightInfo();
    await advanceLane(75);
    await expect(freshRead).resolves.toBe(100n);
    expect(getHeightInfo).toHaveBeenCalledTimes(1);

    selected.resolve(null);
    await mutationRejection;
    expect(selectCoins).toHaveBeenCalledTimes(1);
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
    expect(rpc.getHeightInfo).toHaveBeenCalledTimes(2);
    expect(rpc.registerCoins).toHaveBeenCalledTimes(1);
    expect(rpc.getCoinRecordsByNames).toHaveBeenCalledTimes(1);
    expect(rpc.getBalance).toHaveBeenCalledTimes(1);

    connected = false;
    onConnectionChange?.(false);
    await jest.advanceTimersByTimeAsync(5000);
    expect(rpc.getHeightInfo).toHaveBeenCalledTimes(2);
    expect(rpc.registerCoins).toHaveBeenCalledTimes(1);
    expect(rpc.getCoinRecordsByNames).toHaveBeenCalledTimes(1);
    expect(rpc.getBalance).toHaveBeenCalledTimes(1);

    connected = true;
    onConnectionChange?.(true);
    await jest.advanceTimersByTimeAsync(0);
    expect(rpc.getHeightInfo).toHaveBeenCalledTimes(4);
    expect(rpc.registerCoins).toHaveBeenCalledTimes(2);
    expect(rpc.getCoinRecordsByNames).toHaveBeenCalledTimes(2);
    expect(rpc.getBalance).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });

  it('runs fresh polling and urgent spend after reconnect while the old RPC remains hung', async () => {
    jest.useFakeTimers();
    let connected = true;
    let onConnectionChange: ((next: boolean) => void) | undefined;
    const firstHeight = deferred<bigint>();
    const getHeightInfo = jest
      .fn()
      .mockReturnValueOnce(firstHeight.promise)
      .mockResolvedValue(101n);
    const registerCoins = jest.fn().mockResolvedValue(undefined);
    const getCoinRecordsByNames = jest.fn().mockResolvedValue([]);
    const spend = jest.fn().mockResolvedValue({ status: 'acknowledged' });
    const rpc = {
      getHeightInfo,
      registerCoins,
      getCoinRecordsByNames,
      spend,
      isConnected: () => connected,
      onConnectionChange: (callback: (next: boolean) => void) => {
        onConnectionChange = callback;
        return () => {
          onConnectionChange = undefined;
        };
      },
    } as unknown as InternalBlockchainInterface;
    const reportNewBlock = jest.fn();
    const reportCoinStates = jest.fn();
    const cradle: PollingGameSession = {
      snapshotWatchedCoins: () => [{ coin_name: 'aa', coin_string: 'coin-a' }],
      reportNewBlock,
      reportCoinStates,
    };
    const poller = new BlockchainPoller(rpc, 1000);
    poller.attachGameSession(cradle);
    poller.start();

    await advanceLane(0);
    expect(getHeightInfo).toHaveBeenCalledTimes(1);

    connected = false;
    onConnectionChange?.(false);
    connected = true;
    onConnectionChange?.(true);
    const spendResult = poller.rpc.spend('blob', {}, '11'.repeat(32), 'submitTransaction', 0n);

    await advanceLane(0);
    expect(getHeightInfo).toHaveBeenCalledTimes(3);
    expect(registerCoins).toHaveBeenCalledTimes(1);
    expect(getCoinRecordsByNames).toHaveBeenCalledTimes(1);
    expect(spend).toHaveBeenCalledTimes(1);
    expect(reportNewBlock).toHaveBeenCalledWith(101n);
    expect(reportCoinStates).toHaveBeenCalledWith(101n, [
      { coin: 'coin-a', created_height: null, spent_height: null },
    ]);
    await expect(spendResult).resolves.toEqual({ status: 'acknowledged' });
    jest.useRealTimers();
  });

  it('does not overlap an active wallet mutation with its reconnect replacement', async () => {
    jest.useFakeTimers();
    let connected = true;
    let onConnectionChange: ((next: boolean) => void) | undefined;
    const firstSpend = deferred<WalletSubmitOutcome>();
    let activeSpends = 0;
    let maxActiveSpends = 0;
    const spend = jest
      .fn()
      .mockImplementationOnce(async () => {
        activeSpends++;
        maxActiveSpends = Math.max(maxActiveSpends, activeSpends);
        try {
          return await firstSpend.promise;
        } finally {
          activeSpends--;
        }
      })
      .mockImplementationOnce(async () => {
        activeSpends++;
        maxActiveSpends = Math.max(maxActiveSpends, activeSpends);
        activeSpends--;
        return { status: 'acknowledged' };
      });
    const rpc = {
      spend,
      isConnected: () => connected,
      onConnectionChange: (callback: (next: boolean) => void) => {
        onConnectionChange = callback;
        return () => {
          onConnectionChange = undefined;
        };
      },
    } as unknown as InternalBlockchainInterface;
    const poller = new BlockchainPoller(rpc, 1000);
    poller.startBalanceInterest(1000, { onBalance: () => {} });

    const stale = poller.rpc.spend('first', {}, '11'.repeat(32));
    await advanceLane(0);
    expect(spend).toHaveBeenCalledTimes(1);

    connected = false;
    onConnectionChange?.(false);
    await expect(stale).resolves.toMatchObject({ status: 'unavailable' });
    connected = true;
    onConnectionChange?.(true);
    const replacement = poller.rpc.spend('second', {}, '22'.repeat(32));
    await advanceLane(0);
    expect(spend).toHaveBeenCalledTimes(1);

    firstSpend.resolve({ status: 'acknowledged' });
    await advanceLane(0);
    expect(spend).toHaveBeenCalledTimes(2);
    await expect(replacement).resolves.toEqual({ status: 'acknowledged' });
    expect(maxActiveSpends).toBe(1);
    jest.useRealTimers();
  });

  it('returns a stale successful wallet offer to durable lifecycle ownership', async () => {
    jest.useFakeTimers();
    walletReservationLedger.resetForTests();
    let connected = true;
    let onConnectionChange: ((next: boolean) => void) | undefined;
    const firstOffer = deferred<{
      kind: 'created';
      material: { kind: 'offer'; offer: string };
      tradeId: string;
    }>();
    const beginWalletOffer = jest
      .fn()
      .mockReturnValueOnce(firstOffer.promise)
      .mockResolvedValueOnce({
        kind: 'created',
        material: { kind: 'offer', offer: 'offer-new' },
        tradeId: 'trade-new',
      });
    const beginWalletOfferCancellation = jest
      .fn()
      .mockResolvedValue({ status: 'unavailable', detail: 'wallet offline' });
    const rpc = {
      getWalletOfferProvider: () => ({
        capability: 'best-effort' as const,
        scope: walletOperation.owner.providerScope,
        beginCreation: beginWalletOffer,
        cancel: beginWalletOfferCancellation,
      }),
      isConnected: () => connected,
      onConnectionChange: (callback: (next: boolean) => void) => {
        onConnectionChange = callback;
        return () => {
          onConnectionChange = undefined;
        };
      },
    } as unknown as InternalBlockchainInterface;
    const poller = new BlockchainPoller(rpc, 1000);
    walletReservationLedger.attachProvider(poller.rpc.getWalletOfferProvider()!);
    poller.startBalanceInterest(1000, { onBalance: () => {} });

    const stale = walletReservationLedger.createOffer(
      walletOperation.owner,
      walletOperation.purpose,
      { ...walletRequest, uniqueId: 'old' },
      {
        kind: 'funding',
        canonical: { amount: '1', fee: '0', conditions: [] },
      },
    );
    await advanceLane(0);
    connected = false;
    onConnectionChange?.(false);
    connected = true;
    onConnectionChange?.(true);

    firstOffer.resolve({
      kind: 'created',
      material: { kind: 'offer', offer: 'offer-old' },
      tradeId: 'trade-old',
    });
    await advanceLane(0);
    await expect(stale).resolves.toEqual({
      kind: 'created',
      material: { kind: 'offer', offer: 'offer-old' },
      tradeId: 'trade-old',
    });
    walletReservationLedger.settleOperation(
      walletOperation.owner,
      walletOperation.purpose,
      'cancel-required',
      'stale-completion',
    );
    await advanceLane(0);
    expect(beginWalletOffer).toHaveBeenCalledTimes(1);
    expect(beginWalletOfferCancellation).toHaveBeenCalledWith('trade-old');
    expect(walletReservationLedger.entriesFor(walletOperation.owner)).toEqual([
      expect.objectContaining({ tradeId: 'trade-old', stage: 'cancel-required' }),
    ]);
    await advanceLane(0);
    expect(beginWalletOfferCancellation).toHaveBeenCalledTimes(1);
    walletReservationLedger.resetForTests();
    jest.useRealTimers();
  });

  it('does not let an inactive constructed poller steal ledger RPC ownership', async () => {
    walletReservationLedger.resetForTests();
    const activeRelease = jest.fn().mockResolvedValue({ status: 'cancelled' });
    const inactiveRelease = jest.fn().mockResolvedValue({ status: 'cancelled' });
    const activeRpc = {
      getWalletOfferProvider: () => ({
        capability: 'best-effort' as const,
        scope: {
          provider: 'simulator' as const,
          identity: 'installation',
        },
        beginCreation: jest.fn(),
        cancel: activeRelease,
      }),
      onConnectionChange: () => () => {},
    } as unknown as InternalBlockchainInterface;
    walletReservationLedger.attachProvider(activeRpc.getWalletOfferProvider()!);
    new BlockchainPoller(
      {
        ...makeRpc([1n]),
        beginWalletOfferCancellation: inactiveRelease,
      },
      1000,
    );
    const owner = {
      installationPlayerId: 'installation',
      peerSessionId: 'peer-session',
      providerScope: { provider: 'simulator' as const, identity: 'installation' },
    };
    const purpose = { kind: 'fee' as const, operationId: 'submission' };

    walletReservationLedger.registerReserved('trade-active-owner', owner, purpose);
    walletReservationLedger.requireCancellation('trade-active-owner', 'wallet-outcome-finalized');
    await walletReservationLedger.awaitOwner(owner);

    expect(activeRelease).toHaveBeenCalledWith('trade-active-owner');
    expect(inactiveRelease).not.toHaveBeenCalled();
    walletReservationLedger.resetForTests();
  });

  it('detaches wallet recovery readiness while the active provider is disconnected', () => {
    jest.useFakeTimers();
    walletReservationLedger.resetForTests();
    let connected = true;
    const connectionListeners = new Set<(next: boolean) => void>();
    const sourceProvider = {
      capability: 'best-effort' as const,
      scope: walletOperation.owner.providerScope,
      beginCreation: jest.fn(),
      cancel: jest.fn(),
    };
    const rpc = makeRpc([1n]);
    rpc.getWalletOfferProvider = () => sourceProvider;
    rpc.isConnected = () => connected;
    rpc.onConnectionChange = (listener) => {
      connectionListeners.add(listener);
      return () => {
        connectionListeners.delete(listener);
      };
    };
    walletReservationLedger.registerReserved(
      'trade-provider-readiness',
      walletOperation.owner,
      walletOperation.purpose,
    );

    try {
      activate(rpc, 60_000);
      expect(walletReservationLedger.getRecoveryReadiness()).toBe('ready');

      connected = false;
      for (const listener of connectionListeners) listener(false);
      expect(walletReservationLedger.getRecoveryReadiness()).toBe('wallet-unavailable');

      connected = true;
      for (const listener of connectionListeners) listener(true);
      expect(walletReservationLedger.getRecoveryReadiness()).toBe('ready');
    } finally {
      deactivate();
      walletReservationLedger.resetForTests();
      jest.useRealTimers();
    }
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
    const selected = deferred<string | null>();
    const selectCoins = jest.fn(() => selected.promise);
    const beginWalletOffer = jest.fn();
    const rpc = {
      selectCoins,
      getWalletOfferProvider: () => ({
        capability: 'best-effort' as const,
        scope: walletOperation.owner.providerScope,
        beginCreation: beginWalletOffer,
        cancel: jest.fn(),
      }),
      isConnected: () => connected,
      onConnectionChange: (callback: (next: boolean) => void) => {
        onConnectionChange = callback;
        return () => {
          onConnectionChange = undefined;
        };
      },
    } as unknown as InternalBlockchainInterface;
    const poller = new BlockchainPoller(rpc, 1000);
    poller.startBalanceInterest(1000, { onBalance: () => {} });
    const walletRequest = poller.rpc.selectCoins('wallet', 1n);
    const feeRequest = poller.rpc.getWalletOfferProvider(walletOperation.owner)!.beginCreation(
      { ...walletOperation, purpose: { kind: 'fee', operationId: 'fee' } },
      {
        kind: 'fee',
        uniqueId: 'wallet',
        fee: 1n,
        concurrentSpendCoinId: 'fee-target',
      },
    );
    await advanceLane(0);
    expect(selectCoins).toHaveBeenCalledTimes(1);

    connected = false;
    onConnectionChange?.(false);
    await expect(walletRequest).rejects.toThrow(
      'RPC request discarded during disconnect: selectCoins',
    );
    await expect(poller.rpc.selectCoins('wallet', 1n)).rejects.toThrow(
      'RPC request discarded during disconnect: selectCoins',
    );
    await expect(poller.rpc.spend('blob', {}, '11'.repeat(32))).resolves.toEqual({
      status: 'unavailable',
      detail: 'RPC request discarded during disconnect: spend',
    });
    await expect(feeRequest).rejects.toThrow(
      'RPC request discarded during disconnect: beginWalletOffer',
    );
    expect(selectCoins).toHaveBeenCalledTimes(1);
    expect(beginWalletOffer).not.toHaveBeenCalled();

    selected.resolve(null);
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

    await pollOnce(poller);
    scope = '100';
    await pollOnce(poller);

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

    await pollOnce(poller);
    await pollOnce(poller);

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

  it('reports explicit absence for every omitted coin in a successful batch', async () => {
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

    await pollOnce(poller);
    await pollOnce(poller);

    const expectedReports = [
      {
        peak: 100n,
        records: [
          { coin: 'coin-a', created_height: 10n, spent_height: null },
          { coin: 'coin-b', created_height: 10n, spent_height: null },
        ],
      },
      {
        peak: 100n,
        records: [
          { coin: 'coin-a', created_height: 10n, spent_height: null },
          { coin: 'coin-b', created_height: null, spent_height: null },
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

    await pollOnce(poller);

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

    await pollOnce(poller);

    expect(reports).toEqual([
      {
        peak: 100n,
        records: [{ coin: 'coin-spent', created_height: 10n, spent_height: 42n }],
      },
    ]);
  });
});
