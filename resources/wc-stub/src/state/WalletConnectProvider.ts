import type { Pair } from '../util/Pair';
import useNotifications from './useNotifications';
import { useWalletConnect } from './useWalletConnect';

export interface WalletConnectContext {
  enabled: boolean;
  isLoading: boolean;
  error: Error | undefined;
  pair: (uri: string, fingerprints: number[], mainnet?: boolean) => Promise<string>;
  disconnect: (topic: string) => Promise<void>;
  pairs: {
    getPair: (topic: string) => Pair | undefined;
    get: () => Pair[];
  };
};

export type WalletConnectProviderProps = {
  projectId: string;
};

export default function WalletConnectProvider(props: WalletConnectProviderProps) {
  const { projectId } = props;
  const showNotification = () => { };

  const walletConnect = {
    projectId,
    onNotification: showNotification,
  };

  return walletConnect;
}
