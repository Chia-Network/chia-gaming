import { WasmConnection, WatchReport } from '../types/ChiaGaming';
import { CoinRecord } from '../types/rpc/GetCoinRecordsByNames';
import { WalletType } from '../types/WalletType';
import { ChildFrameBlockchainInterface } from './ChildFrameBlockchainInterface';

const REMOTE_WALLET_TYPE = WalletType.Remote;
const DEFAULT_POLL_INTERVAL_MS = 5000;

export class CoinWatcher {
  private wasm: WasmConnection;
  private cradleId: number;
  private blockchain: ChildFrameBlockchainInterface;
  private onBlock: (peak: number, blocks: any[], report: WatchReport) => void;

  private remoteWalletId: number | undefined;
  private registeredCoinIds: Set<string> = new Set();
  private previousCoinStates: Map<string, CoinRecord> = new Map();
  private lastPeak: number = 0;
  private pollInterval: ReturnType<typeof setInterval> | undefined;
  private polling: boolean = false;
  private started: boolean = false;

  constructor(
    wasm: WasmConnection,
    cradleId: number,
    blockchain: ChildFrameBlockchainInterface,
    onBlock: (peak: number, blocks: any[], report: WatchReport) => void,
  ) {
    this.wasm = wasm;
    this.cradleId = cradleId;
    this.blockchain = blockchain;
    this.onBlock = onBlock;
  }

  async start(intervalMs: number = DEFAULT_POLL_INTERVAL_MS) {
    if (this.started) return;
    this.started = true;

    try {
      await this.ensureRemoteWallet();
    } catch (e) {
      console.error('CoinWatcher: failed to ensure remote wallet', e);
    }

    this.pollInterval = setInterval(() => this.poll(), intervalMs);
    this.poll();
  }

  stop() {
    this.started = false;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = undefined;
    }
  }

  private async ensureRemoteWallet() {
    try {
      const wallets = await this.blockchain.getWallets(false);
      const remote = wallets.find(
        (w: any) => w.type === REMOTE_WALLET_TYPE,
      );
      if (remote) {
        this.remoteWalletId = remote.id;
        return;
      }
    } catch (e) {
      console.warn('CoinWatcher: getWallets failed, creating new remote wallet', e);
    }

    const result = await this.blockchain.createNewRemoteWallet();
    this.remoteWalletId = result.walletId;
  }

  private async poll() {
    if (this.polling || !this.started) return;
    this.polling = true;

    try {
      const heightInfo = await this.blockchain.getHeightInfo();
      const currentPeak = heightInfo.height;

      if (currentPeak <= this.lastPeak) {
        return;
      }

      const watchedCoinIds: string[] = this.wasm.get_watched_coins(this.cradleId);

      await this.registerNewCoins(watchedCoinIds);

      if (watchedCoinIds.length === 0) {
        this.lastPeak = currentPeak;
        this.onBlock(currentPeak, [], {
          created_watched: [],
          deleted_watched: [],
          timed_out: [],
        });
        return;
      }

      const response = await this.blockchain.getCoinRecordsByNames(
        watchedCoinIds,
        undefined,
        undefined,
        true,
      );

      const watchReport = this.diffCoinRecords(response.coinRecords);
      this.lastPeak = currentPeak;

      this.onBlock(currentPeak, [], watchReport);
    } catch (e) {
      console.error('CoinWatcher: poll failed', e);
    } finally {
      this.polling = false;
    }
  }

  private async registerNewCoins(coinIds: string[]) {
    if (this.remoteWalletId === undefined) {
      try {
        await this.ensureRemoteWallet();
      } catch (e) {
        console.error('CoinWatcher: failed to ensure wallet during registration', e);
        return;
      }
    }

    const newCoinIds = coinIds.filter((id) => !this.registeredCoinIds.has(id));
    if (newCoinIds.length === 0) return;

    try {
      await this.blockchain.registerRemoteCoins(
        this.remoteWalletId!,
        newCoinIds,
      );
      for (const id of newCoinIds) {
        this.registeredCoinIds.add(id);
      }
    } catch (e) {
      console.error('CoinWatcher: registerRemoteCoins failed', e);
    }
  }

  private diffCoinRecords(coinRecords: CoinRecord[]): WatchReport {
    const created_watched: string[] = [];
    const deleted_watched: string[] = [];
    const timed_out: string[] = [];

    for (const record of coinRecords) {
      const coinId = this.computeCoinId(record);
      const coinString = this.buildCoinString(record);
      if (!coinString) continue;

      const prev = this.previousCoinStates.get(coinId);

      if (!prev && record.confirmedBlockIndex > 0) {
        created_watched.push(coinString);
      } else if (prev && !prev.spent && record.spent) {
        deleted_watched.push(coinString);
      }

      this.previousCoinStates.set(coinId, record);
    }

    return { created_watched, deleted_watched, timed_out };
  }

  private computeCoinId(record: CoinRecord): string {
    const coinString = this.buildCoinString(record);
    if (!coinString) return '';
    return this.wasm.sha256bytes(coinString);
  }

  private buildCoinString(record: CoinRecord): string | undefined {
    if (!record.coin) return undefined;
    const parent = record.coin.parentCoinInfo?.replace(/^0x/, '') ?? '';
    const puzzle = record.coin.puzzleHash?.replace(/^0x/, '') ?? '';
    const amount = record.coin.amount ?? 0;
    if (!parent || !puzzle) return undefined;

    try {
      return this.wasm.convert_coinset_to_coin_string(parent, puzzle, amount);
    } catch (e) {
      console.error('CoinWatcher: failed to build coin string', e);
      return undefined;
    }
  }
}
