import { WalletSubmitOutcome } from '../types/ChiaGaming';
import { CoinRecord } from '../types/rpc/CoinRecord';
import { WalletSpendBundle } from '../types/rpc/PushTransactions';
import { log } from '../services/log';
import { toUint8, toHexString } from '../util';
import { jsonStringify } from '../util/jsonSafe';
import { isExactDuplicateTransaction } from '../util/walletSubmit';
import { isTestnet } from '../constants/currency';
import { normalizeHex } from './cloudWalletOAuth';

/**
 * Sends one Coinset full-node RPC (`get_blockchain_state`, `push_tx`, ...) and
 * returns its JSON response. Cloud Wallet relays through its GraphQL proxy;
 * signer-only wallets call coinset.org directly.
 */
export type CoinsetCall = <T>(endpoint: string, request: Record<string, unknown>) => Promise<T>;

const ACCEPTED_BROADCAST_STATUSES = new Set([
  'SUCCESS',
  'SUBMITTED',
  'PENDING',
  'PROCESSING',
  'OK',
]);
const REJECTED_BROADCAST_STATUSES = new Set(['FAILED', 'REJECTED', 'REFUSED']);

type CoinsetCoinRecord = {
  coin?: {
    parent_coin_info?: unknown;
    puzzle_hash?: unknown;
    amount?: unknown;
  };
  confirmed_block_index?: unknown;
  spent_block_index?: unknown;
  spent?: unknown;
  coinbase?: unknown;
  timestamp?: unknown;
};

type CoinsetFailure = {
  success?: boolean;
  structuredError?: { code?: unknown } | null;
};

function coinRecordFromCoinset(record: CoinsetCoinRecord): CoinRecord {
  const parentCoinInfo = normalizeHex(record.coin?.parent_coin_info);
  const puzzleHash = normalizeHex(record.coin?.puzzle_hash);
  if (
    parentCoinInfo.length !== 64 ||
    puzzleHash.length !== 64 ||
    record.coin?.amount == null ||
    record.confirmed_block_index == null ||
    record.spent_block_index == null ||
    typeof record.spent !== 'boolean' ||
    typeof record.coinbase !== 'boolean' ||
    record.timestamp == null
  ) {
    throw new Error('Coinset returned an incomplete coin record');
  }
  return {
    coin: {
      parentCoinInfo,
      puzzleHash,
      amount: BigInt(record.coin.amount as string | number | bigint),
    },
    confirmedBlockIndex: BigInt(record.confirmed_block_index as string | number | bigint),
    spentBlockIndex: BigInt(record.spent_block_index as string | number | bigint),
    spent: record.spent,
    coinbase: record.coinbase,
    timestamp: BigInt(record.timestamp as string | number | bigint),
  };
}

/** The full node reports an unknown coin as a failed lookup, not an empty one. */
function isCoinRecordNotFound(response: CoinsetFailure): boolean {
  return response.success === false && response.structuredError?.code === 'COIN_RECORD_NOT_FOUND';
}

/**
 * Coinset full-node reads and broadcast, independent of how requests reach
 * Coinset. Request and response shapes are Coinset's own.
 */
export class CoinsetClient {
  constructor(
    private readonly call: CoinsetCall,
    private readonly logTag: string,
  ) {}

  async getHeightInfo(): Promise<bigint> {
    const response = await this.call<{
      success?: boolean;
      blockchain_state?: { peak?: { height?: unknown } | null };
    }>('get_blockchain_state', {});
    const height = response.blockchain_state?.peak?.height;
    if (response.success !== true || height == null) {
      throw new Error('Malformed Coinset get_blockchain_state response');
    }
    return BigInt(height as string | number | bigint);
  }

  async getPuzzleAndSolution(coin: string): Promise<string[] | null> {
    const coinBytes = toUint8(coin);
    const hashBuf = await crypto.subtle.digest('SHA-256', coinBytes);
    const coinName = toHexString(new Uint8Array(hashBuf));
    const recordResponse = await this.call<
      CoinsetFailure & { coin_record?: CoinsetCoinRecord | null }
    >('get_coin_record_by_name', { name: coinName });
    if (isCoinRecordNotFound(recordResponse)) return null;
    if (recordResponse.success !== true) {
      throw new Error('Coinset get_coin_record_by_name failed');
    }
    if (!recordResponse.coin_record) return null;
    const record = coinRecordFromCoinset(recordResponse.coin_record);
    if (!record.spent || record.spentBlockIndex === 0n) return null;

    const response = await this.call<{
      success?: boolean;
      coin_solution?: { puzzle_reveal?: unknown; solution?: unknown } | null;
    }>('get_puzzle_and_solution', {
      coin_id: coinName,
      height: Number(record.spentBlockIndex),
    });
    if (response.success !== true) {
      throw new Error('Coinset get_puzzle_and_solution failed');
    }
    const payload = response.coin_solution;
    if (!payload?.puzzle_reveal || !payload.solution) return null;
    return [normalizeHex(payload.puzzle_reveal), normalizeHex(payload.solution)];
  }

  async getCoinRecordsByNames(names: string[]): Promise<CoinRecord[]> {
    const uniqueNames = [...new Set(names.map((n) => normalizeHex(n)).filter(Boolean))];
    if (uniqueNames.length === 0) return [];
    try {
      if (uniqueNames.length === 1) {
        const response = await this.call<
          CoinsetFailure & { coin_record?: CoinsetCoinRecord | null }
        >('get_coin_record_by_name', { name: uniqueNames[0] });
        if (isCoinRecordNotFound(response)) return [];
        if (response.success !== true) {
          throw new Error('Coinset get_coin_record_by_name failed');
        }
        return response.coin_record ? [coinRecordFromCoinset(response.coin_record)] : [];
      }

      const response = await this.call<{
        success?: boolean;
        coin_records?: CoinsetCoinRecord[];
      }>('get_coin_records_by_names', {
        names: uniqueNames,
        include_spent_coins: true,
      });
      if (response.success !== true || !Array.isArray(response.coin_records)) {
        throw new Error('Malformed Coinset get_coin_records_by_names response');
      }
      return response.coin_records.map(coinRecordFromCoinset);
    } catch (e) {
      const message = `Coinset coin-record batch failed: ${String(e)}`;
      log(`${this.logTag} getCoinRecordsByNames error: ${message}`);
      throw new Error(message, { cause: e });
    }
  }

  /**
   * Broadcast through `push_tx`. Transport failures propagate so the caller
   * can classify them with its own transport error types.
   */
  async pushTx(
    bundle: WalletSpendBundle,
    source: string | undefined,
    fee: bigint,
  ): Promise<WalletSubmitOutcome> {
    if (!bundle?.coin_spends?.length) {
      return { status: 'rejected', detail: 'push_tx: empty spend bundle' };
    }

    const response = await this.call<{
      success?: unknown;
      status?: unknown;
      error?: unknown;
    }>('push_tx', { spend_bundle: bundle });
    const status = response.status;
    log(
      `${this.logTag} push_tx from=${source ?? 'unknown'} success=${String(response.success)} status=${String(status)} spends=${bundle.coin_spends.length} fee=${fee}`,
    );
    const detail =
      typeof response.error === 'string'
        ? response.error
        : typeof status === 'string'
          ? status
          : jsonStringify(response);
    if (response.success === true) {
      return { status: 'acknowledged', detail };
    }
    if (isExactDuplicateTransaction(detail)) {
      return { status: 'acknowledged', detail };
    }
    if (response.success !== false) {
      return {
        status: 'rejected',
        detail: 'Malformed Coinset push_tx response',
      };
    }
    const normalizedStatus = typeof status === 'string' ? status.toUpperCase() : '';
    if (ACCEPTED_BROADCAST_STATUSES.has(normalizedStatus)) {
      return { status: 'acknowledged', detail: normalizedStatus };
    }
    if (REJECTED_BROADCAST_STATUSES.has(normalizedStatus)) {
      return {
        status: 'rejected',
        detail: `Coinset push_tx rejected: status=${detail}`,
      };
    }
    return {
      status: 'rejected',
      detail: `Coinset push_tx rejected: ${detail}`,
    };
  }
}

/** Coinset could not be reached or did not answer; the request may be retried. */
export class CoinsetTransportError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'CoinsetTransportError';
  }
}

const COINSET_MAINNET_URL = 'https://api.coinset.org';
const COINSET_TESTNET_URL = 'https://testnet11.api.coinset.org';

/** Public Coinset API for the currently selected network. */
export function coinsetApiUrl(): string {
  return isTestnet() ? COINSET_TESTNET_URL : COINSET_MAINNET_URL;
}

/**
 * Call the public coinset.org API directly. Network failures, rate limiting,
 * and server errors are transport failures; any JSON body is returned as-is.
 */
export const coinsetHttpCall: CoinsetCall = async <T>(
  endpoint: string,
  request: Record<string, unknown>,
): Promise<T> => {
  const url = `${coinsetApiUrl()}/${endpoint}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: jsonStringify(request),
    });
  } catch (error) {
    throw new CoinsetTransportError(`Coinset ${endpoint} request failed: ${String(error)}`, error);
  }
  if (response.status === 429 || response.status >= 500) {
    throw new CoinsetTransportError(`Coinset ${endpoint} returned HTTP ${response.status}`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new CoinsetTransportError(`Coinset ${endpoint} returned a non-JSON body`, error);
  }
  if (!body || typeof body !== 'object') {
    throw new CoinsetTransportError(`Coinset ${endpoint} returned an empty body`);
  }
  return body as T;
};
