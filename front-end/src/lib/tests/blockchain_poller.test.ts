import { BlockchainPoller, PollingCradle } from '../../hooks/BlockchainPoller';
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
        (target as Record<string, unknown>)[prop as string] ??
        (() => Promise.resolve(undefined)),
    },
  );
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
    const cradle: PollingCradle = {
      getCoinsToPoll: () => [],
      reportCoinStates: (peak) => {
        reportedPeaks.push(peak);
      },
    };

    const poller = new BlockchainPoller(rpc, 1000);
    poller.attachCradle(cradle);

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
          (target as Record<string, unknown>)[prop as string] ??
          (() => Promise.resolve(undefined)),
      },
    );
    const reportedPeaks: bigint[] = [];
    const cradle: PollingCradle = {
      getCoinsToPoll: () => [{ coin_name: 'aabb', coin_string: 'coin-1' }],
      reportCoinStates: (peak) => {
        reportedPeaks.push(peak);
      },
    };

    const poller = new BlockchainPoller(rpc, 1000);
    poller.attachCradle(cradle);

    // Registration fails: no report (a partial snapshot would be misread).
    await (poller as unknown as { pollOnce: () => Promise<void> }).pollOnce();
    expect(reportedPeaks).toEqual([]);

    // Registration succeeds on the retry: the cradle is reported.
    registerOk = true;
    await (poller as unknown as { pollOnce: () => Promise<void> }).pollOnce();
    expect(reportedPeaks).toEqual([100n]);
  });

  it('skips transient partial snapshots for coins that were previously observed', async () => {
    const recordA = makeCoinRecord(1);
    const recordB = makeCoinRecord(2);
    const nameA = await coinRecordToName(recordA);
    const nameB = await coinRecordToName(recordB);
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
          (target as Record<string, unknown>)[prop as string] ??
          (() => Promise.resolve(undefined)),
      },
    );
    const reports: Array<{ peak: bigint; records: Array<{ coin: string; created_height: bigint | null; spent_height: bigint | null }> }> = [];
    const cradle: PollingCradle = {
      getCoinsToPoll: () => [
        { coin_name: nameA!, coin_string: 'coin-a' },
        { coin_name: nameB!, coin_string: 'coin-b' },
      ],
      reportCoinStates: (peak, records) => {
        reports.push({ peak, records });
      },
    };

    const poller = new BlockchainPoller(rpc, 1000);
    poller.attachCradle(cradle);

    await (poller as unknown as { pollOnce: () => Promise<void> }).pollOnce();
    await (poller as unknown as { pollOnce: () => Promise<void> }).pollOnce();

    expect(reports).toEqual([{
      peak: 100n,
      records: [
        { coin: 'coin-a', created_height: 10n, spent_height: null },
        { coin: 'coin-b', created_height: 10n, spent_height: null },
      ],
    }]);
  });
});
