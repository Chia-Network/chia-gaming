import {
  PeerSession as BrowserPeerSession,
  decodePeerAppMessage,
  encodePeerAppMessage,
  generateSessionId,
} from '../../services/PeerSession';
import type { HubConnection } from '../../services/HubConnection';
import { sessionReceivePolicy } from '../session/receivePolicy';

const SESSION_ID = '000102030405060708090a0b0c0d0e0f';
class PeerSession extends BrowserPeerSession {
  constructor(
    peerId: string,
    _legacySessionId: string,
    conn: HubConnection,
    policy = sessionReceivePolicy(),
  ) {
    super(peerId, SESSION_ID, conn, policy);
  }
}

function reliableFrame(
  tag: 0x01 | 0x02 | 0x03,
  msgno = 0,
  body?: Uint8Array,
  sessionBytes = Uint8Array.from({ length: 16 }, (_, index) => index),
): Uint8Array {
  const frame = new Uint8Array((tag === 0x03 ? 17 : 21) + (body?.byteLength ?? 0));
  frame[0] = tag;
  frame.set(sessionBytes, 1);
  if (tag !== 0x03) new DataView(frame.buffer).setUint32(17, msgno, false);
  if (body) frame.set(body, 21);
  return frame;
}

function mockHubConnection(): HubConnection & {
  sentPeerMessages: Array<{ targetId: string; payload: Uint8Array }>;
} {
  const conn = {
    sentPeerMessages: [] as Array<{ targetId: string; payload: Uint8Array }>,
    sendToPeer(targetId: string, payload: Uint8Array) {
      conn.sentPeerMessages.push({ targetId, payload });
      return true;
    },
  } as unknown as HubConnection & {
    sentPeerMessages: Array<{ targetId: string; payload: Uint8Array }>;
  };
  return conn;
}

describe('PeerSession', () => {
  describe('lifecycle', () => {
    it('starts with null liveness', () => {
      const conn = mockHubConnection();
      const ps = new PeerSession('peer1', 'session1', conn);
      expect(ps.liveness).toBeNull();
      expect(ps.peerId).toBe('peer1');
      expect(ps.sessionId).toBe(SESSION_ID);
      expect(ps.isDestroyed()).toBe(false);
    });

    it('destroy makes the session inert', () => {
      const conn = mockHubConnection();
      const ps = new PeerSession('peer1', 'session1', conn);
      ps.notePeerActivity();
      expect(ps.liveness).toBe('connected');

      ps.destroy();
      expect(ps.isDestroyed()).toBe(true);

      ps.sendMessage(1, new Uint8Array([0x01]));
      expect(conn.sentPeerMessages).toHaveLength(0);
    });

    it('destroy clears liveness listeners', () => {
      const conn = mockHubConnection();
      const ps = new PeerSession('peer1', 'session1', conn);
      const updates: Array<string | null> = [];
      ps.onLivenessChange((l) => updates.push(l));

      ps.notePeerActivity();
      expect(updates).toEqual(['connected']);

      ps.destroy();
      ps.notePeerActivity();
      expect(updates).toEqual(['connected']);
    });
  });

  describe('liveness', () => {
    it('notePeerActivity sets connected and records timestamp', () => {
      const conn = mockHubConnection();
      const ps = new PeerSession('peer1', 'session1', conn);
      const before = Date.now();
      ps.notePeerActivity();
      expect(ps.liveness).toBe('connected');
      expect(ps.lastActivity).toBeGreaterThanOrEqual(before);
    });

    it('markDegraded sets degraded from connected', () => {
      const conn = mockHubConnection();
      const ps = new PeerSession('peer1', 'session1', conn);
      ps.notePeerActivity();
      ps.markDegraded();
      expect(ps.liveness).toBe('degraded');
    });

    it('markDead sets dead', () => {
      const conn = mockHubConnection();
      const ps = new PeerSession('peer1', 'session1', conn);
      ps.markDead();
      expect(ps.liveness).toBe('dead');
    });

    it('notePeerActivity is no-op when dead', () => {
      const conn = mockHubConnection();
      const ps = new PeerSession('peer1', 'session1', conn);
      ps.markDead();
      ps.notePeerActivity();
      expect(ps.liveness).toBe('dead');
    });

    it('markDegraded is no-op when dead', () => {
      const conn = mockHubConnection();
      const ps = new PeerSession('peer1', 'session1', conn);
      ps.markDead();
      ps.markDegraded();
      expect(ps.liveness).toBe('dead');
    });

    it('markInactive resets to null unless dead', () => {
      const conn = mockHubConnection();
      const ps = new PeerSession('peer1', 'session1', conn);
      ps.notePeerActivity();
      ps.markInactive();
      expect(ps.liveness).toBeNull();
      expect(ps.lastActivity).toBe(0);
    });

    it('markInactive is no-op when dead', () => {
      const conn = mockHubConnection();
      const ps = new PeerSession('peer1', 'session1', conn);
      ps.markDead();
      ps.markInactive();
      expect(ps.liveness).toBe('dead');
    });

    it('onLivenessChange fires on changes', () => {
      const conn = mockHubConnection();
      const ps = new PeerSession('peer1', 'session1', conn);
      const updates: Array<string | null> = [];
      ps.onLivenessChange((l) => updates.push(l));

      ps.notePeerActivity();
      ps.markDegraded();
      ps.markDead();
      expect(updates).toEqual(['connected', 'degraded', 'dead']);
    });

    it('onLivenessChange unsubscribe stops notifications', () => {
      const conn = mockHubConnection();
      const ps = new PeerSession('peer1', 'session1', conn);
      const updates: Array<string | null> = [];
      const unsub = ps.onLivenessChange((l) => updates.push(l));

      ps.notePeerActivity();
      unsub();
      ps.markDegraded();
      expect(updates).toEqual(['connected']);
    });
  });

  describe('message routing', () => {
    it('buffers ordered data until handler is registered', () => {
      const conn = mockHubConnection();
      const ps = new PeerSession('peer1', 'session1', conn);
      const received: Array<{ type: string; msgno: number; data?: Uint8Array }> = [];

      const msgPayload = reliableFrame(0x01, 1, new Uint8Array([0xaa, 0xbb]));
      ps.deliverRawPeerMessage('peer1', msgPayload);

      ps.registerMessageHandler({
        handler: (msgno, data) => received.push({ type: 'msg', msgno, data }),
        ackHandler: (msgno) => received.push({ type: 'ack', msgno }),
        keepaliveHandler: () => received.push({ type: 'keepalive', msgno: 0 }),
      });

      expect(received).toEqual([{ type: 'msg', msgno: 1, data: new Uint8Array([0xaa, 0xbb]) }]);
    });

    it('routes messages directly when handler is registered', () => {
      const conn = mockHubConnection();
      const ps = new PeerSession('peer1', 'session1', conn);
      const received: Array<{ type: string; msgno: number }> = [];

      ps.registerMessageHandler({
        handler: (msgno) => received.push({ type: 'msg', msgno }),
        ackHandler: (msgno) => received.push({ type: 'ack', msgno }),
        keepaliveHandler: () => received.push({ type: 'keepalive', msgno: 0 }),
      });

      const payload = reliableFrame(0x01, 1, new Uint8Array([0xff]));
      ps.deliverRawPeerMessage('peer1', payload);
      expect(received).toEqual([{ type: 'msg', msgno: 1 }]);
    });

    it('rejects messages from wrong peer', () => {
      const conn = mockHubConnection();
      const ps = new PeerSession('peer1', 'session1', conn);
      const received: Array<unknown> = [];

      ps.registerMessageHandler({
        handler: (msgno, data) => received.push({ msgno, data }),
        ackHandler: () => {},
        keepaliveHandler: () => {},
      });

      const payload = reliableFrame(0x01, 1, new Uint8Array([0xaa]));
      const result = ps.deliverRawPeerMessage('wrong_peer', payload);
      expect(result).toBe(false);
      expect(received).toHaveLength(0);
    });

    it('rejects messages when dead', () => {
      const conn = mockHubConnection();
      const ps = new PeerSession('peer1', 'session1', conn);
      ps.markDead();

      const payload = reliableFrame(0x01, 1, new Uint8Array([0xaa]));
      const result = ps.deliverRawPeerMessage('peer1', payload);
      expect(result).toBe(false);
    });

    it('rejects messages when destroyed', () => {
      const conn = mockHubConnection();
      const ps = new PeerSession('peer1', 'session1', conn);
      ps.destroy();

      const payload = reliableFrame(0x01, 1, new Uint8Array([0xaa]));
      const result = ps.deliverRawPeerMessage('peer1', payload);
      expect(result).toBe(false);
    });

    it('rejects unknown tags without counting peer activity', () => {
      const conn = mockHubConnection();
      const ps = new PeerSession('peer1', 'session1', conn);
      expect(ps.liveness).toBeNull();

      const result = ps.deliverRawPeerMessage('peer1', new Uint8Array([0x99]));
      expect(result).toBe(false);
      expect(ps.liveness).toBeNull();
      expect(ps.lastActivity).toBe(0);
    });

    it('ignores mismatched ack and keepalive session ids', () => {
      const conn = mockHubConnection();
      const ps = new PeerSession('peer1', 'session1', conn);
      const handlers = {
        handler: jest.fn(),
        ackHandler: jest.fn(),
        keepaliveHandler: jest.fn(),
        failureHandler: jest.fn(),
      };
      ps.registerMessageHandler(handlers);
      const otherSession = new Uint8Array(16).fill(0xff);

      expect(
        ps.deliverRawPeerMessage('peer1', reliableFrame(0x02, 1, undefined, otherSession)),
      ).toBe(false);
      expect(
        ps.deliverRawPeerMessage('peer1', reliableFrame(0x03, 0, undefined, otherSession)),
      ).toBe(false);
      expect(handlers.ackHandler).not.toHaveBeenCalled();
      expect(handlers.keepaliveHandler).not.toHaveBeenCalled();
      expect(handlers.failureHandler).not.toHaveBeenCalled();
      expect(ps.liveness).toBeNull();
    });

    it('escalates mismatched data from the selected peer', () => {
      const conn = mockHubConnection();
      const ps = new PeerSession('peer1', 'session1', conn);
      const failureHandler = jest.fn();
      ps.registerMessageHandler({
        handler: jest.fn(),
        ackHandler: jest.fn(),
        keepaliveHandler: jest.fn(),
        failureHandler,
      });

      expect(
        ps.deliverRawPeerMessage(
          'peer1',
          reliableFrame(0x01, 1, new Uint8Array([0xaa]), new Uint8Array(16).fill(0xff)),
        ),
      ).toBe(false);
      expect(failureHandler).toHaveBeenCalledWith(expect.stringContaining('session mismatch'));
      expect(ps.liveness).toBe('dead');
    });

    it('rejects short msg/ack frames without counting peer activity', () => {
      const conn = mockHubConnection();
      const ps = new PeerSession('peer1', 'session1', conn);

      expect(ps.deliverRawPeerMessage('peer1', new Uint8Array([0x01, 0x00]))).toBe(false);
      expect(ps.deliverRawPeerMessage('peer1', new Uint8Array([0x02, 0x00, 0x00]))).toBe(false);
      expect(ps.liveness).toBeNull();
      expect(ps.lastActivity).toBe(0);
    });

    it('fails and clears the early buffer when count or bytes are exceeded', () => {
      const conn = mockHubConnection();
      const ps = new PeerSession(
        'peer1',
        'session1',
        conn,
        sessionReceivePolicy({ maxQueuedMessages: 1, maxQueuedBytes: 10 }),
      );
      const failures: string[] = [];

      expect(
        ps.deliverRawPeerMessage('peer1', reliableFrame(0x01, 1, new Uint8Array([0xaa, 0xbb]))),
      ).toBe(true);
      expect(
        ps.deliverRawPeerMessage('peer1', reliableFrame(0x01, 2, new Uint8Array([0xcc]))),
      ).toBe(false);
      ps.registerMessageHandler({
        handler: () => fail('cleared data must not drain'),
        ackHandler: () => fail('cleared ack must not drain'),
        keepaliveHandler: () => fail('cleared keepalive must not drain'),
        failureHandler: (reason) => failures.push(reason),
      });

      expect(ps.liveness).toBe('dead');
      expect(failures[0]).toContain('queue count');
    });

    it('does not double-account duplicate numbered frames before binding', () => {
      const conn = mockHubConnection();
      const ps = new PeerSession(
        'peer1',
        'session1',
        conn,
        sessionReceivePolicy({ maxQueuedMessages: 1, maxQueuedBytes: 1 }),
      );
      const frame = reliableFrame(0x01, 1, new Uint8Array([0xaa]));
      const received: number[] = [];

      expect(ps.deliverRawPeerMessage('peer1', frame)).toBe(true);
      expect(ps.deliverRawPeerMessage('peer1', frame)).toBe(true);
      ps.registerMessageHandler({
        handler: (msgno) => received.push(msgno),
        ackHandler: () => {},
        keepaliveHandler: () => {},
      });

      expect(received).toEqual([1]);
      expect(ps.liveness).toBe('connected');
    });

    it('re-acks a duplicate proposal without re-prompting or leaking it to WASM', async () => {
      const conn = mockHubConnection();
      const ps = new PeerSession('peer1', 'session1', conn);
      const prompt = jest.fn();
      const wasm = jest.fn();
      const localReply = new Uint8Array([0xcc]);
      ps.reliableState.messageNumber = 2n;
      ps.reliableState.unackedMessages = [{ msgno: 1n, msg: localReply }];
      ps.reliableTransport.attachConsumer({
        isReady: () => true,
        deliver: (_msgno, body) => {
          expect(body).toEqual(
            encodePeerAppMessage({
              type: 'session_proposal',
              proposer_amount: '10',
              responder_amount: '10',
            }),
          );
          prompt();
        },
        persist: () => Promise.resolve(),
        failure: (reason) => fail(reason),
      });
      const proposal = reliableFrame(
        0x01,
        1,
        encodePeerAppMessage({
          type: 'session_proposal',
          proposer_amount: '10',
          responder_amount: '10',
        }),
      );

      expect(ps.deliverRawPeerMessage('peer1', proposal)).toBe(true);
      await ps.reliableTransport.flushPending();
      conn.sentPeerMessages = [];
      expect(ps.deliverRawPeerMessage('peer1', proposal)).toBe(true);

      ps.reliableTransport.attachConsumer({
        isReady: () => true,
        deliver: wasm,
        persist: () => Promise.resolve(),
        failure: (reason) => fail(reason),
      });
      expect(prompt).toHaveBeenCalledTimes(1);
      expect(wasm).not.toHaveBeenCalled();
      expect(conn.sentPeerMessages.map(({ payload }) => payload[0])).toEqual([0x02, 0x01]);
    });

    it('buffers early WASM until consumer handoff while duplicate proposal re-ACKs', async () => {
      const conn = mockHubConnection();
      const ps = new PeerSession('peer1', 'session1', conn);
      const prompt = jest.fn();
      const wasm = jest.fn();
      const proposalBody = encodePeerAppMessage({
        type: 'session_proposal',
        proposer_amount: '10',
        responder_amount: '10',
      });
      const handshakeA = new Uint8Array([0xaa, 0xbb]);
      ps.reliableTransport.attachConsumer({
        isReady: () => true,
        canDeliver: (msgno, body) => {
          if (msgno === 1n) return true;
          try {
            return decodePeerAppMessage(body)?.type === 'session_reject';
          } catch {
            return false;
          }
        },
        deliver: (msgno) => {
          expect(msgno).toBe(1n);
          prompt();
        },
        persist: () => Promise.resolve(),
        failure: (reason) => fail(reason),
      });

      expect(ps.deliverRawPeerMessage('peer1', reliableFrame(0x01, 1, proposalBody))).toBe(true);
      await ps.reliableTransport.flushPending();
      conn.sentPeerMessages = [];
      expect(ps.deliverRawPeerMessage('peer1', reliableFrame(0x01, 2, handshakeA))).toBe(true);
      expect(ps.deliverRawPeerMessage('peer1', reliableFrame(0x01, 1, proposalBody))).toBe(true);

      expect(prompt).toHaveBeenCalledTimes(1);
      expect(wasm).not.toHaveBeenCalled();
      expect(ps.reliableState.remoteNumber).toBe(1n);
      expect(ps.reliableTransport.runtime.reorderQueue.get(2n)).toEqual(handshakeA);
      expect(conn.sentPeerMessages.map(({ payload }) => payload[0])).toEqual([0x02]);

      ps.reliableTransport.attachConsumer({
        isReady: () => true,
        deliver: wasm,
        persist: () => Promise.resolve(),
        failure: (reason) => fail(reason),
      });
      await ps.reliableTransport.flushPending();

      expect(wasm).toHaveBeenCalledTimes(1);
      expect(wasm).toHaveBeenCalledWith(2n, handshakeA);
      expect(ps.reliableState.remoteNumber).toBe(2n);
    });

    it('lets a terminal rejection discard buffered pre-consent handshake traffic', async () => {
      const conn = mockHubConnection();
      const ps = new PeerSession('peer1', 'session1', conn);
      const delivered = jest.fn();
      const rejectBody = encodePeerAppMessage({ type: 'session_reject' });
      ps.reliableState.remoteNumber = 1n;
      ps.reliableTransport.attachConsumer({
        isReady: () => true,
        canDeliver: (_msgno, body) => {
          try {
            return decodePeerAppMessage(body)?.type === 'session_reject';
          } catch {
            return false;
          }
        },
        canTerminateAt: (_msgno, body) => {
          try {
            return decodePeerAppMessage(body)?.type === 'session_reject';
          } catch {
            return false;
          }
        },
        deliver: delivered,
        persist: () => Promise.resolve(),
        failure: (reason) => fail(reason),
      });

      expect(ps.reliableTransport.receiveData(2n, new Uint8Array([0xaa]))).toBe(true);
      expect(ps.reliableTransport.receiveData(3n, rejectBody)).toBe(true);
      await ps.reliableTransport.flushPending();

      expect(delivered).toHaveBeenCalledTimes(1);
      expect(delivered).toHaveBeenCalledWith(3n, rejectBody);
      expect(ps.reliableState.remoteNumber).toBe(3n);
      expect(ps.reliableTransport.runtime.reorderQueue.size).toBe(0);
    });

    it('rejects a cumulative ack beyond the allocated range without pruning', () => {
      const conn = mockHubConnection();
      const ps = new PeerSession('peer1', 'session1', conn);
      const failure = jest.fn();
      ps.reliableState.messageNumber = 2n;
      ps.reliableState.unackedMessages = [{ msgno: 1n, msg: new Uint8Array([0xaa]) }];
      ps.reliableTransport.attachConsumer({
        isReady: () => true,
        deliver: jest.fn(),
        persist: () => Promise.resolve(),
        failure,
      });

      expect(ps.deliverRawPeerMessage('peer1', reliableFrame(0x02, 2))).toBe(false);
      expect(ps.reliableState.unackedMessages).toEqual([
        { msgno: 1n, msg: new Uint8Array([0xaa]) },
      ]);
      expect(failure).toHaveBeenCalledWith(expect.stringContaining('highest allocated'));
    });

    it('does not create queued candidate state for malformed or unknown controls', () => {
      const conn = mockHubConnection();
      const ps = new PeerSession('peer1', 'session1', conn);

      expect(ps.deliverRawPeerMessage('peer1', new Uint8Array([0x99]))).toBe(false);
      expect(ps.deliverRawPeerMessage('peer1', new Uint8Array([0x02, 0x00]))).toBe(false);
      expect(ps.reliableState.remoteNumber).toBe(0n);
      expect(ps.reliableTransport.runtime.reorderQueue.size).toBe(0);
    });

    it('does not replay outbound data before its persistence completes', async () => {
      const conn = mockHubConnection();
      const ps = new PeerSession('peer1', 'session1', conn);
      let resolvePersist!: () => void;
      const persist = new Promise<void>((resolve) => {
        resolvePersist = resolve;
      });
      ps.reliableTransport.attachConsumer({
        isReady: () => true,
        deliver: jest.fn(),
        persist: () => persist,
        failure: (reason) => fail(reason),
      });

      ps.reliableTransport.allocateOutbound(new Uint8Array([0xaa]));
      const flush = ps.reliableTransport.flushPending();
      ps.reliableTransport.receiveKeepalive();
      expect(conn.sentPeerMessages).toEqual([]);

      resolvePersist();
      await flush;
      expect(conn.sentPeerMessages.map(({ payload }) => payload[0])).toEqual([0x01]);
    });

    it('coalesces a duplicate ack behind the in-flight receive persistence', async () => {
      const conn = mockHubConnection();
      const ps = new PeerSession('peer1', 'session1', conn);
      let resolvePersist!: () => void;
      const persist = new Promise<void>((resolve) => {
        resolvePersist = resolve;
      });
      ps.reliableTransport.attachConsumer({
        isReady: () => true,
        deliver: jest.fn(),
        persist: () => persist,
        failure: (reason) => fail(reason),
      });
      const frame = reliableFrame(0x01, 1, new Uint8Array([0xaa]));

      ps.deliverRawPeerMessage('peer1', frame);
      const flush = ps.reliableTransport.flushPending();
      ps.deliverRawPeerMessage('peer1', frame);
      expect(conn.sentPeerMessages).toEqual([]);

      resolvePersist();
      await flush;
      expect(conn.sentPeerMessages.map(({ payload }) => payload[0])).toEqual([0x02]);
    });

    it('runs another persistence pass for work queued during an in-flight flush', async () => {
      const conn = mockHubConnection();
      const ps = new PeerSession('peer1', 'session1', conn);
      let resolveFirstPersist!: () => void;
      const firstPersist = new Promise<void>((resolve) => {
        resolveFirstPersist = resolve;
      });
      const persist = jest
        .fn<Promise<void>, []>()
        .mockReturnValueOnce(firstPersist)
        .mockResolvedValue(undefined);
      ps.reliableTransport.attachConsumer({
        isReady: () => true,
        deliver: jest.fn(),
        persist,
        failure: (reason) => fail(reason),
      });

      ps.reliableTransport.allocateOutbound(new Uint8Array([0x01]));
      const flush = ps.reliableTransport.flushPending();
      ps.reliableTransport.allocateOutbound(new Uint8Array([0x02]));
      ps.deliverRawPeerMessage('peer1', reliableFrame(0x01, 1, new Uint8Array([0x03])));
      resolveFirstPersist();
      await flush;

      expect(persist).toHaveBeenCalledTimes(2);
      expect(conn.sentPeerMessages.map(({ payload }) => payload[0])).toEqual([0x01, 0x01, 0x02]);
    });

    it('fails an oversized body before binding', () => {
      const conn = mockHubConnection();
      const ps = new PeerSession(
        'peer1',
        'session1',
        conn,
        sessionReceivePolicy({ maxPeerBodyBytes: 1 }),
      );
      const failures: string[] = [];

      expect(
        ps.deliverRawPeerMessage('peer1', reliableFrame(0x01, 1, new Uint8Array([0xaa, 0xbb]))),
      ).toBe(false);
      ps.registerMessageHandler({
        handler: () => {},
        ackHandler: () => {},
        keepaliveHandler: () => {},
        failureHandler: (reason) => failures.push(reason),
      });

      expect(failures[0]).toContain('message body');
      expect(ps.liveness).toBe('dead');
    });
  });

  describe('send methods', () => {
    it('sendMessage builds and sends correct frame', () => {
      const conn = mockHubConnection();
      const ps = new PeerSession('peer1', 'session1', conn);

      ps.sendMessage(42, new Uint8Array([0xde, 0xad]));
      expect(conn.sentPeerMessages).toHaveLength(1);
      const { targetId, payload } = conn.sentPeerMessages[0];
      expect(targetId).toBe('peer1');
      expect(payload[0]).toBe(0x01);
      const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      expect(payload.slice(1, 17)).toEqual(Uint8Array.from({ length: 16 }, (_, index) => index));
      expect(view.getUint32(17, false)).toBe(42);
      expect(payload.slice(21)).toEqual(new Uint8Array([0xde, 0xad]));
    });

    it('sendAck builds correct frame', () => {
      const conn = mockHubConnection();
      const ps = new PeerSession('peer1', 'session1', conn);

      ps.sendAck(7);
      expect(conn.sentPeerMessages).toHaveLength(1);
      const { payload } = conn.sentPeerMessages[0];
      expect(payload[0]).toBe(0x02);
      const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      expect(payload).toHaveLength(21);
      expect(view.getUint32(17, false)).toBe(7);
    });

    it('sendKeepalive sends a session-bound frame', () => {
      const conn = mockHubConnection();
      const ps = new PeerSession('peer1', 'session1', conn);

      ps.sendKeepalive();
      expect(conn.sentPeerMessages).toHaveLength(1);
      expect(conn.sentPeerMessages[0].payload).toEqual(reliableFrame(0x03));
    });

    it('send methods are no-ops when destroyed', () => {
      const conn = mockHubConnection();
      const ps = new PeerSession('peer1', 'session1', conn);
      ps.destroy();

      ps.sendMessage(1, new Uint8Array([0x01]));
      ps.sendAck(1);
      ps.sendKeepalive();
      expect(conn.sentPeerMessages).toHaveLength(0);
    });

    it('encodes session rejection as a reliable body', () => {
      expect(new TextDecoder().decode(encodePeerAppMessage({ type: 'session_reject' }))).toContain(
        'session_reject',
      );
    });

    it('does not duplicate the frame session id inside a proposal body', () => {
      const body = encodePeerAppMessage({
        type: 'session_proposal',
        proposer_amount: '100',
        responder_amount: '100',
        network: 'testnet',
      });
      expect(new TextDecoder().decode(body)).not.toContain('game_session_id');
    });
  });

  describe('generateSessionId', () => {
    it('produces a 32-character hex string', () => {
      const id = generateSessionId();
      expect(id).toMatch(/^[0-9a-f]{32}$/);
    });

    it('produces unique IDs', () => {
      const ids = new Set(Array.from({ length: 10 }, () => generateSessionId()));
      expect(ids.size).toBe(10);
    });
  });
});
