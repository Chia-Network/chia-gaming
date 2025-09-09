import { Subject } from 'rxjs';
import { useState, useEffect, useCallback } from 'react';
import Client from '@walletconnect/sign-client';
import { SessionTypes } from '@walletconnect/types';
import { PROJECT_ID, RELAY_URL, CHAIN_ID } from '../constants/env';

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
  session?: SessionTypes.Struct;
  error?: string;
  client?: any;
  observable: Subject<WalletConnectOutboundState>;

  constructor() {
    this.isConnected = false;
    this.isInitialized = false;
    this.observable = new Subject();
  }

  getObservable() { return this.observable; }

  getClient() { return this.client; }

  getSession() { return this.session; }

  getChainId() { return CHAIN_ID; }

  async init() {
    if (this.isInitialized) {
      return;
    }

    this.isInitialized = true;

    this.observable.next({ stateName: "initializing", initializing: true });

    const signClient = await Client.init({
      logger: 'error',
      projectId: PROJECT_ID,
      relayUrl: RELAY_URL,
      metadata: {
        name: 'Chia Gaming',
        description: 'Chia Gaming Platform',
        url: window.location.origin,
        icons: [`${window.location.origin}/logo.png`]
      }
    });


    this.client = signClient;
    const sessions = signClient.session.getAll();

    if (sessions.length > 0) {
      const session = sessions[0];
      const address = session.namespaces.chia.accounts[0].split(':')[2];
      this.isConnected = true;
      this.address = address;
      this.session = session;
      this.observable.next({
        stateName: "connected",
        initialized: true,
        haveClient: true,
        haveSession: true,
        connected: true,
        sessions: sessions.length
      });
    }

    this.observable.next({
      stateName: "initialized",
      initialized: true,
      haveClient: true,
    });
  }

  async disconnect() {
    if (!this.client || !this.session) return;

    this.observable.next({
      stateName: "initialized",
      connected: false,
      sessions: 0,
      address: undefined
    });

    try {
      await this.client.disconnect({
        topic: this.session.topic,
        reason: {
          code: 6000,
          message: 'User disconnected'
        }
      });
    } catch (error) {
      this.error = 'Failed to disconnect wallet';
    }
  }

  async startConnect(): Promise<StartConnectResult> {
    this.observable.next({
      stateName: "connecting",
      connecting: true
    });
    const { uri, approval } = await this.client.connect({
      optionalNamespaces: {
        chia: {
          methods: ['chia_getCurrentAddress', 'chia_sendTransaction'],
          chains: [CHAIN_ID],
          events: []
        }
      }
    });

    this.observable.next({
      stateName: "waitingApproval",
      waitingApproval: true,
      connecting: false
    });

    return { uri, approval };
  }

  async connect(approval: () => Promise<SessionTypes.Struct>) {
    const session = await approval();
    const address = session.namespaces.chia.accounts[0].split(':')[2];

    this.observable.next({
      stateName: "connected",
      waitingApproval: false,
      connected: true,
      sessions: 1,
      address
    });

    this.address = address;
    this.session = session;
  }
};

export const walletConnectState = new WalletState();
