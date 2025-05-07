import { useState, useEffect, useCallback } from 'react';
import { SignClient } from '@walletconnect/sign-client';
import { SessionTypes } from '@walletconnect/types';

interface WalletState {
  isConnected: boolean;
  address?: string;
  session?: SessionTypes.Struct;
  error?: string;
}

export const useWalletConnect = () => {
  const [client, setClient] = useState<SignClient | null>(null);
  const [state, setState] = useState<WalletState>({
    isConnected: false
  });

  const init = useCallback(async () => {
    try {
      const signClient = await SignClient.init({
        projectId: process.env.REACT_APP_WALLETCONNECT_PROJECT_ID,
        metadata: {
          name: 'Chia Gaming',
          description: 'Chia Gaming Platform',
          url: window.location.origin,
          icons: [`${window.location.origin}/logo.png`]
        }
      });

      setClient(signClient);

      const sessions = signClient.session.getAll();
      if (sessions.length > 0) {
        const session = sessions[0];
        const address = session.namespaces.chia.accounts[0].split(':')[2];
        setState({
          isConnected: true,
          address,
          session
        });
      }
    } catch (error) {
      setState(prev => ({
        ...prev,
        error: 'Failed to initialize wallet connection'
      }));
    }
  }, []);

  const connect = useCallback(async () => {
    if (!client) return;

    try {
      const { uri, approval } = await client.connect({
        requiredNamespaces: {
          chia: {
            methods: ['chia_signMessage'],
            chains: ['chia:mainnet'],
            events: []
          }
        }
      });

      if (uri) {
        // Open WalletConnect modal
        window.open(`chia://wc?uri=${encodeURIComponent(uri)}`, '_blank');
      }

      const session = await approval();
      const address = session.namespaces.chia.accounts[0].split(':')[2];

      setState({
        isConnected: true,
        address,
        session
      });
    } catch (error) {
      setState(prev => ({
        ...prev,
        error: 'Failed to connect wallet'
      }));
    }
  }, [client]);

  const disconnect = useCallback(async () => {
    if (!client || !state.session) return;

    try {
      await client.disconnect({
        topic: state.session.topic,
        reason: {
          code: 6000,
          message: 'User disconnected'
        }
      });

      setState({
        isConnected: false
      });
    } catch (error) {
      setState(prev => ({
        ...prev,
        error: 'Failed to disconnect wallet'
      }));
    }
  }, [client, state.session]);

  const signMessage = useCallback(async (message: string) => {
    if (!client || !state.session) {
      throw new Error('Wallet not connected');
    }

    try {
      const result = await client.request({
        topic: state.session.topic,
        request: {
          method: 'chia_signMessage',
          params: {
            message
          }
        }
      });

      return result as string;
    } catch (error) {
      throw new Error('Failed to sign message');
    }
  }, [client, state.session]);

  useEffect(() => {
    init();
  }, [init]);

  return {
    ...state,
    connect,
    disconnect,
    signMessage
  };
}; 