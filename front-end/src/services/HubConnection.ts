import { log } from './log';
import {
  decode as decodeBencodex,
  encode as encodeBencodex,
  getBytes,
  getInteger,
  getText,
  isDictionary,
  type BencodexKey,
  type BencodexValue,
} from 'chia-gaming-bencodex';

export interface AdvisoryStartParams {
  peer_id: string;
  peer_alias: string;
  my_amount: string;
  their_amount: string;
  channel_timeout?: string;
  unroll_timeout?: string;
}

export interface HubConnectionCallbacks {
  onAdvisoryStart: (params: AdvisoryStartParams) => void;
  onPeerMessage: (from_id: string, from_alias: string, payload: Uint8Array) => void;
  onPeerAppMessage: (from_id: string, from_alias: string, data: PeerAppMessage) => void;
  onDeliveryFailure: (to: string) => void;
  onRegistered: (player_id: string) => void;
  onAliasUpdated: (alias: string) => void;
  onPeerAvailable: (player_id: string) => void;
  onClosed: () => void;
  onHubAttention: () => void;
  onHubDisconnected: () => void;
  onHubReconnected: () => void;
  onHubActivity: () => void;
  getPresence: () => { busy: boolean };
}

type HubEnvelope =
  | {
      type: 'advisory_start';
      peer_id: string;
      peer_alias: string;
      my_amount: string;
      their_amount: string;
      channel_timeout?: string;
      unroll_timeout?: string;
    }
  | { type: 'registered'; player_id: string }
  | { type: 'delivery_failure'; to: string }
  | { type: 'alias_updated'; alias: string }
  | { type: 'peer_available'; player_id: string }
  | { type: 'relay'; from: string; alias: string; payload: Uint8Array }
  | { type: 'hub_attention' }
  | { type: 'closed' }
  | { type: 'keepalive' };

export type PeerAppMessage =
  | {
      type: 'session_proposal';
      proposer_amount: string;
      responder_amount: string;
      channel_timeout?: string;
      unroll_timeout?: string;
      game_session_id?: string;
      network?: string;
    }
  | { type: 'session_reject' };

function definedBencodexFields(
  data: Record<string, BencodexValue | undefined>,
): Record<string, BencodexValue> {
  const out: Record<string, BencodexValue> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function optionalText(map: Map<BencodexKey, BencodexValue>, key: string): string | undefined {
  const value = map.get(key);
  return typeof value === 'string' ? value : undefined;
}

function requireText(map: Map<BencodexKey, BencodexValue>, key: string): string {
  const value = optionalText(map, key);
  if (value === undefined) throw new Error(`missing text field: ${key}`);
  return value;
}

const WIRE_ID_BYTES = 16;
const MAX_ALIAS_BYTES = 128;

function requireBytes(
  map: Map<BencodexKey, BencodexValue>,
  key: string,
  length?: number,
): Uint8Array {
  const value = getBytes(map, key);
  if (!value || (length !== undefined && value.byteLength !== length)) {
    throw new Error(
      length === undefined
        ? `missing byte string field: ${key}`
        : `${key} must be exactly ${length} bytes`,
    );
  }
  return value;
}

function requireInteger(map: Map<BencodexKey, BencodexValue>, key: string): bigint {
  const value = getInteger(map, key);
  if (value === undefined) throw new Error(`missing integer field: ${key}`);
  return value;
}

function optionalInteger(map: Map<BencodexKey, BencodexValue>, key: string): bigint | undefined {
  if (!map.has(key)) return undefined;
  const value = getInteger(map, key);
  if (value === undefined) throw new Error(`invalid integer field: ${key}`);
  return value;
}

function playerIdFromWire(bytes: Uint8Array): string {
  if (bytes.byteLength !== WIRE_ID_BYTES) throw new Error('invalid player id length');
  return `p_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function playerIdToWire(playerId: string): Uint8Array {
  if (!/^p_[0-9a-f]{32}$/.test(playerId)) throw new Error(`invalid player id: ${playerId}`);
  return Uint8Array.from(
    playerId
      .slice(2)
      .match(/../g)!
      .map((pair) => Number.parseInt(pair, 16)),
  );
}

function sessionIdToWire(sessionId: string): Uint8Array {
  if (!/^[0-9a-f]{32}$/.test(sessionId)) throw new Error(`invalid hub session id: ${sessionId}`);
  return Uint8Array.from(sessionId.match(/../g)!.map((pair) => Number.parseInt(pair, 16)));
}

function requireAlias(map: Map<BencodexKey, BencodexValue>, key: string): string {
  const alias = requireText(map, key);
  if (!alias || new TextEncoder().encode(alias).byteLength > MAX_ALIAS_BYTES) {
    throw new Error(`invalid alias field: ${key}`);
  }
  return alias;
}

function decodeHubEnvelope(input: ArrayBuffer): HubEnvelope | null {
  const decoded = decodeBencodex(input);
  if (!isDictionary(decoded)) return null;
  const type = getText(decoded, 'type');
  if (!type) return null;
  switch (type) {
    case 'advisory_start':
      return {
        type,
        peer_id: playerIdFromWire(requireBytes(decoded, 'peer_id', WIRE_ID_BYTES)),
        peer_alias: requireAlias(decoded, 'peer_alias'),
        my_amount: requireInteger(decoded, 'my_amount').toString(),
        their_amount: requireInteger(decoded, 'their_amount').toString(),
        channel_timeout: optionalInteger(decoded, 'channel_timeout')?.toString(),
        unroll_timeout: optionalInteger(decoded, 'unroll_timeout')?.toString(),
      };
    case 'registered':
      return {
        type,
        player_id: playerIdFromWire(requireBytes(decoded, 'player_id', WIRE_ID_BYTES)),
      };
    case 'delivery_failure':
      return { type, to: playerIdFromWire(requireBytes(decoded, 'to', WIRE_ID_BYTES)) };
    case 'alias_updated':
      return { type, alias: requireAlias(decoded, 'alias') };
    case 'peer_available':
      return {
        type,
        player_id: playerIdFromWire(requireBytes(decoded, 'player_id', WIRE_ID_BYTES)),
      };
    case 'relay':
      return {
        type,
        from: playerIdFromWire(requireBytes(decoded, 'from', WIRE_ID_BYTES)),
        alias: requireAlias(decoded, 'alias'),
        payload: requireBytes(decoded, 'payload'),
      };
    case 'hub_attention':
    case 'closed':
    case 'keepalive':
      return { type };
    default:
      return null;
  }
}

function decodePeerAppMessage(payload: Uint8Array): PeerAppMessage | null {
  const decoded = decodeBencodex(payload);
  if (!isDictionary(decoded)) return null;
  const type = getText(decoded, 'type');
  if (!type) return null;
  switch (type) {
    case 'session_proposal':
      return {
        type,
        proposer_amount: requireText(decoded, 'proposer_amount'),
        responder_amount: requireText(decoded, 'responder_amount'),
        channel_timeout: optionalText(decoded, 'channel_timeout'),
        unroll_timeout: optionalText(decoded, 'unroll_timeout'),
        game_session_id: optionalText(decoded, 'game_session_id'),
        network: optionalText(decoded, 'network'),
      };
    case 'session_reject':
      return { type };
    default:
      return null;
  }
}

export class HubConnection {
  private hubUrl: string;
  private sessionId: string;
  private callbacks: HubConnectionCallbacks;
  private ws: WebSocket | null = null;
  private closed = false;
  private wasDisconnected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  // Monotonic backoff: stay out of Firefox's failure queue during cutovers.
  private static readonly RECONNECT_DELAYS = [5000, 10000, 20000, 30000, 60000];
  // See FakeBlockchainInterface: Firefox can delay WS opens for many seconds
  // after failures; aborting early makes the next attempt slower.
  private static readonly CONNECT_TIMEOUT_MS = 30_000;
  static readonly MAX_RECONNECT_ATTEMPTS = 18;
  private reconnectAttempt = 0;
  private busy = false;
  private closePending = false;
  private myPlayerId: string | null = null;

  constructor(hubUrl: string, sessionId: string, callbacks: HubConnectionCallbacks) {
    this.hubUrl = hubUrl;
    this.sessionId = sessionId;
    this.callbacks = callbacks;
    const presence = callbacks.getPresence();
    this.busy = presence.busy;
    this.connectWs();
  }

  private getWsUrl(): string {
    const url = new URL(this.hubUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = '/ws/game';
    url.search = '';
    url.hash = '';
    return url.toString();
  }

  private sendWs(payload: Record<string, unknown>): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      log(`[hub] sendWs dropped (ws not open) type=${String(payload.type ?? '?')}`);
      return false;
    }
    ws.send(
      encodeBencodex(definedBencodexFields(payload as Record<string, BencodexValue | undefined>)),
    );
    return true;
  }

  private presencePayload(type: 'identify' | 'set_busy'): Record<string, unknown> {
    return {
      type,
      ...(type === 'identify' ? { session_id: sessionIdToWire(this.sessionId) } : {}),
      busy: this.busy,
    };
  }

  private connectWs(): void {
    if (this.closed) return;
    let wsUrl: string;
    try {
      wsUrl = this.getWsUrl();
    } catch {
      this.closed = true;
      const msg = `Invalid hub URL: ${this.hubUrl}`;
      log(`[hub] ${msg}`);
      throw new Error(msg);
    }
    const ws = new WebSocket(wsUrl);

    const connectTimeout = globalThis.setTimeout(() => {
      if (this.ws === ws || this.closed) return;
      log('[hub] connection timeout, closing attempt');
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }, HubConnection.CONNECT_TIMEOUT_MS);
    if (typeof connectTimeout === 'object' && 'unref' in connectTimeout) connectTimeout.unref();

    ws.onopen = () => {
      globalThis.clearTimeout(connectTimeout);
      this.ws = ws;
      this.reconnectAttempt = 0;
      const presence = this.callbacks.getPresence();
      this.busy = presence.busy;
      this.sendWs(this.presencePayload('identify'));
      if (this.closePending) {
        this.sendCloseRequest();
      }
      if (this.wasDisconnected) {
        log('[hub] reconnected to hub');
        this.callbacks.onHubReconnected();
      }
      this.wasDisconnected = false;
      if (this.reconnectTimer !== null) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.startKeepaliveTimer();
    };

    ws.binaryType = 'arraybuffer';

    ws.onmessage = (evt: MessageEvent) => {
      if (this.ws !== ws) return;
      this.callbacks.onHubActivity();

      if (evt.data instanceof ArrayBuffer) {
        if (this.closed) return;
        this.dispatchHubEnvelope(evt.data);
        return;
      }

      log('[hub] recv unexpected text ws frame');
    };

    ws.onerror = () => {
      globalThis.clearTimeout(connectTimeout);
      this.stopKeepaliveTimer();
      if (!this.closed && !this.wasDisconnected) {
        this.wasDisconnected = true;
        log('[hub] WS connection error, will auto-reconnect');
        this.callbacks.onHubDisconnected();
      }
    };

    ws.onclose = () => {
      globalThis.clearTimeout(connectTimeout);
      this.stopKeepaliveTimer();
      if (this.closed) return;
      if (!this.wasDisconnected) {
        this.wasDisconnected = true;
        this.callbacks.onHubDisconnected();
      }
      if (this.ws === ws) {
        this.ws = null;
      }
      if (this.reconnectTimer === null) {
        if (this.reconnectAttempt >= HubConnection.MAX_RECONNECT_ATTEMPTS) {
          log('[hub] reconnect budget exhausted, declaring connection dead');
          this.closed = true;
          this.callbacks.onClosed();
          return;
        }
        const base =
          HubConnection.RECONNECT_DELAYS[
            Math.min(this.reconnectAttempt, HubConnection.RECONNECT_DELAYS.length - 1)
          ];
        const jitter = Math.round(base * (0.75 + Math.random() * 0.5));
        this.reconnectAttempt++;
        this.reconnectTimer = globalThis.setTimeout(() => {
          this.reconnectTimer = null;
          this.connectWs();
        }, jitter);
        if (typeof this.reconnectTimer === 'object' && 'unref' in this.reconnectTimer)
          this.reconnectTimer.unref();
      }
    };
  }

  private dispatchHubEnvelope(buf: ArrayBuffer): void {
    let msg: HubEnvelope | null;
    try {
      msg = decodeHubEnvelope(buf);
    } catch {
      log('[hub] recv malformed bencodex envelope');
      return;
    }
    if (!msg || typeof msg !== 'object' || !('type' in msg)) {
      log('[hub] recv malformed ws envelope');
      return;
    }

    switch (msg.type) {
      case 'advisory_start': {
        const params: AdvisoryStartParams = {
          peer_id: msg.peer_id,
          peer_alias: msg.peer_alias,
          my_amount: msg.my_amount,
          their_amount: msg.their_amount,
          channel_timeout: msg.channel_timeout,
          unroll_timeout: msg.unroll_timeout,
        };
        log(
          `[hub] advisory_start peer=${params.peer_id} alias=${params.peer_alias} my_amount=${params.my_amount} their_amount=${params.their_amount}`,
        );
        this.callbacks.onAdvisoryStart(params);
        break;
      }
      case 'registered':
        this.myPlayerId = msg.player_id;
        log(`[hub] registered as player_id=${msg.player_id}`);
        this.callbacks.onRegistered(msg.player_id);
        break;
      case 'delivery_failure':
        log(`[hub] delivery_failure to=${msg.to}`);
        this.callbacks.onDeliveryFailure(msg.to);
        break;
      case 'alias_updated':
        this.callbacks.onAliasUpdated(msg.alias);
        break;
      case 'peer_available':
        this.callbacks.onPeerAvailable(msg.player_id);
        break;
      case 'relay':
        this.dispatchRelay(msg.from, msg.alias, msg.payload);
        break;
      case 'hub_attention':
        this.callbacks.onHubAttention();
        break;
      case 'closed':
        this.closePending = false;
        this.callbacks.onClosed();
        break;
      case 'keepalive':
        break;
      default:
        break;
    }
  }

  sendToPeer(targetId: string, payload: Uint8Array): boolean {
    const sent = this.sendWs({ type: 'relay', to: playerIdToWire(targetId), payload });
    if (!sent) {
      log(`[hub] sendToPeer dropped (ws not open) to=${targetId} len=${payload.byteLength}`);
      return false;
    }
    log(`[hub] send to=${targetId} len=${payload.byteLength}`);
    return true;
  }

  /**
   * Send a bencodex app message to a specific peer through the hub pipe.
   */
  sendPeerAppMessage(targetId: string, data: PeerAppMessage): boolean {
    log(`[hub] send app type=${data.type} to=${targetId}`);
    const payload = encodeBencodex(
      definedBencodexFields(data as Record<string, BencodexValue | undefined>),
    );
    return this.sendToPeer(targetId, payload);
  }

  getPlayerId(): string | null {
    return this.myPlayerId;
  }

  forceDisconnect() {
    if (this.closed) return;
    this.closed = true;
    log('[hub] force disconnect');
    this.stopKeepaliveTimer();
    this.ws?.close();
    this.ws = null;
  }

  setBusy(busy: boolean) {
    this.busy = busy;
    this.sendWs(this.presencePayload('set_busy'));
  }

  close() {
    if (this.closed) return;
    if (this.closePending) {
      this.sendCloseRequest();
      return;
    }
    this.closePending = true;
    log('[hub] requesting close');
    this.sendCloseRequest();
  }

  private sendCloseRequest() {
    this.sendWs({ type: 'close' });
  }

  disconnect() {
    this.closed = true;
    this.stopKeepaliveTimer();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  private dispatchRelay(fromId: string, fromAlias: string, payload: Uint8Array): void {
    if (payload.length > 0 && payload[0] === 0x64) {
      try {
        const data = decodePeerAppMessage(payload);
        if (data) {
          log(`[hub] recv app type=${data.type} from=${fromId}`);
          this.callbacks.onPeerAppMessage(fromId, fromAlias, data);
          return;
        }
      } catch {
        // Not a valid app message, fall through to raw peer protocol bytes.
      }
    }

    log(`[hub] recv from=${fromId} len=${payload.byteLength}`);
    this.callbacks.onPeerMessage(fromId, fromAlias, payload);
  }

  private startKeepaliveTimer() {
    this.stopKeepaliveTimer();
    this.keepaliveTimer = setInterval(() => {
      this.sendWs({ type: 'keepalive' });
    }, 15_000);
    if (typeof this.keepaliveTimer === 'object' && 'unref' in this.keepaliveTimer)
      this.keepaliveTimer.unref();
  }

  private stopKeepaliveTimer() {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }
}
