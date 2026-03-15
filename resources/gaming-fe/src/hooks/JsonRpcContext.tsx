import { ChiaMethod } from '../constants/wallet-connect';
import {
  GetCurrentAddressRequest,
  GetCurrentAddressResponse,
} from '../types/rpc/GetCurrentAddress';
import {
  GetWalletBalanceRequest,
  GetWalletBalanceResponse,
} from '../types/rpc/GetWalletBalance';
import {
  SendTransactionRequest,
  SendTransactionResponse,
} from '../types/rpc/SendTransaction';

import { walletConnectState } from './useWalletConnect';

async function request<T, D extends object>(method: ChiaMethod, data: D): Promise<T> {
  if (!walletConnectState.getClient())
    throw new Error('WalletConnect is not initialized');
  if (!walletConnectState.getSession())
    throw new Error('Session is not connected');

  const address = walletConnectState.getAddress();
  if (!address) {
    throw new Error('no fingerprint set in walletconnect');
  }

  const params = { ...data, fingerprint: parseInt(address) } as Record<string, unknown>;

  console.log('[WC] >>>', method, params);

  const raw = await walletConnectState.getClient()!.request({
    topic: walletConnectState.getSession()!.topic,
    chainId: walletConnectState.getChainId(),
    request: { method, params },
  });

  const result = raw as Record<string, unknown> | undefined;
  console.log('[WC] <<<', method, result);

  if (result?.error) throw new Error(JSON.stringify(result.error));

  return (result?.data ?? result) as T;
}

async function getCurrentAddress(data: GetCurrentAddressRequest) {
  return await request<GetCurrentAddressResponse, GetCurrentAddressRequest>(
    ChiaMethod.GetCurrentAddress,
    data,
  );
}

async function getWalletBalance(data: GetWalletBalanceRequest) {
  return await request<GetWalletBalanceResponse, GetWalletBalanceRequest>(
    ChiaMethod.GetWalletBalance,
    data,
  );
}

async function sendTransaction(data: SendTransactionRequest) {
  return await request<SendTransactionResponse, SendTransactionRequest>(
    ChiaMethod.SendTransaction,
    data,
  );
}

export const rpc = {
  getCurrentAddress,
  getWalletBalance,
  sendTransaction,
};
