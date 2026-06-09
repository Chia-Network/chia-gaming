import { BlockchainPoller, PollingCradle } from '../../hooks/BlockchainPoller';
import { InternalBlockchainInterface } from '../../types/ChiaGaming';

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
});
