import { InternalBlockchainInterface } from '../types/ChiaGaming';
import { CoinStateMonitor, CoinStateBackend } from './CoinStateMonitor';
import { debugLog } from '../services/debugLog';

export class BlockchainPoller {
  readonly rpc: InternalBlockchainInterface;
  private monitor: CoinStateMonitor;
  private running = false;
  private pollIntervalMs: number;

  constructor(blockchain: InternalBlockchainInterface, pollIntervalMs: number) {
    this.rpc = blockchain;
    this.pollIntervalMs = pollIntervalMs;

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
    void this.tick();
  }

  stop() {
    this.running = false;
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    try {
      const height = await this.rpc.getHeightInfo();
      const names = this.monitor.getRegisteredCoinNames();
      const records = await this.rpc.getCoinRecordsByNames(names);
      await this.monitor.receiveCoinStates(height, records);
    } catch (e) {
      console.error('[blockchain-poller] poll failed', e);
      debugLog(`[blockchain-poller] poll failed: ${String(e)}`);
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, this.pollIntervalMs);
    });
    if (!this.running) return;
    await this.tick();
  }
}
