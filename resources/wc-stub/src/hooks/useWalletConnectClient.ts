import Client from '@walletconnect/sign-client';

import useWalletConnectPreferences from './useWalletConnectPreferences';

export const WalletConnectChiaProjectId = 'f3f661fcfc24e2e6e6c6f926f02c9c6e';

export const defaultMetadata = {
  name: 'Chia Blockchain',
  description: 'GUI for Chia Blockchain',
  url: 'https://www.chia.net',
  icons: ['https://www.chia.net/wp-content/uploads/2022/09/chia-logo.svg'],
};

export type UseWalletConnectConfig = {
  projectId: string;
  relayUrl?: string;
  metadata?: {
    name: string;
    description: string;
    url: string;
    icons: string[];
  };
  debug?: boolean;
};

let clientId = 1;

export async function useWalletConnectClient(config: UseWalletConnectConfig) {
  const { projectId, relayUrl = 'wss://relay.walletconnect.com', metadata = defaultMetadata, debug = false } = config;

  let isLoading = true;
  let client: Client | undefined = undefined;
  let error: Error | undefined = undefined;

  const metadataString = JSON.stringify(metadata);
  const memoizedMetadata = JSON.parse(metadataString);

  const prepareClient = async () => {
    const currentClientId = ++clientId;

    try {
      client = undefined;
      error = undefined;
      isLoading = true;

      const newClient = await Client.init({
        logger: debug ? 'debug' : undefined,
        projectId,
        relayUrl,
        metadata: memoizedMetadata,
      });

      if (currentClientId === clientId) {
        client = newClient;
      }
    } catch (e) {
      if (currentClientId === clientId) {
        error = e as Error;
      }
    } finally {
      if (currentClientId === clientId) {
        isLoading = false;
      }
    }
  };

  await prepareClient();

  return {
    isLoading,
    client,
    error,
  };
}
