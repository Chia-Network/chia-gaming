import { InternalBlockchainInterface, CoinStateRecord } from '../types/ChiaGaming';
import { CoinRecord } from '../types/rpc/CoinRecord';
import { coinRecordToName } from '../util/coinWatch';
import { log, diagStack } from '../services/log';
import {
  AsyncJobQueue,
  AsyncJobQueueOptions,
  AsyncQueueJob,
  AsyncPollingScheduler,
  AsyncPollingTarget,
  AsyncRequestStartGate,
} from '../lib/AsyncScheduler';
import { walletReservationLedger } from '../lib/session/walletReservationLedger';

export const CHAIN_POLL_INTERVAL_MS = 10000;
export const BALANCE_POLL_INTERVAL_MS = 60000;
const MAX_COIN_SNAPSHOT_ATTEMPTS = 3;

class BlockchainRpcUnavailableError extends Error {
  constructor(label: string) {
    super(`RPC request discarded during disconnect: ${label}`);
    this.name = 'BlockchainRpcUnavailableError';
  }
}

/**
 * A cradle that the poller drives with raw chain state.  The transaction
 * manager inside the WASM cradle owns the durable watched-coin set and computes
 * the created/deleted diff. The poller snapshots that semantic interest set
 * when the cradle attaches, then owns the repeated raw chain queries and runtime
 * watch deltas.
 */
export type CoinPollInterest = { coin_name: string; coin_string: string };

export interface PollingGameSession {
  snapshotWatchedCoins(): CoinPollInterest[];
  /** Advance protocol clocks without asserting a complete coin snapshot. */
  reportNewBlock(peak: bigint): Promise<void> | void;
  reportCoinStates(peak: bigint, records: CoinStateRecord[]): Promise<void> | void;
}

type BalanceCallbacks = {
  onBalance: (balance: bigint) => void;
  onError?: (err: unknown) => void;
};

export class BlockchainPoller {
  readonly rpc: InternalBlockchainInterface;
  private readonly adapter: InternalBlockchainInterface;
  private sessions = new Set<PollingGameSession>();
  private sessionCoins = new Map<PollingGameSession, CoinPollInterest[]>();
  private registeredNames = new Set<string>();
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
  private balancePollIntervalMs = BALANCE_POLL_INTERVAL_MS;
  private readLane: AsyncJobQueue;
  private mutationLane: AsyncJobQueue;
  private heightPollingScheduler: AsyncPollingScheduler;
  private coinPollingScheduler: AsyncPollingScheduler;
  private balancePollingScheduler: AsyncPollingScheduler;
  private connectionUnsubscribe: (() => void) | null = null;
  private connectionActive = true;
  private connectionEpoch = 0;
  private pendingRpcRejects = new Set<() => void>();
  private requestStartGate: AsyncRequestStartGate;

  constructor(
    blockchain: InternalBlockchainInterface,
    pollIntervalMs: number,
    maxBackoffMs?: number,
  ) {
    this.adapter = blockchain;
    this.pollIntervalMs = pollIntervalMs;
    this.maxBackoffMs = maxBackoffMs ?? 60000;
    this.requestStartGate = new AsyncRequestStartGate(blockchain.requestGapMs ?? 0);
    const queueOptions: AsyncJobQueueOptions = {
      onError: (job, e) => {
        log(`[blockchain-poller] queued job failed label=${job.label}: ${String(e)}`);
      },
    };
    this.readLane = new AsyncJobQueue(queueOptions);
    this.mutationLane = new AsyncJobQueue(queueOptions);
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
        queue: this.readLane,
        intervalMs: this.pollIntervalMs,
      },
      heightPollingTarget,
    );
    this.coinPollingScheduler = new AsyncPollingScheduler(
      {
        label: 'blockchain-coins',
        queue: this.readLane,
        intervalMs: this.pollIntervalMs,
      },
      coinPollingTarget,
    );
    this.balancePollingScheduler = new AsyncPollingScheduler(
      {
        label: 'blockchain-balance',
        queue: this.readLane,
        intervalMs: BALANCE_POLL_INTERVAL_MS,
      },
      balancePollingTarget,
    );
  }

  private makeQueuedRpc(adapter: InternalBlockchainInterface): InternalBlockchainInterface {
    return {
      requestGapMs: adapter.requestGapMs,
      fundingMode: adapter.fundingMode,
      getWalletProviderScope: (owner) => adapter.getWalletProviderScope?.(owner) ?? null,
      getRegistrationScopeKey: () => adapter.getRegistrationScopeKey?.(),
      spend: async (blob, spendBundle, changePuzzleHash, source, fee) => {
        try {
          return await this.enqueueMutation('spend', () =>
            adapter.spend(blob, spendBundle, changePuzzleHash, source, fee),
          );
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          if (error instanceof BlockchainRpcUnavailableError) {
            return { status: 'unavailable', detail };
          }
          throw error;
        }
      },
      beginWalletOffer: (operation, request) =>
        this.enqueueMutation(
          'beginWalletOffer',
          () => adapter.beginWalletOffer(operation, request),
          true,
        ),
      reconcileWalletOffer: adapter.reconcileWalletOffer
        ? (operation, request, recoveryId) =>
            this.enqueueMutation(
              'reconcileWalletOffer',
              () => adapter.reconcileWalletOffer!(operation, request, recoveryId),
              true,
            )
        : undefined,
      beginWalletOfferCancellation: adapter.beginWalletOfferCancellation
        ? (tradeId) =>
            this.enqueueMutation('beginWalletOfferCancellation', () =>
              adapter.beginWalletOfferCancellation!(tradeId),
            )
        : undefined,
      reconcileWalletOfferCancellation: adapter.reconcileWalletOfferCancellation
        ? (tradeId, recoveryId) =>
            this.enqueueMutation('reconcileWalletOfferCancellation', () =>
              adapter.reconcileWalletOfferCancellation!(tradeId, recoveryId),
            )
        : undefined,
      getAddress: () => this.enqueueRead('getAddress', () => adapter.getAddress()),
      getBalance: () => this.enqueueRead('getBalance', () => adapter.getBalance()),
      getPuzzleAndSolution: (coin) =>
        this.enqueueRead('getPuzzleAndSolution', () => adapter.getPuzzleAndSolution(coin)),
      selectCoins: (uniqueId, amount) =>
        this.enqueueMutation('selectCoins', () => adapter.selectCoins(uniqueId, amount)),
      getHeightInfo: () => this.enqueueRead('getHeightInfo', () => adapter.getHeightInfo()),
      getCoinRecordsByNames: (names) =>
        this.enqueueRead('getCoinRecordsByNames', () => adapter.getCoinRecordsByNames(names)),
      registerCoins: (names) =>
        this.enqueueRead('registerCoins', () => adapter.registerCoins(names)),
      startMonitoring: () =>
        this.enqueueMutation('startMonitoring', () => adapter.startMonitoring()),
      beginConnect: (uniqueId) => adapter.beginConnect(uniqueId),
      disconnect: () => adapter.disconnect(),
      isConnected: () => adapter.isConnected(),
      onConnectionChange: (cb) => adapter.onConnectionChange(cb),
      isReadyForPlay: () => adapter.isReadyForPlay?.() ?? adapter.isConnected(),
      onPlayReadinessChange: (cb) => adapter.onPlayReadinessChange?.(cb) ?? (() => {}),
    };
  }

  private enqueueRead<T>(label: string, run: () => Promise<T> | T): Promise<T> {
    return this.enqueueRpc(this.readLane, label, run);
  }

  private enqueueMutation<T>(
    label: string,
    run: () => Promise<T> | T,
    preserveActiveCompletion = false,
  ): Promise<T> {
    return this.enqueueRpc(
      this.mutationLane,
      label,
      () => walletReservationLedger.runAfterHydration(run),
      preserveActiveCompletion,
    );
  }

  private enqueueRpc<T>(
    lane: AsyncJobQueue,
    label: string,
    run: () => Promise<T> | T,
    preserveActiveCompletion = false,
  ): Promise<T> {
    if (!this.isConnected()) {
      return Promise.reject(new BlockchainRpcUnavailableError(label));
    }
    const connectionEpoch = this.connectionEpoch;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const rejectForDisconnect = () => settle(reject, new BlockchainRpcUnavailableError(label));
      const settle = <V>(complete: (value: V) => void, value: V) => {
        if (settled) return;
        settled = true;
        this.pendingRpcRejects.delete(rejectForDisconnect);
        complete(value);
      };
      if (!preserveActiveCompletion) this.pendingRpcRejects.add(rejectForDisconnect);
      const job: AsyncQueueJob = {
        label,
        run: async () => {
          if (!this.isConnectionEpochActive(connectionEpoch)) {
            rejectForDisconnect();
            return;
          }
          try {
            const result = await this.runAdapterRpc(connectionEpoch, label, run);
            if (!this.isConnectionEpochActive(connectionEpoch)) {
              if (preserveActiveCompletion) {
                settle(resolve, result);
                return;
              }
              rejectForDisconnect();
              return;
            }
            settle(resolve, result);
          } catch (e) {
            settle(reject, e);
          }
        },
        onDiscard: rejectForDisconnect,
      };
      lane.enqueue(job);
    });
  }

  private async runAdapterRpc<T>(
    connectionEpoch: number,
    label: string,
    run: () => Promise<T> | T,
  ): Promise<T> {
    await this.requestStartGate.wait();
    if (!this.isConnectionEpochActive(connectionEpoch)) {
      throw new BlockchainRpcUnavailableError(label);
    }
    return run();
  }

  attachGameSession(cradle: PollingGameSession) {
    this.sessions.add(cradle);
    this.snapshotGameSessionCoinInterest(cradle);
  }

  detachGameSession(cradle: PollingGameSession) {
    this.sessions.delete(cradle);
    this.sessionCoins.delete(cradle);
    this.refreshCoinInterest();
  }

  snapshotGameSessionCoinInterest(
    cradle: PollingGameSession,
    watchedCoins?: CoinPollInterest[],
  ): void {
    if (!this.sessions.has(cradle)) return;
    const snapshot = watchedCoins ?? cradle.snapshotWatchedCoins();
    this.sessionCoins.set(cradle, snapshot);
    this.refreshCoinInterest();
  }

  watchCoin(cradle: PollingGameSession, coin: CoinPollInterest): void {
    if (!this.sessions.has(cradle)) return;
    const byName = new Map(
      (this.sessionCoins.get(cradle) ?? []).map((existing) => [existing.coin_name, existing]),
    );
    byName.set(coin.coin_name, coin);
    this.sessionCoins.set(cradle, [...byName.values()]);
    this.refreshCoinInterest();
  }

  unwatchCoin(cradle: PollingGameSession, coin: CoinPollInterest): void {
    if (!this.sessions.has(cradle)) return;
    const remaining = (this.sessionCoins.get(cradle) ?? []).filter(
      (existing) => existing.coin_name !== coin.coin_name,
    );
    this.sessionCoins.set(cradle, remaining);
    this.refreshCoinInterest();
  }

  getPeak(): bigint {
    return this.peak;
  }

  startBalanceInterest(intervalMs: number, callbacks: BalanceCallbacks): void {
    this.balanceCallbacks = callbacks;
    this.balancePollIntervalMs = intervalMs;
    this.ensureConnectionListener();
    if (this.isConnected()) {
      this.balancePollingScheduler.start(intervalMs);
    }
  }

  stopBalanceInterest(): void {
    this.balancePollingScheduler.stop();
    this.balanceCallbacks = null;
    this.releaseConnectionListenerIfIdle();
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.firstTick = true;
    this.startedAt = performance.now();
    log(`[blockchain-poller] started, pollMs=${this.pollIntervalMs}`);
    this.ensureConnectionListener();
    this.resumePollingIfConnected();
  }

  private ensureConnectionListener(): void {
    if (this.connectionUnsubscribe) return;
    const unsubscribe = this.adapter.onConnectionChange((connected) => {
      this.connectionActive = connected;
      if (connected) {
        this.resumePollingIfConnected();
      } else {
        this.pausePollingForDisconnect();
      }
    });
    if (typeof unsubscribe === 'function') {
      this.connectionUnsubscribe = unsubscribe;
    }
  }

  private releaseConnectionListenerIfIdle(): void {
    if (this.running || this.balanceCallbacks || !this.connectionUnsubscribe) return;
    this.connectionUnsubscribe();
    this.connectionUnsubscribe = null;
  }

  private pausePollingForDisconnect(): void {
    this.connectionEpoch++;
    this.heightPollingScheduler.stop();
    this.coinPollingScheduler.stop();
    this.balancePollingScheduler.stop();
    for (const reject of [...this.pendingRpcRejects]) reject();
    this.readLane.abandonActive();
    this.mutationLane.clearQueued();
    // Remote wallet coin registrations are lost with the connection. Clear the
    // local cache even when a reconnect reuses the same registration scope key.
    this.registrationScopeKey = undefined;
    this.registeredNames.clear();
  }

  private resumePollingIfConnected(): void {
    if (!this.adapter.isConnected()) return;
    if (this.running) {
      this.heightPollingScheduler.start(this.pollIntervalMs);
      this.refreshCoinInterest();
    }
    if (this.balanceCallbacks) {
      this.balancePollingScheduler.start(this.balancePollIntervalMs);
    }
  }

  private isConnected(): boolean {
    return this.connectionActive && this.adapter.isConnected();
  }

  private isConnectionEpochActive(connectionEpoch: number): boolean {
    return connectionEpoch === this.connectionEpoch && this.isConnected();
  }

  /**
   * Stop game-session height/coin watching. Does not stop wallet balance
   * interest — that is wallet-lifetime (`stopBalanceInterest` / deactivate).
   */
  stop() {
    this.running = false;
    this.heightPollingScheduler.stop();
    this.coinPollingScheduler.stop();
    this.releaseConnectionListenerIfIdle();
  }

  private collectGameSessionCoins(): Array<{ c: PollingGameSession; coins: CoinPollInterest[] }> {
    return [...this.sessions].map((c) => ({ c, coins: this.sessionCoins.get(c) ?? [] }));
  }

  private refreshCoinInterest(): void {
    if (!this.running || !this.isConnected()) {
      this.coinPollingScheduler.stop();
      return;
    }
    const hasCoins = this.collectGameSessionCoins().some(({ coins }) => coins.length > 0);
    if (hasCoins) {
      this.coinPollingScheduler.start(this.pollIntervalMs);
    } else {
      this.coinPollingScheduler.stop();
    }
  }

  private async ensureRegistered(names: string[], connectionEpoch: number) {
    if (!this.isConnectionEpochActive(connectionEpoch)) return;
    this.syncRegistrationScope();
    const newNames = names.filter((n) => !this.registeredNames.has(n));
    if (newNames.length === 0) return;
    try {
      await this.runAdapterRpc(connectionEpoch, 'registerCoins', () =>
        this.adapter.registerCoins(newNames),
      );
      if (!this.isConnectionEpochActive(connectionEpoch)) return;
      for (const n of newNames) this.registeredNames.add(n);
    } catch (e) {
      if (!this.isConnectionEpochActive(connectionEpoch)) return;
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

  private pollOnce(): Promise<void> {
    return this.enqueueRead('blockchain-explicit-poll', async () => {
      await this.runHeightPoll();
      await this.runCoinPoll();
    });
  }

  private async runHeightPoll(): Promise<void> {
    const connectionEpoch = this.connectionEpoch;
    if (!this.isConnectionEpochActive(connectionEpoch)) return;
    try {
      // Report the latest height even when it decreases: a drop signals a reorg,
      // which the transaction manager detects via height < last_height. Clamping
      // this monotonically would hide reorgs from the manager.
      const previousPeak = this.peak;
      const height = await this.runAdapterRpc(connectionEpoch, 'getHeightInfo', () =>
        this.adapter.getHeightInfo(),
      );
      if (!this.isConnectionEpochActive(connectionEpoch)) return;
      this.previousPeakForCoinReport = previousPeak;
      this.peak = height;
      // Advance every session as soon as a height is available, independently
      // of the slower watched-coin lookup. This is deliberately a
      // manager-owned height-only observation, not an empty coin snapshot.
      await Promise.allSettled(
        this.collectGameSessionCoins().map(({ c }) => Promise.resolve(c.reportNewBlock(height))),
      );

      if (this.firstTick) {
        this.firstTick = false;
        const elapsed = Math.round(performance.now() - this.startedAt);
        log(`[blockchain-poller] first height: height=${height} (${elapsed}ms)`);
      }
      this.consecutiveFailures = 0;
    } catch (e) {
      if (!this.running || !this.isConnectionEpochActive(connectionEpoch)) return;
      this.consecutiveFailures++;
      diagStack('blockchain-poller height failed', e);
      log(`[blockchain-poller] height failed: ${String(e)}`);
    }
  }

  private async runCoinPoll(): Promise<void> {
    const connectionEpoch = this.connectionEpoch;
    if (!this.isConnectionEpochActive(connectionEpoch)) return;
    try {
      const perSession = this.collectGameSessionCoins();

      const allNames = new Set<string>();
      for (const { coins } of perSession) {
        for (const { coin_name } of coins) allNames.add(coin_name);
      }
      const names = [...allNames];
      await this.ensureRegistered(names, connectionEpoch);
      if (!this.isConnectionEpochActive(connectionEpoch)) return;
      // Only query coins we've successfully registered.  If a backend requires
      // registration, querying an unregistered name can throw and turn a transient
      // register failure into a polling failure loop; registration is retried each
      // tick, so the coin gets picked up once it registers.
      const namesToQuery = names.filter((n) => this.registeredNames.has(n));

      let openingPeak = this.peak;
      for (let attempt = 1; attempt <= MAX_COIN_SNAPSHOT_ATTEMPTS; attempt++) {
        const records =
          namesToQuery.length > 0
            ? await this.runAdapterRpc(connectionEpoch, 'getCoinRecordsByNames', () =>
                this.adapter.getCoinRecordsByNames(namesToQuery),
              )
            : [];
        if (!this.isConnectionEpochActive(connectionEpoch)) return;
        // None of the current providers offers an atomic peak-and-records read.
        // Close the window immediately after the records query and retry if the
        // tip moved or the provider returned a record from above that boundary.
        const closingPeak = await this.runAdapterRpc(connectionEpoch, 'getHeightInfo', () =>
          this.adapter.getHeightInfo(),
        );
        if (!this.isConnectionEpochActive(connectionEpoch)) return;
        const coherent = openingPeak === closingPeak && this.recordsFitPeak(records, closingPeak);
        if (!coherent) {
          openingPeak = closingPeak;
          if (attempt < MAX_COIN_SNAPSHOT_ATTEMPTS) continue;
          throw new Error(
            `coin snapshot remained incoherent after ${MAX_COIN_SNAPSHOT_ATTEMPTS} attempts`,
          );
        }

        const recordByName = await this.recordMap(records, connectionEpoch);
        if (!this.isConnectionEpochActive(connectionEpoch)) return;
        if (recordByName) {
          this.peak = closingPeak;
          await this.reportToCradles(
            perSession,
            recordByName,
            closingPeak,
            this.previousPeakForCoinReport,
          );
        }
        this.consecutiveFailures = 0;
        return;
      }
    } catch (e) {
      if (!this.running || !this.isConnectionEpochActive(connectionEpoch)) return;
      this.consecutiveFailures++;
      diagStack('blockchain-poller coin poll failed', e);
      log(`[blockchain-poller] coin poll failed: ${String(e)}`);
    }
  }

  private recordsFitPeak(records: CoinRecord[], peak: bigint): boolean {
    return records.every(
      (record) =>
        record.confirmedBlockIndex <= peak &&
        (record.spentBlockIndex === 0n || record.spentBlockIndex <= peak),
    );
  }

  private async runBalancePoll(): Promise<void> {
    const connectionEpoch = this.connectionEpoch;
    if (!this.balanceCallbacks || !this.isConnectionEpochActive(connectionEpoch)) return;
    try {
      const balance = await this.runAdapterRpc(connectionEpoch, 'getBalance', () =>
        this.adapter.getBalance(),
      );
      if (
        this.isConnectionEpochActive(connectionEpoch) &&
        this.balancePollingScheduler.isInterested()
      ) {
        this.balanceCallbacks?.onBalance(balance);
      }
    } catch (e) {
      if (!this.isConnectionEpochActive(connectionEpoch)) return;
      this.balanceCallbacks?.onError?.(e);
    }
  }

  private async recordMap(
    records: CoinRecord[],
    connectionEpoch: number,
  ): Promise<Map<string, CoinRecord> | null> {
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
    if (!this.isConnectionEpochActive(connectionEpoch)) return null;
    return hasUnmappedRecord ? null : recordByName;
  }

  // Hand each cradle its complete coin-state snapshot for `height`. A
  // successful query explicitly represents every registered interest:
  // omitted records are authoritative absences, not partial results.
  private async reportToCradles(
    perSession: Array<{ c: PollingGameSession; coins: CoinPollInterest[] }>,
    recordByName: Map<string, CoinRecord>,
    height: bigint,
    _previousPeak: bigint,
  ): Promise<void> {
    const deliveries: Array<Promise<void>> = [];
    for (const { c, coins } of perSession) {
      // The snapshot was captured before asynchronous registration/record/peak
      // RPCs. A session detached while those requests were in flight must not
      // receive the completed snapshot.
      if (!this.sessions.has(c)) {
        continue;
      }
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
      const csr: CoinStateRecord[] = [];
      for (const { coin_name, coin_string } of coins) {
        const rec = recordByName.get(coin_name);
        if (!rec) {
          csr.push({ coin: coin_string, created_height: null, spent_height: null });
          continue;
        }
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
      }
      csr.sort((a, b) => a.coin.localeCompare(b.coin));
      deliveries.push(Promise.resolve(c.reportCoinStates(height, csr)));
    }
    await Promise.allSettled(deliveries);
  }

  private currentBackoffMs(): number {
    return this.consecutiveFailures > 0
      ? Math.min(this.pollIntervalMs * 2 ** this.consecutiveFailures, this.maxBackoffMs)
      : this.pollIntervalMs;
  }
}
