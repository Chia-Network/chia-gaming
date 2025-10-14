import type { Pair } from '../util/Pair';

export interface WalletConnectContext {
  enabled: boolean;
  isLoading: boolean;
  error: Error | undefined;
  pair: (
    uri: string,
    fingerprints: number[],
    mainnet?: boolean,
  ) => Promise<string>;
  disconnect: (topic: string) => Promise<void>;
  pairs: {
    getPair: (topic: string) => Pair | undefined;
    get: () => Pair[];
  };
}

export interface WalletConnectProviderProps {
  projectId: string;
};

function doesNothingYet() {
  const _x = 0;
}

export default function WalletConnectProvider(
  props: WalletConnectProviderProps,
) {
  const { projectId } = props;
  const showNotification = doesNothingYet;

  const walletConnect = {
    projectId,
    onNotification: showNotification,
  };

  return walletConnect;
}
