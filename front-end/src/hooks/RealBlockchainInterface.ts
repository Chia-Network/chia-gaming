import { rpc } from '../hooks/JsonRpcContext';
import {
  InternalBlockchainInterface,
  BlockchainInboundAddressResult,
  ConnectionSetup,
} from '../types/ChiaGaming';
import { WalletType } from '../types/WalletType';
import { CoinRecord } from '../types/rpc/CoinRecord';

import { debugLog } from '../services/debugLog';
import { normalizeHexString, toUint8, toHexString } from '../util';
import { decodeBech32mPuzzleHash, encodePuzzleHashToBech32m } from '../util/bech32m';
import { TransactionRecord, WalletSpendBundle } from '../types/rpc/PushTransactions';
import { walletConnectState } from './useWalletConnect';

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

function isRetryablePushTxError(errStr: string): boolean {
  return errStr.includes('UNKNOWN_UNSPENT') || errStr.includes('NO_TRANSACTIONS_WHILE_SYNCING');
}

export class RealBlockchainInterface implements InternalBlockchainInterface {
  blockchainAddressData: BlockchainInboundAddressResult;

  private remoteWalletId: number | undefined;
  private remoteWalletPending = false;
  private connectionListeners = new Set<(connected: boolean) => void>();
  private lastConnectedState = false;
  private wcSubscription: { unsubscribe: () => void } | null = null;

  constructor() {
    this.blockchainAddressData = { puzzleHash: '' };
  }

  async getAddress() {
    return this.blockchainAddressData;
  }

  async startMonitoring() {
    try {
      const addr = await rpc.getCurrentAddress({ walletId: 1 });
      const puzzleHash = decodeBech32mPuzzleHash(addr);
      if (puzzleHash) {
        this.blockchainAddressData = { puzzleHash };
        debugLog(`[wc-blockchain] address resolved: ${addr} → ${puzzleHash}`);
      } else {
        console.warn('[wc-blockchain] failed to decode address:', addr);
      }
    } catch (e) {
      console.warn('[wc-blockchain] getCurrentAddress failed, puzzleHash will be empty', e);
    }
    this.ensureRemoteWallet();
  }

  private spendSeq = 0;

  private async buildTransactionRecord(
    spendBundle: WalletSpendBundle,
    fee: number,
  ): Promise<TransactionRecord> {
    const puzzleHash = this.blockchainAddressData.puzzleHash || '0'.repeat(64);
    const toAddress = encodePuzzleHashToBech32m(puzzleHash);

    const nameBytes = new TextEncoder().encode(JSON.stringify(spendBundle));
    const hashBuf = await crypto.subtle.digest('SHA-256', nameBytes);
    const name = Array.from(new Uint8Array(hashBuf), (b) => b.toString(16).padStart(2, '0')).join('');

    return {
      confirmed_at_height: 0,
      created_at_time: Math.floor(Date.now() / 1000),
      to_puzzle_hash: puzzleHash,
      amount: 0,
      fee_amount: fee,
      confirmed: false,
      sent: 0,
      spend_bundle: spendBundle,
      additions: [],
      removals: [],
      wallet_id: 0,
      sent_to: [],
      trade_id: null,
      type: 1,
      name,
      memos: {},
      valid_times: {},
      to_address: toAddress,
    };
  }

  async spend(_blob: string, spendBundle: unknown, _source?: string, fee?: number): Promise<string> {
    const seq = ++this.spendSeq;
    const src = _source ?? 'unknown';
    const feeValue = fee || 0;
    debugLog(`[wc-blockchain] pushTransactions submitting #${seq} from=${src} fee=${feeValue}`);

    try {
      const txRecord = await this.buildTransactionRecord(spendBundle as WalletSpendBundle, feeValue);
      const result = await rpc.pushTransactions({
        transactions: [txRecord],
        push: true,
        sign: false,
        fee: feeValue || undefined,
      });
      debugLog(`[wc-blockchain] pushTransactions submitted #${seq} result=${JSON.stringify(result)}`);
      return result as unknown as string;
    } catch (e: unknown) {
      const errStr = typeof e === 'string' ? e : ((e as any)?.message || JSON.stringify(e));
      if (isRetryablePushTxError(errStr)) {
        return new Promise((resolve, reject) => {
          setTimeout(() => {
            this.spend(_blob, spendBundle, `retry-of-#${seq}`, fee).then(resolve).catch(reject);
          }, PUSH_TX_RETRY_DELAY);
        });
      }
      debugLog(`[wc-blockchain] pushTransactions error #${seq}: ${String(e)}`);
      throw e;
    }
  }

  async getBalance(): Promise<number> {
    const result = await rpc.getWalletBalance({ walletId: 1 });
    return (result as any)?.confirmedWalletBalance ?? 0;
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
      throw e;
    }
  }

  async getHeightInfo(): Promise<number> {
    const resp = await rpc.getHeightInfo({});
    return resp.prevTransactionBlockHeight ?? 0;
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

  async getCoinRecordsByNames(names: string[]): Promise<CoinRecord[]> {
    const records: CoinRecord[] = [];
    for (const name of names) {
      try {
        const resp = await rpc.getCoinRecordsByNames({
          names: [name],
          includeSpentCoins: true,
        });
        const r = resp.coinRecords ?? [];
        if (r.length > 0) {
          debugLog(`[wc-blockchain] getCoinRecordsByNames hit name=${name} count=${r.length}`);
        }
        records.push(...r);
      } catch (e) {
        const msg = String(e);
        if (msg.includes('not found')) {
          debugLog(`[wc-blockchain] getCoinRecordsByNames miss name=${name}: ${msg}`);
        } else {
          console.error(`[wc-blockchain] getCoinRecordsByNames unexpected error name=${name}:`, e);
          throw e;
        }
      }
    }
    return records;
  }

  async registerCoins(names: string[]): Promise<void> {
    await this.waitForRemoteWallet();
    const result = await rpc.registerRemoteCoins({
      walletId: this.remoteWalletId!,
      coinIds: names,
    });
    debugLog(`[wc-blockchain] registerRemoteCoins names=${names.join(',')} result=${JSON.stringify(result)}`);
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
        this.fireConnectionChange(evt.stateName === 'connected');
      },
    });
  }

  async beginConnect(_uniqueId: string): Promise<ConnectionSetup> {
    await walletConnectState.init();
    this.subscribeToWcEvents();

    if (walletConnectState.getSession()) {
      return {
        qrUri: `wc-session://${walletConnectState.getSession()!.topic}`,
        finalize: async () => {
          await this.startMonitoring();
          this.fireConnectionChange(true);
        },
      };
    }

    const { uri, approval } = await walletConnectState.startConnect();
    return {
      qrUri: uri,
      finalize: async () => {
        await walletConnectState.connect(approval);
        await this.startMonitoring();
        this.fireConnectionChange(true);
      },
    };
  }

  async disconnect(): Promise<void> {
    if (this.wcSubscription) {
      this.wcSubscription.unsubscribe();
      this.wcSubscription = null;
    }
    await walletConnectState.disconnect();
    this.fireConnectionChange(false);
  }

  isConnected(): boolean {
    return walletConnectState.getSession() !== undefined;
  }

  onConnectionChange(cb: (connected: boolean) => void): () => void {
    this.connectionListeners.add(cb);
    this.subscribeToWcEvents();
    return () => { this.connectionListeners.delete(cb); };
  }
}

export const realBlockchainInfo: RealBlockchainInterface =
  new RealBlockchainInterface();
