import { InternalBlockchainInterface, CoinStateRecord } from '../types/ChiaGaming';
import { CoinRecord } from '../types/rpc/CoinRecord';
import { coinRecordToName } from '../util/coinWatch';
import { log, diagStack } from '../services/log';
import { jsonStringify } from '../util/jsonSafe';
import {
  walletConnectScheduler,
  WC_CHAIN_POLL_INTERVAL_MS,
  WalletConnectCoinInterest,
} from './JsonRpcContext';
import {
  AsyncJobQueue,
  AsyncPollingScheduler,
  AsyncPollingTarget,
} from '../lib/AsyncScheduler';

/**
 * A cradle that the poller drives with raw chain state.  The transaction
 * manager inside the WASM cradle owns the watched-coin set and computes the
 * created/deleted diff, so the poller is a thin I/O loop: it asks each cradle
 * which coins to poll, queries the chain, and hands back raw records.
 */
export interface PollingCradle {
  getCoinsToPoll(): Array<{ coin_name: string; coin_string: string }>;
  reportCoinStates(peak: bigint, records: CoinStateRecord[]): void;
  // Advance to `peak` with no coin-state change.  Lets the poller deliver a
  // height tick as soon as the height is known, before the (possibly slow) coin
  // record lookup, so height-only progress (e.g. handshake new_block) isn't
  // gated on the coin-records RPC.
  reportNewBlock(peak: bigint): void;
}

export class BlockchainPoller {
  readonly rpc: InternalBlockchainInterface;
  private cradles = new Set<PollingCradle>();
  private registeredNames = new Set<string>();
  private observedNames = new Set<string>();
  // Last (peak, records) snapshot reported to each cradle, so we only report on
  // a new block or an actual coin-state change (mirrors the old emit gating and
  // avoids redundant same-height work in the cradle).
  private lastReported = new Map<PollingCradle, string>();
  private running = false;
  private pollIntervalMs: number;
  private maxBackoffMs: number;
  private firstTick = false;
  private startedAt = 0;
  private consecutiveFailures = 0;
  private peak = 0n;
  private useWalletConnectScheduler: boolean;
  private previousPeakForCoinReport = 0n;
  private genericPollLane = new AsyncJobQueue();
  private simulatorBlockchainPollingScheduler: AsyncPollingScheduler;

  constructor(blockchain: InternalBlockchainInterface, pollIntervalMs: number, maxBackoffMs?: number) {
    this.rpc = blockchain;
    this.pollIntervalMs = pollIntervalMs;
    this.maxBackoffMs = maxBackoffMs ?? 60000;
    this.useWalletConnectScheduler = (blockchain as any).usesWalletConnectScheduler === true;
    const simulatorBlockchainPollingTarget: AsyncPollingTarget = {
      runOnce: () => this.runGenericPollOnce(),
      getNextIntervalMs: () => this.currentBackoffMs(),
    };
    this.simulatorBlockchainPollingScheduler = new AsyncPollingScheduler(
      {
        label: 'simulator-blockchain',
        queue: this.genericPollLane,
        intervalMs: this.pollIntervalMs,
      },
      simulatorBlockchainPollingTarget,
    );
  }

  attachCradle(cradle: PollingCradle) {
    this.cradles.add(cradle);
    this.refreshWalletConnectCoinInterest();
  }

  detachCradle(cradle: PollingCradle) {
    this.cradles.delete(cradle);
    this.lastReported.delete(cradle);
    this.refreshWalletConnectCoinInterest();
  }

  getPeak(): bigint {
    return this.peak;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.firstTick = true;
    this.startedAt = performance.now();
    log(`[blockchain-poller] started, pollMs=${this.pollIntervalMs}`);
    if (this.useWalletConnectScheduler) {
      walletConnectScheduler.startHeightInterest(WC_CHAIN_POLL_INTERVAL_MS, {
        onHeight: (height) => this.handleWalletConnectHeight(height),
        onError: (e) => {
          this.consecutiveFailures++;
          diagStack('blockchain-poller height failed', e);
          log(`[blockchain-poller] height failed: ${String(e)}`);
        },
      });
      this.refreshWalletConnectCoinInterest();
      return;
    }
    this.simulatorBlockchainPollingScheduler.start(this.pollIntervalMs);
  }

  stop() {
    this.running = false;
    if (this.useWalletConnectScheduler) {
      walletConnectScheduler.stopHeightInterest();
      walletConnectScheduler.stopCoinInterest();
    }
    this.simulatorBlockchainPollingScheduler.stop();
  }

  private collectCradleCoins(): Array<{ c: PollingCradle; coins: Array<{ coin_name: string; coin_string: string }> }> {
    return [...this.cradles].map((c) => ({ c, coins: c.getCoinsToPoll() }));
  }

  private uniqueCoinInterest(
    perCradle: Array<{ c: PollingCradle; coins: Array<{ coin_name: string; coin_string: string }> }>,
  ): WalletConnectCoinInterest[] {
    const byName = new Map<string, WalletConnectCoinInterest>();
    for (const { coins } of perCradle) {
      for (const coin of coins) {
        byName.set(coin.coin_name, coin);
      }
    }
    return [...byName.values()];
  }

  private refreshWalletConnectCoinInterest(): void {
    if (!this.useWalletConnectScheduler || !this.running) return;
    const perCradle = this.collectCradleCoins();
    walletConnectScheduler.setCoinInterest(
      this.uniqueCoinInterest(perCradle),
      WC_CHAIN_POLL_INTERVAL_MS,
      {
        onRecords: (records, registeredNames) => {
          this.registeredNames = new Set(registeredNames);
          void this.handleWalletConnectCoinRecords(records);
        },
        onError: (e) => {
          this.consecutiveFailures++;
          diagStack('blockchain-poller coin poll failed', e);
          log(`[blockchain-poller] coin poll failed: ${String(e)}`);
        },
      },
    );
  }

  private handleWalletConnectHeight(height: bigint): void {
    if (!this.running) return;
    const previousPeak = this.peak;
    this.previousPeakForCoinReport = previousPeak;
    this.peak = height;
    for (const { c } of this.collectCradleCoins()) {
      c.reportNewBlock(height);
    }
    this.refreshWalletConnectCoinInterest();
    if (this.firstTick) {
      this.firstTick = false;
      const elapsed = Math.round(performance.now() - this.startedAt);
      log(`[blockchain-poller] first scheduler height: height=${height} (${elapsed}ms)`);
    }
  }

  private async handleWalletConnectCoinRecords(records: CoinRecord[]): Promise<void> {
    if (!this.running) return;
    const recordByName = await this.recordMap(records);
    if (!recordByName) return;
    this.reportToCradles(
      this.collectCradleCoins(),
      recordByName,
      this.peak,
      this.previousPeakForCoinReport,
    );
  }

  private async ensureRegistered(names: string[]) {
    const newNames = names.filter((n) => !this.registeredNames.has(n));
    if (newNames.length === 0) return;
    try {
      await this.rpc.registerCoins(newNames);
      for (const n of newNames) this.registeredNames.add(n);
    } catch (e) {
      // Leave unregistered so the next tick retries.
      log(`[blockchain-poller] registerCoins failed, will retry: ${String(e)}`);
    }
  }

  private async pollOnce(): Promise<void> {
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

    // Report the latest height even when it decreases: a drop signals a reorg,
    // which the transaction manager detects via height < last_height.  Clamping
    // this monotonically would hide reorgs from the manager.
    const previousPeak = this.peak;
    const height = await this.rpc.getHeightInfo();
    this.peak = height;

    // Deliver the height tick immediately, before the (potentially slow) coin
    // record lookup.  A cradle's new_block only needs the height, so cradles
    // whose watched coins aren't on chain yet (e.g. the channel coin mid-
    // handshake) advance right away instead of waiting out the coin-records RPC.
    // This goes through new_block with an empty created/deleted delta, which
    // forwards no coin changes -- so unlike the full snapshot below it can never
    // be misread as a coin deletion and needs no registration/observation guard.
    // Done every tick (no height dedup) so a pending_coin_spend set mid-block is
    // cleared on the next poll rather than waiting for the next height change.
    for (const { c } of perCradle) {
      c.reportNewBlock(height);
    }

    const records = namesToQuery.length > 0 ? await this.rpc.getCoinRecordsByNames(namesToQuery) : [];
    const recordByName = await this.recordMap(records);
    if (recordByName) {
      this.reportToCradles(perCradle, recordByName, height, previousPeak);
    }

    if (this.firstTick) {
      this.firstTick = false;
      const elapsed = Math.round(performance.now() - this.startedAt);
      log(`[blockchain-poller] first poll: height=${height} coins=${names.length} (${elapsed}ms)`);
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
  // partial-snapshot guards and per-cradle dedup.  Called twice per tick: once
  // with an empty record set right after the height is known (so height-only
  // progress like new_block isn't blocked by the coin-records RPC) and once with
  // the real records.  The dedup key makes the second call a no-op when the
  // records didn't add anything beyond what the early pass already delivered.
  private reportToCradles(
    perCradle: Array<{ c: PollingCradle; coins: Array<{ coin_name: string; coin_string: string }> }>,
    recordByName: Map<string, CoinRecord>,
    height: bigint,
    previousPeak: bigint,
  ): void {
    for (const { c, coins } of perCradle) {
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
      }
      // Sort by coin so the dedup key is independent of the order coins come
      // back in (get_coins_to_poll iterates a HashMap, whose order can shift on
      // mutation or after a reload re-seeds the map).
      csr.sort((a, b) => a.coin.localeCompare(b.coin));
      const key = `${height}:${jsonStringify(csr)}`;
      if (this.lastReported.get(c) === key) {
        continue;
      }
      this.lastReported.set(c, key);
      c.reportCoinStates(height, csr);
    }
  }

  private async runGenericPollOnce(): Promise<void> {
    if (!this.running) return;
    try {
      await this.pollOnce();
      this.consecutiveFailures = 0;
    } catch (e) {
      this.consecutiveFailures++;
      diagStack('blockchain-poller poll failed', e);
      log(`[blockchain-poller] poll failed: ${String(e)}`);
    }
  }

  private currentBackoffMs(): number {
    return this.consecutiveFailures > 0
      ? Math.min(this.pollIntervalMs * 2 ** this.consecutiveFailures, this.maxBackoffMs)
      : this.pollIntervalMs;
  }
}
