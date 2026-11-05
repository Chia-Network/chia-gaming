import { ChiaMethod, SageMethod } from '../constants/wallet-connect';
import {
  CreateOfferForIdsRequest,
  CreateOfferForIdsResponse,
} from '../types/rpc/CreateOfferForIds';
import { GetNextAddressRequest, GetNextAddressResponse } from '../types/rpc/GetNextAddress';
import { GetWalletBalanceRequest, GetWalletBalanceResponse } from '../types/rpc/GetWalletBalance';
import { GetHeightInfoRequest, GetHeightInfoResponse } from '../types/rpc/GetHeightInfo';
import {
  CreateNewRemoteWalletRequest,
  CreateNewRemoteWalletResponse,
} from '../types/rpc/CreateNewRemoteWallet';
import {
  RegisterRemoteCoinsRequest,
  RegisterRemoteCoinsResponse,
} from '../types/rpc/RegisterRemoteCoins';
import {
  GetCoinRecordsByNamesRequest,
  GetCoinRecordsByNamesResponse,
} from '../types/rpc/GetCoinRecordsByNames';
import {
  GetPuzzleAndSolutionRequest,
  GetPuzzleAndSolutionResponse,
} from '../types/rpc/GetPuzzleAndSolution';
import { PushTransactionsRequest, PushTransactionsResponse } from '../types/rpc/PushTransactions';
import { SelectCoinsRequest, SelectCoinsResponse } from '../types/rpc/SelectCoins';
import {
  GetFullNodePeerCountRequest,
  GetFullNodePeerCountResponse,
} from '../types/rpc/GetFullNodePeerCount';
import { log } from '../services/log';
import { integersToBigInt, jsonStringify } from '../util/jsonSafe';
import { AsyncJobQueue } from '../lib/AsyncScheduler';

import { walletConnectState } from './useWalletConnect';

type Loose = Record<string, unknown>;
type GetWalletsRequest = Loose;
type GetWalletsResponse = Array<{ id: bigint; type: bigint; [key: string]: unknown }>;
const WC_RELAY_CONNECT_TIMEOUT_MS = 15000;
const WC_RETRYABLE_REQUEST_TIMEOUT_MS = 30000;
export const WC_INTER_REQUEST_MS = 50;

function getErrorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object') {
    const obj = err as Record<string, unknown>;
    if (typeof obj.message === 'string') {
      const parts = [obj.message];
      if ('code' in obj) parts.push(`code=${String(obj.code)}`);
      if ('data' in obj && obj.data !== undefined) {
        try {
          parts.push(`data=${jsonStringify(obj.data)}`);
        } catch {
          /* skip */
        }
      }
      return parts.length > 1 ? `${parts[0]} (${parts.slice(1).join(', ')})` : parts[0];
    }
    try {
      return jsonStringify(err);
    } catch {
      /* fall through */
    }
  }
  return String(err);
}

function toDebugJson(value: unknown): string {
  try {
    return jsonStringify(value);
  } catch {
    return String(value);
  }
}

function errorWithCause<T extends Error>(error: T, cause?: unknown): T {
  if (cause !== undefined) (error as T & { cause?: unknown }).cause = cause;
  return error;
}

export class WalletConnectTransportError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'WalletConnectTransportError';
    errorWithCause(this, cause);
  }
}

export class WalletConnectResponseError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'WalletConnectResponseError';
    errorWithCause(this, cause);
  }
}

type WalletConnectMethod = ChiaMethod | SageMethod;

const CHIA_WALLET_METHODS = new Set<string>(Object.values(ChiaMethod));

/**
 * Methods whose successful result legitimately carries an `error` field:
 * `chip0002_sendTransaction` answers `{ status, error }` with the mempool's
 * verdict, which the caller interprets.
 */
const RESULT_CARRIES_ERROR = new Set<string>([SageMethod.SendTransaction]);

function transportError(method: WalletConnectMethod, detail: string, cause?: unknown): Error {
  return new WalletConnectTransportError(`WalletConnect RPC ${method} failed: ${detail}`, cause);
}

function responseError(method: WalletConnectMethod, detail: string, cause?: unknown): Error {
  return new WalletConnectResponseError(`WalletConnect RPC ${method} failed: ${detail}`, cause);
}

function isNarrowWalletConnectTransportFailure(error: unknown): boolean {
  const detail = getErrorText(error);
  return (
    /\b(?:timeout|timed out|network error|network request failed|socket closed)\b/i.test(detail) ||
    /\brelayer\b.*\b(?:disconnect|closed|connect|unavailable|timeout)\b/i.test(detail) ||
    /\b(?:session|pairing|request)\b.*\b(?:expired|expiry)\b/i.test(detail)
  );
}

function shouldLogRpcError(method: WalletConnectMethod): boolean {
  return method !== ChiaMethod.GetCoinRecordsByNames;
}

/** High-frequency poll methods — skip success traces to avoid drowning the log. */
function shouldLogRpcTraffic(method: WalletConnectMethod): boolean {
  return (
    method !== ChiaMethod.GetCoinRecordsByNames &&
    method !== ChiaMethod.GetHeightInfo &&
    method !== ChiaMethod.GetWalletBalance &&
    method !== SageMethod.GetAssetBalance
  );
}

function summarizeRpcValue(value: unknown, maxLen = 400): string {
  const text = toDebugJson(value);
  return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
}

/** WC wire hack: negative BigInt → decimal string (avoids WC "-100n" leftover). Positives stay bigint. */
function negativeBigintsToDecimalStrings(value: unknown): unknown {
  if (typeof value === 'bigint') return value < 0n ? value.toString() : value;
  if (Array.isArray(value)) return value.map(negativeBigintsToDecimalStrings);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = negativeBigintsToDecimalStrings(v);
    }
    return out;
  }
  return value;
}

async function waitForRelayerConnected(): Promise<void> {
  const client = walletConnectState.getClient();
  if (!client) throw new Error('WalletConnect is not initialized');

  const relayer = client.core.relayer;
  if (relayer.connected) return;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      relayer.off('relayer_connect', onConnect);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const onConnect = () => finish();
    const timer = setTimeout(() => {
      fail(
        new Error(`WalletConnect relayer did not connect after ${WC_RELAY_CONNECT_TIMEOUT_MS}ms`),
      );
    }, WC_RELAY_CONNECT_TIMEOUT_MS);

    relayer.on('relayer_connect', onConnect);
    if (relayer.connected) finish();
  });
}

type PreparedRpc = {
  client: NonNullable<ReturnType<typeof walletConnectState.getClient>>;
  topic: string;
  chainId: string;
  epoch: number;
  address: string | undefined;
  method: WalletConnectMethod;
  params: Record<string, unknown>;
  data: object;
  paramKeys: string;
  enqueuedAt: number;
};

function isReadOnlyRpc(method: WalletConnectMethod): boolean {
  return (
    method === ChiaMethod.GetWallets ||
    method === ChiaMethod.GetWalletBalance ||
    method === ChiaMethod.GetHeightInfo ||
    method === ChiaMethod.GetCoinRecordsByNames ||
    method === ChiaMethod.GetPuzzleAndSolution ||
    method === ChiaMethod.GetFullNodePeerCount ||
    method === SageMethod.GetAddress ||
    method === SageMethod.GetAssetBalance ||
    method === SageMethod.GetAssetCoins
  );
}

function supportsTimeoutRecovery(method: WalletConnectMethod): boolean {
  // Registering the same coin IDs again is idempotent and reserves no funds.
  return (
    isReadOnlyRpc(method) ||
    method === ChiaMethod.PushTransactions ||
    method === ChiaMethod.RegisterRemoteCoins
  );
}

class WalletConnectRpcClient {
  private requestQueue = new AsyncJobQueue({ gapMs: WC_INTER_REQUEST_MS });

  request<T, D extends object = object>(method: WalletConnectMethod, data: D): Promise<T> {
    let prepared: PreparedRpc;
    try {
      prepared = this.prepareRpc(method, data);
    } catch (e) {
      if (e instanceof WalletConnectTransportError) return Promise.reject(e);
      return Promise.reject(responseError(method, getErrorText(e), e));
    }
    // WalletConnect cannot reliably handle overlapping requests.
    // Keep ownership until the SDK request settles or a retryable request's relay
    // replacement finishes. Reservation mutations retain their SDK completion lifetime.
    const response = new Promise<T>((resolve, reject) => {
      const job = {
        label: prepared.method,
        run: async () => {
          try {
            resolve(await this.runPreparedRpc<T>(prepared));
          } catch (error) {
            reject(error);
          }
        },
      };
      if (isReadOnlyRpc(prepared.method)) this.requestQueue.enqueue(job);
      else this.requestQueue.enqueueFront(job);
    });
    return response.catch((e) => {
      this.logRpcError(prepared, e);
      if (e instanceof WalletConnectTransportError || e instanceof WalletConnectResponseError) {
        throw e;
      }
      throw responseError(method, getErrorText(e), e);
    });
  }

  private prepareRpc<D extends object>(method: WalletConnectMethod, data: D): PreparedRpc {
    const client = walletConnectState.getClient();
    const session = walletConnectState.getSession();
    if (!client) {
      throw transportError(method, 'WalletConnect is not initialized');
    }
    if (!session) {
      throw transportError(method, 'Session is not connected');
    }

    // The Chia reference wallet routes each request to a key by fingerprint;
    // Sage serves its active wallet and validates params strictly.
    let routed: object = data;
    if (CHIA_WALLET_METHODS.has(method)) {
      const address = walletConnectState.getAddress();
      if (!address) {
        throw new Error('no fingerprint set in walletconnect');
      }
      const fingerprint = Number.parseInt(address, 10);
      if (!Number.isFinite(fingerprint)) {
        throw new Error('walletconnect fingerprint is not a valid integer');
      }
      routed = { ...data, fingerprint };
    }

    const params = negativeBigintsToDecimalStrings(routed) as Record<string, unknown>;
    const paramKeys = Object.keys(params).join(',');
    const enqueuedAt = Date.now();

    return {
      client,
      topic: session.topic,
      chainId: walletConnectState.getChainId(),
      epoch: walletConnectState.getRequestEpoch(),
      address: walletConnectState.getAddress(),
      method,
      params,
      data,
      paramKeys,
      enqueuedAt,
    };
  }

  private async runPreparedRpc<T>(prepared: PreparedRpc): Promise<T> {
    const { client, topic, chainId } = prepared;
    const assertCurrentContext = () => {
      if (
        walletConnectState.getClient() !== client ||
        walletConnectState.getSession()?.topic !== topic ||
        walletConnectState.getChainId() !== chainId ||
        walletConnectState.getRequestEpoch() !== prepared.epoch ||
        walletConnectState.getAddress() !== prepared.address
      ) {
        throw transportError(prepared.method, 'Wallet context changed before request could start');
      }
    };
    assertCurrentContext();

    try {
      await waitForRelayerConnected();
    } catch (error) {
      throw transportError(prepared.method, getErrorText(error), error);
    }
    assertCurrentContext();

    if (shouldLogRpcTraffic(prepared.method)) {
      log(
        `[WC RPC] → ${prepared.method} keys=[${prepared.paramKeys}] params=${summarizeRpcValue(prepared.params)}`,
      );
    }

    let raw: unknown;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let requestTimedOut = false;
    try {
      const response = client.request({
        topic,
        chainId,
        request: { method: prepared.method, params: prepared.params },
      });
      raw = supportsTimeoutRecovery(prepared.method)
        ? await Promise.race([
            response,
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => {
                log(
                  `[WC RPC timeout] ${prepared.method} after ${WC_RETRYABLE_REQUEST_TIMEOUT_MS}ms; restarting relay`,
                );
                requestTimedOut = true;
                reject(transportError(prepared.method, 'Request timed out'));
              }, WC_RETRYABLE_REQUEST_TIMEOUT_MS);
            }),
          ])
        : await response;
    } catch (error) {
      if (requestTimedOut) {
        try {
          await walletConnectState.recoverRelay(client, topic, prepared.method);
        } catch (recoveryError) {
          throw transportError(
            prepared.method,
            'Request timed out; relay recovery failed',
            recoveryError,
          );
        }
        throw transportError(prepared.method, 'Request timed out; relay restarted');
      }
      if (error instanceof WalletConnectTransportError) throw error;
      const connected =
        walletConnectState.getClient() === client &&
        walletConnectState.getSession()?.topic === topic &&
        client.core.relayer.connected;
      if (!connected || isNarrowWalletConnectTransportFailure(error)) {
        throw transportError(prepared.method, getErrorText(error), error);
      }
      throw responseError(prepared.method, getErrorText(error), error);
    } finally {
      clearTimeout(timer);
    }
    const result = this.normalizeResult<T>(prepared, raw);
    if (shouldLogRpcTraffic(prepared.method)) {
      const elapsed = Date.now() - prepared.enqueuedAt;
      log(`[WC RPC] ← ${prepared.method} ok ${elapsed}ms result=${summarizeRpcValue(result)}`);
    }
    return result;
  }

  private normalizeResult<T>(prepared: PreparedRpc, raw: unknown): T {
    const result = integersToBigInt(raw) as Record<string, unknown> | undefined;
    if (result?.error && !RESULT_CARRIES_ERROR.has(prepared.method)) {
      const errorText = toDebugJson(result.error);
      const trace = new Error().stack?.split('\n').slice(1, 6).join('\n') ?? '';
      if (shouldLogRpcError(prepared.method)) {
        console.error(
          `[WC RPC rejected] method=${prepared.method} paramKeys=[${prepared.paramKeys}]\n  error: ${errorText}\n${trace}`,
        );
        log(
          `[WC RPC rejected] method=${prepared.method} paramKeys=[${prepared.paramKeys}] error=${errorText}`,
        );
      }
      throw responseError(prepared.method, errorText, result.error);
    }

    if (result?.data !== undefined) return result.data as T;
    return result as T;
  }

  private logRpcError(prepared: PreparedRpc, e: unknown): void {
    const elapsed = Date.now() - prepared.enqueuedAt;
    const errText = getErrorText(e);
    if (shouldLogRpcError(prepared.method)) {
      const knownTopics = walletConnectState.getClient()?.session?.keys ?? [];
      const activeTopicNow = walletConnectState.getSession()?.topic ?? 'none';
      log(
        `[WC RPC error] ${prepared.method} after ${elapsed}ms: ${errText} paramKeys=[${prepared.paramKeys}] active=${activeTopicNow} known=${knownTopics.join(',') || 'none'}`,
      );
      console.error(`[WC RPC error] ${prepared.method} paramKeys=[${prepared.paramKeys}]`, e);
    }
  }
}

export const walletConnectRpcClient = new WalletConnectRpcClient();

async function request<T, D extends object = object>(
  method: WalletConnectMethod,
  data: D,
): Promise<T> {
  return walletConnectRpcClient.request<T, D>(method, data);
}

async function getWallets(data: GetWalletsRequest) {
  return await request<GetWalletsResponse>(ChiaMethod.GetWallets, data);
}

async function getWalletBalance(data: GetWalletBalanceRequest) {
  return await request<GetWalletBalanceResponse>(ChiaMethod.GetWalletBalance, data);
}

async function getNextAddress(data: GetNextAddressRequest) {
  return await request<GetNextAddressResponse>(ChiaMethod.GetNextAddress, data);
}

async function selectCoins(data: SelectCoinsRequest) {
  return await request<SelectCoinsResponse>(ChiaMethod.SelectCoins, data);
}

async function getHeightInfo(data: GetHeightInfoRequest) {
  return await request<GetHeightInfoResponse>(ChiaMethod.GetHeightInfo, data);
}

async function createOfferForIds(data: CreateOfferForIdsRequest) {
  return await request<CreateOfferForIdsResponse>(ChiaMethod.CreateOfferForIds, data);
}

async function cancelOffer(data: { tradeId: string; secure: boolean; fee: bigint }) {
  return await request<
    {
      success: boolean;
      error?: unknown;
      message?: unknown;
      detail?: unknown;
      data?: unknown;
    },
    typeof data
  >(ChiaMethod.CancelOffer, data);
}

async function pushTransactions(data: PushTransactionsRequest) {
  return await request<PushTransactionsResponse>(ChiaMethod.PushTransactions, data);
}

async function createNewRemoteWallet(data: CreateNewRemoteWalletRequest) {
  return await request<CreateNewRemoteWalletResponse>(ChiaMethod.CreateNewRemoteWallet, data);
}

async function registerRemoteCoins(data: RegisterRemoteCoinsRequest) {
  return await request<RegisterRemoteCoinsResponse>(ChiaMethod.RegisterRemoteCoins, data);
}

async function getCoinRecordsByNames(data: GetCoinRecordsByNamesRequest) {
  return await request<GetCoinRecordsByNamesResponse>(ChiaMethod.GetCoinRecordsByNames, data);
}

async function getPuzzleAndSolution(data: GetPuzzleAndSolutionRequest) {
  return await request<GetPuzzleAndSolutionResponse>(ChiaMethod.GetPuzzleAndSolution, data);
}

async function getFullNodePeerCount(data: GetFullNodePeerCountRequest) {
  return await request<GetFullNodePeerCountResponse>(ChiaMethod.GetFullNodePeerCount, data);
}

/** Sage coin JSON after integer normalization; amounts may also be decimal strings. */
export interface SageCoin {
  parent_coin_info: string;
  puzzle_hash: string;
  amount: bigint | string;
}

export interface SageSpendableCoin {
  coin: SageCoin;
  coinName: string;
  puzzle: string;
  confirmedBlockIndex: bigint;
  locked: boolean;
}

export interface SageCoinSpend {
  coin: SageCoin;
  puzzle_reveal: string;
  solution: string;
}

export const sageRpc = {
  getAddress: () => request<{ address: string }>(SageMethod.GetAddress, {}),
  getAssetBalance: () =>
    request<{ confirmed: string; spendable: string; spendableCoinCount: bigint }>(
      SageMethod.GetAssetBalance,
      { type: null, assetId: null },
    ),
  getAssetCoins: (offset: number, limit: number) =>
    request<SageSpendableCoin[]>(SageMethod.GetAssetCoins, {
      type: null,
      assetId: null,
      offset,
      limit,
    }),
  signCoinSpends: (coinSpends: SageCoinSpend[]) =>
    request<string>(SageMethod.SignCoinSpends, { coinSpends, partialSign: false }),
  /** Mempool inclusion status: 1 success, 2 pending, 3 failed (or no peer answered). */
  sendTransaction: (spendBundle: { coin_spends: SageCoinSpend[]; aggregated_signature: string }) =>
    request<{ status: bigint; error: string | null }>(SageMethod.SendTransaction, {
      spendBundle,
    }),
};

export const rpc = {
  getWallets,
  getWalletBalance,
  getNextAddress,
  selectCoins,
  getHeightInfo,
  createOfferForIds,
  cancelOffer,
  pushTransactions,
  createNewRemoteWallet,
  registerRemoteCoins,
  getCoinRecordsByNames,
  getPuzzleAndSolution,
  getFullNodePeerCount,
};
