import Client from '@walletconnect/sign-client';

import {
  UseWalletConnectConfig,
  useWalletConnectClient,
} from './useWalletConnectClient';

export interface UseWalletConnectResult {
  client?: Client;
  error?: unknown;
}

export async function useWalletConnect(
  config: UseWalletConnectConfig,
): Promise<UseWalletConnectResult> {
  const { projectId, relayUrl, metadata, debug } = config;

  const { client, error } = await useWalletConnectClient({
    projectId,
    relayUrl,
    metadata,
    debug,
  });

  return {
    client,
    error,
  };
}
