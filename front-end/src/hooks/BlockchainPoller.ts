import { InternalBlockchainInterface, CoinStateRecord } from '../types/ChiaGaming';
import { CoinRecord } from '../types/rpc/CoinRecord';
import { coinRecordToName } from '../util/coinWatch';
import { log } from '../services/log';

/**
 * A cradle that the poller drives with raw chain state.  The transaction
 * manager inside the WASM cradle owns the watched-coin set and computes the
 * created/deleted diff, so the poller is a thin I/O loop: it asks each cradle
 * which coins to poll, queries the chain, and hands back raw records.
 */
export interface PollingCradle {
  getCoinsToPoll(): Array<{ coin_name: string; coin_string: string }>;
  reportCoinStates(peak: bigint, records: CoinStateRecord[]): void;
}

export class BlockchainPoller {
  readonly rpc: InternalBlockchainInterface;
  private cradles = new Set<PollingCradle>();
  private registeredNames = new Set<string>();
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

  constructor(blockchain: InternalBlockchainInterface, pollIntervalMs: number, maxBackoffMs?: number) {
    this.rpc = blockchain;
    this.pollIntervalMs = pollIntervalMs;
    this.maxBackoffMs = maxBackoffMs ?? 60000;
  }

  attachCradle(cradle: PollingCradle) {
    this.cradles.add(cradle);
  }

  detachCradle(cradle: PollingCradle) {
    this.cradles.delete(cradle);
    this.lastReported.delete(cradle);
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
    void this.tick();
  }

  stop() {
    this.running = false;
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
    const perCradle = [...this.cradles].map((c) => ({ c, coins: c.getCoinsToPoll() }));

    const allNames = new Set<string>();
    for (const { coins } of perCradle) {
      for (const { coin_name } of coins) allNames.add(coin_name);
    }
    const names = [...allNames];
    await this.ensureRegistered(names);

    const height = await this.rpc.getHeightInfo();
    if (height > this.peak) {
      this.peak = height;
    }

    const records = names.length > 0 ? await this.rpc.getCoinRecordsByNames(names) : [];
    const recordByName = new Map<string, CoinRecord>();
    for (const rec of records) {
      const name = await coinRecordToName(rec);
      if (name) recordByName.set(name, rec);
    }

    for (const { c, coins } of perCradle) {
      const csr: CoinStateRecord[] = [];
      for (const { coin_name, coin_string } of coins) {
        const rec = recordByName.get(coin_name);
        if (!rec) continue; // not on chain yet
        const created = rec.confirmedBlockIndex > 0n ? Number(rec.confirmedBlockIndex) : null;
        const spent = rec.spent || rec.spentBlockIndex > 0n ? Number(rec.spentBlockIndex) : null;
        csr.push({ coin: coin_string, created_height: created, spent_height: spent });
      }
      const key = `${this.peak}:${JSON.stringify(csr)}`;
      if (this.lastReported.get(c) === key) continue;
      this.lastReported.set(c, key);
      c.reportCoinStates(this.peak, csr);
    }

    if (this.firstTick) {
      this.firstTick = false;
      const elapsed = Math.round(performance.now() - this.startedAt);
      log(`[blockchain-poller] first poll: height=${height} coins=${names.length} (${elapsed}ms)`);
    }
  }

  private async tick(): Promise<void> {
    while (this.running) {
      try {
        await this.pollOnce();
        this.consecutiveFailures = 0;
      } catch (e) {
        this.consecutiveFailures++;
        console.error('[blockchain-poller] poll failed', e);
        log(`[blockchain-poller] poll failed: ${String(e)}`);
      }
      const backoff = this.consecutiveFailures > 0
        ? Math.min(this.pollIntervalMs * 2 ** this.consecutiveFailures, this.maxBackoffMs)
        : this.pollIntervalMs;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, backoff);
      });
    }
  }
}
