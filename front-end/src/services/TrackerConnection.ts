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
  amount: string;
  channel_timeout?: string;
  unroll_timeout?: string;
}

export interface TrackerConnectionCallbacks {
  onAdvisoryStart: (params: AdvisoryStartParams) => void;
  onPeerMessage: (from_id: string, from_alias: string, payload: Uint8Array) => void;
  onPeerAppMessage: (from_id: string, from_alias: string, data: PeerAppMessage) => void;
  onDeliveryFailure: (to: string) => void;
  onRegistered: (player_id: string) => void;
  onClosed: () => void;
  onLobbyAttention: () => void;
  onTrackerDisconnected: () => void;
  onTrackerReconnected: () => void;
  onTrackerActivity: () => void;
}

export interface TrackerConnectionOptions {
  initialBusy?: boolean;
  initialAlias?: string | null;
}

type TrackerEnvelope =
  | { type: 'advisory_start'; peer_id: string; peer_alias: string; amount: string; channel_timeout?: string; unroll_timeout?: string }
  | { type: 'registered'; player_id: string }
  | { type: 'delivery_failure'; to: string }
  | { type: 'lobby_attention' }
  | { type: 'closed' }
  | { type: 'keepalive' }
  | { type: 'error'; error?: string };

export type PeerAppMessage =
  | { type: 'session_proposal'; amount: string; from_alias?: string; channel_timeout?: string; unroll_timeout?: string }
  | { type: 'session_reject' }
  | { type: 'chat'; text: string; timestamp?: bigint };

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

function decodeTrackerEnvelope(input: ArrayBuffer): TrackerEnvelope | null {
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
        amount: requireText(decoded, 'amount'),
        channel_timeout: optionalText(decoded, 'channel_timeout'),
        unroll_timeout: optionalText(decoded, 'unroll_timeout'),
      };
    case 'registered':
      return { type, player_id: requireText(decoded, 'player_id') };
    case 'delivery_failure':
      return { type, to: requireText(decoded, 'to') };
    case 'lobby_attention':
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
        amount: requireText(decoded, 'amount'),
        from_alias: optionalText(decoded, 'from_alias'),
        channel_timeout: optionalText(decoded, 'channel_timeout'),
        unroll_timeout: optionalText(decoded, 'unroll_timeout'),
      };
    case 'session_reject':
      return { type };
    case 'chat': {
      const text = requireText(decoded, 'text');
      const rawTimestamp = decoded.get('timestamp');
      return {
        type,
        text,
        timestamp: typeof rawTimestamp === 'bigint' ? rawTimestamp : undefined,
      };
    }
    default:
      return null;
  }
}

export class TrackerConnection {
  private trackerUrl: string;
  private sessionId: string;
  private callbacks: TrackerConnectionCallbacks;
  private ws: WebSocket | null = null;
  private closed = false;
  private wasDisconnected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 15000, 30000];
  static readonly MAX_RECONNECT_ATTEMPTS = 18;
  private reconnectAttempt = 0;
  private busy = false;
  private closePending = false;
  private myPlayerId: string | null = null;
  private alias: string | undefined;

  constructor(trackerUrl: string, sessionId: string, callbacks: TrackerConnectionCallbacks, options: TrackerConnectionOptions = {}) {
    this.trackerUrl = trackerUrl;
    this.sessionId = sessionId;
    this.callbacks = callbacks;
    this.busy = options.initialBusy ?? false;
    this.alias = options.initialAlias ?? undefined;
    this.connectWs();
  }

  private getWsUrl(): string {
    const url = new URL(this.trackerUrl);
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
      const msg = `Invalid tracker URL: ${this.trackerUrl}`;
      log(`[tracker] ${msg}`);
      throw new Error(msg);
    }
    const ws = new WebSocket(wsUrl);

    const connectTimeout = globalThis.setTimeout(() => {
      if (this.ws === ws || this.closed) return;
      log('[tracker] connection timeout, closing attempt');
      try { ws.close(); } catch { /* ignore */ }
    }, 10_000);
    if (typeof connectTimeout === 'object' && 'unref' in connectTimeout) connectTimeout.unref();

    ws.onopen = () => {
      globalThis.clearTimeout(connectTimeout);
      this.ws = ws;
      this.reconnectAttempt = 0;
      this.sendWs(this.presencePayload('identify'));
      if (this.closePending) {
        this.sendCloseRequest();
      }
      if (this.wasDisconnected) {
        log('[tracker] reconnected to tracker');
        this.callbacks.onTrackerReconnected();
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
      this.callbacks.onTrackerActivity();

      if (evt.data instanceof ArrayBuffer) {
        if (this.closed) return;
        const bytes = new Uint8Array(evt.data);
        if (bytes[0] === 0x64) {
          this.dispatchTrackerEnvelope(evt.data);
        } else {
          this.dispatchBinaryFrame(evt.data);
        }
        return;
      }

      log('[tracker] recv unexpected text ws frame');
    };

    ws.onerror = () => {
      globalThis.clearTimeout(connectTimeout);
      this.stopKeepaliveTimer();
      if (!this.closed && !this.wasDisconnected) {
        this.wasDisconnected = true;
        log('[tracker] WS connection error, will auto-reconnect');
        this.callbacks.onTrackerDisconnected();
      }
    };

    ws.onclose = () => {
      globalThis.clearTimeout(connectTimeout);
      this.stopKeepaliveTimer();
      if (this.closed) return;
      if (!this.wasDisconnected) {
        this.wasDisconnected = true;
        this.callbacks.onTrackerDisconnected();
      }
      if (this.ws === ws) {
        this.ws = null;
      }
      if (this.reconnectTimer === null) {
        if (this.reconnectAttempt >= TrackerConnection.MAX_RECONNECT_ATTEMPTS) {
          log('[tracker] reconnect budget exhausted, declaring connection dead');
          this.closed = true;
          this.callbacks.onClosed();
          return;
        }
        const base = TrackerConnection.RECONNECT_DELAYS[
          Math.min(this.reconnectAttempt, TrackerConnection.RECONNECT_DELAYS.length - 1)
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

  private dispatchTrackerEnvelope(buf: ArrayBuffer): void {
    let msg: TrackerEnvelope | null = null;
    try {
      msg = decodeTrackerEnvelope(buf);
    } catch {
      log('[tracker] recv malformed bencodex envelope');
      return;
    }
    if (!msg || typeof msg !== 'object' || !('type' in msg)) {
      log('[tracker] recv malformed ws envelope');
      return;
    }

    switch (msg.type) {
      case 'advisory_start': {
        const params: AdvisoryStartParams = {
          peer_id: msg.peer_id,
          peer_alias: msg.peer_alias,
          amount: msg.amount,
          channel_timeout: msg.channel_timeout,
          unroll_timeout: msg.unroll_timeout,
        };
        log(`[tracker] advisory_start peer=${params.peer_id} alias=${params.peer_alias} amount=${params.amount}`);
        this.callbacks.onAdvisoryStart(params);
        break;
      }
      case 'registered':
        this.myPlayerId = msg.player_id;
        log(`[tracker] registered as player_id=${msg.player_id}`);
        this.callbacks.onRegistered(msg.player_id);
        break;
      case 'delivery_failure':
        log(`[tracker] delivery_failure to=${msg.to}`);
        this.callbacks.onDeliveryFailure(msg.to);
        break;
      case 'lobby_attention':
        this.callbacks.onLobbyAttention();
        break;
      case 'closed':
        this.closePending = false;
        this.callbacks.onClosed();
        break;
      case 'keepalive':
        break;
      case 'error':
        log(`[tracker] server error: ${msg.error ?? 'unknown'}`);
        break;
      default:
        break;
    }
  }

  /**
   * Send a binary payload to a specific peer through the tracker pipe.
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
    log(`[tracker] send to=${targetId} len=${payload.byteLength}`);
  }

  /**
   * Send a bencodex app message to a specific peer through the tracker pipe.
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
    log('[tracker] force disconnect');
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

  refreshPresence(alias?: string | null) {
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
    log('[tracker] requesting close');
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
      log('[tracker] recv binary frame too short');
      return;
    }
    const view = new DataView(buf);
    const fromIdLen = view.getUint32(0, false);
    if (buf.byteLength < 4 + fromIdLen + 4) {
      log('[tracker] recv binary frame header incomplete');
      return;
    }
    const fromIdBytes = new Uint8Array(buf, 4, fromIdLen);
    const fromId = new TextDecoder().decode(fromIdBytes);
    const aliasOffset = 4 + fromIdLen;
    const fromAliasLen = view.getUint32(aliasOffset, false);
    const payloadStart = aliasOffset + 4 + fromAliasLen;
    if (buf.byteLength < payloadStart) {
      log('[tracker] recv binary frame alias header incomplete');
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

    log(`[tracker] recv from=${fromId} len=${payload.byteLength}`);
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
