import Client from '@walletconnect/sign-client';
import { SessionTypes } from '@walletconnect/types';
import { Subject } from 'rxjs';

import { PROJECT_ID, RELAY_URL, CHAIN_ID } from '../constants/env';
import { REQUIRED_NAMESPACES } from '../constants/wallet-connect';

export interface StartConnectResult {
  approval: () => Promise<SessionTypes.Struct>;
  uri: string;
}

export interface WalletConnectOutboundState {
  stateName: string;
  initializing?: boolean;
  initialized?: boolean;
  connecting?: boolean;
  haveClient?: boolean;
  haveSession?: boolean;
  waitingApproval?: boolean;
  connected?: boolean;
  sessions?: number;
  address?: string;
}

class WalletState {
  isConnected: boolean;
  isInitialized: boolean;
  address?: string;
  chainId?: string;
  session?: SessionTypes.Struct;
  error?: string;
  client?: any;
  observable: Subject<WalletConnectOutboundState>;

  constructor() {
    this.isConnected = false;
    this.isInitialized = false;
    this.observable = new Subject();
  }

  getObservable() {
    return this.observable;
  }

  getClient() {
    return this.client;
  }

  getSession() {
    return this.session;
  }

  getChainId() {
    return this.chainId ?? CHAIN_ID;
  }

  getAddress() {
    return this.address;
  }

  async init() {
    if (this.isInitialized) {
      console.log('[WC] init() skipped -- already initialized');
      return;
    }

    this.isInitialized = true;

    console.log(`[WC] network: ${CHAIN_ID}`);
    console.log('[WC] init() starting', {
      projectId: PROJECT_ID,
      relayUrl: RELAY_URL,
      chainId: CHAIN_ID,
      origin: window.location.origin,
    });

    this.observable.next({ stateName: 'initializing', initializing: true });

    const originalConsoleError = console.error;
    console.error = (...args: any[]) => {
      if (args.some(a => typeof a === 'object' && a instanceof Error
        ? a.message?.includes('No matching key. history:')
        : String(a).includes('No matching key. history:'))) {
        return;
      }
      originalConsoleError.apply(console, args);
    };

    try {
      const signClient = await Client.init({
        logger: 'error',
        projectId: PROJECT_ID,
        relayUrl: RELAY_URL,
        metadata: {
          name: 'Chia Gaming',
          description: 'Chia Gaming Platform',
          url: window.location.origin,
          icons: [`${window.location.origin}/logo.png`],
        },
      });

      console.log('[WC] Client.init() succeeded', {
        relayConnected: (signClient.core?.relayer as any)?.connected,
        relayTransportClosed: (signClient.core?.relayer as any)?.transportExplicitlyClosed,
      });

      this.client = signClient;
      const sessions = signClient.session.getAll();
      const pairings = signClient.core.pairing.getPairings();
      console.log(`[WC] existing sessions: ${sessions.length}, pairings: ${pairings.length}`);

      if (sessions.length > 0) {
        const session = sessions[0];
        const accountParts = session.namespaces.chia.accounts[0].split(':');
        const address = accountParts[2];
        const detectedChain = `${accountParts[0]}:${accountParts[1]}`;
        console.log('[WC] restoring existing session', {
          topic: session.topic,
          address,
          chainId: detectedChain,
          methods: session.namespaces.chia.methods,
          peer: session.peer?.metadata?.name,
        });

        this.isConnected = true;
        this.address = address;
        this.chainId = detectedChain;
        this.session = session;
        this.observable.next({
          stateName: 'connected',
          initialized: true,
          haveClient: true,
          haveSession: true,
          connected: true,
          sessions: sessions.length,
        });
      }

      this.observable.next({
        stateName: 'initialized',
        initialized: true,
        haveClient: true,
      });
    } catch (err) {
      console.error('[WC] Client.init() FAILED', err);
      this.isInitialized = false;
      this.observable.next({
        stateName: 'initialized',
        initialized: true,
        haveClient: false,
      });
    }
  }

  async disconnect() {
    if (!this.client || !this.session) return;

    this.observable.next({
      stateName: 'initialized',
      connected: false,
      sessions: 0,
      address: undefined,
    });

    try {
      await this.client.disconnect({
        topic: this.session.topic,
        reason: {
          code: 6000,
          message: 'User disconnected',
        },
      });
    } catch (error) {
      this.error = 'Failed to disconnect wallet';
    }
  }

  async startConnect(): Promise<StartConnectResult> {
    console.log('[WC] startConnect() called', {
      hasClient: !!this.client,
      isInitialized: this.isInitialized,
    });

    if (!this.client) {
      const msg = 'startConnect() called but client is undefined -- init() may have failed';
      console.error('[WC]', msg);
      throw new Error(msg);
    }

    this.observable.next({
      stateName: 'connecting',
      connecting: true,
    });

    try {
      const { uri, approval } = await this.client.connect({
        optionalNamespaces: REQUIRED_NAMESPACES,
      });

      console.log('[WC] startConnect() got URI', {
        uriPrefix: uri?.substring(0, 50),
        uriLength: uri?.length,
      });

      this.observable.next({
        stateName: 'waitingApproval',
        waitingApproval: true,
        connecting: false,
      });

      return { uri, approval };
    } catch (err) {
      console.error('[WC] startConnect() FAILED', err);
      this.observable.next({
        stateName: 'initialized',
        connecting: false,
        waitingApproval: false,
      });
      throw err;
    }
  }

  async connect(approval: () => Promise<SessionTypes.Struct>) {
    console.log('[WC] connect() waiting for wallet approval...');
    try {
      const session = await approval();
      const accountParts = session.namespaces.chia.accounts[0].split(':');
      const address = accountParts[2];
      const detectedChain = `${accountParts[0]}:${accountParts[1]}`;

      console.log(`[WC] network: ${detectedChain}`);
      console.log('[WC] connect() session approved', {
        topic: session.topic,
        address,
        chainId: detectedChain,
        methods: session.namespaces.chia.methods,
        peer: session.peer?.metadata?.name,
        expiry: session.expiry,
      });

      this.address = address;
      this.chainId = detectedChain;
      this.session = session;

      this.observable.next({
        stateName: 'connected',
        waitingApproval: false,
        connected: true,
        sessions: 1,
        address,
      });
    } catch (err) {
      console.error('[WC] connect() approval FAILED or rejected', err);
      this.observable.next({
        stateName: 'initialized',
        waitingApproval: false,
        connecting: false,
        connected: false,
      });
      throw err;
    }
  }
}

export const walletConnectState = new WalletState();
