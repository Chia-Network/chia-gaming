import { PeerConnectionResult, ChatMessage } from '../types/ChiaGaming';
import { log } from './log';

export interface MatchedParams {
  token: string;
  game_type: string;
  amount: string;
  per_game: string;
  i_am_initiator: boolean;
  my_alias?: string;
  peer_alias?: string;
}

export interface ConnectionStatus {
  has_pairing: boolean;
  token?: string;
  game_type?: string;
  amount?: string;
  per_game?: string;
  i_am_initiator?: boolean;
  peer_connected?: boolean;
  my_alias?: string;
  peer_alias?: string;
}

export interface TrackerConnectionCallbacks {
  onMatched: (params: MatchedParams) => void;
  onConnectionStatus: (status: ConnectionStatus) => void;
  onPeerReconnected: () => void;
  onMessage: (data: MessagePayload) => void;
  onAck: (ack: number) => void;
  onKeepalive: () => void;
  onClosed: () => void;
  onTrackerDisconnected: () => void;
  onTrackerReconnected: () => void;
  onTrackerActivity: () => void;
  onChat: (msg: ChatMessage) => void;
  onLobbyAttention: () => void;
}

export type MessagePayload =
  | { msgno: number; msg: Uint8Array }
  | { ack: number }
  | { keepalive: true };

type TrackerEnvelope =
  | { type: 'connection_status'; has_pairing: boolean; token?: string; game_type?: string; amount?: string; per_game?: string; i_am_initiator?: boolean; peer_connected?: boolean; my_alias?: string; peer_alias?: string }
  | { type: 'matched'; token: string; game_type: string; amount: string; per_game: string; i_am_initiator: boolean; my_alias?: string; peer_alias?: string }
  | { type: 'message'; data?: unknown }
  | { type: 'chat'; text: string; from_alias: string; timestamp: number }
  | { type: 'peer_reconnected' }
  | { type: 'keepalive' }
  | { type: 'closed' }
  | { type: 'error'; error?: string }
  | { type: 'lobby_attention' };

function isMessagePayload(data: unknown): data is MessagePayload {
  if (!data || typeof data !== 'object') return false;
  if ('keepalive' in data) return (data as { keepalive?: unknown }).keepalive === true;
  if ('ack' in data) return typeof (data as { ack?: unknown }).ack === 'number';
  if ('msgno' in data || 'msg' in data) {
    return (
      typeof (data as { msgno?: unknown }).msgno === 'number' &&
      (data as { msg?: unknown }).msg instanceof Uint8Array
    );
  }
  return false;
}

function isKeepalivePayload(data: MessagePayload): data is { keepalive: true } {
  return 'keepalive' in data && data.keepalive === true;
}

function isAckPayload(data: MessagePayload): data is { ack: number } {
  return 'ack' in data;
}

function isDataPayload(data: MessagePayload): data is { msgno: number; msg: Uint8Array } {
  return 'msgno' in data && 'msg' in data;
}

export class TrackerConnection {
  private trackerUrl: string;
  private sessionId: string;
  private callbacks: TrackerConnectionCallbacks;
  private ws: WebSocket | null = null;
  private messageBuffer: MessagePayload[] = [];
  private handlerRegistered = false;
  private closed = false;
  private closePending = false;
  private wasDisconnected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 15000, 30000];
  static readonly MAX_RECONNECT_ATTEMPTS = 18;
  private reconnectAttempt = 0;
  private available = true;

  constructor(trackerUrl: string, sessionId: string, callbacks: TrackerConnectionCallbacks) {
    this.trackerUrl = trackerUrl;
    this.sessionId = sessionId;
    this.callbacks = callbacks;
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
    ws.send(JSON.stringify(payload));
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

    ws.onopen = () => {
      globalThis.clearTimeout(connectTimeout);
      this.ws = ws;
      this.reconnectAttempt = 0;
      this.sendWs({ type: 'identify', session_id: this.sessionId, available: this.available });
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
        if (this.closed || this.closePending) return;
        if (evt.data.byteLength < 4) {
          log('[tracker] recv binary frame too short');
          return;
        }
        const view = new DataView(evt.data);
        const msgno = view.getUint32(0, false);
        const msgBytes = new Uint8Array(evt.data, 4);
        const payload: MessagePayload = { msgno, msg: msgBytes };
        log(`[tracker] recv msgno=${msgno} len=${msgBytes.byteLength}`);
        if (!this.handlerRegistered) {
          this.messageBuffer.push(payload);
          return;
        }
        this.callbacks.onMessage(payload);
        return;
      }

      let msg: TrackerEnvelope | null = null;
      try {
        msg = JSON.parse(evt.data as string) as TrackerEnvelope;
      } catch {
        log('[tracker] recv malformed ws json');
        return;
      }
      if (!msg || typeof msg !== 'object' || !('type' in msg)) {
        log('[tracker] recv malformed ws envelope');
        return;
      }

      switch (msg.type) {
        case 'connection_status': {
          const status: ConnectionStatus = {
            has_pairing: msg.has_pairing,
            token: msg.token,
            game_type: msg.game_type,
            amount: msg.amount,
            per_game: msg.per_game,
            i_am_initiator: msg.i_am_initiator,
            peer_connected: msg.peer_connected,
            my_alias: msg.my_alias,
            peer_alias: msg.peer_alias,
          };
          log(`[tracker] connection_status has_pairing=${status.has_pairing} token=${status.token ?? 'none'} peer=${status.peer_connected ?? 'n/a'}`);
          this.callbacks.onConnectionStatus(status);
          break;
        }
        case 'matched': {
          const params: MatchedParams = {
            token: msg.token,
            game_type: msg.game_type,
            amount: msg.amount,
            per_game: msg.per_game,
            i_am_initiator: msg.i_am_initiator,
            my_alias: msg.my_alias,
            peer_alias: msg.peer_alias,
          };
          log(`[tracker] matched initiator=${params.i_am_initiator} amount=${params.amount}`);
          this.callbacks.onMatched(params);
          break;
        }
        case 'message': {
          if (this.closed || this.closePending) return;
          if (!isMessagePayload(msg.data)) {
            log('[tracker] recv malformed envelope');
            return;
          }
          const payload: MessagePayload = msg.data;
          if (isKeepalivePayload(payload)) {
            this.callbacks.onKeepalive();
            return;
          }
          if (isAckPayload(payload)) {
            log(`[tracker] recv ack=${payload.ack}`);
            this.callbacks.onAck(payload.ack);
            return;
          }
          log('[tracker] recv unexpected text-frame data message');
          break;
        }
        case 'chat':
          this.callbacks.onChat({ text: msg.text, fromAlias: msg.from_alias, timestamp: msg.timestamp, isMine: false });
          break;
        case 'peer_reconnected':
          log('[tracker] peer_reconnected');
          this.callbacks.onPeerReconnected();
          break;
        case 'keepalive':
          break;
        case 'closed':
          this.closePending = false;
          this.callbacks.onClosed();
          break;
        case 'lobby_attention':
          this.callbacks.onLobbyAttention();
          break;
        case 'error':
          log(`[tracker] server error: ${msg.error ?? 'unknown'}`);
          break;
        default:
          break;
      }
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
      }
    };
  }

  sendMessage(msgno: number, input: Uint8Array) {
    log(`[tracker] send msgno=${msgno} len=${input.byteLength}`);
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const frame = new Uint8Array(4 + input.byteLength);
    const view = new DataView(frame.buffer);
    view.setUint32(0, msgno, false);
    frame.set(input, 4);
    ws.send(frame);
  }

  sendAck(ackMsgno: number) {
    const payload: MessagePayload = { ack: ackMsgno };
    log(`[tracker] send ack=${ackMsgno}`);
    this.sendWs({ type: 'message', session_id: this.sessionId, data: payload });
  }

  sendKeepalive() {
    const payload: MessagePayload = { keepalive: true };
    this.sendWs({ type: 'message', session_id: this.sessionId, data: payload });
  }

  hostLog(_msg: string) {
    // no-op: server-side logging not supported over REST
  }

  sendChat(text: string) {
    this.sendWs({ type: 'chat', session_id: this.sessionId, text });
  }

  close() {
    if (this.closed) return;
    this.closePending = true;
    log('[tracker] requesting close');
    this.sendWs({ type: 'close', session_id: this.sessionId });
  }

  forceDisconnect() {
    if (this.closed) return;
    this.closed = true;
    log('[tracker] force disconnect');
    this.stopKeepaliveTimer();
    this.ws?.close();
    this.ws = null;
  }

  getPeerConnection(): PeerConnectionResult {
    return {
      sendMessage: (msgno: number, input: Uint8Array) => this.sendMessage(msgno, input),
      sendAck: (ackMsgno: number) => this.sendAck(ackMsgno),
      sendKeepalive: () => this.sendKeepalive(),
      hostLog: (msg: string) => this.hostLog(msg),
      close: () => this.close(),
    };
  }

  registerMessageHandler(
    handler: (msgno: number, msg: Uint8Array) => void,
    ackHandler: (ack: number) => void,
    keepaliveHandler: () => void,
  ) {
    this.callbacks.onMessage = (data: MessagePayload) => {
      try {
        if (isKeepalivePayload(data)) {
          keepaliveHandler();
          return;
        }
        if (isAckPayload(data)) {
          ackHandler(data.ack);
          return;
        }
        if (!isDataPayload(data)) {
          throw new Error('unknown message payload');
        }
        handler(data.msgno, data.msg);
      } catch {
        console.error('[TrackerConnection] failed to handle message payload:', data);
      }
    };
    this.callbacks.onAck = ackHandler;
    this.callbacks.onKeepalive = keepaliveHandler;
    this.handlerRegistered = true;
    const buffered = this.messageBuffer;
    this.messageBuffer = [];
    for (const payload of buffered) {
      this.callbacks.onMessage(payload);
    }
  }

  setAvailable(available: boolean) {
    this.available = available;
    this.sendWs({ type: 'set_status', session_id: this.sessionId, available });
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

  private startKeepaliveTimer() {
    this.stopKeepaliveTimer();
    this.keepaliveTimer = setInterval(() => {
      this.sendWs({ type: 'keepalive' });
    }, 15_000);
  }

  private stopKeepaliveTimer() {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }
}
