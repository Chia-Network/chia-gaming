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
  private eventSource: EventSource | null = null;
  private messageBuffer: MessagePayload[] = [];
  private handlerRegistered = false;
  private closed = false;
  private closePending = false;
  private wasDisconnected = false;

  constructor(trackerUrl: string, sessionId: string, callbacks: TrackerConnectionCallbacks) {
    this.trackerUrl = trackerUrl;
    this.sessionId = sessionId;
    this.callbacks = callbacks;

    this.postJSON('/game/identify', { session_id: sessionId });
    this.connectSSE();
  }

  private connectSSE(): void {
    if (this.closed) return;

    const url = `${this.trackerUrl}/game/events?session_id=${encodeURIComponent(this.sessionId)}`;
    const es = new EventSource(url);
    this.eventSource = es;

    es.addEventListener('connection_status', (e: MessageEvent) => {
      const status: ConnectionStatus = JSON.parse(e.data);
      debugLog(`[tracker] connection_status has_pairing=${status.has_pairing} token=${status.token ?? 'none'} peer=${status.peer_connected ?? 'n/a'}`);
      this.callbacks.onConnectionStatus(status);
    });

    es.addEventListener('matched', (e: MessageEvent) => {
      const params: MatchedParams = JSON.parse(e.data);
      debugLog(`[tracker] matched initiator=${params.i_am_initiator} amount=${params.amount}`);
      this.callbacks.onMatched(params);
    });

    es.addEventListener('message', (e: MessageEvent) => {
      const event = JSON.parse(e.data) as { data?: unknown };
      if (this.closed || this.closePending) return;
      if (!isMessagePayload(event.data)) {
        debugLog('[tracker] recv malformed envelope');
        return;
      }
      const payload: MessagePayload = event.data;
      try {
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
          throw new Error('unknown message payload');
        }
        debugLog(`[tracker] recv msgno=${payload.msgno} len=${payload.msg.length}`);
      } catch {
        debugLog(`[tracker] recv malformed payload`);
        return;
      }
      if (!this.handlerRegistered) {
        this.messageBuffer.push(payload);
        return;
      }
      this.callbacks.onMessage(payload);
    });

    es.addEventListener('chat', (e: MessageEvent) => {
      const { text, from_alias, timestamp } = JSON.parse(e.data);
      this.callbacks.onChat({ text, fromAlias: from_alias, timestamp, isMine: false });
    });

    es.addEventListener('peer_reconnected', () => {
      debugLog('[tracker] peer_reconnected');
      this.callbacks.onPeerReconnected();
    });

    es.addEventListener('closed', () => {
      this.closePending = false;
      this.callbacks.onClosed();
    });

    es.onopen = () => {
      if (this.wasDisconnected) {
        debugLog('[tracker] reconnected to tracker');
        this.callbacks.onTrackerReconnected();
        this.postJSON('/game/identify', { session_id: this.sessionId });
      }
      this.wasDisconnected = false;
    };

    es.onerror = () => {
      if (!this.closed && !this.wasDisconnected) {
        this.wasDisconnected = true;
        debugLog('[tracker] SSE connection error, will auto-reconnect');
        this.callbacks.onTrackerDisconnected();
      }
    };
  }

  private postJSON(path: string, body: unknown): void {
    fetch(`${this.trackerUrl}${path}`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    }).catch((err) => debugLog(`[tracker] POST ${path} failed: ${err}`));
  }

  sendMessage(msgno: number, input: string) {
    const payload: MessagePayload = { msgno, msg: input };
    debugLog(`[tracker] send msgno=${msgno} len=${input.length}`);
    this.postJSON('/game/send', { session_id: this.sessionId, data: payload });
  }

  sendAck(ackMsgno: number) {
    const payload: MessagePayload = { ack: ackMsgno };
    debugLog(`[tracker] send ack=${ackMsgno}`);
    this.postJSON('/game/send', { session_id: this.sessionId, data: payload });
  }

  sendPing() {
    const payload: MessagePayload = { ping: true };
    this.postJSON('/game/send', { session_id: this.sessionId, data: payload });
  }

  hostLog(_msg: string) {
    // no-op: server-side logging not supported over REST
  }

  sendChat(text: string) {
    this.postJSON('/game/chat', { session_id: this.sessionId, text });
  }

  close() {
    if (this.closed) return;
    this.closePending = true;
    debugLog('[tracker] requesting close');
    this.postJSON('/game/close', { session_id: this.sessionId });
  }

  forceDisconnect() {
    if (this.closed) return;
    this.closed = true;
    debugLog('[tracker] force disconnect');
    this.eventSource?.close();
    this.eventSource = null;
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
    this.eventSource?.close();
    this.eventSource = null;
  }
}
