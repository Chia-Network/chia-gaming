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
  console.log('[WC] >>>', method, params);

  let raw: unknown;
  try {
    debugLog(`[WC RPC fire] ${method}`);
    raw = await walletConnectState.getClient()!.request({
      topic: walletConnectState.getSession()!.topic,
      chainId: walletConnectState.getChainId(),
      request: { method, params },
    });
  } catch (e) {
    const elapsed = Date.now() - startedAt;
    debugLog(`[WC RPC error] ${method} after ${elapsed}ms: ${String(e)}`);
    throw e;
  }

  const elapsed = Date.now() - startedAt;
  debugLog(`[WC RPC end] ${method} after ${elapsed}ms`);
  console.log('[WC] <<<', method, raw);

  const result = raw as Record<string, unknown> | undefined;
  if (result?.error) throw new Error(JSON.stringify(result.error));

  return (result?.data ?? result) as T;
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
