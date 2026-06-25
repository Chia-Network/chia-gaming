import { BlockchainPoller, PollingCradle } from '../../hooks/BlockchainPoller';
import { InternalBlockchainInterface } from '../../types/ChiaGaming';
import { CoinRecord } from '../../types/rpc/CoinRecord';
import { coinRecordToName } from '../../util/coinWatch';

// DBG_POLLER_FLAKE: "skips transient partial snapshots" has flaked in CI but
// never reproduces locally. The only environment-dependent dependency in the
// path is crypto.subtle (via coinRecordToName). This helper captures runtime
// versions and crypto availability so the next CI failure is self-describing.
// Remove this block (and its uses below) once the flake is understood.
function envDiagObj(): Record<string, unknown> {
  const cr = globalThis.crypto as unknown as { subtle?: { digest?: unknown } } | undefined;
  return {
    nodeVersion: typeof process !== 'undefined' ? process.version : '(no process)',
    versions: typeof process !== 'undefined' ? process.versions : '(no process)',
    jestWorker: typeof process !== 'undefined' ? (process.env.JEST_WORKER_ID ?? '(none)') : '(no process)',
    cryptoType: typeof cr,
    subtleType: typeof cr?.subtle,
    digestType: typeof cr?.subtle?.digest,
  };
}

function envDiag(): string {
  try {
    return JSON.stringify(envDiagObj());
  } catch {
    return '(envDiag stringify failed)';
  }
}

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
      reportNewBlock: () => {},
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
      reportNewBlock: () => {},
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
    // DBG_POLLER_FLAKE: a fast assertion failure here in CI means
    // coinRecordToName returned undefined, i.e. crypto.subtle threw/was absent.
    // Surface that (with versions) instead of a bare "expected defined".
    if (!nameA || !nameB) {
      throw new Error(
        `DBG_POLLER_FLAKE coinRecordToName returned undefined ` +
        `(nameA=${String(nameA)} nameB=${String(nameB)}) env=${envDiag()}`,
      );
    }
    // DBG_POLLER_FLAKE: a collision (replaced/garbage digest from a polluting
    // global mock in the same worker) would make both coins map to one name.
    if (nameA === nameB) {
      throw new Error(`DBG_POLLER_FLAKE nameA === nameB (${nameA}); env=${envDiag()}`);
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
      reportNewBlock: () => {},
    };

    const poller = new BlockchainPoller(rpc, 1000);
    poller.attachCradle(cradle);

    await (poller as unknown as { pollOnce: () => Promise<void> }).pollOnce();
    await (poller as unknown as { pollOnce: () => Promise<void> }).pollOnce();

    const expectedReports = [{
      peak: 100n,
      records: [
        { coin: 'coin-a', created_height: 10n, spent_height: null },
        { coin: 'coin-b', created_height: 10n, spent_height: null },
      ],
    }];
    try {
      expect(reports).toEqual(expectedReports);
    } catch (e) {
      // DBG_POLLER_FLAKE: dump everything needed to tell apart the failure
      // modes -- 0 reports (skip mis-fired / coins absent), 1 wrong report,
      // or 2 reports (partial-snapshot skip didn't fire) -- plus env/versions.
      // The test script runs jest with --silent=false --useStderr, so this
      // shows up in CI logs.
      // eslint-disable-next-line no-console
      console.error('DBG_POLLER_FLAKE failure', {
        env: envDiagObj(),
        nameA,
        nameB,
        sameName: nameA === nameB,
        reportsCount: reports.length,
        reports,
      });
      throw e;
    }
  });

  it('skips snapshots when returned records cannot be mapped to coin names', async () => {
    const recordA = makeCoinRecord(1);
    const nameA = await coinRecordToName(recordA);
    if (!nameA) {
      throw new Error(`coinRecordToName returned undefined; env=${envDiag()}`);
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
          (target as Record<string, unknown>)[prop as string] ??
          (() => Promise.resolve(undefined)),
      },
    );
    const reports: Array<{ peak: bigint; records: Array<{ coin: string; created_height: bigint | null; spent_height: bigint | null }> }> = [];
    const cradle: PollingCradle = {
      getCoinsToPoll: () => [{ coin_name: nameA, coin_string: 'coin-a' }],
      reportCoinStates: (peak, records) => {
        reports.push({ peak, records });
      },
      reportNewBlock: () => {},
    };

    const poller = new BlockchainPoller(rpc, 1000);
    poller.attachCradle(cradle);

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
      throw new Error(`coinRecordToName returned undefined; env=${envDiag()}`);
    }

    const rpc = new Proxy(
      {
        getHeightInfo: () => Promise.resolve(100n),
        registerCoins: () => Promise.resolve(),
        getCoinRecordsByNames: () => Promise.resolve([record]),
      } as unknown as InternalBlockchainInterface,
      {
        get: (target, prop) =>
          (target as Record<string, unknown>)[prop as string] ??
          (() => Promise.resolve(undefined)),
      },
    );
    const reports: Array<{ peak: bigint; records: Array<{ coin: string; created_height: bigint | null; spent_height: bigint | null }> }> = [];
    const cradle: PollingCradle = {
      getCoinsToPoll: () => [{ coin_name: name, coin_string: 'coin-spent' }],
      reportCoinStates: (peak, records) => {
        reports.push({ peak, records });
      },
      reportNewBlock: () => {},
    };

    const poller = new BlockchainPoller(rpc, 1000);
    poller.attachCradle(cradle);

    await (poller as unknown as { pollOnce: () => Promise<void> }).pollOnce();

    expect(reports).toEqual([{
      peak: 100n,
      records: [{ coin: 'coin-spent', created_height: 10n, spent_height: 42n }],
    }]);
  });
});
