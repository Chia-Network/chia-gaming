import { Pair } from '../util/Pair';
import Client from '@walletconnect/sign-client';
import { Notification } from '../util/Notification';
import { disconnectPair, bindEvents, cleanupPairings } from '../util/walletConnect';

import { UseWalletConnectConfig, useWalletConnectClient } from './useWalletConnectClient';
import { Pairs, parseWcLink, useWalletConnectPairs } from './useWalletConnectPairs';
import useWalletConnectPreferences from './useWalletConnectPreferences';

export interface UseWalletConnectResult {
  client?: Client;
  error?: any;
  pair: any;
  pairs: Pairs;
  disconnect: (topic: string) => void;
};

export default async function useWalletConnect(config: UseWalletConnectConfig, in_pairs: Pair[]): Promise<UseWalletConnectResult> {
  const { projectId, relayUrl, metadata, debug } = config;
  let isLoadingData = null;

  const pairs = useWalletConnectPairs();
  const { client, isLoading, error } = await useWalletConnectClient({
    projectId,
    relayUrl,
    metadata,
    debug,
  });

  if (client) {
    cleanupPairings(client, pairs);
  }

  const handlePair = async (uri: string, fingerprints: number[], mainnet = false) => {
    if (!client) {
      throw new Error('Client is not defined');
    }

    const { topic } = await (client as any).core.pairing.pair({ uri });
    if (!topic) {
      throw new Error('Pairing failed');
    }

    pairs.addPair({
      topic,
      fingerprints,
      mainnet,
      sessions: [],
    });

    return topic;
  };

  const handleDisconnect = (topic: string) => {
    if (!client) {
      throw new Error('Client is not defined');
    }

    return disconnectPair(client, pairs, topic);
  };

  for (var p = 0; p < in_pairs.length; p++) {
    await handlePair((in_pairs[p] as any).uri, in_pairs[p].fingerprints, in_pairs[p].mainnet);
  }

  return {
    client,
    error,

    pair: handlePair,
    disconnect: handleDisconnect,

    pairs,
  };
}
