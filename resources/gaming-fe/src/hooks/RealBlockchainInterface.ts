import { rpc } from '../hooks/JsonRpcContext';
import {
  InternalBlockchainInterface,
  BlockchainInboundAddressResult,
} from '../types/ChiaGaming';
import { WalletType } from '../types/WalletType';
import { CoinRecord } from '../types/rpc/CoinRecord';

import { CoinStateMonitor, CoinStateBackend } from './CoinStateMonitor';
import { debugLog } from '../services/debugLog';

const PUSH_TX_RETRY_DELAY = 30000;
const ASSERT_BEFORE_HEIGHT_ABSOLUTE = 87;

function encodeU64AsClvmHex(val: number): string {
  if (val === 0) return '';
  const bytes: number[] = [];
  let h = val;
  while (h > 0) {
    bytes.push(h & 0xff);
    h = Math.floor(h / 256);
  }
  bytes.reverse();
  if (bytes[0] & 0x80) {
    bytes.unshift(0);
  }
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
}
const POLL_INTERVAL = 10000;

function isRetryablePushTxError(errStr: string): boolean {
  return errStr.includes('UNKNOWN_UNSPENT') || errStr.includes('NO_TRANSACTIONS_WHILE_SYNCING');
}

class WalletConnectPoller {
  private pollingTimer: ReturnType<typeof setTimeout> | undefined;
  private remoteWalletReady = false;

  constructor(
    private monitor: CoinStateMonitor,
    private ensureRemoteWallet: () => void,
    private isRemoteWalletReady: () => boolean,
    private pollIntervalMs: number,
  ) {}

  start() {
    if (this.pollingTimer) return;
    this.tick();
  }

  stop() {
    if (this.pollingTimer) {
      clearTimeout(this.pollingTimer);
      this.pollingTimer = undefined;
    }
  }

  private async tick() {
    this.ensureRemoteWallet();
    try {
      const height = await rpc.getHeightInfo({});
      const names = this.monitor.getRegisteredCoinNames();
      let records: CoinRecord[] = [];
      for (const name of names) {
        try {
          const r = await rpc.getCoinRecordsByNames({
            names: [name],
            includeSpentCoins: true,
          });
          records.push(...r);
        } catch {
          // Coin not on-chain yet — skip.
        }
      }
      await this.monitor.receiveCoinStates(height, records);
    } catch (e) {
      console.error('[wc-poller] poll failed', e);
      debugLog(`[wc-poller] poll failed: ${String(e)}`);
    }
    this.pollingTimer = setTimeout(() => this.tick(), this.pollIntervalMs);
  }
}

export class RealBlockchainInterface implements InternalBlockchainInterface {
  addressData: BlockchainInboundAddressResult;
  monitor: CoinStateMonitor;

  private poller: WalletConnectPoller;
  private remoteWalletId: number | undefined;
  private remoteWalletPending = false;

  constructor() {
    this.addressData = { address: '', puzzleHash: '' };

    const self = this;
    const backend: CoinStateBackend = {
      async registerCoins(names: string[]) {
        await self.waitForRemoteWallet();
        await rpc.registerRemoteCoins({
          walletId: self.remoteWalletId!,
          coinIds: names,
        });
      },
    };
    this.monitor = new CoinStateMonitor(backend);

    this.poller = new WalletConnectPoller(
      this.monitor,
      () => this.ensureRemoteWallet(),
      () => this.remoteWalletId !== undefined,
      POLL_INTERVAL,
    );
  }

  registerCoin(coinName: string, coinString: string) {
    void this.monitor.registerCoin(coinName, coinString);
  }

  async getAddress() {
    return this.addressData;
  }

  async startMonitoring() {
    this.poller.start();
  }

  stopMonitoring() {
    this.poller.stop();
  }

  getObservable() {
    return this.monitor.getObservable();
  }

  async spend(_blob: string, spendBundle: unknown): Promise<string> {
    console.log('[wc-blockchain] >>> walletPushTx');
    try {
      const result = await rpc.walletPushTx({ spendBundle: spendBundle as object });
      console.log('[wc-blockchain] <<< walletPushTx', (result as any)?.status);
      return result as unknown as string;
    } catch (e: unknown) {
      const errStr = typeof e === 'string' ? e : ((e as any)?.message || JSON.stringify(e));
      if (isRetryablePushTxError(errStr)) {
        console.warn(`[wc-blockchain] walletPushTx retryable error, retry in ${PUSH_TX_RETRY_DELAY / 1000}s:`, errStr);
        return new Promise((resolve, reject) => {
          setTimeout(() => {
            this.spend(_blob, spendBundle).then(resolve).catch(reject);
          }, PUSH_TX_RETRY_DELAY);
        });
      }
      console.error('[wc-blockchain] walletPushTx error', e);
      debugLog(`[wc-blockchain] walletPushTx error: ${String(e)}`);
      throw e;
    }
  }

  async getBalance(): Promise<number> {
    const result = await rpc.getWalletBalance({ walletId: 1 });
    return (result as any)?.confirmedWalletBalance ?? 0;
  }

  async getPuzzleAndSolution(coin: string): Promise<string[] | null> {
    try {
      const height = await rpc.getHeightInfo({});
      const records = await rpc.getCoinRecordsByNames({
        names: [coin],
        includeSpentCoins: true,
      });
      const record = records.find((r: CoinRecord) => r.spent);
      if (!record) return null;
      return [record.coin.parentCoinInfo, record.coin.puzzleHash, String(record.coin.amount)];
    } catch (e) {
      console.error('[wc-blockchain] getPuzzleAndSolution error', e);
      debugLog(`[wc-blockchain] getPuzzleAndSolution error: ${String(e)}`);
      return null;
    }
  }

  async selectCoins(_uniqueId: string, amount: number): Promise<string | null> {
    try {
      const result = await rpc.selectCoins({ walletId: 1, amount });
      if (!result?.coins?.length) return null;
      return result.coins[0].parentCoinInfo ?? null;
    } catch (e) {
      console.error('[wc-blockchain] selectCoins error', e);
      debugLog(`[wc-blockchain] selectCoins error: ${String(e)}`);
      return null;
    }
  }

  async getHeightInfo(): Promise<number> {
    return rpc.getHeightInfo({});
  }

  async createOfferForIds(
    _uniqueId: string,
    offer: { [walletId: string]: number },
    extraConditions?: Array<{ opcode: number; args: string[] }>,
    coinIds?: string[],
    maxHeight?: number,
  ): Promise<any | null> {
    try {
      const conditions = [...(extraConditions ?? [])];
      if (maxHeight !== undefined) {
        conditions.push({
          opcode: ASSERT_BEFORE_HEIGHT_ABSOLUTE,
          args: [encodeU64AsClvmHex(maxHeight)],
        });
      }
      return await rpc.createOfferForIds({
        offer,
        extraConditions: conditions.length ? conditions : undefined,
        coinIds,
      });
    } catch (e) {
      console.error('[wc-blockchain] createOfferForIds error', e);
      debugLog(`[wc-blockchain] createOfferForIds error: ${String(e)}`);
      return null;
    }
  }

  // --- Private ---

  private ensureRemoteWallet() {
    if (this.remoteWalletPending || this.remoteWalletId !== undefined) return;
    this.remoteWalletPending = true;
    console.log('[wc-blockchain] ensuring remote wallet exists...');
    rpc.getWallets({ includeData: true })
      .then((wallets) => {
        const remote = wallets.find((w: any) => w.type === WalletType.Remote);
        if (remote) {
          this.remoteWalletId = remote.id;
          this.remoteWalletPending = false;
          console.log(`[wc-blockchain] found existing remote wallet id=${remote.id}`);
        } else {
          console.log('[wc-blockchain] no remote wallet found, creating...');
          rpc.createNewRemoteWallet({})
            .then((created) => {
              this.remoteWalletId = created.id;
              this.remoteWalletPending = false;
              console.log(`[wc-blockchain] created remote wallet id=${created.id}`);
            })
            .catch((e) => {
              this.remoteWalletPending = false;
              console.warn('[wc-blockchain] createNewRemoteWallet failed, will retry', e);
              debugLog(`[wc-blockchain] createNewRemoteWallet failed: ${String(e)}`);
            });
        }
      })
      .catch((e) => {
        this.remoteWalletPending = false;
        console.warn('[wc-blockchain] getWallets failed, will retry', e);
        debugLog(`[wc-blockchain] getWallets failed: ${String(e)}`);
      });
  }

  private waitForRemoteWallet(): Promise<void> {
    if (this.remoteWalletId !== undefined) return Promise.resolve();
    this.ensureRemoteWallet();
    return new Promise((resolve) => {
      const check = () => {
        if (this.remoteWalletId !== undefined) {
          resolve();
        } else {
          setTimeout(check, 500);
        }
      };
      check();
    });
  }

}

export const realBlockchainInfo: RealBlockchainInterface =
  new RealBlockchainInterface();
