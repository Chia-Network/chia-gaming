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

export interface TrackerConnectionCallbacks {
  onMatched: (params: MatchedParams) => void;
  onMessage: (data: string) => void;
  onClosed: () => void;
}

export class TrackerConnection {
  private socket: Socket;
  private callbacks: TrackerConnectionCallbacks;
  private messageBuffer: string[] = [];
  private handlerRegistered = false;
  private closed = false;

  constructor(trackerUrl: string, sessionId: string, callbacks: TrackerConnectionCallbacks) {
    this.callbacks = callbacks;
    this.socket = io(trackerUrl);

    this.socket.on('connect', () => {
      this.socket.emit('identify', { session_id: sessionId });
    });

    this.socket.on('matched', (params: MatchedParams) => {
      debugLog(`[tracker] matched initiator=${params.i_am_initiator} amount=${params.amount}`);
      this.callbacks.onMatched(params);
    });

    this.socket.on('message', ({ data }: { data: string }) => {
      if (this.closed) return;
      try {
        const parsed = JSON.parse(data);
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
      this.callbacks.onClosed();
    });
  }

  sendMessage(msgno: number, input: string) {
    const payload = JSON.stringify({ msgno, msg: input });
    debugLog(`[tracker] send msgno=${msgno} len=${payload.length}`);
    this.socket.emit('message', { data: payload });
  }

  hostLog(msg: string) {
    this.socket.emit('log', msg);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    debugLog('[tracker] closing connection');
    this.socket.emit('close', {});
    this.socket.disconnect();
  }

  getPeerConnection(): PeerConnectionResult {
    return {
      sendMessage: (msgno: number, input: string) => this.sendMessage(msgno, input),
      hostLog: (msg: string) => this.hostLog(msg),
      close: () => this.close(),
    };
  }

  registerMessageHandler(handler: (msgno: number, msg: string) => void) {
    this.callbacks.onMessage = (data: string) => {
      try {
        const parsed = JSON.parse(data);
        handler(parsed.msgno, parsed.msg);
      } catch {
        console.error('[TrackerConnection] failed to parse message:', data);
      }
    };
    this.handlerRegistered = true;
    const buffered = this.messageBuffer;
    this.messageBuffer = [];
    for (const data of buffered) {
      this.callbacks.onMessage(data);
    }
  }

  disconnect() {
    this.socket.disconnect();
  }
}
