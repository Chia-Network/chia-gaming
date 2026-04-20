import { ChiaMethod } from '../constants/wallet-connect';
import {
  CreateOfferForIdsRequest,
  CreateOfferForIdsResponse,
} from '../types/rpc/CreateOfferForIds';
import {
  GetCurrentAddressRequest,
  GetCurrentAddressResponse,
} from '../types/rpc/GetCurrentAddress';
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
  PushTxRequest,
  PushTxResponse,
} from '../types/rpc/PushTx';
import {
  SelectCoinsRequest,
  SelectCoinsResponse,
} from '../types/rpc/SelectCoins';
import { log } from '../services/log';

import { walletConnectState } from './useWalletConnect';

type Loose = Record<string, unknown>;
type GetWalletsRequest = Loose;
type GetWalletsResponse = Array<{ id: number; type: number; [key: string]: unknown }>;
const WC_REQUEST_TIMEOUT_MS = 15000;
const WC_RETRY_DELAY_MS = 1000;
const WC_INTER_REQUEST_MS = 50;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let queueTail: Promise<unknown> = Promise.resolve();

function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const prev = queueTail;
  const result = prev.then(() => delay(WC_INTER_REQUEST_MS)).then(fn);
  queueTail = result.catch(() => {});
  return result;
}

function getErrorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object') {
    const obj = err as Record<string, unknown>;
    if (typeof obj.message === 'string') {
      const parts = [obj.message];
      if ('code' in obj) parts.push(`code=${String(obj.code)}`);
      if ('data' in obj && obj.data !== undefined) {
        try { parts.push(`data=${JSON.stringify(obj.data)}`); } catch { /* skip */ }
      }
      return parts.length > 1 ? `${parts[0]} (${parts.slice(1).join(', ')})` : parts[0];
    }
    try { return JSON.stringify(err); } catch { /* fall through */ }
  }
  return String(err);
}

function toDebugJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isTransientWalletConnectError(err: unknown): boolean {
  const message = getErrorText(err).toLowerCase();
  return (
    message.includes('socket stalled') ||
    message.includes('failed to fetch') ||
    message.includes('networkerror') ||
    message.includes('connection') ||
    message.includes('websocket') ||
    message.includes('timed out')
  );
}

async function request<T, D extends object = object>(
  method: ChiaMethod,
  data: D,
): Promise<T> {
  if (!walletConnectState.getClient())
    throw new Error('WalletConnect is not initialized');
  if (!walletConnectState.getSession())
    throw new Error('Session is not connected');

  const address = walletConnectState.getAddress();
  if (!address) {
    throw new Error('no fingerprint set in walletconnect');
  }

  const params: Record<string, unknown> = {
    ...data,
    fingerprint: Number.parseInt(address, 10),
  };

  const startedAt = Date.now();

  let raw: unknown;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      raw = await serialized(() =>
        Promise.race([
          walletConnectState.getClient()!.request({
            topic: walletConnectState.getSession()!.topic,
            chainId: walletConnectState.getChainId(),
            request: { method, params },
          }),
          new Promise<never>((_, reject) => {
            setTimeout(() => {
              reject(new Error(`WalletConnect RPC ${method} timed out after ${WC_REQUEST_TIMEOUT_MS}ms`));
            }, WC_REQUEST_TIMEOUT_MS);
          }),
        ]),
      );
      break;
    } catch (e) {
      const elapsed = Date.now() - startedAt;
      const errText = getErrorText(e);
      const knownTopics = walletConnectState.getClient()?.session?.keys ?? [];
      const activeTopicNow = walletConnectState.getSession()?.topic ?? 'none';
      const retryBlockedByMethod =
        method === ChiaMethod.CreateOfferForIds
        || method === ChiaMethod.CreateNewRemoteWallet;
      const isRetryable = false
        && attempt < 2
        && !retryBlockedByMethod
        && isTransientWalletConnectError(e);
      log(
        `[WC RPC error] ${method} after ${elapsed}ms attempt=${attempt}: ${errText} active=${activeTopicNow} known=${knownTopics.join(',') || 'none'}`,
      );
      if (!isRetryable) {
        throw e;
      }
      console.warn(`[WC] ${method} transient failure, retrying once...`, e);
      await delay(WC_RETRY_DELAY_MS);
    }
  }

  const result = raw as Record<string, unknown> | undefined;
  if (result?.error) {
    const errorText = toDebugJson(result.error);
    throw new Error(errorText);
  }

  if (result?.data !== undefined) return result.data as T;
  return result as T;
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

async function getCurrentAddress(data: GetCurrentAddressRequest) {
  return await request<GetCurrentAddressResponse>(
    ChiaMethod.GetCurrentAddress,
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

async function walletPushTx(data: PushTxRequest) {
  return await request<PushTxResponse>(ChiaMethod.WalletPushTx, data);
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

export const rpc = {
  getWallets,
  getWalletBalance,
  getCurrentAddress,
  selectCoins,
  getHeightInfo,
  createOfferForIds,
  walletPushTx,
  createNewRemoteWallet,
  registerRemoteCoins,
  getCoinRecordsByNames,
  getPuzzleAndSolution,
};
