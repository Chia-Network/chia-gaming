import { PeerConnectionResult, ChatMessage } from '../types/ChiaGaming';
import { debugLog } from './debugLog';

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
  onPing: () => void;
  onClosed: () => void;
  onTrackerDisconnected: () => void;
  onTrackerReconnected: () => void;
  onChat: (msg: ChatMessage) => void;
}

export type MessagePayload =
  | { msgno: number; msg: string }
  | { ack: number }
  | { ping: true };

type TrackerEnvelope =
  | { type: 'connection_status'; has_pairing: boolean; token?: string; game_type?: string; amount?: string; per_game?: string; i_am_initiator?: boolean; peer_connected?: boolean; my_alias?: string; peer_alias?: string }
  | { type: 'matched'; token: string; game_type: string; amount: string; per_game: string; i_am_initiator: boolean; my_alias?: string; peer_alias?: string }
  | { type: 'message'; data?: unknown }
  | { type: 'chat'; text: string; from_alias: string; timestamp: number }
  | { type: 'peer_reconnected' }
  | { type: 'closed' }
  | { type: 'error'; error?: string };

function isMessagePayload(data: unknown): data is MessagePayload {
  if (!data || typeof data !== 'object') return false;
  if ('ping' in data) return (data as { ping?: unknown }).ping === true;
  if ('ack' in data) return typeof (data as { ack?: unknown }).ack === 'number';
  if ('msgno' in data || 'msg' in data) {
    return (
      typeof (data as { msgno?: unknown }).msgno === 'number' &&
      typeof (data as { msg?: unknown }).msg === 'string'
    );
  }
  return false;
}

function isPingPayload(data: MessagePayload): data is { ping: true } {
  return 'ping' in data && data.ping === true;
}

function isAckPayload(data: MessagePayload): data is { ack: number } {
  return 'ack' in data;
}

function isDataPayload(data: MessagePayload): data is { msgno: number; msg: string } {
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

  constructor(trackerUrl: string, sessionId: string, callbacks: TrackerConnectionCallbacks) {
    this.trackerUrl = trackerUrl;
    this.sessionId = sessionId;
    this.callbacks = callbacks;
    this.connectWs();
  }

  private getWsUrl(): string {
    const url = new URL(this.trackerUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = '/ws';
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
    const ws = new WebSocket(this.getWsUrl());
    this.ws = ws;

    ws.onopen = () => {
      this.sendWs({ type: 'identify', session_id: this.sessionId });
      if (this.wasDisconnected) {
        debugLog('[tracker] reconnected to tracker');
        this.callbacks.onTrackerReconnected();
      }
      this.wasDisconnected = false;
      if (this.reconnectTimer !== null) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
    };

    ws.onmessage = (evt: MessageEvent<string>) => {
      let msg: TrackerEnvelope | null = null;
      try {
        msg = JSON.parse(evt.data) as TrackerEnvelope;
      } catch {
        debugLog('[tracker] recv malformed ws json');
        return;
      }
      if (!msg || typeof msg !== 'object' || !('type' in msg)) {
        debugLog('[tracker] recv malformed ws envelope');
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
          debugLog(`[tracker] connection_status has_pairing=${status.has_pairing} token=${status.token ?? 'none'} peer=${status.peer_connected ?? 'n/a'}`);
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
          debugLog(`[tracker] matched initiator=${params.i_am_initiator} amount=${params.amount}`);
          this.callbacks.onMatched(params);
          break;
        }
        case 'message': {
          if (this.closed || this.closePending) return;
          if (!isMessagePayload(msg.data)) {
            debugLog('[tracker] recv malformed envelope');
            return;
          }
          const payload: MessagePayload = msg.data;
          if (isPingPayload(payload)) {
            this.callbacks.onPing();
            return;
          }
          if (isAckPayload(payload)) {
            debugLog(`[tracker] recv ack=${payload.ack}`);
            this.callbacks.onAck(payload.ack);
            return;
          }
          if (!isDataPayload(payload)) {
            debugLog('[tracker] recv malformed payload');
            return;
          }
          debugLog(`[tracker] recv msgno=${payload.msgno} len=${payload.msg.length}`);
          if (!this.handlerRegistered) {
            this.messageBuffer.push(payload);
            return;
          }
          this.callbacks.onMessage(payload);
          break;
        }
        case 'chat':
          this.callbacks.onChat({ text: msg.text, fromAlias: msg.from_alias, timestamp: msg.timestamp, isMine: false });
          break;
        case 'peer_reconnected':
          debugLog('[tracker] peer_reconnected');
          this.callbacks.onPeerReconnected();
          break;
        case 'closed':
          this.closePending = false;
          this.callbacks.onClosed();
          break;
        case 'error':
          debugLog(`[tracker] server error: ${msg.error ?? 'unknown'}`);
          break;
        default:
          break;
      }
    };

    ws.onerror = () => {
      if (!this.closed && !this.wasDisconnected) {
        this.wasDisconnected = true;
        debugLog('[tracker] WS connection error, will auto-reconnect');
        this.callbacks.onTrackerDisconnected();
      }
    };

    ws.onclose = () => {
      if (this.closed) return;
      if (!this.wasDisconnected) {
        this.wasDisconnected = true;
        this.callbacks.onTrackerDisconnected();
      }
      this.ws = null;
      if (this.reconnectTimer === null) {
        this.reconnectTimer = globalThis.setTimeout(() => {
          this.reconnectTimer = null;
          this.connectWs();
        }, 1000);
      }
    };
  }

  sendMessage(msgno: number, input: string) {
    const payload: MessagePayload = { msgno, msg: input };
    debugLog(`[tracker] send msgno=${msgno} len=${input.length}`);
    this.sendWs({ type: 'message', session_id: this.sessionId, data: payload });
  }

  sendAck(ackMsgno: number) {
    const payload: MessagePayload = { ack: ackMsgno };
    debugLog(`[tracker] send ack=${ackMsgno}`);
    this.sendWs({ type: 'message', session_id: this.sessionId, data: payload });
  }

  sendPing() {
    const payload: MessagePayload = { ping: true };
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
    debugLog('[tracker] requesting close');
    this.sendWs({ type: 'close', session_id: this.sessionId });
  }

  forceDisconnect() {
    if (this.closed) return;
    this.closed = true;
    debugLog('[tracker] force disconnect');
    this.ws?.close();
    this.ws = null;
  }

  getPeerConnection(): PeerConnectionResult {
    return {
      sendMessage: (msgno: number, input: string) => this.sendMessage(msgno, input),
      sendAck: (ackMsgno: number) => this.sendAck(ackMsgno),
      sendPing: () => this.sendPing(),
      hostLog: (msg: string) => this.hostLog(msg),
      close: () => this.close(),
    };
  }

  registerMessageHandler(
    handler: (msgno: number, msg: string) => void,
    ackHandler: (ack: number) => void,
    pingHandler: () => void,
  ) {
    this.callbacks.onMessage = (data: MessagePayload) => {
      try {
        if (isPingPayload(data)) {
          pingHandler();
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
    this.callbacks.onPing = pingHandler;
    this.handlerRegistered = true;
    const buffered = this.messageBuffer;
    this.messageBuffer = [];
    for (const payload of buffered) {
      this.callbacks.onMessage(payload);
    }
  }

  disconnect() {
    this.closed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }
}
