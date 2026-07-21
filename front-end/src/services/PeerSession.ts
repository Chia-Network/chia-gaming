import { PeerConnectionResult, PeerLiveness } from '../types/ChiaGaming';
import { HubConnection, type PeerAppMessage } from './HubConnection';
import { log } from './log';

export type MessageHandler = {
  handler: (msgno: number, msg: Uint8Array) => void;
  ackHandler: (ack: number) => void;
  keepaliveHandler: () => void;
};

type BufferedFrame = { tag: number; msgno: number; data: Uint8Array };

function buildFrame(tag: number, msgno: number, data?: Uint8Array): Uint8Array {
  const len = 1 + 4 + (data?.byteLength ?? 0);
  const frame = new Uint8Array(len);
  const view = new DataView(frame.buffer);
  frame[0] = tag;
  view.setUint32(1, msgno, false);
  if (data) frame.set(data, 5);
  return frame;
}

/**
 * Encapsulates all per-session peer state: identity, liveness, message
 * buffering/routing, and outbound send methods. Each game session gets
 * one PeerSession; destroying it makes the object inert so stale callbacks
 * are harmless.
 */
export class PeerSession implements PeerConnectionResult {
  readonly sessionId: string;
  readonly peerId: string;
  private hubConn: HubConnection;
  private _liveness: PeerLiveness = null;
  private _lastActivity: number = 0;
  private messageHandler: MessageHandler | null = null;
  private messageBuffer: BufferedFrame[] = [];
  private destroyed = false;
  private livenessListeners = new Set<(liveness: PeerLiveness) => void>();

  constructor(peerId: string, sessionId: string, hubConn: HubConnection) {
    this.peerId = peerId;
    this.sessionId = sessionId;
    this.hubConn = hubConn;
  }

  // --- PeerConnectionResult interface ---

  sendMessage(msgno: number, input: Uint8Array): boolean {
    if (this.destroyed) return false;
    return this.hubConn.sendToPeer(this.peerId, buildFrame(0x01, msgno, input));
  }

  sendAck(ackMsgno: number): boolean {
    if (this.destroyed) return false;
    return this.hubConn.sendToPeer(this.peerId, buildFrame(0x02, ackMsgno));
  }

  sendKeepalive(): boolean {
    if (this.destroyed) return false;
    const sent = this.hubConn.sendToPeer(this.peerId, new Uint8Array([0x03]));
    if (!sent) {
      log(`[PeerSession] keepalive dropped (hub ws not open) peer=${this.peerId}`);
    }
    return sent;
  }

  hostLog(_msg: string): void { /* no-op */ }
  close(): void { /* no-op; destroy() handles real cleanup */ }

  // --- Liveness ---

  get liveness(): PeerLiveness { return this._liveness; }
  get lastActivity(): number { return this._lastActivity; }

  onLivenessChange(listener: (liveness: PeerLiveness) => void): () => void {
    this.livenessListeners.add(listener);
    return () => { this.livenessListeners.delete(listener); };
  }

  private setLiveness(next: PeerLiveness) {
    if (this._liveness === next) return;
    this._liveness = next;
    for (const fn of this.livenessListeners) fn(next);
  }

  notePeerActivity(): void {
    if (this.destroyed || this._liveness === 'dead') return;
    this._lastActivity = Date.now();
    this.setLiveness('connected');
  }

  markDegraded(): void {
    if (this.destroyed || this._liveness === 'dead') return;
    this.setLiveness('degraded');
  }

  markDead(): void {
    if (this.destroyed) return;
    this.setLiveness('dead');
  }

  markInactive(): void {
    if (this.destroyed || this._liveness === 'dead') return;
    this._lastActivity = 0;
    this.setLiveness(null);
  }

  // --- Message handler registration ---

  registerMessageHandler(mh: MessageHandler): void {
    this.messageHandler = mh;
    const buffered = this.messageBuffer.splice(0);
    for (const item of buffered) {
      if (item.tag === 0x01) mh.handler(item.msgno, item.data);
      else if (item.tag === 0x02) mh.ackHandler(item.msgno);
      else if (item.tag === 0x03) mh.keepaliveHandler();
    }
  }

  clearMessageHandler(): void {
    this.messageHandler = null;
  }

  // --- Inbound message delivery (called by Shell's hub callbacks) ---

  deliverRawPeerMessage(fromId: string, payload: Uint8Array): boolean {
    if (this.destroyed || this._liveness === 'dead') return false;
    if (fromId !== this.peerId) return false;
    if (payload.length < 1) {
      log(`[PeerSession] reject empty peer frame from=${fromId}`);
      return false;
    }
    const tag = payload[0];
    if (tag === 0x01 && payload.length >= 5) {
      this.notePeerActivity();
      const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      const msgno = view.getUint32(1, false);
      const msg = payload.slice(5);
      if (this.messageHandler) this.messageHandler.handler(msgno, msg);
      else this.messageBuffer.push({ tag, msgno, data: msg });
      return true;
    }
    if (tag === 0x02 && payload.length >= 5) {
      this.notePeerActivity();
      const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      const ack = view.getUint32(1, false);
      if (this.messageHandler) this.messageHandler.ackHandler(ack);
      else this.messageBuffer.push({ tag, msgno: ack, data: new Uint8Array(0) });
      return true;
    }
    if (tag === 0x03) {
      this.notePeerActivity();
      if (this.messageHandler) this.messageHandler.keepaliveHandler();
      else this.messageBuffer.push({ tag, msgno: 0, data: new Uint8Array(0) });
      return true;
    }
    log(`[PeerSession] reject peer frame tag=0x${tag.toString(16)} len=${payload.length} from=${fromId}`);
    return false;
  }

  // --- App-message helpers ---

  sendAppMessage(msg: PeerAppMessage): void {
    if (this.destroyed) return;
    this.hubConn.sendPeerAppMessage(this.peerId, msg);
  }

  // --- Lifecycle ---

  isDestroyed(): boolean { return this.destroyed; }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.messageHandler = null;
    this.messageBuffer = [];
    this.livenessListeners.clear();
    log(`[PeerSession] destroyed session=${this.sessionId} peer=${this.peerId}`);
  }
}

/** Generate a random hex session ID. */
export function generateSessionId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
