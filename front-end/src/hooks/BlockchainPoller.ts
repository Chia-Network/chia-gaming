import { InternalBlockchainInterface, CoinStateRecord } from '../types/ChiaGaming';
import { CoinRecord } from '../types/rpc/CoinRecord';
import { coinRecordToName } from '../util/coinWatch';
import { log, diagStack } from '../services/log';
import {
  AsyncJobQueue,
  AsyncQueueJob,
  AsyncPollingScheduler,
  AsyncPollingTarget,
} from '../lib/AsyncScheduler';

export const CHAIN_POLL_INTERVAL_MS = 10000;
export const BALANCE_POLL_INTERVAL_MS = 60000;
export const COIN_EVICTION_CONFIRMATION_DEPTH = 32n;

/**
 * A cradle that the poller drives with raw chain state.  The transaction
 * manager inside the WASM cradle owns the durable watched-coin set and computes
 * the created/deleted diff. The poller snapshots that semantic interest set
 * when the cradle attaches, then owns the repeated raw chain queries and runtime
 * watch deltas.
 */
export type CoinPollInterest = { coin_name: string; coin_string: string };

export interface PollingCradle {
  snapshotWatchedCoins(): CoinPollInterest[];
  reportCoinStates(peak: bigint, records: CoinStateRecord[]): void;
  // Advance to `peak` with no coin-state change.  Lets the poller deliver a
  // height tick as soon as the height is known, before the (possibly slow) coin
  // record lookup, so height-only progress (e.g. handshake new_block) isn't
  // gated on the coin-records RPC.
  reportNewBlock(peak: bigint): void;
}

type BalanceCallbacks = {
  onBalance: (balance: bigint) => void;
  onError?: (err: unknown) => void;
};

export class BlockchainPoller {
  readonly rpc: InternalBlockchainInterface;
  private readonly adapter: InternalBlockchainInterface;
  private cradles = new Set<PollingCradle>();
  private cradleCoins = new Map<PollingCradle, CoinPollInterest[]>();
  private registeredNames = new Set<string>();
  private observedNames = new Set<string>();
  private running = false;
  private pollIntervalMs: number;
  private maxBackoffMs: number;
  private firstTick = false;
  private startedAt = 0;
  private consecutiveFailures = 0;
  private peak = 0n;
  private previousPeakForCoinReport = 0n;
  private registrationScopeKey: string | undefined;
  private balanceCallbacks: BalanceCallbacks | null = null;
  private requestLane: AsyncJobQueue;
  private heightPollingScheduler: AsyncPollingScheduler;
  private coinPollingScheduler: AsyncPollingScheduler;
  private balancePollingScheduler: AsyncPollingScheduler;

  constructor(blockchain: InternalBlockchainInterface, pollIntervalMs: number, maxBackoffMs?: number) {
    this.adapter = blockchain;
    this.pollIntervalMs = pollIntervalMs;
    this.maxBackoffMs = maxBackoffMs ?? 60000;
    this.requestLane = new AsyncJobQueue({
      gapMs: blockchain.requestGapMs ?? 0,
      onError: (job, e) => {
        log(`[blockchain-poller] queued job failed label=${job.label}: ${String(e)}`);
      },
    });
    this.rpc = this.makeQueuedRpc(blockchain);
    const heightPollingTarget: AsyncPollingTarget = {
      runOnce: () => this.runHeightPoll(),
      getNextIntervalMs: () => this.currentBackoffMs(),
    };
    const coinPollingTarget: AsyncPollingTarget = {
      runOnce: () => this.runCoinPoll(),
      getNextIntervalMs: () => this.currentBackoffMs(),
    };
    const balancePollingTarget: AsyncPollingTarget = {
      runOnce: () => this.runBalancePoll(),
      onError: (e) => this.balanceCallbacks?.onError?.(e),
    };
    this.heightPollingScheduler = new AsyncPollingScheduler(
      {
        label: 'blockchain-height',
        queue: this.requestLane,
        intervalMs: this.pollIntervalMs,
      },
      heightPollingTarget,
    );
    this.coinPollingScheduler = new AsyncPollingScheduler(
      {
        label: 'blockchain-coins',
        queue: this.requestLane,
        intervalMs: this.pollIntervalMs,
      },
      coinPollingTarget,
    );
    this.balancePollingScheduler = new AsyncPollingScheduler(
      {
        label: 'blockchain-balance',
        queue: this.requestLane,
        intervalMs: BALANCE_POLL_INTERVAL_MS,
      },
      balancePollingTarget,
    );
  }

  private makeQueuedRpc(adapter: InternalBlockchainInterface): InternalBlockchainInterface {
    return {
      requestGapMs: adapter.requestGapMs,
      getRegistrationScopeKey: () => adapter.getRegistrationScopeKey?.(),
      spend: (blob, spendBundle, source, fee) =>
        this.enqueueRpc('spend', () => adapter.spend(blob, spendBundle, source, fee), true),
      rememberLocalRemovals: adapter.rememberLocalRemovals
        ? (spendBundle) => this.enqueueRpc(
          'rememberLocalRemovals',
          () => adapter.rememberLocalRemovals!(spendBundle),
          true,
        )
        : undefined,
      getAddress: () => this.enqueueRpc('getAddress', () => adapter.getAddress(), true),
      getBalance: () => this.enqueueRpc('getBalance', () => adapter.getBalance()),
      getPuzzleAndSolution: (coin) =>
        this.enqueueRpc('getPuzzleAndSolution', () => adapter.getPuzzleAndSolution(coin), true),
      selectCoins: (uniqueId, amount) =>
        this.enqueueRpc('selectCoins', () => adapter.selectCoins(uniqueId, amount), true),
      getHeightInfo: () => this.enqueueRpc('getHeightInfo', () => adapter.getHeightInfo()),
      createOfferForIds: (uniqueId, offer, extraConditions, coinIds, maxHeight) =>
        this.enqueueRpc(
          'createOfferForIds',
          () => adapter.createOfferForIds(uniqueId, offer, extraConditions, coinIds, maxHeight),
          true,
        ),
      getCoinRecordsByNames: (names) =>
        this.enqueueRpc('getCoinRecordsByNames', () => adapter.getCoinRecordsByNames(names)),
      registerCoins: (names) => this.enqueueRpc('registerCoins', () => adapter.registerCoins(names)),
      startMonitoring: () => this.enqueueRpc('startMonitoring', () => adapter.startMonitoring(), true),
      beginConnect: (uniqueId) => adapter.beginConnect(uniqueId),
      disconnect: () => adapter.disconnect(),
      isConnected: () => adapter.isConnected(),
      onConnectionChange: (cb) => adapter.onConnectionChange(cb),
    };
  }

  private enqueueRpc<T>(label: string, run: () => Promise<T> | T, foreground = false): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const job: AsyncQueueJob = {
        label,
        run: async () => {
          try {
            resolve(await run());
          } catch (e) {
            reject(e);
          }
        },
      };
      if (foreground) {
        this.requestLane.enqueueFront(job);
      } else {
        this.requestLane.enqueue(job);
      }
    });
  }

  attachCradle(cradle: PollingCradle) {
    this.cradles.add(cradle);
    this.snapshotCradleCoinInterest(cradle);
  }

  detachCradle(cradle: PollingCradle) {
    this.cradles.delete(cradle);
    this.cradleCoins.delete(cradle);
    this.refreshCoinInterest();
  }

  snapshotCradleCoinInterest(cradle: PollingCradle): void {
    if (!this.cradles.has(cradle)) return;
    this.cradleCoins.set(cradle, cradle.snapshotWatchedCoins());
    this.refreshCoinInterest();
  }

  watchCoin(cradle: PollingCradle, coin: CoinPollInterest): void {
    if (!this.cradles.has(cradle)) return;
    const byName = new Map(
      (this.cradleCoins.get(cradle) ?? []).map((existing) => [existing.coin_name, existing]),
    );
    byName.set(coin.coin_name, coin);
    this.cradleCoins.set(cradle, [...byName.values()]);
    this.refreshCoinInterest();
  }

  getPeak(): bigint {
    return this.peak;
  }

  startBalanceInterest(intervalMs: number, callbacks: BalanceCallbacks): void {
    this.balanceCallbacks = callbacks;
    this.balancePollingScheduler.start(intervalMs);
  }

  stopBalanceInterest(): void {
    this.balancePollingScheduler.stop();
    this.balanceCallbacks = null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.firstTick = true;
    this.startedAt = performance.now();
    log(`[blockchain-poller] started, pollMs=${this.pollIntervalMs}`);
    this.heightPollingScheduler.start(this.pollIntervalMs);
    this.refreshCoinInterest();
  }

  stop() {
    this.running = false;
    this.heightPollingScheduler.stop();
    this.coinPollingScheduler.stop();
    this.balancePollingScheduler.stop();
  }

  private collectCradleCoins(): Array<{ c: PollingCradle; coins: CoinPollInterest[] }> {
    return [...this.cradles].map((c) => ({ c, coins: this.cradleCoins.get(c) ?? [] }));
  }

  private refreshCoinInterest(): void {
    if (!this.running) return;
    const hasCoins = this.collectCradleCoins().some(({ coins }) => coins.length > 0);
    if (hasCoins) {
      this.coinPollingScheduler.start(this.pollIntervalMs);
    } else {
      this.coinPollingScheduler.stop();
    }
  }

  private async ensureRegistered(names: string[]) {
    this.syncRegistrationScope();
    const newNames = names.filter((n) => !this.registeredNames.has(n));
    if (newNames.length === 0) return;
    try {
      await this.adapter.registerCoins(newNames);
      for (const n of newNames) this.registeredNames.add(n);
    } catch (e) {
      // Leave unregistered so the next tick retries.
      log(`[blockchain-poller] registerCoins failed, will retry: ${String(e)}`);
    }
  }

  private syncRegistrationScope(): void {
    const nextScope = this.adapter.getRegistrationScopeKey?.();
    if (nextScope === this.registrationScopeKey) return;
    this.registrationScopeKey = nextScope;
    this.registeredNames.clear();
  }

  private async pollOnce(): Promise<void> {
    await this.runHeightPoll();
    await this.runCoinPoll();
  }

  private async runHeightPoll(): Promise<void> {
    try {
      // Report the latest height even when it decreases: a drop signals a reorg,
      // which the transaction manager detects via height < last_height. Clamping
      // this monotonically would hide reorgs from the manager.
      const previousPeak = this.peak;
      const height = await this.adapter.getHeightInfo();
      this.previousPeakForCoinReport = previousPeak;
      this.peak = height;

      // Deliver the height tick immediately, before the (potentially slow) coin
      // record lookup. A cradle's new_block only needs the height, so cradles
      // whose watched coins aren't on chain yet can advance right away.
      for (const { c } of this.collectCradleCoins()) {
        c.reportNewBlock(height);
      }

      if (this.firstTick) {
        this.firstTick = false;
        const elapsed = Math.round(performance.now() - this.startedAt);
        log(`[blockchain-poller] first height: height=${height} (${elapsed}ms)`);
      }
      this.consecutiveFailures = 0;
    } catch (e) {
      this.consecutiveFailures++;
      diagStack('blockchain-poller height failed', e);
      log(`[blockchain-poller] height failed: ${String(e)}`);
    }
  }

  private async runCoinPoll(): Promise<void> {
    try {
      const perCradle = this.collectCradleCoins();

      const allNames = new Set<string>();
      for (const { coins } of perCradle) {
        for (const { coin_name } of coins) allNames.add(coin_name);
      }
      const names = [...allNames];
      await this.ensureRegistered(names);
      // Only query coins we've successfully registered.  If a backend requires
      // registration, querying an unregistered name can throw and turn a transient
      // register failure into a polling failure loop; registration is retried each
      // tick, so the coin gets picked up once it registers.
      const namesToQuery = names.filter((n) => this.registeredNames.has(n));

      const records = namesToQuery.length > 0 ? await this.adapter.getCoinRecordsByNames(namesToQuery) : [];
      const recordByName = await this.recordMap(records);
      if (recordByName) {
        const reportedNames = this.reportToCradles(perCradle, recordByName, this.peak, this.previousPeakForCoinReport);
        this.evictBuriedSpentCoins(recordByName, reportedNames);
      }
      this.consecutiveFailures = 0;
    } catch (e) {
      this.consecutiveFailures++;
      diagStack('blockchain-poller coin poll failed', e);
      log(`[blockchain-poller] coin poll failed: ${String(e)}`);
    }
  }

  private evictBuriedSpentCoins(
    recordByName: Map<string, CoinRecord>,
    reportedNames: Set<string>,
  ): void {
    const evictedNames = new Set<string>();
    for (const name of reportedNames) {
      const rec = recordByName.get(name);
      if (!rec) continue;
      const spentHeight = rec.spent || rec.spentBlockIndex > 0n ? rec.spentBlockIndex : null;
      if (spentHeight !== null && this.peak >= spentHeight + COIN_EVICTION_CONFIRMATION_DEPTH) {
        evictedNames.add(name);
      }
    }
    if (evictedNames.size === 0) return;
    for (const [cradle, coins] of this.cradleCoins) {
      this.cradleCoins.set(
        cradle,
        coins.filter(({ coin_name }) => !evictedNames.has(coin_name)),
      );
    }
    this.refreshCoinInterest();
  }

  private async runBalancePoll(): Promise<void> {
    if (!this.balanceCallbacks) return;
    try {
      const balance = await this.adapter.getBalance();
      if (this.balancePollingScheduler.isInterested()) {
        this.balanceCallbacks?.onBalance(balance);
      }
    } catch (e) {
      this.balanceCallbacks?.onError?.(e);
    }
  }

  private async recordMap(records: CoinRecord[]): Promise<Map<string, CoinRecord> | null> {
    const recordByName = new Map<string, CoinRecord>();
    let hasUnmappedRecord = false;
    for (const rec of records) {
      const name = await coinRecordToName(rec);
      if (name) {
        recordByName.set(name, rec);
      } else {
        hasUnmappedRecord = true;
      }
    }
    for (const name of recordByName.keys()) this.observedNames.add(name);
    return hasUnmappedRecord ? null : recordByName;
  }

  // Hand each cradle its coin-state snapshot for `height`, applying the
  // partial-snapshot guards that keep transient RPC misses from looking like
  // deletions to the transaction manager.
  private reportToCradles(
    perCradle: Array<{ c: PollingCradle; coins: CoinPollInterest[] }>,
    recordByName: Map<string, CoinRecord>,
    height: bigint,
    previousPeak: bigint,
  ): Set<string> {
    const interestCounts = new Map<string, number>();
    const reportedCounts = new Map<string, number>();
    for (const { coins } of perCradle) {
      for (const { coin_name } of coins) {
        interestCounts.set(coin_name, (interestCounts.get(coin_name) ?? 0) + 1);
      }
    }
    for (const { c, coins } of perCradle) {
      if (coins.length === 0) {
        continue;
      }
      // Never hand the manager a partial snapshot.  If any of this cradle's
      // coins is still pending registration (so we couldn't query it), a coin
      // the manager already knows is live would be absent from the snapshot and
      // read as a deletion -- for a restored manager that looks like mass
      // spends and drives spurious on-chain transitions.  Registration retries
      // each tick, so reporting resumes once every coin is registered.
      if (coins.some(({ coin_name }) => !this.registeredNames.has(coin_name))) {
        continue;
      }
      // If a coin has previously appeared, a same-height/forward-height response
      // that omits it is ambiguous and can be a transient RPC miss.  Do not turn
      // that into a deletion.  Height decreases are different: they are the reorg
      // signal the transaction manager needs, so omissions must be forwarded.
      if (height >= previousPeak
          && coins.some(({ coin_name }) => this.observedNames.has(coin_name) && !recordByName.has(coin_name))) {
        continue;
      }
      const csr: CoinStateRecord[] = [];
      for (const { coin_name, coin_string } of coins) {
        const rec = recordByName.get(coin_name);
        if (!rec) continue; // not on chain yet
        // A returned record means the coin exists on chain, so confirmedBlockIndex
        // is its true creation height (including height 0); the record's presence,
        // not confirmedBlockIndex > 0, is what marks it created.
        //
        // A spend is anything the record shows as spent.  The `spent` boolean is
        // not reliably populated through the WalletConnect bridge (a coin can come
        // back spent on-chain with `spent:false` but a real spentBlockIndex), so
        // honor either signal -- spentBlockIndex is set whenever the coin is spent.
        // Relying on `spent` alone silently misses every channel/unroll/stale
        // spend, which is how clean-shutdown completion stopped being detected.
        const created = rec.confirmedBlockIndex;
        const spent = rec.spent || rec.spentBlockIndex > 0n ? rec.spentBlockIndex : null;
        csr.push({ coin: coin_string, created_height: created, spent_height: spent });
        reportedCounts.set(coin_name, (reportedCounts.get(coin_name) ?? 0) + 1);
      }
      csr.sort((a, b) => a.coin.localeCompare(b.coin));
      c.reportCoinStates(height, csr);
    }
    const fullyReportedNames = new Set<string>();
    for (const [name, count] of reportedCounts) {
      if (count === interestCounts.get(name)) fullyReportedNames.add(name);
    }
    return fullyReportedNames;
  }

  private currentBackoffMs(): number {
    return this.consecutiveFailures > 0
      ? Math.min(this.pollIntervalMs * 2 ** this.consecutiveFailures, this.maxBackoffMs)
      : this.pollIntervalMs;
  }
}
