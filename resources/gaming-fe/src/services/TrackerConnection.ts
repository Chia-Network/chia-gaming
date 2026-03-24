import io, { Socket } from 'socket.io-client';
import { PeerConnectionResult } from '../types/ChiaGaming';
import { debugLog } from './debugLog';

export interface MatchedParams {
  token: string;
  game_type: string;
  amount: string;
  per_game: string;
  i_am_initiator: boolean;
}

export interface ConnectionStatus {
  has_pairing: boolean;
  token?: string;
  game_type?: string;
  amount?: string;
  per_game?: string;
  i_am_initiator?: boolean;
  peer_connected?: boolean;
}

export interface TrackerConnectionCallbacks {
  onMatched: (params: MatchedParams) => void;
  onConnectionStatus: (status: ConnectionStatus) => void;
  onPeerReconnected: () => void;
  onMessage: (data: string) => void;
  onAck: (ack: number) => void;
  onPing: () => void;
  onClosed: () => void;
  onTrackerDisconnected: () => void;
  onTrackerReconnected: () => void;
}

const TRACKER_PING_INTERVAL_MS = 15_000;
const TRACKER_PING_TIMEOUT_MS = 60_000;

export class TrackerConnection {
  private socket: Socket;
  private callbacks: TrackerConnectionCallbacks;
  private messageBuffer: string[] = [];
  private handlerRegistered = false;
  private closed = false;
  private closePending = false;
  private lastTrackerHeardFrom: number = Date.now();
  private trackerPingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(trackerUrl: string, sessionId: string, callbacks: TrackerConnectionCallbacks) {
    this.callbacks = callbacks;
    this.socket = io(trackerUrl, {
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 30000,
      randomizationFactor: 0.5,
    });

    this.socket.on('connect', () => {
      this.lastTrackerHeardFrom = Date.now();
      this.startTrackerPingTimer();
      this.socket.emit('identify', { session_id: sessionId });
    });

    this.socket.on('disconnect', (reason: string, description?: unknown) => {
      this.stopTrackerPingTimer();
      const desc = description ? ` detail=${JSON.stringify(description)}` : '';
      debugLog(`[tracker] disconnected from tracker reason=${reason}${desc}`);
      this.callbacks.onTrackerDisconnected();
    });

    this.socket.on('connect_error', (err: Error) => {
      debugLog(`[tracker] connect_error: ${err.message}`);
    });

    this.socket.io.on('reconnect', () => {
      debugLog('[tracker] reconnected to tracker');
      this.callbacks.onTrackerReconnected();
    });

    this.socket.on('tracker_ping', () => {
      this.noteTrackerActivity();
      this.socket.emit('tracker_pong');
    });

    this.socket.on('tracker_pong', () => {
      this.noteTrackerActivity();
    });

    this.socket.on('matched', (params: MatchedParams) => {
      this.noteTrackerActivity();
      debugLog(`[tracker] matched initiator=${params.i_am_initiator} amount=${params.amount}`);
      this.callbacks.onMatched(params);
    });

    this.socket.on('connection_status', (status: ConnectionStatus) => {
      this.noteTrackerActivity();
      debugLog(`[tracker] connection_status has_pairing=${status.has_pairing} token=${status.token ?? 'none'} peer=${status.peer_connected ?? 'n/a'}`);
      this.callbacks.onConnectionStatus(status);
    });

    this.socket.on('peer_reconnected', () => {
      this.noteTrackerActivity();
      debugLog('[tracker] peer_reconnected');
      this.callbacks.onPeerReconnected();
    });

    this.socket.on('message', ({ data }: { data: string }) => {
      this.noteTrackerActivity();
      if (this.closed || this.closePending) return;
      try {
        const parsed = JSON.parse(data);
        if (parsed.ping) {
          this.callbacks.onPing();
          return;
        }
        if (parsed.ack !== undefined) {
          debugLog(`[tracker] recv ack=${parsed.ack}`);
          this.callbacks.onAck(parsed.ack);
          return;
        }
        debugLog(`[tracker] recv msgno=${parsed.msgno} len=${data.length}`);
      } catch {
        debugLog(`[tracker] recv len=${data.length}`);
      }
      if (!this.handlerRegistered) {
        this.messageBuffer.push(data);
        return;
      }
      this.callbacks.onMessage(data);
    });

    this.socket.on('closed', () => {
      this.noteTrackerActivity();
      this.closePending = false;
      this.callbacks.onClosed();
    });
  }

  private noteTrackerActivity() {
    this.lastTrackerHeardFrom = Date.now();
  }

  private startTrackerPingTimer() {
    this.stopTrackerPingTimer();
    this.trackerPingTimer = setInterval(() => {
      this.socket.emit('tracker_ping');
      if (Date.now() - this.lastTrackerHeardFrom > TRACKER_PING_TIMEOUT_MS) {
        debugLog('[tracker] tracker liveness timeout, forcing disconnect');
        this.socket.disconnect();
      }
    }, TRACKER_PING_INTERVAL_MS);
  }

  private stopTrackerPingTimer() {
    if (this.trackerPingTimer) {
      clearInterval(this.trackerPingTimer);
      this.trackerPingTimer = null;
    }
  }

  sendMessage(msgno: number, input: string) {
    const payload = JSON.stringify({ msgno, msg: input });
    debugLog(`[tracker] send msgno=${msgno} len=${payload.length}`);
    this.socket.emit('message', { data: payload });
  }

  sendAck(ackMsgno: number) {
    const payload = JSON.stringify({ ack: ackMsgno });
    debugLog(`[tracker] send ack=${ackMsgno}`);
    this.socket.emit('message', { data: payload });
  }

  sendPing() {
    this.socket.emit('message', { data: JSON.stringify({ ping: true }) });
  }

  hostLog(msg: string) {
    this.socket.emit('log', msg);
  }

  close() {
    if (this.closed) return;
    this.closePending = true;
    debugLog('[tracker] requesting close');
    this.socket.emit('close', {});
  }

  forceDisconnect() {
    if (this.closed) return;
    this.closed = true;
    this.stopTrackerPingTimer();
    debugLog('[tracker] force disconnect');
    this.socket.disconnect();
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
    this.callbacks.onMessage = (data: string) => {
      try {
        const parsed = JSON.parse(data);
        if (parsed.ping) {
          pingHandler();
          return;
        }
        if (parsed.ack !== undefined) {
          ackHandler(parsed.ack);
          return;
        }
        handler(parsed.msgno, parsed.msg);
      } catch {
        console.error('[TrackerConnection] failed to parse message:', data);
      }
    };
    this.callbacks.onAck = ackHandler;
    this.callbacks.onPing = pingHandler;
    this.handlerRegistered = true;
    const buffered = this.messageBuffer;
    this.messageBuffer = [];
    for (const data of buffered) {
      this.callbacks.onMessage(data);
    }
  }

  disconnect() {
    this.stopTrackerPingTimer();
    this.socket.disconnect();
  }
}
