import { Pair } from '../util/Pair';
import Client from '@walletconnect/sign-client';
import { Notification } from '../util/Notification';
import { bindEvents } from '../util/walletConnect';

import {
  UseWalletConnectConfig,
  useWalletConnectClient,
} from './useWalletConnectClient';
import { Pairs } from './useWalletConnectPairs';
import useWalletConnectPreferences from './useWalletConnectPreferences';

export interface UseWalletConnectResult {
  client?: Client;
  error?: any;
}

export async function useWalletConnect(
  config: UseWalletConnectConfig,
): Promise<UseWalletConnectResult> {
  const { projectId, relayUrl, metadata, debug } = config;
  let isLoadingData = null;

  const { client, isLoading, error } = await useWalletConnectClient({
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
