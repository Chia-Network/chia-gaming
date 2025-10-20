import Client from '@walletconnect/sign-client';
import { PairingTypes, SessionTypes } from '@walletconnect/types';
import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  ReactNode,
} from 'react';

import { METADATA, REQUIRED_NAMESPACES } from '../constants/wallet-connect';

interface WalletConnectState {
  client?: Client;
  session?: SessionTypes.Struct;
  chainId: string;
  fingerprint?: string;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  isInitializing: boolean;
  pairings: PairingTypes.Struct[];
  accounts: string[];
  connectionUri?: string;
  showQRModal: boolean;
  setShowQRModal: (show: boolean) => void;
}

const WalletConnectContext = createContext<WalletConnectState | null>(null);

export function WalletConnectProvider({
  projectId,
  relayUrl,
  chainId,
  children,
}: {
  projectId: string;
  relayUrl: string;
  chainId: string;
  children: ReactNode;
}) {
  const [client, setClient] = useState<Client>();
  const [session, setSession] = useState<SessionTypes.Struct>();
  const [fingerprint, setFingerprint] = useState<string>();
  const [isInitializing, setIsInitializing] = useState(false);
  const [accounts, setAccounts] = useState<string[]>([]);
  const [pairings, setPairings] = useState<PairingTypes.Struct[]>([]);
  const [connectionUri, setConnectionUri] = useState<string>('');
  const [showQRModal, setShowQRModal] = useState(false);

  const reset = useCallback(() => {
    setSession(undefined);
    setAccounts([]);
    setFingerprint(undefined);
  }, []);

  const onSessionConnected = useCallback((session: SessionTypes.Struct) => {
    console.log('Session connected:', session);
    const allNamespaceAccounts = Object.values(session.namespaces)
      .map((namespace) => namespace.accounts)
      .flat();

    setSession(session);
    setAccounts(allNamespaceAccounts);
    if (allNamespaceAccounts.length > 0) {
      const fingerprint = allNamespaceAccounts[0].split(':')[2];
      setFingerprint(fingerprint);
    }
  }, []);

  const connect = useCallback(async () => {
    if (!client) {
      console.error('Client not initialized');
      return;
    }

    try {
      console.log('Starting connection...');
      const { uri, approval } = await client.connect({
        requiredNamespaces: REQUIRED_NAMESPACES,
      });

      if (uri) {
        console.log('Connection URI:', uri);
        setConnectionUri(uri);
        setShowQRModal(true);

        const session = await approval();
        console.log('Session approved:', session);

        onSessionConnected(session);
        setPairings(client.pairing.getAll({ active: true }));
        setShowQRModal(false);
        setConnectionUri('');
      }
    } catch (e) {
      console.error('Connection error:', e);
      setShowQRModal(false);
      setConnectionUri('');
    }
  }, [client, onSessionConnected]);

  const disconnect = useCallback(async () => {
    if (!client || !session) return;

    try {
      await client.disconnect({
        topic: session.topic,
        reason: { code: 6000, message: 'User disconnected' },
      });
    } catch (e) {
      console.error('Disconnect error:', e);
    }
    reset();
  }, [client, session, reset]);

  useEffect(() => {
    async function initClient() {
      try {
        setIsInitializing(true);
        console.log('Initializing WalletConnect client...');
        console.log('Project ID:', projectId);
        console.log('Relay URL:', relayUrl);
        console.log('Chain ID:', chainId);

        const client = await Client.init({
          logger: 'error',
          projectId,
          relayUrl,
          metadata: METADATA,
        });

        console.log('WalletConnect client initialized');
        setClient(client);

        // Set up event listeners
        client.on('session_update', ({ topic, params }) => {
          console.log('Session updated:', topic, params);
          const session = client.session.get(topic);
          const updatedSession = { ...session, namespaces: params.namespaces };
          onSessionConnected(updatedSession);
        });

        client.on('session_delete', () => {
          console.log('Session deleted');
          reset();
        });

        client.on('session_expire', () => {
          console.log('Session expired');
          reset();
        });

        // Check for existing sessions
        setPairings(client.pairing.getAll({ active: true }));
        if (client.session.length) {
          const lastSession = client.session.get(
            client.session.keys[client.session.keys.length - 1],
          );
          onSessionConnected(lastSession);
        }
      } catch (error) {
        console.error('Failed to initialize WalletConnect:', error);
      } finally {
        setIsInitializing(false);
      }
    }

    initClient();
  }, [projectId, relayUrl, chainId, onSessionConnected, reset]);

  const value: WalletConnectState = {
    client,
    session,
    chainId,
    fingerprint,
    connect,
    disconnect,
    isInitializing,
    pairings,
    accounts,
    connectionUri,
    showQRModal,
    setShowQRModal,
  };

  return (
    <WalletConnectContext.Provider value={value}>
      {children}
    </WalletConnectContext.Provider>
  );
}

export function useWalletConnect() {
  const context = useContext(WalletConnectContext);
  if (!context) {
    throw new Error(
      'useWalletConnect must be used within WalletConnectProvider',
    );
  }
  return context;
}
