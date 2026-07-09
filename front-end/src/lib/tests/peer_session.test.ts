import { PeerSession, generateSessionId } from '../../services/PeerSession';
import type { TrackerConnection } from '../../services/TrackerConnection';

function mockTrackerConnection(): TrackerConnection & { sentPeerMessages: Array<{ targetId: string; payload: Uint8Array }>; sentAppMessages: Array<{ targetId: string; data: unknown }> } {
  const conn = {
    sentPeerMessages: [] as Array<{ targetId: string; payload: Uint8Array }>,
    sentAppMessages: [] as Array<{ targetId: string; data: unknown }>,
    sendToPeer(targetId: string, payload: Uint8Array) {
      conn.sentPeerMessages.push({ targetId, payload });
    },
    sendPeerAppMessage(targetId: string, data: unknown) {
      conn.sentAppMessages.push({ targetId, data });
    },
  } as unknown as TrackerConnection & { sentPeerMessages: Array<{ targetId: string; payload: Uint8Array }>; sentAppMessages: Array<{ targetId: string; data: unknown }> };
  return conn;
}

describe('PeerSession', () => {
  describe('lifecycle', () => {
    it('starts with null liveness', () => {
      const conn = mockTrackerConnection();
      const ps = new PeerSession('peer1', 'session1', conn);
      expect(ps.liveness).toBeNull();
      expect(ps.peerId).toBe('peer1');
      expect(ps.sessionId).toBe('session1');
      expect(ps.isDestroyed()).toBe(false);
    });

    it('destroy makes the session inert', () => {
      const conn = mockTrackerConnection();
      const ps = new PeerSession('peer1', 'session1', conn);
      ps.notePeerActivity();
      expect(ps.liveness).toBe('connected');

      ps.destroy();
      expect(ps.isDestroyed()).toBe(true);

      ps.sendMessage(1, new Uint8Array([0x01]));
      expect(conn.sentPeerMessages).toHaveLength(0);
    });

    it('destroy clears liveness listeners', () => {
      const conn = mockTrackerConnection();
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
      const conn = mockTrackerConnection();
      const ps = new PeerSession('peer1', 'session1', conn);
      const before = Date.now();
      ps.notePeerActivity();
      expect(ps.liveness).toBe('connected');
      expect(ps.lastActivity).toBeGreaterThanOrEqual(before);
    });

    it('markDegraded sets degraded from connected', () => {
      const conn = mockTrackerConnection();
      const ps = new PeerSession('peer1', 'session1', conn);
      ps.notePeerActivity();
      ps.markDegraded();
      expect(ps.liveness).toBe('degraded');
    });

    it('markDead sets dead', () => {
      const conn = mockTrackerConnection();
      const ps = new PeerSession('peer1', 'session1', conn);
      ps.markDead();
      expect(ps.liveness).toBe('dead');
    });

    it('notePeerActivity is no-op when dead', () => {
      const conn = mockTrackerConnection();
      const ps = new PeerSession('peer1', 'session1', conn);
      ps.markDead();
      ps.notePeerActivity();
      expect(ps.liveness).toBe('dead');
    });

    it('markDegraded is no-op when dead', () => {
      const conn = mockTrackerConnection();
      const ps = new PeerSession('peer1', 'session1', conn);
      ps.markDead();
      ps.markDegraded();
      expect(ps.liveness).toBe('dead');
    });

    it('markInactive resets to null unless dead', () => {
      const conn = mockTrackerConnection();
      const ps = new PeerSession('peer1', 'session1', conn);
      ps.notePeerActivity();
      ps.markInactive();
      expect(ps.liveness).toBeNull();
      expect(ps.lastActivity).toBe(0);
    });

    it('markInactive is no-op when dead', () => {
      const conn = mockTrackerConnection();
      const ps = new PeerSession('peer1', 'session1', conn);
      ps.markDead();
      ps.markInactive();
      expect(ps.liveness).toBe('dead');
    });

    it('onLivenessChange fires on changes', () => {
      const conn = mockTrackerConnection();
      const ps = new PeerSession('peer1', 'session1', conn);
      const updates: Array<string | null> = [];
      ps.onLivenessChange((l) => updates.push(l));

      ps.notePeerActivity();
      ps.markDegraded();
      ps.markDead();
      expect(updates).toEqual(['connected', 'degraded', 'dead']);
    });

    it('onLivenessChange unsubscribe stops notifications', () => {
      const conn = mockTrackerConnection();
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
    it('buffers messages until handler is registered', () => {
      const conn = mockTrackerConnection();
      const ps = new PeerSession('peer1', 'session1', conn);
      const received: Array<{ type: string; msgno: number; data?: Uint8Array }> = [];

      const msgPayload = new Uint8Array([0x01, 0x00, 0x00, 0x00, 0x05, 0xAA, 0xBB]);
      ps.deliverRawPeerMessage('peer1', msgPayload);

      const ackPayload = new Uint8Array([0x02, 0x00, 0x00, 0x00, 0x03]);
      ps.deliverRawPeerMessage('peer1', ackPayload);

      const keepalivePayload = new Uint8Array([0x03]);
      ps.deliverRawPeerMessage('peer1', keepalivePayload);

      ps.registerMessageHandler({
        handler: (msgno, data) => received.push({ type: 'msg', msgno, data }),
        ackHandler: (msgno) => received.push({ type: 'ack', msgno }),
        keepaliveHandler: () => received.push({ type: 'keepalive', msgno: 0 }),
      });

      expect(received).toHaveLength(3);
      expect(received[0]).toEqual({ type: 'msg', msgno: 5, data: new Uint8Array([0xAA, 0xBB]) });
      expect(received[1]).toEqual({ type: 'ack', msgno: 3 });
      expect(received[2]).toEqual({ type: 'keepalive', msgno: 0 });
    });

    it('routes messages directly when handler is registered', () => {
      const conn = mockTrackerConnection();
      const ps = new PeerSession('peer1', 'session1', conn);
      const received: Array<{ type: string; msgno: number }> = [];

      ps.registerMessageHandler({
        handler: (msgno) => received.push({ type: 'msg', msgno }),
        ackHandler: (msgno) => received.push({ type: 'ack', msgno }),
        keepaliveHandler: () => received.push({ type: 'keepalive', msgno: 0 }),
      });

      const payload = new Uint8Array([0x01, 0x00, 0x00, 0x00, 0x0A, 0xFF]);
      ps.deliverRawPeerMessage('peer1', payload);
      expect(received).toEqual([{ type: 'msg', msgno: 10 }]);
    });

    it('rejects messages from wrong peer', () => {
      const conn = mockTrackerConnection();
      const ps = new PeerSession('peer1', 'session1', conn);
      const received: Array<unknown> = [];

      ps.registerMessageHandler({
        handler: (msgno, data) => received.push({ msgno, data }),
        ackHandler: () => {},
        keepaliveHandler: () => {},
      });

      const payload = new Uint8Array([0x01, 0x00, 0x00, 0x00, 0x01, 0xAA]);
      const result = ps.deliverRawPeerMessage('wrong_peer', payload);
      expect(result).toBe(false);
      expect(received).toHaveLength(0);
    });

    it('rejects messages when dead', () => {
      const conn = mockTrackerConnection();
      const ps = new PeerSession('peer1', 'session1', conn);
      ps.markDead();

      const payload = new Uint8Array([0x01, 0x00, 0x00, 0x00, 0x01, 0xAA]);
      const result = ps.deliverRawPeerMessage('peer1', payload);
      expect(result).toBe(false);
    });

    it('rejects messages when destroyed', () => {
      const conn = mockTrackerConnection();
      const ps = new PeerSession('peer1', 'session1', conn);
      ps.destroy();

      const payload = new Uint8Array([0x01, 0x00, 0x00, 0x00, 0x01, 0xAA]);
      const result = ps.deliverRawPeerMessage('peer1', payload);
      expect(result).toBe(false);
    });
  });

  describe('send methods', () => {
    it('sendMessage builds and sends correct frame', () => {
      const conn = mockTrackerConnection();
      const ps = new PeerSession('peer1', 'session1', conn);

      ps.sendMessage(42, new Uint8Array([0xDE, 0xAD]));
      expect(conn.sentPeerMessages).toHaveLength(1);
      const { targetId, payload } = conn.sentPeerMessages[0];
      expect(targetId).toBe('peer1');
      expect(payload[0]).toBe(0x01);
      const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      expect(view.getUint32(1, false)).toBe(42);
      expect(payload.slice(5)).toEqual(new Uint8Array([0xDE, 0xAD]));
    });

    it('sendAck builds correct frame', () => {
      const conn = mockTrackerConnection();
      const ps = new PeerSession('peer1', 'session1', conn);

      ps.sendAck(7);
      expect(conn.sentPeerMessages).toHaveLength(1);
      const { payload } = conn.sentPeerMessages[0];
      expect(payload[0]).toBe(0x02);
      const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      expect(view.getUint32(1, false)).toBe(7);
    });

    it('sendKeepalive sends 0x03 byte', () => {
      const conn = mockTrackerConnection();
      const ps = new PeerSession('peer1', 'session1', conn);

      ps.sendKeepalive();
      expect(conn.sentPeerMessages).toHaveLength(1);
      expect(conn.sentPeerMessages[0].payload).toEqual(new Uint8Array([0x03]));
    });

    it('send methods are no-ops when destroyed', () => {
      const conn = mockTrackerConnection();
      const ps = new PeerSession('peer1', 'session1', conn);
      ps.destroy();

      ps.sendMessage(1, new Uint8Array([0x01]));
      ps.sendAck(1);
      ps.sendKeepalive();
      expect(conn.sentPeerMessages).toHaveLength(0);
    });

    it('sendAppMessage delegates to tracker', () => {
      const conn = mockTrackerConnection();
      const ps = new PeerSession('peer1', 'session1', conn);

      ps.sendAppMessage({ type: 'session_reject' });
      expect(conn.sentAppMessages).toHaveLength(1);
      expect(conn.sentAppMessages[0]).toEqual({
        targetId: 'peer1',
        data: { type: 'session_reject' },
      });
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
