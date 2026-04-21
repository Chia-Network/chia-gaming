import { InternalBlockchainInterface } from '../types/ChiaGaming';
import { CoinStateMonitor, CoinStateBackend } from './CoinStateMonitor';
import { log } from '../services/log';

export class BlockchainPoller {
  readonly rpc: InternalBlockchainInterface;
  private monitor: CoinStateMonitor;
  private running = false;
  private pollIntervalMs: number;
  private maxBackoffMs: number;
  private firstTick = false;
  private startedAt = 0;
  private consecutiveFailures = 0;

  constructor(blockchain: InternalBlockchainInterface, pollIntervalMs: number, maxBackoffMs?: number) {
    this.rpc = blockchain;
    this.pollIntervalMs = pollIntervalMs;
    this.maxBackoffMs = maxBackoffMs ?? 60000;

    const backend: CoinStateBackend = {
      registerCoins: (names: string[]) => this.rpc.registerCoins(names),
    };
    this.monitor = new CoinStateMonitor(backend);
  }

  registerCoin(coinName: string, coinString: string) {
    void this.monitor.registerCoin(coinName, coinString);
  }

  getObservable() {
    return this.monitor.getObservable();
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

  private async tick(): Promise<void> {
    while (this.running) {
      try {
        await this.monitor.retryPendingRegistrations();
        const height = await this.rpc.getHeightInfo();
        const names = this.monitor.getRegisteredCoinNames();
        const records = await this.rpc.getCoinRecordsByNames(names);
        await this.monitor.receiveCoinStates(height, records);
        this.consecutiveFailures = 0;
        if (this.firstTick) {
          this.firstTick = false;
          const elapsed = Math.round(performance.now() - this.startedAt);
          log(`[blockchain-poller] first poll: height=${height} coins=${names.length} (${elapsed}ms)`);
        }
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
