import { PeerConnectionResult, PeerLiveness } from '../types/ChiaGaming';
import { HubConnection } from './HubConnection';
import { log } from './log';
import { createPeerProtocol } from './peerProtocol';
import type { PeerProtocolApi, PeerSessionTerms } from '../../../wasm/contract';
import {
  DEFAULT_SESSION_RECEIVE_POLICY,
  type ReadonlySessionReceivePolicy,
} from '../lib/session/receivePolicy';
import {
  decode as decodeBencodex,
  encode as encodeBencodex,
  getText,
  isDictionary,
  type BencodexValue,
} from 'chia-gaming-bencodex';
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
  sessionId: string;
  messageNumber: bigint;
  remoteNumber: bigint;
  unackedMessages: Array<{ msgno: bigint; msg: Uint8Array }>;
  disposition: 'active' | 'proposal-received' | 'outbound-reject' | 'inbound-reject';
}

export type ReliableFrame =
  | { tag: 0x01; sessionId: string; msgno: number; data: Uint8Array }
  | { tag: 0x02; sessionId: string; msgno: number }
  | { tag: 0x03; sessionId: string };

export type MessageHandler = {
  handler: (msgno: number, msg: Uint8Array) => void;
  ackHandler: (ack: number) => void;
  keepaliveHandler: () => void;
  failureHandler?: (reason: string) => void;
};

export interface ReliableMessageConsumer {
  isReady: () => boolean;
  canDeliver?: (msgno: bigint, body: Uint8Array) => boolean;
  canTerminateAt?: (msgno: bigint, body: Uint8Array) => boolean;
  deliver: (msgno: bigint, body: Uint8Array) => void;
  persist: () => Promise<void>;
  failure: (reason: string) => void;
  acknowledged?: (ack: bigint) => void;
  sent?: (msgno: bigint) => void;
  keepalive?: () => void;
  committed?: () => void;
}

export interface PreparedReliableCommit {
  generation: number;
  outboundCount: number;
  ackCount: number;
  remoteNumber: bigint;
}

/** Executes host work around the Rust reliability owner. Scheduling and the
 * aggregate checkpoint remain in TypeScript; protocol decisions live in Rust. */
export class ReliablePeerTransport {
  readonly state: ReliableTransportState;
  readonly protocol: PeerProtocolApi;
  readonly runtime: { readonly reorderQueue: Map<bigint, Uint8Array> };
  private consumer: ReliableMessageConsumer | null = null;
  private flushScheduled = false;
  private flushing = false;
  private flushPromise: Promise<void> = Promise.resolve();
  private commitCoordinator: ReliableCommitCoordinator | null = null;

  constructor(
    state: ReliableTransportState,
    receivePolicy: ReadonlySessionReceivePolicy,
    private readonly sendData: (msgno: bigint, body: Uint8Array) => boolean,
    private readonly sendAck: (msgno: bigint) => boolean,
  ) {
    this.protocol = createPeerProtocol(state, receivePolicy);
    const reads = {
      sessionId: () => this.protocol.session_id(),
      messageNumber: () => this.protocol.message_number(),
      remoteNumber: () => this.protocol.remote_number(),
      disposition: () => this.protocol.disposition(),
      unackedMessages: () =>
        this.protocol.unacked().map(({ msgno, msg }) => ({ msgno, msg: Uint8Array.from(msg) })),
    };
    // Existing snapshot consumers retain their narrow data interface. These
    // accessors read/write Rust state; there is no second mutable transport log.
    for (const key of Object.keys(state) as Array<keyof ReliableTransportState>) {
      Object.defineProperty(state, key, {
        enumerable: true,
        configurable: true,
        get: reads[key],
        set: (value: unknown) => this.protocol.restore_state({ ...this.snapshot(), [key]: value }),
      });
    }
    this.state = state;
    const protocol = this.protocol;
    this.runtime = {
      get reorderQueue() {
        return new Map(protocol.queued().map(({ msgno, msg }) => [msgno, Uint8Array.from(msg)]));
      },
    };
  }

  private snapshot(): ReliableTransportState {
    const state = this.protocol.snapshot();
    return {
      ...state,
      unackedMessages: state.unackedMessages.map(({ msgno, msg }) => ({
        msgno,
        msg: Uint8Array.from(msg),
      })),
    };
  }

  acceptSession(terms: PeerSessionTerms, initiator: boolean): void {
    this.protocol.accept_session(terms, initiator);
    if (this.hasPendingDurability()) this.scheduleFlush();
  }

  attachConsumer(consumer: ReliableMessageConsumer): void {
    this.consumer = consumer;
    this.drainContiguous();
  }

  attachCommitCoordinator(coordinator: ReliableCommitCoordinator): void {
    this.commitCoordinator = coordinator;
    if (this.hasPendingDurability()) coordinator.requestCommit();
  }

  detachCommitCoordinator(coordinator: ReliableCommitCoordinator): void {
    if (this.commitCoordinator === coordinator) this.commitCoordinator = null;
  }

  drain(): void {
    for (const msgno of this.runtime.reorderQueue.keys()) {
      if (msgno > this.state.remoteNumber) continue;
      this.protocol.remove_queued(msgno);
      this.sendAck(msgno);
    }
    this.drainContiguous();
  }

  detachConsumer(consumer?: ReliableMessageConsumer): void {
    if (!consumer || this.consumer === consumer) this.consumer = null;
  }

  allocateOutbound(body: Uint8Array, disposition = this.state.disposition): bigint {
    const msgno = this.protocol.allocate(body, disposition);
    this.scheduleFlush();
    return msgno;
  }

  receiveData(msgno: bigint, body: Uint8Array): boolean {
    if (this.commitCoordinator) {
      let accepted = true;
      this.commitCoordinator.enqueue(() => {
        accepted = this.receiveDataNow(msgno, body);
      });
      return accepted;
    }
    return this.receiveDataNow(msgno, body);
  }

  private receiveDataNow(msgno: bigint, body: Uint8Array): boolean {
    try {
      const consumer = this.consumer;
      const candidate = this.protocol.delivery_candidate(msgno, body.byteLength);
      const ready = candidate !== 'duplicate' && !!consumer?.isReady();
      const action = this.protocol.receive(
        msgno,
        body,
        ready &&
          candidate === 'next' &&
          (!consumer!.canDeliver || consumer!.canDeliver(msgno, body)),
        ready && candidate === 'future' && !!consumer!.canTerminateAt?.(msgno, body),
      );
      if (action === 'ack') this.sendAck(msgno);
      if (candidate === 'duplicate') {
        if (this.hasPendingDurability()) this.scheduleFlush();
        return true;
      }
      if (action === 'deliver' && !this.deliverOne(msgno, body)) return false;
      if (this.hasPendingDurability()) this.scheduleFlush();
      this.drainContiguous();
      return true;
    } catch (error) {
      this.reportFailure(error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  receiveAck(ack: bigint): boolean {
    if (this.commitCoordinator) {
      let accepted = true;
      this.commitCoordinator.enqueue(() => {
        accepted = this.receiveAckNow(ack);
      });
      return accepted;
    }
    return this.receiveAckNow(ack);
  }

  private receiveAckNow(ack: bigint): boolean {
    try {
      this.protocol.acknowledge(ack);
      if (this.hasPendingDurability()) this.scheduleFlush();
      this.consumer?.acknowledged?.(ack);
      return true;
    } catch (error) {
      this.reportFailure(error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  receiveKeepalive(): void {
    this.consumer?.keepalive?.();
    for (const ack of this.protocol.retry_acks()) {
      this.protocol.ack_sent(ack, this.sendAck(ack));
    }
  }

  connectivity(
    event: 'disconnected' | 'reconnected' | 'registered' | 'peer-available' | 'peer-unavailable',
    force = false,
  ): boolean {
    const messages = this.protocol.connectivity(event, Date.now(), force);
    if (!messages) return false;
    for (const { msgno, msg } of messages) {
      const sent = this.sendData(msgno, Uint8Array.from(msg));
      this.protocol.sent(msgno, sent);
      if (!sent) return false;
      this.consumer?.sent?.(msgno);
    }
    return true;
  }

  replayUnacked(force = false): boolean {
    return this.connectivity('registered', force);
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
  clearReceiveQueue(): void {
    this.protocol.clear_receive_queue();
  }

  clearRuntime(): void {
    this.protocol.clear_runtime();
    this.flushScheduled = false;
    this.consumer = null;
    this.commitCoordinator = null;
  }

  discardOutbound(): void {
    this.protocol.discard_outbound();
    if (this.hasPendingDurability()) this.scheduleFlush();
  }

  private drainContiguous(): void {
    const consumer = this.consumer;
    if (!consumer?.isReady()) return;
    while (consumer.isReady()) {
      const message = this.protocol.next_message();
      if (!message) break;
      const next = message.msgno;
      const body = Uint8Array.from(message.msg);
      try {
        if (consumer.canDeliver && !consumer.canDeliver(next, body)) break;
      } catch (error) {
        this.reportFailure(error instanceof Error ? error.message : String(error));
        return;
      }
      this.protocol.remove_queued(next);
      if (!this.deliverOne(next, body)) return;
    }
  }

  private deliverOne(msgno: bigint, body: Uint8Array): boolean {
    try {
      this.consumer!.deliver(msgno, body);
      this.protocol.delivered(msgno);
      this.scheduleFlush();
      return true;
    } catch (error) {
      this.reportFailure(error instanceof Error ? error.message : String(error));
      return false;
    }
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
      if (!consumer) throw new Error('Reliable transport has no durability consumer');
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

  completeCommit(commit: PreparedReliableCommit, persistenceSucceeded: boolean): void {
    const consumer = this.consumer;
    const frames = this.protocol.complete_commit(commit, persistenceSucceeded);
    for (const { msgno, msg } of frames.outbound) {
      const sent = this.sendData(msgno, Uint8Array.from(msg));
      this.protocol.sent(msgno, sent);
      if (sent) consumer?.sent?.(msgno);
    }
    for (const ack of frames.acks) this.protocol.ack_sent(ack, this.sendAck(ack));
    if (persistenceSucceeded) consumer?.committed?.();
  }

  reportFailure(reason: string): void {
    this.clearReceiveQueue();
    this.consumer?.failure(reason);
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
  private hubConn: HubConnection;
  private _liveness: PeerLiveness = null;
  private _lastActivity: number = 0;
  private messageHandler: MessageHandler | null = null;
  private messageConsumer: ReliableMessageConsumer | null = null;
  private failureReason: string | null = null;
  private destroyed = false;
  private livenessListeners = new Set<(liveness: PeerLiveness) => void>();
  readonly reliableState: ReliableTransportState;
  readonly reliableTransport: ReliablePeerTransport;

  constructor(
    peerId: string,
    sessionId: string,
    hubConn: HubConnection,
    receivePolicy: ReadonlySessionReceivePolicy = DEFAULT_SESSION_RECEIVE_POLICY,
    initialState?: Omit<ReliableTransportState, 'sessionId'>,
  ) {
    this.peerId = peerId;
    this.sessionId = sessionId;
    this.hubConn = hubConn;
    this.receivePolicy = receivePolicy;
    this.reliableState = {
      sessionId,
      messageNumber: 1n,
      remoteNumber: 0n,
      unackedMessages: [],
      disposition: 'active',
      ...initialState,
    };
    this.reliableTransport = new ReliablePeerTransport(
      this.reliableState,
      receivePolicy,
      (msgno, body) => this.sendMessage(Number(msgno), body),
      (msgno) => this.sendAck(Number(msgno)),
    );
    this.reliableTransport.attachConsumer({
      isReady: () => false,
      deliver: () => {},
      persist: () => Promise.reject(new Error('Reliable transport consumer is not attached')),
      failure: (reason) => this.failBufferedPeer(reason),
    });
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

  hostLog(_msg: string): void {
    /* no-op */
  }
  close(): void {
    /* no-op; destroy() handles real cleanup */
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

  // --- Message handler registration ---

  registerMessageHandler(mh: MessageHandler): void {
    this.messageHandler = mh;
    if (this.failureReason) {
      mh.failureHandler?.(this.failureReason);
      return;
    }
    const consumer: ReliableMessageConsumer = {
      isReady: () => true,
      deliver: (msgno, body) => mh.handler(Number(msgno), body),
      persist: () => Promise.resolve(),
      failure: (reason) => mh.failureHandler?.(reason),
      acknowledged: (ack) => mh.ackHandler(Number(ack)),
      keepalive: mh.keepaliveHandler,
    };
    this.messageConsumer = consumer;
    this.reliableTransport.attachConsumer(consumer);
  }

  clearMessageHandler(): void {
    if (this.messageConsumer) this.reliableTransport.detachConsumer(this.messageConsumer);
    this.messageConsumer = null;
    this.messageHandler = null;
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
    this.clearMessageHandler();
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
