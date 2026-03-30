import { Subject } from 'rxjs';
import { CoinRecord } from '../types/rpc/CoinRecord';
import { BlockchainReport } from '../types/ChiaGaming';
import { applyCoinRecordsWatchDiff } from '../util/coinWatch';

export interface CoinStateBackend {
  registerCoins(names: string[]): Promise<void>;
}

export class CoinStateMonitor {
  private coinNameToString = new Map<string, string>();
  private registeredCoinNames = new Set<string>();
  private previousCoinStates = new Map<string, boolean>();
  private peak = 0;
  private lastEmittedPeak = -1;
  private observable = new Subject<BlockchainReport>();

  constructor(private backend: CoinStateBackend) {}

  getObservable() {
    return this.observable;
  }

  getRegisteredCoinNames(): string[] {
    return Array.from(this.registeredCoinNames);
  }

  getPeak(): number {
    return this.peak;
  }

  async registerCoin(coinName: string, coinString: string) {
    this.coinNameToString.set(coinName, coinString);
    if (this.registeredCoinNames.has(coinName)) return;
    this.registeredCoinNames.add(coinName);

    try {
      await this.backend.registerCoins([coinName]);
    } catch (e) {
      console.error('[coin-monitor] registerCoins failed', e);
      this.registeredCoinNames.delete(coinName);
    }
  }

  async receiveCoinStates(peak: number, records: CoinRecord[]) {
    if (peak > this.peak) {
      this.peak = peak;
    }
    await this.applyRecords(records);
  }

  private async applyRecords(records: CoinRecord[]) {
    const report = await applyCoinRecordsWatchDiff(
      records,
      this.coinNameToString,
      this.previousCoinStates,
    );

    const hasChanges =
      report.created_watched.length > 0 ||
      report.deleted_watched.length > 0 ||
      report.timed_out.length > 0;

    if (!hasChanges && this.peak <= this.lastEmittedPeak) {
      return;
    }
    this.lastEmittedPeak = this.peak;
    this.observable.next({
      peak: this.peak,
      block: undefined,
      report,
    });
  }
}
