import Client from '@walletconnect/sign-client';
import { SessionTypes } from '@walletconnect/types';
import { Subject } from 'rxjs';

import { PROJECT_ID, RELAY_URL } from '../../constants/env';
import {
  getChainId,
  getOptionalNamespaces,
  getRequiredNamespaces,
} from '../../constants/wallet-connect';
import { log } from '../../services/log';
import { walletConnectDappMetadata } from '../../util/walletConnectMetadata';
import { startPendingWalletConnectWipe } from '../session/saveHardReset';
import { AsyncJobQueue } from '../AsyncScheduler';

const WC_RELAY_LIFECYCLE_TIMEOUT_MS = 30000;
const WC_SESSION_AUTHORITY_KEY = 'appState_wcSessionAuthority';

export interface StartConnectResult {
  approval: () => Promise<SessionTypes.Struct>;
  uri: string;
  skipQr?: boolean;
}

/**
 * Extract the pairing topic from a WalletConnect v2 URI of the form
 * `wc:<topic>@<version>?...`. Throws if the topic is absent so a cancelled
 * pairing can always be torn down rather than leaking a live pairing.
 */
function pairingTopicFromUri(uri: string): string {
  const match = /^wc:([0-9a-f]+)@/i.exec(uri);
  if (!match) {
    throw new Error(`WalletConnect connect() returned an unparseable URI: ${uri}`);
  }
  return match[1];
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
  timedOutMethod?: string;
}

class WalletState {
  isConnected: boolean;
  address?: string;
  chainId?: string;
  session?: SessionTypes.Struct;
  client?: InstanceType<typeof Client>;
  observable: Subject<WalletConnectOutboundState>;
  private initPromise: Promise<void> | null = null;
  private pendingPairingTopic?: string;
  private relayAvailable = true;
  private requestEpoch = 0;
  private relayRecovery: Promise<void> | null = null;
  private relayLifecycle = new AsyncJobQueue();
  private connectionAttempt = 0;
  private approvalOwners = new WeakMap<
    StartConnectResult['approval'],
    {
      attempt: number;
      client: InstanceType<typeof Client>;
      topic: string;
    }
  >();

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
    return this.relayAvailable ? this.session : undefined;
  }

  getRequestEpoch(): number {
    return this.requestEpoch;
  }

  private runRelayLifecycle<T>(
    label: string,
    run: () => Promise<T> | T,
    boundActiveOperation = false,
    retainQueuedOperation = false,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let expired = false;
      const timer = setTimeout(() => {
        expired = true;
        reject(
          new Error(`WalletConnect ${label} timed out; reload the app if the relay remains stuck`),
        );
      }, WC_RELAY_LIFECYCLE_TIMEOUT_MS);
      this.relayLifecycle.enqueue({
        label,
        run: async () => {
          if (expired && !retainQueuedOperation) return;
          // Pairing/session mutations retain their true completion lifetime.
          // A timed-out relay operation still holds this consumer until settled.
          if (!boundActiveOperation) clearTimeout(timer);
          try {
            const result = await run();
            if (!expired) resolve(result);
          } catch (error) {
            reject(error);
          } finally {
            clearTimeout(timer);
          }
        },
      });
    });
  }

  recoverRelay(
    client: InstanceType<typeof Client>,
    topic: string,
    timedOutMethod?: string,
  ): Promise<void> {
    if (this.relayRecovery) return this.relayRecovery;
    if (this.client !== client || this.session?.topic !== topic) {
      return Promise.reject(new Error('WalletConnect session changed before relay recovery'));
    }
    const epoch = ++this.requestEpoch;
    this.relayAvailable = false;
    this.isConnected = false;
    this.observable.next({
      stateName: 'reconnecting',
      connected: false,
      sessions: 1,
      timedOutMethod,
    });
    const isCurrent = () =>
      this.client === client && this.session?.topic === topic && this.requestEpoch === epoch;
    const recovery = this.runRelayLifecycle(
      'relay recovery',
      async () => {
        if (!isCurrent()) throw new Error('WalletConnect session changed during relay recovery');
        log('[WC session] restarting relay after stalled request');
        await client.core.relayer.transportClose();
        // Finish replacing the shared transport even if the user disconnected.
        // New session establishment waits behind this entire physical operation.
        await client.core.relayer.transportOpen();
      },
      true,
    )
      .then(() => {
        if (!isCurrent()) throw new Error('WalletConnect session changed during relay recovery');
        this.relayAvailable = true;
        this.relayRecovery = null;
        this.onSessionConnected(this.session!);
      })
      .catch((error) => {
        if (isCurrent()) {
          this.observable.next({ stateName: 'disconnected', connected: false, sessions: 1 });
        }
        throw error;
      })
      .finally(() => {
        if (this.relayRecovery === recovery) this.relayRecovery = null;
      });
    this.relayRecovery = recovery;
    return recovery;
  }

  getChainId() {
    return this.chainId ?? getChainId();
  }

  getAddress() {
    return this.address;
  }

  supportsMethod(method: string): boolean {
    return this.session?.namespaces.chia?.methods?.includes(method) ?? false;
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
    const chainId = getChainId();
    const account = accounts.find((candidate) => candidate.startsWith(`${chainId}:`)) ?? null;
    const chainGranted = chains.includes(chainId) || !!account;
    const requiredMethods = getRequiredNamespaces().chia.methods ?? [];
    const methodsGranted = requiredMethods.every((method) => methods.includes(method));

    return account && chainGranted && methodsGranted ? account : null;
  }

  private async restoreExistingSession(signClient: InstanceType<typeof Client>): Promise<boolean> {
    const authorizedTopic = localStorage.getItem(WC_SESSION_AUTHORITY_KEY);
    const sessions = signClient.session.keys.map((key) => signClient.session.get(key));
    for (const session of sessions.reverse()) {
      if (authorizedTopic !== null && session.topic !== authorizedTopic) continue;
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
    localStorage.setItem(WC_SESSION_AUTHORITY_KEY, session.topic);

    this.isConnected = true;
    this.relayAvailable = true;
    this.address = address;
    this.chainId = detectedChain;
    this.session = session;
    this.pendingPairingTopic = undefined;
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
    this.requestEpoch++;
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

  /**
   * Release a pairing we have stopped waiting on. A pairing created by
   * `connect()` stays live in the WalletConnect store until it expires, so
   * every path that abandons an attempt has to cancel it explicitly. The topic
   * is a parameter rather than read from `pendingPairingTopic` because an
   * attempt can outlive its turn as the current one: a late failure must tear
   * down its own pairing, not whichever attempt is pending by then.
   */
  private async cancelPairing(topic: string | undefined, client = this.client) {
    if (!topic) return;
    await this.runRelayLifecycle(
      'pairing cancellation',
      async () => {
        if (this.pendingPairingTopic === topic) this.pendingPairingTopic = undefined;
        try {
          await client?.core.pairing.disconnect({ topic });
        } catch {
          // Pairing disconnect can fail if the pairing is already gone.
        }
      },
      false,
      true,
    );
  }

  async forgetSessions() {
    const client = this.client;
    localStorage.setItem(WC_SESSION_AUTHORITY_KEY, '');
    this.connectionAttempt++;
    this.resetSession();
    if (client) {
      await this.runRelayLifecycle(
        'session removal',
        async () => {
          for (const topic of client.session.keys) {
            try {
              await client.disconnect({
                topic,
                reason: { code: 6000, message: 'User disconnected' },
              });
            } catch {
              // WC disconnect can fail if the session is already gone.
            }
          }
        },
        false,
        true,
      );
    }
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
    // Finish any origin-wide wipe deferred from a hard reset before opening storage.
    await startPendingWalletConnectWipe();

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
        if (this.session?.topic !== topic) return;
        const updated = signClient.session.get(topic);
        const merged = { ...updated, namespaces: params.namespaces };
        log(`[WC session] update topic=${topic}`);
        if (!this.relayAvailable) {
          this.session = merged;
          return;
        }
        this.onSessionConnected(merged);
      });

      signClient.on('session_delete', ({ topic }: { topic: string }) => {
        log(`[WC session] delete topic=${topic}`);
        if (this.client === signClient && this.session?.topic === topic) this.resetSession();
      });

      signClient.on('session_expire', ({ topic }: { topic: string }) => {
        log(`[WC session] expire topic=${topic}`);
        if (this.client === signClient && this.session?.topic === topic) this.resetSession();
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
    const client = this.client;
    const sessionTopic = this.session?.topic;
    localStorage.setItem(WC_SESSION_AUTHORITY_KEY, '');
    this.connectionAttempt++;
    this.resetSession();
    if (!client) return;
    await this.runRelayLifecycle(
      'session disconnect',
      async () => {
        const pairingTopic = this.pendingPairingTopic;
        if (pairingTopic) {
          if (this.pendingPairingTopic === pairingTopic) this.pendingPairingTopic = undefined;
          try {
            await client.core.pairing.disconnect({ topic: pairingTopic });
          } catch {
            /* Already gone. */
          }
        }
        if (sessionTopic) {
          try {
            await client.disconnect({
              topic: sessionTopic,
              reason: { code: 6000, message: 'User disconnected' },
            });
          } catch {
            // WC disconnect can fail if session is already gone
          }
        }
      },
      false,
      true,
    );
  }

  async startConnect(): Promise<StartConnectResult> {
    const client = this.client;
    if (!client) {
      const msg = 'startConnect() called but client is undefined -- init() may have failed';
      console.error('[WC]', msg);
      throw new Error(msg);
    }

    const attempt = ++this.connectionAttempt;
    const isCurrent = () => this.client === client && this.connectionAttempt === attempt;

    // An attempt we never finished still holds a live pairing; cancel it before
    // creating another, since the new topic overwrites the one we would need to
    // tear it down with.
    await this.cancelPairing(this.pendingPairingTopic, client);

    try {
      const result = await this.runRelayLifecycle('pairing creation', async () => {
        if (!isCurrent()) throw new Error('WalletConnect connection attempt was cancelled');
        // Recovery can have restored the approved session while this job waited.
        const session = this.getSession();
        if (session) return { uri: '', skipQr: true, approval: async () => session };
        // A failed relay recovery hides the session without revoking approval.
        // Keep its restoration authority so reload can recover the same pairing.
        if (this.session)
          throw new Error(
            'WalletConnect relay is unavailable; reload to restore the approved session',
          );
        localStorage.setItem(WC_SESSION_AUTHORITY_KEY, '');
        this.observable.next({ stateName: 'connecting', connecting: true });
        if (!isCurrent()) throw new Error('WalletConnect connection attempt was cancelled');
        const { uri, approval } = await client.connect({
          optionalNamespaces: getOptionalNamespaces(),
        });
        if (!uri) throw new Error('WalletConnect connect() returned no URI');
        const topic = pairingTopicFromUri(uri);
        if (!isCurrent()) {
          try {
            await client.core.pairing.disconnect({ topic });
          } catch {
            /* Already gone. */
          }
          // Approval can still arrive after pairing cancellation. Keep ownership
          // of that result so its session can never become a restore candidate.
          void Promise.resolve()
            .then(approval)
            .then(
              (approved) => this.discardSession(client, approved.topic),
              () => {},
            )
            .catch((error) =>
              log(`[WC session] abandoned approval cleanup failed: ${String(error)}`),
            );
          throw new Error('WalletConnect connection attempt was cancelled');
        }
        const ownedApproval = () => approval();
        this.approvalOwners.set(ownedApproval, { attempt, client, topic });
        this.pendingPairingTopic = topic;
        this.observable.next({
          stateName: 'waitingApproval',
          waitingApproval: true,
          connecting: false,
        });
        return { uri, approval: ownedApproval };
      });
      if (!isCurrent()) throw new Error('WalletConnect connection attempt was cancelled');
      return result;
    } catch (err) {
      console.error('[WC] startConnect() FAILED', err);
      if (isCurrent())
        this.observable.next({
          stateName: 'initialized',
          connecting: false,
          waitingApproval: false,
        });
      throw err;
    }
  }

  private discardSession(client: InstanceType<typeof Client>, topic: string): Promise<void> {
    return this.runRelayLifecycle(
      'abandoned session removal',
      async () => {
        try {
          await client.disconnect({
            topic,
            reason: { code: 6000, message: 'Connection attempt cancelled' },
          });
        } catch {
          /* Already gone. */
        }
      },
      false,
      true,
    );
  }

  async connect(approval: () => Promise<SessionTypes.Struct>) {
    // The pairing this approval belongs to. An approval can reject long after
    // it was abandoned (proposal expiry), by which time a retry may own the
    // pending topic, so teardown below uses this one rather than the current.
    const owner = this.approvalOwners.get(approval);
    const topic = owner?.topic ?? this.pendingPairingTopic;
    const client = owner?.client ?? this.client;
    const attempt = owner?.attempt ?? this.connectionAttempt;
    let approvedSession: SessionTypes.Struct | undefined;
    try {
      const session = await approval();
      approvedSession = session;
      await this.runRelayLifecycle('session installation', () => {
        if (this.client !== client || this.connectionAttempt !== attempt)
          throw new Error('WalletConnect connection attempt was cancelled');
        this.onSessionConnected(session);
      });
    } catch (err) {
      console.error('[WC] connect() approval FAILED or rejected', err);
      // A retry or an explicit disconnect during the wait owns the connection
      // state now, and has already reported it; a superseded attempt may only
      // clean up after itself.
      const superseded = this.connectionAttempt !== attempt || this.pendingPairingTopic !== topic;
      // The proposal is dead once approval settles with an error, but its
      // pairing is not; the wallet declining must not leak it.
      if (approvedSession && client) {
        await this.discardSession(client, approvedSession.topic).catch((error) =>
          log(`[WC session] abandoned session cleanup pending: ${String(error)}`),
        );
      }
      await this.cancelPairing(topic, client);
      if (!superseded) {
        this.observable.next({
          stateName: 'initialized',
          waitingApproval: false,
          connecting: false,
          connected: false,
        });
      }
      throw err;
    }
  }
}

export const walletConnectState = new WalletState();
