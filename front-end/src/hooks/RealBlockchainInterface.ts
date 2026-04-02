import { rpc } from '../hooks/JsonRpcContext';
import {
  InternalBlockchainInterface,
  BlockchainInboundAddressResult,
} from '../types/ChiaGaming';
import { WalletType } from '../types/WalletType';
import { CoinRecord } from '../types/rpc/CoinRecord';

import { CoinStateMonitor, CoinStateBackend } from './CoinStateMonitor';
import { debugLog } from '../services/debugLog';
import { normalizeHexString } from '../util';

const PUSH_TX_RETRY_DELAY = 30000;
const ASSERT_BEFORE_HEIGHT_ABSOLUTE = 87;
const CREATE_COIN = 51;
const ASSERT_COIN_ANNOUNCEMENT = 61;

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

function decodeNonNegativeClvmIntHex(hex: string): bigint {
  const clean = hex.trim().toLowerCase();
  if (clean === '') return 0n;
  const normalized = clean.length % 2 === 0 ? clean : `0${clean}`;
  const bytes = normalized.match(/.{1,2}/g)?.map((b) => Number.parseInt(b, 16)) ?? [];
  if (bytes.length === 0) return 0n;
  // We only expect non-negative values in this call path.
  const isNegative = (bytes[0] & 0x80) !== 0 && bytes[0] !== 0;
  if (isNegative) {
    throw new Error(`unexpected negative CLVM integer encoding: ${hex}`);
  }
  let result = 0n;
  for (const b of bytes) {
    result = (result << 8n) + BigInt(b);
  }
  return result;
}

function toSafeNumber(value: bigint, fieldName: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${fieldName} exceeds Number.MAX_SAFE_INTEGER: ${value.toString()}`);
  }
  return Number(value);
}

const POLL_INTERVAL = 10000;

function isRetryablePushTxError(errStr: string): boolean {
  return errStr.includes('UNKNOWN_UNSPENT') || errStr.includes('NO_TRANSACTIONS_WHILE_SYNCING');
}

class WalletConnectPoller {
  private running = false;
  private remoteWalletReady = false;

  constructor(
    private monitor: CoinStateMonitor,
    private ensureRemoteWallet: () => void,
    private isRemoteWalletReady: () => boolean,
    private pollIntervalMs: number,
  ) {}

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
    await new Promise<void>((resolve) => {
      setTimeout(resolve, this.pollIntervalMs);
    });
    if (!this.running) return;
    await this.tick();
  }
}

export class RealBlockchainInterface implements InternalBlockchainInterface {
  blockchainAddressData: BlockchainInboundAddressResult;
  monitor: CoinStateMonitor;

  private poller: WalletConnectPoller;
  private remoteWalletId: number | undefined;
  private remoteWalletPending = false;

  constructor() {
    this.blockchainAddressData = { puzzleHash: '' };

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
    return this.blockchainAddressData;
  }

  async startMonitoring() {
    await this.getHeightInfo();
    debugLog('[wc-blockchain] relay probe succeeded, starting poller');
    this.poller.start();
  }

  stopMonitoring() {
    this.poller.stop();
  }

  getObservable() {
    return this.monitor.getObservable();
  }

  async spend(_blob: string, spendBundle: unknown): Promise<string> {
    debugLog('[wc-blockchain] walletPushTx submitting');
    try {
      const result = await rpc.walletPushTx({ spendBundle: spendBundle as object });
      debugLog(`[wc-blockchain] walletPushTx submitted result=${JSON.stringify(result)}`);
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
      const result = await rpc.selectCoins({ walletId: 1, amount: String(amount) });
      if (!result?.coins?.length) return null;
      console.log('[wc-blockchain] <<< selectCoins raw', result);
      console.log('[wc-blockchain] <<< selectCoins raw(json)', JSON.stringify(result));
      const selected = result.coins[0];
      const parentCoinInfo = normalizeHexString(selected.parentCoinInfo);
      const puzzleHash = normalizeHexString(selected.puzzleHash);
      const amountHex = encodeU64AsClvmHex(Number(selected.amount));
      const coinString = `${parentCoinInfo}${puzzleHash}${amountHex}`;
      console.log('[wc-blockchain] selectCoins choosing coin[0]', {
        parentCoinInfo: selected.parentCoinInfo,
        puzzleHash: selected.puzzleHash,
        amount: selected.amount,
        amountHex,
        coinStringLength: coinString.length,
      });
      debugLog(
        `[wc-blockchain] selectCoins coin0 parent=${parentCoinInfo} ph=${puzzleHash} amount=${selected.amount} amountHex=${amountHex} coinStringLen=${coinString.length}`,
      );
      return coinString;
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

      const normalizedOffer = Object.fromEntries(
        Object.entries(offer).map(([walletId, amount]) => [walletId, String(amount)]),
      );

      const normalizedConditions = conditions.map((condition) => {
        const args = condition.args ?? [];
        if (!Array.isArray(args)) {
          return condition;
        }
        if (condition.opcode === CREATE_COIN) {
          const [puzzleHash = '', amountHex = ''] = args;
          return {
            opcode: condition.opcode,
            args: {
              puzzle_hash: puzzleHash,
              amount: toSafeNumber(decodeNonNegativeClvmIntHex(amountHex), 'create_coin.amount'),
              memos: null,
            },
          };
        }
        if (condition.opcode === ASSERT_COIN_ANNOUNCEMENT) {
          const [msg = ''] = args;
          return {
            opcode: condition.opcode,
            args: { msg },
          };
        }
        if (condition.opcode === ASSERT_BEFORE_HEIGHT_ABSOLUTE) {
          const [heightHex = ''] = args;
          return {
            opcode: condition.opcode,
            args: {
              height: toSafeNumber(decodeNonNegativeClvmIntHex(heightHex), 'assert_before_height.height'),
            },
          };
        }
        return condition;
      });

      const payload = {
        offer: normalizedOffer,
        driverDict: {},
        extraConditions: normalizedConditions.length ? normalizedConditions : undefined,
        coinIds,
      };
      console.log('[wc-blockchain] >>> createOfferForIds payload', payload);
      console.log('[wc-blockchain] >>> createOfferForIds payload(json)', JSON.stringify(payload));
      debugLog(`[wc-blockchain] createOfferForIds payload: ${JSON.stringify(payload)}`);
      const response = await rpc.createOfferForIds(payload);
      console.log('[wc-blockchain] <<< createOfferForIds', response);
      console.log('[wc-blockchain] <<< createOfferForIds (json)', JSON.stringify(response));
      const offerStr = (response as any)?.offer;
      if (typeof offerStr === 'string' && offerStr.startsWith('offer')) {
        debugLog('[wc-blockchain] createOfferForIds returned bech32 offer string path');
        return offerStr;
      }
      debugLog(`[wc-blockchain] createOfferForIds returned non-offer payload type=${typeof response}`);
      return response;
    } catch (e) {
      let parsedError: unknown = undefined;
      if (e instanceof Error) {
        try {
          parsedError = JSON.parse(e.message);
        } catch {
          parsedError = undefined;
        }
      }
      console.error('[wc-blockchain] createOfferForIds error', {
        error: e,
        parsedError,
        offer,
        extraConditions,
        coinIds,
        maxHeight,
      });
      debugLog(
        `[wc-blockchain] createOfferForIds error: ${String(e)} payload=${JSON.stringify({
          offer,
          extraConditions,
          coinIds,
          maxHeight,
        })}`,
      );
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
