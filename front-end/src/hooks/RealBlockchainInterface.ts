import { rpc, WC_INTER_REQUEST_MS } from '../hooks/WalletConnectRpc';
import {
  InternalBlockchainInterface,
  BlockchainInboundAddressResult,
  ConnectionSetup,
} from '../types/ChiaGaming';
import { WalletType } from '../types/WalletType';
import { CoinRecord } from '../types/rpc/CoinRecord';

import { log } from '../services/log';
import { coinIdFromBytes, normalizeHexString, toUint8, toHexString } from '../util';
import { decodeBech32mPuzzleHash, encodePuzzleHashToBech32m } from '../util/bech32m';
import { CoinsetCoin, TransactionRecord, WalletSpendBundle } from '../types/rpc/PushTransactions';
import { walletConnectState } from './useWalletConnect';
import { jsonStringify } from '../util/jsonSafe';

const PUSH_RETRY_DELAY = 30000;
const ASSERT_BEFORE_HEIGHT_ABSOLUTE = 87n;
const CREATE_COIN = 51n;
const ASSERT_COIN_ANNOUNCEMENT = 61n;

function encodeU64AsClvmHex(val: bigint): string {
  if (val === 0n) return '';
  const bytes: number[] = [];
  let h = val;
  while (h > 0n) {
    bytes.push(Number(h & 0xffn));
    h >>= 8n;
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

function collectErrorText(err: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();

  const visit = (value: unknown) => {
    if (value == null || seen.has(value)) return;
    seen.add(value);

    if (typeof value === 'string') {
      parts.push(value);
      return;
    }

    if (value instanceof Error) {
      parts.push(value.message);
      visit((value as any).cause);
      return;
    }

    if (typeof value !== 'object') {
      parts.push(String(value));
      return;
    }

    const obj = value as Record<string, unknown>;
    for (const key of ['message', 'error', 'code']) {
      if (obj[key] !== undefined) parts.push(String(obj[key]));
    }
    visit(obj.data);
    visit(obj.structuredError);

    try {
      parts.push(jsonStringify(obj));
    } catch {
      // Ignore unserializable error objects; earlier fields still help.
    }
  };

  visit(err);
  // Chia GUI IPC may encode the daemon error as [wc:<code>|<base64-json>] ....
  // Decode that payload when present so "Coin ID ... not found" is visible here.
  for (const part of [...parts]) {
    const match = part.match(/\[wc:-?\d+\|([A-Za-z0-9+/=]+)\]/);
    if (!match || typeof atob !== 'function') continue;
    try {
      parts.push(atob(match[1]));
    } catch {
      // Best effort only.
    }
  }

  const unique = [...new Set(parts)];
  return unique
    .filter((part, idx) => !unique.some((other, otherIdx) => otherIdx !== idx && other.length > part.length && other.includes(part)))
    .join(' ');
}

function isCoinRecordMiss(err: unknown): boolean {
  const text = collectErrorText(err).toLowerCase();
  return text.includes('not found')
    || text.includes('coin id') && text.includes('unknown')
    || text.includes('internal error') && text.includes('-32603');
}

function isRetryablePushError(errStr: string): boolean {
  return errStr.includes('UNKNOWN_UNSPENT') || errStr.includes('NO_TRANSACTIONS_WHILE_SYNCING');
}

function coinAmount(coin: CoinsetCoin): bigint {
  return typeof coin.amount === 'bigint' ? coin.amount : BigInt(coin.amount);
}

function coinStringFromCoinsetCoin(coin: CoinsetCoin): string {
  return `${normalizeHexString(coin.parent_coin_info)}${normalizeHexString(coin.puzzle_hash)}${encodeU64AsClvmHex(coinAmount(coin))}`;
}

async function rootRemovalsFromSpendBundle(spendBundle: WalletSpendBundle): Promise<CoinsetCoin[]> {
  const coinSpends = spendBundle.coin_spends;
  if (!Array.isArray(coinSpends)) return [];
  const candidateRemovals = coinSpends
    .map((cs) => cs.coin)
    .filter((coin): coin is CoinsetCoin => coin !== undefined);
  const spentCoinIds = new Set<string>();
  for (const coin of candidateRemovals) {
    spentCoinIds.add(await coinIdFromBytes(toUint8(coinStringFromCoinsetCoin(coin))));
  }
  return candidateRemovals.filter(
    (coin) => !spentCoinIds.has(normalizeHexString(coin.parent_coin_info)),
  );
}

export class RealBlockchainInterface implements InternalBlockchainInterface {
  readonly requestGapMs = WC_INTER_REQUEST_MS;
  blockchainAddressData: BlockchainInboundAddressResult;

  private remoteWalletId: bigint | undefined;
  private remoteWalletPending = false;
  private connectionListeners = new Set<(connected: boolean) => void>();
  private lastConnectedState = false;
  private wcSubscription: { unsubscribe: () => void } | null = null;
  private pendingLocalRemovalsForNextPush: CoinsetCoin[] = [];
  private monitoringReady = false;
  private monitoringPromise: Promise<void> | null = null;
  private monitoringEpoch = 0;

  constructor() {
    this.blockchainAddressData = { puzzleHash: '' };
  }

  async getAddress() {
    return this.blockchainAddressData;
  }

  async startMonitoring() {
    if (this.monitoringPromise) {
      return this.monitoringPromise;
    }
    const epoch = this.monitoringEpoch;
    this.monitoringPromise = this.doStartMonitoring(epoch).finally(() => {
      this.monitoringPromise = null;
    });
    return this.monitoringPromise;
  }

  private async doStartMonitoring(epoch: number) {
    try {
      const addr = await rpc.getNextAddress({ walletId: 1n, newAddress: true });
      const puzzleHash = decodeBech32mPuzzleHash(addr);
      if (!puzzleHash) {
        throw new Error(`failed to decode change address: ${addr}`);
      }
      this.blockchainAddressData = { puzzleHash };
      log(`[wc-blockchain] address resolved: ${addr} → ${puzzleHash}`);
      this.ensureRemoteWallet();
      await this.waitForRemoteWallet();
      if (epoch !== this.monitoringEpoch || !walletConnectState.getSession()) {
        return;
      }
      this.monitoringReady = true;
      this.fireConnectionChange(true);
    } catch (err) {
      const e = err as any;
      console.error('[wc-blockchain] startMonitoring failed:', err);
      throw err;
    }
  }

  private markDisconnected() {
    this.monitoringEpoch++;
    this.monitoringReady = false;
    this.monitoringPromise = null;
    this.remoteWalletId = undefined;
    this.remoteWalletPending = false;
    this.fireConnectionChange(false);
  }

  private spendSeq = 0;

  private async buildTransactionRecord(
    spendBundle: WalletSpendBundle,
    fee: bigint,
    removals: CoinsetCoin[],
  ): Promise<TransactionRecord> {
    const puzzleHash = this.blockchainAddressData.puzzleHash || '0'.repeat(64);
    const toAddress = encodePuzzleHashToBech32m(puzzleHash);

    const nameBytes = new TextEncoder().encode(jsonStringify(spendBundle));
    const hashBuf = await crypto.subtle.digest('SHA-256', nameBytes);
    const name = Array.from(new Uint8Array(hashBuf), (b) => b.toString(16).padStart(2, '0')).join('');

    return {
      confirmed_at_height: 0n,
      created_at_time: BigInt(Math.floor(Date.now() / 1000)),
      to_puzzle_hash: puzzleHash,
      amount: 0n,
      fee_amount: fee,
      confirmed: false,
      sent: 0n,
      spend_bundle: spendBundle,
      additions: [],
      removals,
      wallet_id: 0n,
      sent_to: [],
      trade_id: null,
      type: 1n,
      name,
      memos: {},
      valid_times: {},
      to_address: toAddress,
    };
  }

  async spend(_blob: string, spendBundle: unknown, _source?: string, fee?: bigint): Promise<string> {
    const seq = ++this.spendSeq;
    const src = _source ?? 'unknown';
    const feeValue = fee || 0n;
    log(`[wc-blockchain] pushTransactions submitting #${seq} from=${src} fee=${feeValue}`);

    try {
      const submittedRootRemovals = await rootRemovalsFromSpendBundle(spendBundle as WalletSpendBundle);
      const submittedRootIds = new Set<string>();
      for (const coin of submittedRootRemovals) {
        submittedRootIds.add(await coinIdFromBytes(toUint8(coinStringFromCoinsetCoin(coin))));
      }
      const removals: CoinsetCoin[] = [];
      for (const coin of this.pendingLocalRemovalsForNextPush) {
        const coinId = await coinIdFromBytes(toUint8(coinStringFromCoinsetCoin(coin)));
        if (submittedRootIds.has(coinId)) {
          removals.push(coin);
        }
      }
      if (feeValue !== 0n && removals.length === 0) {
        throw new Error('nonzero wallet fee requires local removal metadata for chia_pushTransactions');
      }
      const txRecord = await this.buildTransactionRecord(
        spendBundle as WalletSpendBundle,
        feeValue,
        removals,
      );
      const result = await rpc.pushTransactions({
        transactions: [txRecord],
        push: true,
        sign: false,
        fee: feeValue || undefined,
        allowUnsynced: true,
      });
      this.pendingLocalRemovalsForNextPush = [];
      log(`[wc-blockchain] pushTransactions submitted #${seq} removals=${removals.length} result=${jsonStringify(result)}`);
      return result as unknown as string;
    } catch (e: unknown) {
      const errStr = collectErrorText(e);
      if (isRetryablePushError(errStr)) {
        return new Promise((resolve, reject) => {
          setTimeout(() => {
            this.spend(_blob, spendBundle, `retry-of-#${seq}`, fee).then(resolve).catch(reject);
          }, PUSH_RETRY_DELAY);
        });
      }
      log(`[wc-blockchain] pushTransactions error #${seq}: ${errStr}`);
      throw new Error(`Wallet transaction submit failed from ${src}: ${errStr}`);
    }
  }

  async rememberLocalRemovals(spendBundle: unknown): Promise<void> {
    const removals = await rootRemovalsFromSpendBundle(spendBundle as WalletSpendBundle);
    if (removals.length === 0) return;
    this.pendingLocalRemovalsForNextPush = removals;
    log(`[wc-blockchain] remembered local removals count=${removals.length}`);
  }

  async getBalance(): Promise<bigint> {
    const result = await rpc.getWalletBalance({ walletId: 1n });
    return (result as any)?.confirmedWalletBalance ?? 0n;
  }

  async getPuzzleAndSolution(coin: string): Promise<string[] | null> {
    try {
      const coinBytes = toUint8(coin);
      const hashBuf = await crypto.subtle.digest('SHA-256', coinBytes);
      const coinName = toHexString(new Uint8Array(hashBuf));
      const resp = await rpc.getPuzzleAndSolution({ coinName });
      if (!resp?.puzzleReveal || !resp?.solution) return null;
      return [resp.puzzleReveal, resp.solution];
    } catch (e) {
      console.error('[wc-blockchain] getPuzzleAndSolution error', e);
      log(`[wc-blockchain] getPuzzleAndSolution error: ${String(e)}`);
      return null;
    }
  }

  async selectCoins(_uniqueId: string, amount: bigint): Promise<string | null> {
    try {
      const result = await rpc.selectCoins({ walletId: 1n, amount, allowUnsynced: true });
      if (!result?.coins?.length) return null;
      console.log('[wc-blockchain] <<< selectCoins raw', result);
      console.log('[wc-blockchain] <<< selectCoins raw(json)', jsonStringify(result));
      const selected = result.coins[0];
      const parentCoinInfo = normalizeHexString(selected.parentCoinInfo);
      const puzzleHash = normalizeHexString(selected.puzzleHash);
      const amountHex = encodeU64AsClvmHex(selected.amount);
      const coinString = `${parentCoinInfo}${puzzleHash}${amountHex}`;
      console.log('[wc-blockchain] selectCoins choosing coin[0]', {
        parentCoinInfo: selected.parentCoinInfo,
        puzzleHash: selected.puzzleHash,
        amount: selected.amount,
        amountHex,
        coinStringLength: coinString.length,
      });
      log(
        `[wc-blockchain] selectCoins coin0 parent=${parentCoinInfo} ph=${puzzleHash} amount=${selected.amount} amountHex=${amountHex} coinStringLen=${coinString.length}`,
      );
      return coinString;
    } catch (e) {
      console.error('[wc-blockchain] selectCoins error', e);
      log(`[wc-blockchain] selectCoins error: ${String(e)}`);
      throw e;
    }
  }

  async getHeightInfo(): Promise<bigint> {
    const resp = await rpc.getHeightInfo({ usePeakHeight: true });
    const chosen = resp.height ?? 0n;
    return chosen;
  }

  async createOfferForIds(
    _uniqueId: string,
    offer: { [walletId: string]: bigint },
    extraConditions?: Array<{ opcode: bigint; args: string[] }>,
    coinIds?: string[],
    maxHeight?: bigint,
  ): Promise<any | null> {
    try {
      const conditions = [...(extraConditions ?? [])];
      if (maxHeight !== undefined) {
        conditions.push({
          opcode: ASSERT_BEFORE_HEIGHT_ABSOLUTE,
          args: [encodeU64AsClvmHex(maxHeight)],
        });
      }

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
              amount: decodeNonNegativeClvmIntHex(amountHex),
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
              height: decodeNonNegativeClvmIntHex(heightHex),
            },
          };
        }
        return condition;
      });

      const payload = {
        offer,
        driverDict: {},
        extraConditions: normalizedConditions.length ? normalizedConditions : undefined,
        coinIds,
        allowUnsynced: true,
      };
      console.log('[wc-blockchain] >>> createOfferForIds payload', payload);
      console.log('[wc-blockchain] >>> createOfferForIds payload(json)', jsonStringify(payload));
      log(`[wc-blockchain] createOfferForIds payload: ${jsonStringify(payload)}`);
      const response = await rpc.createOfferForIds(payload);
      console.log('[wc-blockchain] <<< createOfferForIds', response);
      console.log('[wc-blockchain] <<< createOfferForIds (json)', jsonStringify(response));
      if ((response as any)?.error) {
        const errMsg = (response as any).error;
        log(`[wc-blockchain] createOfferForIds daemon error: ${errMsg}`);
        if (/insufficient funds/i.test(String(errMsg))) {
          throw new Error(String(errMsg));
        }
        return null;
      }
      const offerStr = (response as any)?.offer;
      if (typeof offerStr === 'string' && offerStr.startsWith('offer')) {
        log('[wc-blockchain] createOfferForIds returned bech32 offer string path');
        return offerStr;
      }
      log(`[wc-blockchain] createOfferForIds returned non-offer payload type=${typeof response}`);
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
      log(
        `[wc-blockchain] createOfferForIds error: ${String(e)} payload=${jsonStringify({
          offer,
          extraConditions,
          coinIds,
          maxHeight,
        })}`,
      );
      const errorText = collectErrorText(e);
      const errorMsg = (parsedError as any)?.data?.error
        ?? (parsedError as any)?.data?.structuredError?.message
        ?? '';
      if (/insufficient funds/i.test(errorMsg) || /insufficient funds/i.test(errorText)) {
        throw new Error(errorMsg || errorText);
      }
      return null;
    }
  }

  async getCoinRecordsByNames(names: string[]): Promise<CoinRecord[]> {
    const uniqueNames = [...new Set(names)];
    const records: CoinRecord[] = [];
    for (const name of uniqueNames) {
      try {
        const resp = await rpc.getCoinRecordsByNames({
          names: [name],
          includeSpentCoins: true,
          allowUnsynced: true,
        });
        if ((resp as any)?.error) {
          const msg = String((resp as any).error);
          if (!msg.includes('not found')) {
            log(`[wc-blockchain] getCoinRecordsByNames daemon error (skipping coin) name=${name}: ${msg}`);
          }
          continue;
        }
        const r = resp.coinRecords ?? [];
        if (r.length > 0) {
          log(`[wc-blockchain] getCoinRecordsByNames hit name=${name} count=${r.length}`);
        }
        records.push(...r);
      } catch (e) {
        // A single coin lookup must never abort the whole poll. The wallet
        // raises ValueError("Coin ID's: [...] not found.") for coins that
        // don't exist on-chain yet, and that message can arrive mangled
        // through the WalletConnect/IPC bridge so isCoinRecordMiss can't
        // always recognize it. The poller already treats an absent coin as
        // "not on chain yet", so skip this coin instead of rethrowing —
        // rethrowing aborted the poll right after the height was fetched,
        // stalling the handshake on "waiting for height".
        if (!isCoinRecordMiss(e)) {
          log(`[wc-blockchain] getCoinRecordsByNames unexpected error (skipping coin) name=${name}: ${collectErrorText(e)}`);
        }
        continue;
      }
    }
    return records;
  }

  async registerCoins(names: string[]): Promise<void> {
    await this.waitForRemoteWallet();
    await rpc.registerRemoteCoins({
      walletId: this.remoteWalletId!,
      coinIds: names,
    });
  }

  // --- Private ---

  private ensureRemoteWallet() {
    if (this.remoteWalletPending || this.remoteWalletId !== undefined) return;
    this.remoteWalletPending = true;
    console.log('[wc-blockchain] ensuring remote wallet exists...');
    rpc.getWallets({ includeData: true })
      .then((resp) => {
        const wallets = Array.isArray(resp) ? resp : [];
        const remote = wallets.find((w: any) => w.type == WalletType.Remote);
        if (remote) {
          this.remoteWalletId = remote.id;
          this.remoteWalletPending = false;
          console.log(`[wc-blockchain] found existing remote wallet id=${remote.id}`);
        } else {
          console.log('[wc-blockchain] no remote wallet found, creating...');
          rpc.createNewRemoteWallet({ allowUnsynced: true })
            .then((created) => {
              this.remoteWalletId = created.walletId;
              this.remoteWalletPending = false;
              console.log(`[wc-blockchain] created remote wallet id=${created.walletId}`);
            })
            .catch((e) => {
              this.remoteWalletPending = false;
              console.warn('[wc-blockchain] createNewRemoteWallet failed, will retry', e);
              log(`[wc-blockchain] createNewRemoteWallet failed: ${String(e)}`);
            });
        }
      })
      .catch((e) => {
        this.remoteWalletPending = false;
        console.warn('[wc-blockchain] getWallets failed, will retry', e);
        log(`[wc-blockchain] getWallets failed: ${String(e)}`);
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

  private fireConnectionChange(connected: boolean) {
    if (connected === this.lastConnectedState) return;
    this.lastConnectedState = connected;
    for (const cb of this.connectionListeners) {
      try { cb(connected); } catch { /* ignore */ }
    }
  }

  private subscribeToWcEvents() {
    if (this.wcSubscription) return;
    this.wcSubscription = walletConnectState.getObservable().subscribe({
      next: (evt) => {
        if (evt.stateName === 'connected') {
          void this.startMonitoring().catch((err) => {
            console.warn('[wc-blockchain] monitoring setup after WalletConnect event failed', err);
            log(`[wc-blockchain] monitoring setup after WalletConnect event failed: ${String(err)}`);
            this.markDisconnected();
          });
        } else if (evt.connected === false || (evt.stateName === 'initialized' && evt.sessions === 0)) {
          this.markDisconnected();
        }
      },
    });
  }

  async beginConnect(_uniqueId: string): Promise<ConnectionSetup> {
    await walletConnectState.init();
    this.subscribeToWcEvents();

    if (walletConnectState.getSession()) {
      return {
        qrUri: '',
        skipQr: true,
        finalize: async () => {
          await this.startMonitoring();
        },
      };
    }

    const { uri, approval } = await walletConnectState.startConnect();
    return {
      qrUri: uri,
      finalize: async () => {
        await walletConnectState.connect(approval);
        await this.startMonitoring();
      },
    };
  }

  async disconnect(): Promise<void> {
    if (this.wcSubscription) {
      this.wcSubscription.unsubscribe();
      this.wcSubscription = null;
    }
    await walletConnectState.disconnect();
    this.markDisconnected();
  }

  isConnected(): boolean {
    return walletConnectState.getSession() !== undefined;
  }

  onConnectionChange(cb: (connected: boolean) => void): () => void {
    this.connectionListeners.add(cb);
    this.subscribeToWcEvents();
    return () => { this.connectionListeners.delete(cb); };
  }

  getRegistrationScopeKey(): string | undefined {
    return this.remoteWalletId === undefined ? undefined : String(this.remoteWalletId);
  }
}

export const realBlockchainInfo: RealBlockchainInterface =
  new RealBlockchainInterface();
