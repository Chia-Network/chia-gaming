import { log } from './log';
import {
  decode as decodeBencodex,
  encode as encodeBencodex,
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
  onClosed: () => void;
  onHubAttention: () => void;
  onHubDisconnected: () => void;
  onHubReconnected: () => void;
  onHubActivity: () => void;
  getPresence: () => { busy: boolean; alias?: string };
}

type HubEnvelope =
  | { type: 'advisory_start'; peer_id: string; peer_alias: string; my_amount: string; their_amount: string; channel_timeout?: string; unroll_timeout?: string }
  | { type: 'registered'; player_id: string }
  | { type: 'delivery_failure'; to: string }
  | { type: 'hub_attention' }
  | { type: 'closed' }
  | { type: 'keepalive' }
  | { type: 'error'; error?: string };

export type PeerAppMessage =
  | { type: 'session_proposal'; proposer_amount: string; responder_amount: string; from_alias?: string; channel_timeout?: string; unroll_timeout?: string; game_session_id?: string }
  | { type: 'session_reject' };

function definedBencodexFields(data: Record<string, BencodexValue | undefined>): Record<string, BencodexValue> {
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

function decodeHubEnvelope(input: ArrayBuffer): HubEnvelope | null {
  const decoded = decodeBencodex(input);
  if (!isDictionary(decoded)) return null;
  const type = getText(decoded, 'type');
  if (!type) return null;
  switch (type) {
    case 'advisory_start':
      return {
        type,
        peer_id: requireText(decoded, 'peer_id'),
        peer_alias: requireText(decoded, 'peer_alias'),
        my_amount: requireText(decoded, 'my_amount'),
        their_amount: requireText(decoded, 'their_amount'),
        channel_timeout: optionalText(decoded, 'channel_timeout'),
        unroll_timeout: optionalText(decoded, 'unroll_timeout'),
      };
    case 'registered':
      return { type, player_id: requireText(decoded, 'player_id') };
    case 'delivery_failure':
      return { type, to: requireText(decoded, 'to') };
    case 'hub_attention':
    case 'closed':
    case 'keepalive':
      return { type };
    case 'error':
      return { type, error: optionalText(decoded, 'error') };
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
        from_alias: optionalText(decoded, 'from_alias'),
        channel_timeout: optionalText(decoded, 'channel_timeout'),
        unroll_timeout: optionalText(decoded, 'unroll_timeout'),
        game_session_id: optionalText(decoded, 'game_session_id'),
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
  private alias: string | undefined;

  constructor(hubUrl: string, sessionId: string, callbacks: HubConnectionCallbacks) {
    this.hubUrl = hubUrl;
    this.sessionId = sessionId;
    this.callbacks = callbacks;
    const presence = callbacks.getPresence();
    this.busy = presence.busy;
    this.alias = presence.alias;
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

  private sendWs(payload: Record<string, unknown>): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(encodeBencodex(definedBencodexFields(payload as Record<string, BencodexValue | undefined>)));
  }

  private presencePayload(type: 'identify' | 'set_busy'): Record<string, unknown> {
    return {
      type,
      session_id: this.sessionId,
      busy: this.busy,
      ...(this.alias ? { alias: this.alias } : {}),
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
      try { ws.close(); } catch { /* ignore */ }
    }, HubConnection.CONNECT_TIMEOUT_MS);
    if (typeof connectTimeout === 'object' && 'unref' in connectTimeout) connectTimeout.unref();

    ws.onopen = () => {
      globalThis.clearTimeout(connectTimeout);
      this.ws = ws;
      this.reconnectAttempt = 0;
      const presence = this.callbacks.getPresence();
      this.busy = presence.busy;
      this.alias = presence.alias;
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
        const bytes = new Uint8Array(evt.data);
        if (bytes[0] === 0x64) {
          this.dispatchHubEnvelope(evt.data);
        } else {
          this.dispatchBinaryFrame(evt.data);
        }
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
        const base = HubConnection.RECONNECT_DELAYS[
          Math.min(this.reconnectAttempt, HubConnection.RECONNECT_DELAYS.length - 1)
        ];
        const jitter = Math.round(base * (0.75 + Math.random() * 0.5));
        this.reconnectAttempt++;
        this.reconnectTimer = globalThis.setTimeout(() => {
          this.reconnectTimer = null;
          this.connectWs();
        }, jitter);
        if (typeof this.reconnectTimer === 'object' && 'unref' in this.reconnectTimer) this.reconnectTimer.unref();
      }
    };
  }

  private dispatchHubEnvelope(buf: ArrayBuffer): void {
    let msg: HubEnvelope | null = null;
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
        log(`[hub] advisory_start peer=${params.peer_id} alias=${params.peer_alias} my_amount=${params.my_amount} their_amount=${params.their_amount}`);
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
      case 'hub_attention':
        this.callbacks.onHubAttention();
        break;
      case 'closed':
        this.closePending = false;
        this.callbacks.onClosed();
        break;
      case 'keepalive':
        break;
      case 'error':
        log(`[hub] server error: ${msg.error ?? 'unknown'}`);
        break;
      default:
        break;
    }
  }

  /**
   * Send a binary payload to a specific peer through the hub pipe.
   * Wire format: [4-byte target_id_len BE][target_id UTF-8][payload]
   */
  sendToPeer(targetId: string, payload: Uint8Array): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const targetBuf = new TextEncoder().encode(targetId);
    const frame = new Uint8Array(4 + targetBuf.byteLength + payload.byteLength);
    const view = new DataView(frame.buffer);
    view.setUint32(0, targetBuf.byteLength, false);
    frame.set(targetBuf, 4);
    frame.set(payload, 4 + targetBuf.byteLength);
    ws.send(frame);
    log(`[hub] send to=${targetId} len=${payload.byteLength}`);
  }

  /**
   * Send a bencodex app message to a specific peer through the hub pipe.
   */
  sendPeerAppMessage(targetId: string, data: PeerAppMessage): void {
    const payload = encodeBencodex(definedBencodexFields(data as Record<string, BencodexValue | undefined>));
    this.sendToPeer(targetId, payload);
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

  setBusy(busy: boolean, alias?: string | null) {
    this.busy = busy;
    if (alias !== undefined) {
      this.alias = alias || undefined;
    }
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
    this.sendWs({ type: 'close', session_id: this.sessionId });
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

  private dispatchBinaryFrame(buf: ArrayBuffer): void {
    // Inbound binary: [4B from_id_len BE][from_id][4B from_alias_len BE][from_alias][payload]
    if (buf.byteLength < 4) {
      log('[hub] recv binary frame too short');
      return;
    }
    const view = new DataView(buf);
    const fromIdLen = view.getUint32(0, false);
    if (buf.byteLength < 4 + fromIdLen + 4) {
      log('[hub] recv binary frame header incomplete');
      return;
    }
    const fromIdBytes = new Uint8Array(buf, 4, fromIdLen);
    const fromId = new TextDecoder().decode(fromIdBytes);
    const aliasOffset = 4 + fromIdLen;
    const fromAliasLen = view.getUint32(aliasOffset, false);
    const payloadStart = aliasOffset + 4 + fromAliasLen;
    if (buf.byteLength < payloadStart) {
      log('[hub] recv binary frame alias header incomplete');
      return;
    }
    const fromAliasBytes = new Uint8Array(buf, aliasOffset + 4, fromAliasLen);
    const fromAlias = new TextDecoder().decode(fromAliasBytes);
    const payload = new Uint8Array(buf, payloadStart);

    if (payload.length > 0 && payload[0] === 0x64) {
      try {
        const data = decodePeerAppMessage(payload);
        if (data) {
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
    if (typeof this.keepaliveTimer === 'object' && 'unref' in this.keepaliveTimer) this.keepaliveTimer.unref();
  }

  private stopKeepaliveTimer() {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }
}
