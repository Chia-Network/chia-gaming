import { ChiaMethod } from '../constants/wallet-connect';
import {
  CreateOfferForIdsRequest,
  CreateOfferForIdsResponse,
} from '../types/rpc/CreateOfferForIds';
import {
  GetNextAddressRequest,
  GetNextAddressResponse,
} from '../types/rpc/GetNextAddress';
import {
  GetWalletBalanceRequest,
  GetWalletBalanceResponse,
} from '../types/rpc/GetWalletBalance';
import {
  GetHeightInfoRequest,
  GetHeightInfoResponse,
} from '../types/rpc/GetHeightInfo';
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
import {
  PushTransactionsRequest,
  PushTransactionsResponse,
} from '../types/rpc/PushTransactions';
import {
  SelectCoinsRequest,
  SelectCoinsResponse,
} from '../types/rpc/SelectCoins';
import {
  GetFullNodePeerCountRequest,
  GetFullNodePeerCountResponse,
} from '../types/rpc/GetFullNodePeerCount';
import { log } from '../services/log';
import { jsonStringify } from '../util/jsonSafe';

import { walletConnectState } from './useWalletConnect';

type Loose = Record<string, unknown>;
type GetWalletsRequest = Loose;
type GetWalletsResponse = Array<{ id: bigint; type: bigint; [key: string]: unknown }>;
const WC_RELAY_CONNECT_TIMEOUT_MS = 15000;
export const WC_INTER_REQUEST_MS = 50;

function getErrorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object') {
    const obj = err as Record<string, unknown>;
    if (typeof obj.message === 'string') {
      const parts = [obj.message];
      if ('code' in obj) parts.push(`code=${String(obj.code)}`);
      if ('data' in obj && obj.data !== undefined) {
        try { parts.push(`data=${jsonStringify(obj.data)}`); } catch { /* skip */ }
      }
      return parts.length > 1 ? `${parts[0]} (${parts.slice(1).join(', ')})` : parts[0];
    }
    try { return jsonStringify(err); } catch { /* fall through */ }
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

function walletConnectError(method: ChiaMethod, detail: string, cause?: unknown): Error {
  const err = new Error(`WalletConnect RPC ${method} failed: ${detail}`);
  (err as any).cause = cause;
  return err;
}

function shouldLogRpcError(method: ChiaMethod): boolean {
  return method !== ChiaMethod.GetCoinRecordsByNames;
}

/** High-frequency poll methods — skip success traces to avoid drowning the log. */
function shouldLogRpcTraffic(method: ChiaMethod): boolean {
  return (
    method !== ChiaMethod.GetCoinRecordsByNames &&
    method !== ChiaMethod.GetHeightInfo &&
    method !== ChiaMethod.GetWalletBalance
  );
}

function summarizeRpcValue(value: unknown, maxLen = 400): string {
  const text = toDebugJson(value);
  return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
}

function deepNumbersToBigInt(value: unknown): unknown {
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value);
  if (Array.isArray(value)) return value.map(deepNumbersToBigInt);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = deepNumbersToBigInt(v);
    }
    return out;
  }
  return value;
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
      fail(new Error(`WalletConnect relayer did not connect after ${WC_RELAY_CONNECT_TIMEOUT_MS}ms`));
    }, WC_RELAY_CONNECT_TIMEOUT_MS);

    relayer.on('relayer_connect', onConnect);
    if (relayer.connected) finish();
  });
}

type PreparedRpc<T> = {
  method: ChiaMethod;
  params: Record<string, unknown>;
  data: object;
  paramKeys: string;
  enqueuedAt: number;
};

class WalletConnectRpcClient {
  request<T, D extends object = object>(method: ChiaMethod, data: D): Promise<T> {
    let prepared: PreparedRpc<T>;
    try {
      prepared = this.prepareRpc(method, data);
    } catch (e) {
      return Promise.reject(e);
    }
    return this.runPreparedRpc(prepared).catch((e) => {
      this.logRpcError(prepared, e);
      throw walletConnectError(method, getErrorText(e), e);
    });
  }

  private prepareRpc<T, D extends object>(
    method: ChiaMethod,
    data: D,
  ): PreparedRpc<T> {
    if (!walletConnectState.getClient()) throw new Error('WalletConnect is not initialized');
    if (!walletConnectState.getSession()) throw new Error('Session is not connected');

    const address = walletConnectState.getAddress();
    if (!address) {
      throw new Error('no fingerprint set in walletconnect');
    }
    const fingerprint = Number.parseInt(address, 10);
    if (!Number.isFinite(fingerprint)) {
      throw new Error('walletconnect fingerprint is not a valid integer');
    }

    const params = negativeBigintsToDecimalStrings({
      ...data,
      fingerprint,
    }) as Record<string, unknown>;
    const paramKeys = Object.keys(params).join(',');
    const enqueuedAt = Date.now();

    return {
      method,
      params,
      data,
      paramKeys,
      enqueuedAt,
    };
  }

  private async runPreparedRpc<T>(prepared: PreparedRpc<T>): Promise<T> {
    const session = walletConnectState.getSession();
    const client = walletConnectState.getClient();
    if (!session) throw new Error('Session is not connected');
    if (!client) throw new Error('WalletConnect is not initialized');

    await waitForRelayerConnected();

    if (shouldLogRpcTraffic(prepared.method)) {
      log(
        `[WC RPC] → ${prepared.method} keys=[${prepared.paramKeys}] params=${summarizeRpcValue(prepared.params)}`,
      );
    }

    try {
      const raw = await client.request({
        topic: session.topic,
        chainId: walletConnectState.getChainId(),
        request: { method: prepared.method, params: prepared.params },
      });
      const result = this.normalizeResult(prepared, raw);
      if (shouldLogRpcTraffic(prepared.method)) {
        const elapsed = Date.now() - prepared.enqueuedAt;
        log(`[WC RPC] ← ${prepared.method} ok ${elapsed}ms result=${summarizeRpcValue(result)}`);
      }
      return result;
    } catch (e) {
      throw e;
    }
  }

  private normalizeResult<T>(prepared: PreparedRpc<T>, raw: unknown): T {
    const result = deepNumbersToBigInt(raw) as Record<string, unknown> | undefined;
    if (result?.error) {
      const errorText = toDebugJson(result.error);
      const trace = new Error().stack?.split('\n').slice(1, 6).join('\n') ?? '';
      if (shouldLogRpcError(prepared.method)) {
        console.error(`[WC RPC rejected] method=${prepared.method} paramKeys=[${prepared.paramKeys}]\n  error: ${errorText}\n${trace}`);
        log(`[WC RPC rejected] method=${prepared.method} paramKeys=[${prepared.paramKeys}] error=${errorText}`);
      }
      throw walletConnectError(prepared.method, errorText, result.error);
    }

    if (result?.data !== undefined) return result.data as T;
    return result as T;
  }

  private logRpcError(prepared: PreparedRpc<unknown>, e: unknown): void {
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
  method: ChiaMethod,
  data: D,
): Promise<T> {
  return walletConnectRpcClient.request<T, D>(method, data);
}

async function getWallets(data: GetWalletsRequest) {
  return await request<GetWalletsResponse>(ChiaMethod.GetWallets, data);
}

async function getWalletBalance(data: GetWalletBalanceRequest) {
  return await request<GetWalletBalanceResponse>(
    ChiaMethod.GetWalletBalance,
    data,
  );
}

async function getNextAddress(data: GetNextAddressRequest) {
  return await request<GetNextAddressResponse>(
    ChiaMethod.GetNextAddress,
    data,
  );
}

async function selectCoins(data: SelectCoinsRequest) {
  return await request<SelectCoinsResponse>(ChiaMethod.SelectCoins, data);
}

async function getHeightInfo(data: GetHeightInfoRequest) {
  return await request<GetHeightInfoResponse>(ChiaMethod.GetHeightInfo, data);
}

async function createOfferForIds(data: CreateOfferForIdsRequest) {
  return await request<CreateOfferForIdsResponse>(
    ChiaMethod.CreateOfferForIds,
    data,
  );
}

async function pushTransactions(data: PushTransactionsRequest) {
  return await request<PushTransactionsResponse>(ChiaMethod.PushTransactions, data);
}

async function createNewRemoteWallet(data: CreateNewRemoteWalletRequest) {
  return await request<CreateNewRemoteWalletResponse>(
    ChiaMethod.CreateNewRemoteWallet,
    data,
  );
}

async function registerRemoteCoins(data: RegisterRemoteCoinsRequest) {
  return await request<RegisterRemoteCoinsResponse>(
    ChiaMethod.RegisterRemoteCoins,
    data,
  );
}

async function getCoinRecordsByNames(data: GetCoinRecordsByNamesRequest) {
  return await request<GetCoinRecordsByNamesResponse>(
    ChiaMethod.GetCoinRecordsByNames,
    data,
  );
}

async function getPuzzleAndSolution(data: GetPuzzleAndSolutionRequest) {
  return await request<GetPuzzleAndSolutionResponse>(
    ChiaMethod.GetPuzzleAndSolution,
    data,
  );
}

async function getFullNodePeerCount(data: GetFullNodePeerCountRequest) {
  return await request<GetFullNodePeerCountResponse>(
    ChiaMethod.GetFullNodePeerCount,
    data,
  );
}

export const rpc = {
  getWallets,
  getWalletBalance,
  getNextAddress,
  selectCoins,
  getHeightInfo,
  createOfferForIds,
  pushTransactions,
  createNewRemoteWallet,
  registerRemoteCoins,
  getCoinRecordsByNames,
  getPuzzleAndSolution,
  getFullNodePeerCount,
};
