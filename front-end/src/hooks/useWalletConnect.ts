import Client from '@walletconnect/sign-client';
import { SessionTypes } from '@walletconnect/types';
import { Subject } from 'rxjs';

import { PROJECT_ID, RELAY_URL, CHAIN_ID } from '../constants/env';
import { REQUIRED_NAMESPACES } from '../constants/wallet-connect';
import { log } from '../services/log';
import { walletConnectDappMetadata } from '../util/walletConnectMetadata';

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
  address?: string;
  chainId?: string;
  session?: SessionTypes.Struct;
  client?: InstanceType<typeof Client>;
  observable: Subject<WalletConnectOutboundState>;
  private initPromise: Promise<void> | null = null;

  constructor() {
    this.isConnected = false;
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

  private logSessionIds(label: string) {
    const sessionTopic = this.session?.topic ?? 'none';
    const knownTopics = this.client?.session?.keys ?? [];
    log(`[WC session] ${label} active=${sessionTopic} known=${knownTopics.join(',') || 'none'}`);
  }

  private chiaAccountFor(session: SessionTypes.Struct): string | null {
    const namespace = session.namespaces.chia;
    if (!namespace) return null;

    const accounts = namespace.accounts ?? [];
    const methods = namespace.methods ?? [];
    const chains = namespace.chains ?? [];
    const account = accounts.find((candidate) => candidate.startsWith(`${CHAIN_ID}:`)) ?? null;
    const chainGranted = chains.includes(CHAIN_ID) || !!account;
    const methodsGranted = REQUIRED_NAMESPACES.chia.methods.every((method) => methods.includes(method));

    return account && chainGranted && methodsGranted ? account : null;
  }

  private async restoreExistingSession(signClient: InstanceType<typeof Client>): Promise<boolean> {
    const sessions = signClient.session.keys.map((key) => signClient.session.get(key));
    for (const session of sessions.reverse()) {
      const account = this.chiaAccountFor(session);
      if (!account) {
        continue;
      }

      this.onSessionConnected(session);
      return true;
    }
    return false;
  }

  private onSessionConnected(session: SessionTypes.Struct) {
    const account = this.chiaAccountFor(session);
    if (!account) {
      throw new Error('WalletConnect session does not grant the required Chia namespace');
    }
    const accountParts = account.split(':');
    const address = accountParts[2];
    const detectedChain = `${accountParts[0]}:${accountParts[1]}`;

    this.isConnected = true;
    this.address = address;
    this.chainId = detectedChain;
    this.session = session;
    this.logSessionIds('connected');
    this.observable.next({
      stateName: 'connected',
      initialized: true,
      haveClient: true,
      haveSession: true,
      connected: true,
      sessions: 1,
      address,
    });
  }

  private resetSession() {
    this.logSessionIds('before-reset');
    this.isConnected = false;
    this.session = undefined;
    this.address = undefined;
    this.chainId = undefined;
    this.observable.next({
      stateName: 'initialized',
      connected: false,
      sessions: 0,
      address: undefined,
    });
  }

  reset() {
    this.initPromise = null;
    this.client = undefined;
    this.resetSession();
  }

  init(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInit().catch((err) => {
      this.initPromise = null;
      throw err;
    });
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    const metadata = walletConnectDappMetadata();
    this.observable.next({ stateName: 'initializing', initializing: true });
    log('WalletConnect initializing...');

    try {
      const signClient = await Client.init({
        logger: 'error',
        projectId: PROJECT_ID,
        relayUrl: RELAY_URL,
        metadata,
      });

      this.client = signClient;

      signClient.on('session_update', ({ topic, params }) => {
        const updated = signClient.session.get(topic);
        const merged = { ...updated, namespaces: params.namespaces };
        log(`[WC session] update topic=${topic}`);
        this.onSessionConnected(merged);
      });

      signClient.on('session_delete', ({ topic }: { topic: string }) => {
        log(`[WC session] delete topic=${topic}`);
        this.resetSession();
      });

      signClient.on('session_expire', ({ topic }: { topic: string }) => {
        log(`[WC session] expire topic=${topic}`);
        this.resetSession();
      });

      log('WalletConnect initialized');
      this.observable.next({
        stateName: 'initialized',
        initialized: true,
        haveClient: true,
        sessions: signClient.session.length,
      });

      if (signClient.session.length) {
        const restored = await this.restoreExistingSession(signClient);
        if (!restored) {
          log('[WC session] no compatible restored Chia sessions found');
        }
      }
    } catch (err) {
      console.error('[WC] Client.init() FAILED', err);
      log(`WalletConnect init failed: ${err}`);
      this.observable.next({
        stateName: 'initialized',
        initialized: true,
        haveClient: false,
      });
      throw err;
    }
  }

  async disconnect() {
    if (!this.client || !this.session) return;

    const topic = this.session.topic;
    this.resetSession();

    try {
      await this.client.disconnect({
        topic,
        reason: { code: 6000, message: 'User disconnected' },
      });
    } catch {
      // WC disconnect can fail if session is already gone
    }
  }

  async startConnect(): Promise<StartConnectResult> {
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
        requiredNamespaces: REQUIRED_NAMESPACES,
      });

      this.observable.next({
        stateName: 'waitingApproval',
        waitingApproval: true,
        connecting: false,
      });

      if (!uri) throw new Error('WalletConnect connect() returned no URI');
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
    try {
      const session = await approval();
      this.onSessionConnected(session);
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
