import {
  decode as decodeBencodex,
  encode as encodeBencodex,
  getText,
  isDictionary,
  type BencodexValue,
} from 'chia-gaming-bencodex';
import type {
  PeerHost,
  PeerPreparedCommit,
  PeerProtocolApi,
  PeerProtocolSnapshot,
  PeerReceiveMode,
  PeerSessionTerms,
  PeerTerminalHandoff,
  WasmResult,
} from '../../../wasm/contract';
import {
  DEFAULT_SESSION_RECEIVE_POLICY,
  type ReadonlySessionReceivePolicy,
} from '../lib/session/receivePolicy';
import { PeerConnectionResult, PeerLiveness } from '../types/ChiaGaming';
import { PeerCarrier } from './HubConnection';
import { log } from './log';
import { createPeerProtocol } from './peerProtocol';
export interface ReliableCommitCoordinator {
  requestCommit(): void;
  flush(): Promise<void>;
  enqueue(work: () => void): void;
}

export const RELIABLE_DATA_HEADER_BYTES = 21;
export const RELIABLE_ACK_HEADER_BYTES = 21;
export const RELIABLE_KEEPALIVE_BYTES = 17;

export type PeerAppMessage =
  | {
      type: 'session_proposal';
      proposer_amount: string;
      responder_amount: string;
      channel_timeout?: string;
      unroll_timeout?: string;
      network?: string;
    }
  | { type: 'session_reject' };

export interface ReliableTransportState {
  readonly sessionId: string;
  readonly messageNumber: bigint;
  readonly remoteNumber: bigint;
  readonly unackedMessages: Array<{ msgno: bigint; msg: Uint8Array }>;
  readonly disposition: 'active' | 'proposal-received' | 'outbound-reject' | 'inbound-reject';
}

export type ReliableFrame =
  | { tag: 0x01; sessionId: string; msgno: number; data: Uint8Array }
  | { tag: 0x02; sessionId: string; msgno: number }
  | { tag: 0x03; sessionId: string };

export interface ReliableMessageConsumer {
  isReady: () => boolean;
  mode?: PeerReceiveMode;
  deliver: (msgno: bigint, body: Uint8Array) => void;
  /** Null until a durability owner is attached; absence is not a failed checkpoint. */
  persist: (() => Promise<void>) | null;
  failure: (reason: string) => void;
  acknowledged?: (ack: bigint) => void;
  rejectionAcknowledged?: () => void;
  channelResult?: (result: WasmResult) => void;
  error?: (reason: string) => void;
  keepalive?: () => void;
  committed?: () => void;
}

export type PreparedReliableCommit = PeerPreparedCommit;

/** The host persists snapshots and supplies carrier/application callbacks.
 * Rust owns every receive, send, ACK and replay turn. */
export class ReliablePeerTransport {
  readonly protocol: PeerProtocolApi;
  private readonly host: PeerHost;
  private consumer: ReliableMessageConsumer | null = null;
  private flushScheduled = false;
  private flushing = false;
  private flushPromise: Promise<void> = Promise.resolve();
  private commitCoordinator: ReliableCommitCoordinator | null = null;

  constructor(
    state: ReliableTransportState,
    receivePolicy: ReadonlySessionReceivePolicy,
    sendData: (msgno: bigint, body: Uint8Array) => boolean,
    sendAck: (msgno: bigint) => boolean,
  ) {
    this.protocol = createPeerProtocol(state, receivePolicy);
    this.host = {
      send: (frame) =>
        frame.type === 'data'
          ? sendData(frame.msgno, Uint8Array.from(frame.body))
          : sendAck(frame.msgno),
      status: () => ({
        available: !!this.consumer?.isReady(),
      }),
      notify: (event) => {
        switch (event.type) {
          case 'commit-requested':
            this.scheduleFlush();
            break;
          case 'message':
            this.consumer!.deliver(event.msgno, Uint8Array.from(event.body));
            break;
          case 'rejection-acknowledged':
            this.consumer?.rejectionAcknowledged?.();
            break;
          case 'channel-result':
            this.consumer?.channelResult?.(event.result);
            break;
          case 'error':
            this.consumer?.error?.(event.reason);
            break;
          case 'acknowledged':
            this.consumer?.acknowledged?.(event.msgno);
            break;
          case 'keepalive':
            this.consumer?.keepalive?.();
            break;
          case 'committed':
            this.consumer?.committed?.();
            break;
          case 'failure':
            this.consumer?.failure(event.reason);
            break;
        }
      },
    };
  }

  get state(): PeerProtocolSnapshot {
    const state = this.protocol.snapshot();
    return {
      ...state,
      terminalHandoff: state.terminalHandoff
        ? { ...state.terminalHandoff, message: Uint8Array.from(state.terminalHandoff.message) }
        : null,
      unackedMessages: state.unackedMessages.map(({ msgno, msg }) => ({
        msgno,
        msg: Uint8Array.from(msg),
      })),
    };
  }

  restore(state: ReliableTransportState, terminal: PeerTerminalHandoff | null = null): void {
    this.protocol.restore(state, terminal);
  }

  /** Prepare acceptance for the caller-owned first checkpoint before mounting a controller. */
  acceptSession(terms: PeerSessionTerms, initiator: boolean): void {
    this.protocol.accept_session(terms, initiator);
  }

  attachConsumer(consumer: ReliableMessageConsumer): void {
    this.consumer = consumer;
    this.consumerReady();
  }

  attachCommitCoordinator(coordinator: ReliableCommitCoordinator): void {
    this.commitCoordinator = coordinator;
    if (this.hasPendingDurability()) coordinator.requestCommit();
  }

  detachCommitCoordinator(coordinator: ReliableCommitCoordinator): void {
    if (this.commitCoordinator === coordinator) this.commitCoordinator = null;
  }

  consumerReady(): void {
    this.protocol.consumer_ready(this.consumer?.mode ?? 'raw', this.host);
  }

  receiveData(msgno: bigint, body: Uint8Array): boolean {
    let accepted = true;
    const receive = () => {
      accepted = this.protocol.receive({ type: 'data', msgno, body }, this.host);
    };
    if (this.commitCoordinator) this.commitCoordinator.enqueue(receive);
    else receive();
    return accepted;
  }

  receiveAck(msgno: bigint): boolean {
    let accepted = true;
    const receive = () => {
      accepted = this.protocol.receive({ type: 'ack', msgno }, this.host);
    };
    if (this.commitCoordinator) this.commitCoordinator.enqueue(receive);
    else receive();
    return accepted;
  }

  receiveKeepalive(): void {
    this.protocol.receive({ type: 'keepalive' }, this.host);
  }

  connectivity(
    event: 'disconnected' | 'reconnected' | 'registered' | 'peer-available' | 'peer-unavailable',
    force = false,
  ): boolean {
    return this.protocol.connectivity(event, Date.now(), force, this.host);
  }

  async flushPending(): Promise<void> {
    if (this.commitCoordinator) return this.commitCoordinator.flush();
    this.flushScheduled = false;
    if (this.flushing) return this.flushPromise;
    this.flushing = true;
    this.flushPromise = this.drainDurabilityWork().finally(() => {
      this.flushing = false;
    });
    return this.flushPromise;
  }

  hasPendingDurability(): boolean {
    return this.protocol.dirty();
  }
  rejectSession(): void {
    this.protocol.reject_session(this.host);
  }

  clearRuntime(retainRejection = false): void {
    if (this.protocol.retire(retainRejection)) return;
    this.flushScheduled = false;
    this.consumer = null;
    this.commitCoordinator = null;
  }

  private scheduleFlush(): void {
    if (this.commitCoordinator) {
      this.commitCoordinator.requestCommit();
      return;
    }
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    const timer = setTimeout(() => {
      void this.flushPending().catch(() => {});
    }, 0);
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();
  }

  private async drainDurabilityWork(): Promise<void> {
    while (this.hasPendingDurability()) {
      const consumer = this.consumer;
      if (!consumer?.persist) throw new Error('Reliable transport has no durability consumer');
      const commit = this.prepareCommit();
      try {
        await consumer.persist();
      } catch (error) {
        this.completeCommit(commit, false);
        throw error;
      }
      this.completeCommit(commit, true);
    }
  }

  prepareCommit(): PreparedReliableCommit {
    return this.protocol.prepare_commit();
  }
  completeCommit(commit: PreparedReliableCommit, persisted: boolean): void {
    this.protocol.complete_commit(commit, persisted, this.host);
  }
  reportFailure(reason: string): void {
    this.protocol.failure(reason, this.host);
  }
}

function sessionIdToWire(sessionId: string): Uint8Array {
  if (!/^[0-9a-f]{32}$/.test(sessionId)) {
    throw new Error(`invalid reliable session id: ${sessionId}`);
  }
  return Uint8Array.from(sessionId.match(/../g)!.map((pair) => Number.parseInt(pair, 16)));
}

function sessionIdFromWire(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function buildFrame(
  tag: 0x01 | 0x02,
  sessionId: string,
  msgno: number,
  data?: Uint8Array,
): Uint8Array {
  if (!Number.isInteger(msgno) || msgno < 1 || msgno > 0xffff_ffff) {
    throw new Error(`invalid reliable message number: ${msgno}`);
  }
  const len = RELIABLE_ACK_HEADER_BYTES + (data?.byteLength ?? 0);
  const frame = new Uint8Array(len);
  const view = new DataView(frame.buffer);
  frame[0] = tag;
  frame.set(sessionIdToWire(sessionId), 1);
  view.setUint32(17, msgno, false);
  if (data) frame.set(data, RELIABLE_DATA_HEADER_BYTES);
  return frame;
}

export function decodeReliableFrame(payload: Uint8Array): ReliableFrame | null {
  if (payload.byteLength < 1) return null;
  const tag = payload[0];
  if (tag === 0x01) {
    if (payload.byteLength < RELIABLE_DATA_HEADER_BYTES) return null;
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const msgno = view.getUint32(17, false);
    if (msgno === 0) return null;
    return {
      tag,
      sessionId: sessionIdFromWire(payload.subarray(1, 17)),
      msgno,
      data: payload.slice(RELIABLE_DATA_HEADER_BYTES),
    };
  }
  if (tag === 0x02) {
    if (payload.byteLength !== RELIABLE_ACK_HEADER_BYTES) return null;
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const msgno = view.getUint32(17, false);
    if (msgno === 0) return null;
    return {
      tag,
      sessionId: sessionIdFromWire(payload.subarray(1, 17)),
      msgno,
    };
  }
  if (tag === 0x03) {
    if (payload.byteLength !== RELIABLE_KEEPALIVE_BYTES) return null;
    return { tag, sessionId: sessionIdFromWire(payload.subarray(1, 17)) };
  }
  return null;
}

function optionalText(map: Map<unknown, BencodexValue>, key: string): string | undefined {
  const value = map.get(key);
  return typeof value === 'string' ? value : undefined;
}

function requireText(map: Map<unknown, BencodexValue>, key: string): string {
  const value = optionalText(map, key);
  if (value === undefined) throw new Error(`missing text field: ${key}`);
  return value;
}

export function decodePeerAppMessage(payload: Uint8Array): PeerAppMessage | null {
  const decoded = decodeBencodex(payload);
  if (!isDictionary(decoded)) return null;
  const type = getText(decoded, 'type');
  switch (type) {
    case 'session_proposal':
      return {
        type,
        proposer_amount: requireText(decoded, 'proposer_amount'),
        responder_amount: requireText(decoded, 'responder_amount'),
        channel_timeout: optionalText(decoded, 'channel_timeout'),
        unroll_timeout: optionalText(decoded, 'unroll_timeout'),
        network: optionalText(decoded, 'network'),
      };
    case 'session_reject':
      return { type };
    default:
      return null;
  }
}

export function encodePeerAppMessage(message: PeerAppMessage): Uint8Array {
  const fields: Record<string, BencodexValue> = {};
  for (const [key, value] of Object.entries(message)) {
    if (value !== undefined) fields[key] = value;
  }
  return encodeBencodex(fields);
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
  readonly receivePolicy: ReadonlySessionReceivePolicy;
  private hubConn: PeerCarrier;
  private _liveness: PeerLiveness = null;
  private _lastActivity: number = 0;
  private failureReason: string | null = null;
  private destroyed = false;
  private livenessListeners = new Set<(liveness: PeerLiveness) => void>();
  get reliableState(): ReliableTransportState {
    return this.reliableTransport.state;
  }
  readonly reliableTransport: ReliablePeerTransport;

  constructor(
    peerId: string,
    sessionId: string,
    hubConn: PeerCarrier,
    receivePolicy: ReadonlySessionReceivePolicy = DEFAULT_SESSION_RECEIVE_POLICY,
    initialState?: Omit<ReliableTransportState, 'sessionId'> | ReliablePeerTransport,
  ) {
    this.peerId = peerId;
    this.sessionId = sessionId;
    this.hubConn = hubConn;
    this.receivePolicy = receivePolicy;
    this.reliableTransport =
      initialState instanceof ReliablePeerTransport
        ? initialState
        : new ReliablePeerTransport(
            {
              sessionId,
              messageNumber: 1n,
              remoteNumber: 0n,
              unackedMessages: [],
              disposition: 'active',
              ...initialState,
            },
            receivePolicy,
            (msgno, body) => this.sendMessage(Number(msgno), body),
            (msgno) => this.sendAck(Number(msgno)),
          );
    if (!(initialState instanceof ReliablePeerTransport)) {
      this.reliableTransport.attachConsumer({
        isReady: () => false,
        deliver: () => {},
        persist: null,
        failure: (reason) => this.failBufferedPeer(reason),
      });
    }
  }

  attachCarrier(carrier: PeerCarrier): void {
    this.hubConn = carrier;
  }

  // --- PeerConnectionResult interface ---

  sendMessage(msgno: number, input: Uint8Array): boolean {
    if (this.destroyed) return false;
    log(`[peer] send msg msgno=${msgno} len=${input.byteLength} to=${this.peerId}`);
    return this.hubConn.sendToPeer(this.peerId, buildFrame(0x01, this.sessionId, msgno, input));
  }

  sendAck(ackMsgno: number): boolean {
    if (this.destroyed) return false;
    log(`[peer] send ack msgno=${ackMsgno} to=${this.peerId}`);
    return this.hubConn.sendToPeer(this.peerId, buildFrame(0x02, this.sessionId, ackMsgno));
  }

  sendKeepalive(): boolean {
    if (this.destroyed) return false;
    const frame = new Uint8Array(RELIABLE_KEEPALIVE_BYTES);
    frame[0] = 0x03;
    frame.set(sessionIdToWire(this.sessionId), 1);
    const sent = this.hubConn.sendToPeer(this.peerId, frame);
    if (!sent) {
      log(`[PeerSession] keepalive dropped (hub ws not open) peer=${this.peerId}`);
    }
    return sent;
  }

  // --- Liveness ---

  get liveness(): PeerLiveness {
    return this._liveness;
  }
  get lastActivity(): number {
    return this._lastActivity;
  }

  onLivenessChange(listener: (liveness: PeerLiveness) => void): () => void {
    this.livenessListeners.add(listener);
    return () => {
      this.livenessListeners.delete(listener);
    };
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

  private failBufferedPeer(reason: string): void {
    if (this.failureReason) return;
    this.failureReason = reason;
    log(`[PeerSession] ${reason} peer=${this.peerId}`);
    this.markDead();
    this.reliableTransport.reportFailure(reason);
  }

  // --- Inbound message delivery (called by Shell's hub callbacks) ---

  deliverRawPeerMessage(fromId: string, payload: Uint8Array): boolean {
    if (this.destroyed || this._liveness === 'dead') return false;
    if (fromId !== this.peerId) return false;
    const frame = decodeReliableFrame(payload);
    if (!frame) {
      log(`[PeerSession] reject empty peer frame from=${fromId}`);
      return false;
    }
    if (frame.sessionId !== this.sessionId) {
      if (frame.tag === 0x02 || frame.tag === 0x03) {
        log(
          `[PeerSession] ignore ${frame.tag === 0x02 ? 'ack' : 'keepalive'} for unknown session=${frame.sessionId} from=${fromId}`,
        );
        return false;
      }
      this.failBufferedPeer(
        `peer reliable session mismatch: expected ${this.sessionId}, got ${frame.sessionId}`,
      );
      return false;
    }
    const tag = frame.tag;
    if (frame.tag === 0x01) {
      const { msgno, data: msg } = frame;
      if (msg.byteLength > this.receivePolicy.maxPeerBodyBytes) {
        this.failBufferedPeer(
          `peer message body ${msg.byteLength} exceeds maximum ${this.receivePolicy.maxPeerBodyBytes}`,
        );
        return false;
      }
      this.notePeerActivity();
      log(`[peer] recv msg msgno=${msgno} len=${msg.byteLength} from=${fromId}`);
      return this.reliableTransport.receiveData(BigInt(msgno), msg);
    }
    if (frame.tag === 0x02) {
      this.notePeerActivity();
      const ack = frame.msgno;
      log(`[peer] recv ack msgno=${ack} from=${fromId}`);
      return this.reliableTransport.receiveAck(BigInt(ack));
    }
    if (frame.tag === 0x03) {
      this.notePeerActivity();
      this.reliableTransport.receiveKeepalive();
      return true;
    }
    log(
      `[PeerSession] reject peer frame tag=0x${tag.toString(16)} len=${payload.length} from=${fromId}`,
    );
    return false;
  }

  // --- Lifecycle ---

  isDestroyed(): boolean {
    return this.destroyed;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.reliableTransport.clearRuntime();
    this.livenessListeners.clear();
    log(`[PeerSession] destroyed session=${this.sessionId} peer=${this.peerId}`);
  }
}

/** Generate a random hex session ID. */
export function generateSessionId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
