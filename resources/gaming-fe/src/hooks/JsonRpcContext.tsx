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
  PushTxRequest,
  PushTxResponse,
} from '../types/rpc/PushTx';
import {
  SelectCoinsRequest,
  SelectCoinsResponse,
} from '../types/rpc/SelectCoins';
import { debugLog } from '../services/debugLog';

import { walletConnectState } from './useWalletConnect';

type Loose = Record<string, unknown>;
type GetWalletsRequest = Loose;
type GetWalletsResponse = Array<{ id: number; type: number; [key: string]: unknown }>;
const WC_REQUEST_TIMEOUT_MS = 15000;
const WC_RETRY_DELAY_MS = 1000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorText(err: unknown): string {
  if (err instanceof Error) return err.message;
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
  debugLog(`[WC RPC begin] ${method}`);
  const activeTopic = walletConnectState.getSession()?.topic;
  console.log('[WC] >>>', method, params, { topic: activeTopic, chainId: walletConnectState.getChainId() });
  debugLog(`[WC RPC topic] ${method} topic=${activeTopic ?? 'none'}`);

  let raw: unknown;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      debugLog(`[WC RPC fire] ${method} attempt=${attempt}`);
      raw = await Promise.race([
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
      ]);
      break;
    } catch (e) {
      const elapsed = Date.now() - startedAt;
      const errText = getErrorText(e);
      const retryBlockedByMethod =
        method === ChiaMethod.CreateOfferForIds
        || method === ChiaMethod.CreateNewRemoteWallet;
      const isRetryable = attempt < 2
        && !retryBlockedByMethod
        && isTransientWalletConnectError(e);
      debugLog(`[WC RPC error] ${method} after ${elapsed}ms attempt=${attempt}: ${errText}`);
      if (!isRetryable) {
        throw e;
      }
      console.warn(`[WC] ${method} transient failure, retrying once...`, e);
      await delay(WC_RETRY_DELAY_MS);
    }
  }

  const elapsed = Date.now() - startedAt;
  debugLog(`[WC RPC end] ${method} after ${elapsed}ms`);
  console.log('[WC] <<<', method, raw);

  const result = raw as Record<string, unknown> | undefined;
  if (result?.error) {
    const errorText = toDebugJson(result.error);
    if (method === ChiaMethod.CreateOfferForIds) {
      console.error('[WC RPC protocol error] chia_createOfferForIds', {
        params,
        error: result.error,
        raw,
      });
      console.error('[WC RPC protocol error] chia_createOfferForIds params(json)=', toDebugJson(params));
      console.error('[WC RPC protocol error] chia_createOfferForIds error(json)=', errorText);
      console.error('[WC RPC protocol error] chia_createOfferForIds raw(json)=', toDebugJson(raw));
      debugLog(
        `[WC RPC protocol error] ${method}: error=${errorText} params=${toDebugJson(params)}`,
      );
    }
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
};
