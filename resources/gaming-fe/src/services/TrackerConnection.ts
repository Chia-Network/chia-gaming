import io, { Socket } from 'socket.io-client';
import { PeerConnectionResult } from '../types/ChiaGaming';

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
  private _sendMessage: ((msgno: number, input: string) => void) | null = null;

  constructor(trackerUrl: string, sessionId: string, callbacks: TrackerConnectionCallbacks) {
    this.callbacks = callbacks;
    this.socket = io(trackerUrl);

    this.socket.on('connect', () => {
      this.socket.emit('identify', { session_id: sessionId });
    });

    this.socket.on('matched', (params: MatchedParams) => {
      this.callbacks.onMatched(params);
    });

    this.socket.on('message', ({ data }: { data: string }) => {
      this.callbacks.onMessage(data);
    });

    this.socket.on('closed', () => {
      this.callbacks.onClosed();
    });
  }

  sendMessage(msgno: number, input: string) {
    const payload = JSON.stringify({ msgno, msg: input });
    this.socket.emit('message', { data: payload });
  }

  hostLog(msg: string) {
    this.socket.emit('log', msg);
  }

  close() {
    this.socket.emit('close', {});
    this.socket.disconnect();
  }

  getPeerConnection(): PeerConnectionResult {
    return {
      sendMessage: (msgno: number, input: string) => this.sendMessage(msgno, input),
      hostLog: (msg: string) => this.hostLog(msg),
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
  }

  disconnect() {
    this.socket.disconnect();
  }
}
