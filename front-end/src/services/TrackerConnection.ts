import { PeerConnectionResult, ChatMessage } from '../types/ChiaGaming';
import { log } from './log';

export interface MatchedParams {
  token: string;
  amount: string;
  i_am_initiator: boolean;
  my_alias?: string;
  peer_alias?: string;
  channel_timeout?: string;
  unroll_timeout?: string;
}

export interface ConnectionStatus {
  has_pairing: boolean;
  token?: string;
  amount?: string;
  i_am_initiator?: boolean;
  peer_connected?: boolean;
  my_alias?: string;
  peer_alias?: string;
  channel_timeout?: string;
  unroll_timeout?: string;
}

export interface TrackerConnectionCallbacks {
  onMatched: (params: MatchedParams) => void;
  onConnectionStatus: (status: ConnectionStatus) => void;
  onPeerReconnected: () => void;
  onDataMessage: (msgno: number, msg: Uint8Array) => void;
  onAck: (ack: number) => void;
  onKeepalive: () => void;
  onClosed: () => void;
  onTrackerDisconnected: () => void;
  onTrackerReconnected: () => void;
  onTrackerActivity: () => void;
  onChat: (msg: ChatMessage) => void;
  onLobbyAttention: () => void;
}

export interface TrackerConnectionOptions {
  initialBusy?: boolean;
}

// Binary frame type tags for peer-to-peer relay (opaque to the tracker).
const FRAME_DATA = 0x01;
const FRAME_ACK = 0x02;
const FRAME_KEEPALIVE = 0x03;

type TrackerEnvelope =
  | { type: 'connection_status'; has_pairing: boolean; token?: string; amount?: string; i_am_initiator?: boolean; peer_connected?: boolean; my_alias?: string; peer_alias?: string; channel_timeout?: string; unroll_timeout?: string }
  | { type: 'matched'; token: string; amount: string; i_am_initiator: boolean; my_alias?: string; peer_alias?: string; channel_timeout?: string; unroll_timeout?: string }
  | { type: 'chat'; text: string; from_alias: string; timestamp: number }
  | { type: 'peer_reconnected' }
  | { type: 'keepalive' }
  | { type: 'closed' }
  | { type: 'error'; error?: string }
  | { type: 'lobby_attention' };

export class TrackerConnection {
  private trackerUrl: string;
  private sessionId: string;
  private callbacks: TrackerConnectionCallbacks;
  private ws: WebSocket | null = null;
  private binaryBuffer: ArrayBuffer[] = [];
  private handlerRegistered = false;
  private closed = false;
  private closePending = false;
  private wasDisconnected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 15000, 30000];
  static readonly MAX_RECONNECT_ATTEMPTS = 18;
  private reconnectAttempt = 0;
  private busy = false;

  constructor(trackerUrl: string, sessionId: string, callbacks: TrackerConnectionCallbacks, options: TrackerConnectionOptions = {}) {
    this.trackerUrl = trackerUrl;
    this.sessionId = sessionId;
    this.callbacks = callbacks;
    this.busy = options.initialBusy ?? false;
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
    if (typeof connectTimeout === 'object' && 'unref' in connectTimeout) connectTimeout.unref();

    ws.onopen = () => {
      globalThis.clearTimeout(connectTimeout);
      this.ws = ws;
      this.reconnectAttempt = 0;
      this.sendWs({ type: 'identify', session_id: this.sessionId, busy: this.busy });
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
        if (this.closed || this.closePending) return;
        if (!this.handlerRegistered) {
          this.binaryBuffer.push(evt.data);
          return;
        }
        this.dispatchBinaryFrame(evt.data);
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
            amount: msg.amount,
            i_am_initiator: msg.i_am_initiator,
            peer_connected: msg.peer_connected,
            my_alias: msg.my_alias,
            peer_alias: msg.peer_alias,
            channel_timeout: msg.channel_timeout,
            unroll_timeout: msg.unroll_timeout,
          };
          log(`[tracker] connection_status has_pairing=${status.has_pairing} token=${status.token ?? 'none'} peer=${status.peer_connected ?? 'n/a'}`);
          this.callbacks.onConnectionStatus(status);
          break;
        }
        case 'matched': {
          const params: MatchedParams = {
            token: msg.token,
            amount: msg.amount,
            i_am_initiator: msg.i_am_initiator,
            my_alias: msg.my_alias,
            peer_alias: msg.peer_alias,
            channel_timeout: msg.channel_timeout,
            unroll_timeout: msg.unroll_timeout,
          };
          log(`[tracker] matched initiator=${params.i_am_initiator} amount=${params.amount}`);
          this.callbacks.onMatched(params);
          break;
        }
        case 'chat':
          this.callbacks.onChat({ text: msg.text, fromAlias: msg.from_alias, timestamp: BigInt(msg.timestamp), isMine: false });
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
        if (typeof this.reconnectTimer === 'object' && 'unref' in this.reconnectTimer) this.reconnectTimer.unref();
      }
    };
  }

  sendMessage(msgno: number, input: Uint8Array) {
    log(`[tracker] send msgno=${msgno} len=${input.byteLength}`);
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const frame = new Uint8Array(1 + 4 + input.byteLength);
    const view = new DataView(frame.buffer);
    frame[0] = FRAME_DATA;
    view.setUint32(1, msgno, false);
    frame.set(input, 5);
    ws.send(frame);
  }

  sendAck(ackMsgno: number) {
    log(`[tracker] send ack=${ackMsgno}`);
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const frame = new Uint8Array(1 + 4);
    const view = new DataView(frame.buffer);
    frame[0] = FRAME_ACK;
    view.setUint32(1, ackMsgno, false);
    ws.send(frame);
  }

  sendKeepalive() {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(new Uint8Array([FRAME_KEEPALIVE]));
  }

  hostLog(_msg: string) {
    // no-op: server-side logging not supported over REST
  }

  sendChat(text: string) {
    this.sendWs({ type: 'chat', session_id: this.sessionId, text });
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
    this.callbacks.onDataMessage = handler;
    this.callbacks.onAck = ackHandler;
    this.callbacks.onKeepalive = keepaliveHandler;
    this.handlerRegistered = true;
    const buffered = this.binaryBuffer;
    this.binaryBuffer = [];
    for (const frame of buffered) {
      this.dispatchBinaryFrame(frame);
    }
  }

  private dispatchBinaryFrame(buf: ArrayBuffer): void {
    if (buf.byteLength < 1) {
      log('[tracker] recv binary frame empty');
      return;
    }
    const bytes = new Uint8Array(buf);
    const tag = bytes[0];
    switch (tag) {
      case FRAME_DATA: {
        if (buf.byteLength < 5) {
          log('[tracker] recv data frame too short');
          return;
        }
        const view = new DataView(buf);
        const msgno = view.getUint32(1, false);
        const msg = new Uint8Array(buf, 5);
        log(`[tracker] recv msgno=${msgno} len=${msg.byteLength}`);
        this.callbacks.onDataMessage(msgno, msg);
        break;
      }
      case FRAME_ACK: {
        if (buf.byteLength < 5) {
          log('[tracker] recv ack frame too short');
          return;
        }
        const view = new DataView(buf);
        const ackMsgno = view.getUint32(1, false);
        log(`[tracker] recv ack=${ackMsgno}`);
        this.callbacks.onAck(ackMsgno);
        break;
      }
      case FRAME_KEEPALIVE:
        this.callbacks.onKeepalive();
        break;
      default:
        log(`[tracker] recv unknown binary frame tag=${tag}`);
        break;
    }
  }

  setBusy(busy: boolean) {
    this.busy = busy;
    this.sendWs({ type: 'set_busy', session_id: this.sessionId, busy });
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
    if (typeof this.keepaliveTimer === 'object' && 'unref' in this.keepaliveTimer) this.keepaliveTimer.unref();
  }

  private stopKeepaliveTimer() {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }
}
