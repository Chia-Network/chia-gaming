import { log } from './log';
import type { GameHubConnection, HubConnectionCallbacks } from './HubConnection';

/**
 * Pseudo hub origin for the peer-to-peer lobby. It stands in wherever the app
 * keys state by hub origin (saved `hubUrl`, the derived hub session
 * credential), so choosing the P2P lobby behaves like choosing a hub.
 */
export const PEAR_LOBBY_ORIGIN = 'pear://lobby';

export type PearLobbyTopic = 'mainnet' | 'testnet' | 'simulator';

export interface PearLobbyPlayer {
  id: string;
  alias: string;
  busy: boolean;
  /** Buy-in (mojos) the player is looking to play for, if they set one. */
  stake: string | null;
}

export interface PearLobbyChallenge {
  id: string;
  from: string;
  to: string;
  challenger_amount: string;
  target_amount: string;
  channel_timeout?: string;
  unroll_timeout?: string;
}

export interface PearLobbyState {
  me: PearLobbyPlayer | null;
  /** Everyone whose presence reached us, including ourselves. */
  online: number;
  players: PearLobbyPlayer[];
  challenges: PearLobbyChallenge[];
  error: string | null;
}

type PearWorkerMessage =
  | { t: 'ready' }
  | { t: 'registered'; player_id: string }
  | {
      t: 'lobby';
      me: PearLobbyPlayer | null;
      online: number;
      players: PearLobbyPlayer[];
      challenges: PearLobbyChallenge[];
    }
  | {
      t: 'advisory_start';
      peer_id: string;
      peer_alias: string;
      my_amount: string;
      their_amount: string;
      channel_timeout?: string;
      unroll_timeout?: string;
    }
  | { t: 'relay'; from: string; alias: string; payload: string }
  | { t: 'delivery_failure'; to: string }
  | { t: 'peer_available'; player_id: string }
  | { t: 'peer_unavailable'; player_id: string }
  | { t: 'alias_updated'; alias: string }
  | { t: 'hub_attention' }
  | { t: 'challenge_resolved'; id: string; accepted: boolean; peer_id: string }
  | { t: 'error'; error: string }
  | { t: 'closed' }
  | { t: 'log'; text: string }
  | { t: 'updater'; event: string; detail?: string }
  | { t: 'worker_exit' };

export function isPearLobbyAvailable(): boolean {
  return typeof window !== 'undefined' && window.__chiaPear !== undefined;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * The hub connection, served by the desktop app's Pear worker instead of a
 * hub server. It honours the same callbacks as `HubConnection`, so the session
 * code above it — advisory, reliable frames, liveness, restore — is unchanged;
 * the lobby that the hub iframe would show is exposed as `PearLobbyState`.
 */
export class PearHubConnection implements GameHubConnection {
  // Mirrors HubConnection's keepalive cadence: the session layer sends its
  // peer keepalive on each tick so a live channel never looks silent.
  private static readonly KEEPALIVE_MS = 15_000;
  private static readonly WORKER_RESTART_MS = 2_000;

  private readonly bridge: NonNullable<Window['__chiaPear']>;
  private readonly unsubscribe: () => void;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private myPlayerId: string | null = null;
  private lobby: PearLobbyState = {
    me: null,
    online: 0,
    players: [],
    challenges: [],
    error: null,
  };
  private readonly lobbyListeners = new Set<(state: PearLobbyState) => void>();

  constructor(
    private readonly sessionId: string,
    private readonly topic: PearLobbyTopic,
    private alias: string | undefined,
    private readonly callbacks: HubConnectionCallbacks,
  ) {
    const bridge = window.__chiaPear;
    if (bridge === undefined) throw new Error('The peer-to-peer lobby needs the desktop app.');
    this.bridge = bridge;
    this.unsubscribe = bridge.onMessage((raw) => this.onWorkerMessage(raw));
    this.identify();
  }

  private send(message: Record<string, unknown>): void {
    void this.bridge.send(JSON.stringify(message));
  }

  private identify(): void {
    this.send({
      t: 'identify',
      session_id: this.sessionId,
      network: this.topic,
      busy: this.callbacks.getPresence().busy,
      alias: this.alias,
    });
  }

  private onWorkerMessage(raw: string): void {
    if (this.closed) return;
    let message: PearWorkerMessage;
    try {
      message = JSON.parse(raw) as PearWorkerMessage;
    } catch {
      log('[pear] malformed worker message');
      return;
    }
    if (message.t !== 'log') this.callbacks.onHubActivity();

    switch (message.t) {
      case 'registered': {
        const reconnected = this.myPlayerId !== null;
        this.myPlayerId = message.player_id;
        log(`[pear] registered as player_id=${message.player_id}`);
        this.startKeepalive();
        if (reconnected) this.callbacks.onHubReconnected();
        this.callbacks.onRegistered(message.player_id);
        break;
      }
      case 'lobby':
        this.setLobby({
          me: message.me,
          online: message.online,
          players: message.players,
          challenges: message.challenges,
          error: this.lobby.error,
        });
        break;
      case 'advisory_start':
        log(`[pear] advisory_start peer=${message.peer_id}`);
        this.callbacks.onAdvisoryStart({
          peer_id: message.peer_id,
          peer_alias: message.peer_alias,
          my_amount: message.my_amount,
          their_amount: message.their_amount,
          channel_timeout: message.channel_timeout,
          unroll_timeout: message.unroll_timeout,
        });
        break;
      case 'relay': {
        const payload = base64ToBytes(message.payload);
        log(`[pear] recv from=${message.from} len=${payload.byteLength}`);
        this.callbacks.onPeerMessage(message.from, message.alias, payload);
        break;
      }
      case 'delivery_failure':
        log(`[pear] delivery_failure to=${message.to}`);
        this.callbacks.onDeliveryFailure(message.to);
        break;
      case 'peer_available':
        this.callbacks.onPeerAvailable(message.player_id);
        break;
      case 'peer_unavailable':
        this.callbacks.onPeerUnavailable(message.player_id);
        break;
      case 'alias_updated':
        this.alias = message.alias;
        this.callbacks.onAliasUpdated(message.alias);
        break;
      case 'hub_attention':
        this.callbacks.onHubAttention();
        break;
      case 'error':
        this.setLobby({ ...this.lobby, error: message.error });
        break;
      case 'log':
        log(`[pear-worker] ${message.text}`);
        break;
      case 'updater':
        log(`[pear] updater ${message.event}${message.detail ? `: ${message.detail}` : ''}`);
        break;
      case 'worker_exit':
        // Main starts a fresh worker on the next command; identify after a
        // pause so a crash loop cannot spin.
        log('[pear] worker exited; restarting');
        this.stopKeepalive();
        this.callbacks.onHubDisconnected();
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          if (!this.closed) this.identify();
        }, PearHubConnection.WORKER_RESTART_MS);
        break;
      case 'ready':
      case 'challenge_resolved':
      case 'closed':
        break;
    }
  }

  private setLobby(state: PearLobbyState): void {
    this.lobby = state;
    for (const listener of this.lobbyListeners) listener(state);
  }

  private startKeepalive(): void {
    this.stopKeepalive();
    this.keepaliveTimer = setInterval(
      () => this.callbacks.onHubKeepalive?.(),
      PearHubConnection.KEEPALIVE_MS,
    );
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer !== null) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  // --- GameHubConnection -----------------------------------------------------

  sendToPeer(targetId: string, payload: Uint8Array): boolean {
    if (this.closed || this.myPlayerId === null) {
      log(`[pear] sendToPeer dropped (not registered) to=${targetId}`);
      return false;
    }
    this.send({ t: 'relay', to: targetId, payload: bytesToBase64(payload) });
    log(`[pear] send to=${targetId} len=${payload.byteLength}`);
    return true;
  }

  getPlayerId(): string | null {
    return this.myPlayerId;
  }

  setBusy(busy: boolean): void {
    this.send({ t: 'set_busy', busy });
  }

  disconnect(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopKeepalive();
    if (this.restartTimer !== null) clearTimeout(this.restartTimer);
    this.unsubscribe();
    this.lobbyListeners.clear();
    this.send({ t: 'close' });
  }

  // --- Lobby -----------------------------------------------------------------

  getLobby(): PearLobbyState {
    return this.lobby;
  }

  subscribeLobby(listener: (state: PearLobbyState) => void): () => void {
    this.lobbyListeners.add(listener);
    return () => {
      this.lobbyListeners.delete(listener);
    };
  }

  clearLobbyError(): void {
    this.setLobby({ ...this.lobby, error: null });
  }

  setAlias(alias: string): void {
    this.send({ t: 'set_alias', alias });
  }

  /** Advertise the buy-in this player is looking for (null to clear). */
  setStake(stake: string | null): void {
    this.send({ t: 'set_stake', stake });
  }

  challenge(
    to: string,
    challengerAmount: string,
    targetAmount: string,
    channelTimeout: string,
    unrollTimeout: string,
  ): void {
    this.send({
      t: 'challenge',
      to,
      challenger_amount: challengerAmount,
      target_amount: targetAmount,
      channel_timeout: channelTimeout,
      unroll_timeout: unrollTimeout,
    });
  }

  acceptChallenge(id: string): void {
    this.send({ t: 'challenge_accept', id });
  }

  declineChallenge(id: string): void {
    this.send({ t: 'challenge_decline', id });
  }

  cancelChallenge(id: string): void {
    this.send({ t: 'challenge_cancel', id });
  }
}
