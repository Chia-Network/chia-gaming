import type { HubConnection } from '../../services/HubConnection';
import {
  bindOutboundRejectionPeer,
  retainRejectionPeer,
  transferOutboundRejection,
} from '../../services/RejectionTransport';
import {
  encodePeerAppMessage,
  PeerSession,
  type ReliableTransportState,
} from '../../services/PeerSession';
import type { DurableRejectionTombstone } from '../session/indexedDb';

function mockHub(): HubConnection & { sendToPeer: jest.Mock } {
  return {
    sendToPeer: jest.fn(() => true),
  } as unknown as HubConnection & { sendToPeer: jest.Mock };
}

function makeStore() {
  const records = new Map<string, DurableRejectionTombstone>();
  return {
    records,
    write: jest.fn(async (record: DurableRejectionTombstone) => {
      records.set(JSON.stringify([record.peerId, record.sessionId]), structuredClone(record));
    }),
    delete: jest.fn(async (peerId: string, sessionId: string) => {
      records.delete(JSON.stringify([peerId, sessionId]));
    }),
  };
}

const sessionId = '000102030405060708090a0b0c0d0e0f';

function restoredState(
  record: DurableRejectionTombstone,
): Omit<ReliableTransportState, 'sessionId'> {
  return {
    messageNumber: record.messageNumber,
    remoteNumber: record.remoteNumber,
    unackedMessages: structuredClone(record.unackedMessages),
    disposition: 'outbound-reject',
  };
}

describe('outbound rejection transport ownership', () => {
  it('releases the primary slot synchronously and persists before sending', async () => {
    const hub = mockHub();
    const peer = new PeerSession('peer-1', sessionId, hub);
    peer.reliableState.remoteNumber = 1n;
    const peers = new Map<string, PeerSession>();
    const store = makeStore();
    let primary: PeerSession | null = peer;
    let resolveWrite!: () => void;
    store.write.mockImplementationOnce(
      (record) =>
        new Promise<void>((resolve) => {
          store.records.set(
            JSON.stringify([record.peerId, record.sessionId]),
            structuredClone(record),
          );
          resolveWrite = resolve;
        }),
    );

    const transfer = transferOutboundRejection(
      peer,
      peers,
      () => {
        primary = null;
      },
      store,
    );

    expect(primary).toBeNull();
    expect(peers.size).toBe(1);
    expect(hub.sendToPeer).not.toHaveBeenCalled();
    primary?.destroy();
    expect(peer.isDestroyed()).toBe(false);

    resolveWrite();
    await transfer;

    expect(store.write).toHaveBeenCalledTimes(1);
    expect(hub.sendToPeer).toHaveBeenCalledTimes(1);
    expect((hub.sendToPeer.mock.calls[0][1] as Uint8Array)[0]).toBe(0x01);
    expect([...store.records.values()][0]).toMatchObject({
      kind: 'outbound-reject',
      peerId: 'peer-1',
      sessionId,
      remoteNumber: 1n,
    });
  });

  it('admits another peer before ACK and retires the rejection after ACK', async () => {
    const firstHub = mockHub();
    const first = new PeerSession('peer-1', sessionId, firstHub);
    first.reliableState.remoteNumber = 1n;
    const peers = new Map<string, PeerSession>();
    const store = makeStore();
    let primary: PeerSession | null = first;

    expect(primary).toBe(first);
    const transfer = transferOutboundRejection(
      first,
      peers,
      () => {
        primary = null;
      },
      store,
    );
    expect(primary).toBeNull();
    await transfer;
    const second = new PeerSession('peer-2', '10'.repeat(16), mockHub());
    primary = second;

    expect(primary).toBe(second);
    expect(first.isDestroyed()).toBe(false);
    first.reliableTransport.receiveAck(1n);
    await first.reliableTransport.flushPending();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(first.isDestroyed()).toBe(true);
    expect(primary).toBe(second);
    expect(second.isDestroyed()).toBe(false);
    expect(peers.size).toBe(0);
    expect(store.records.size).toBe(0);
  });

  it('restores and replays a persisted rejection until ACK', async () => {
    const initialHub = mockHub();
    const initial = new PeerSession('peer-1', sessionId, initialHub);
    initial.reliableState.remoteNumber = 1n;
    const initialPeers = new Map<string, PeerSession>();
    const store = makeStore();
    await transferOutboundRejection(initial, initialPeers, () => {}, store);
    const record = structuredClone([...store.records.values()][0]);
    initial.destroy();

    const restoredHub = mockHub();
    const restored = new PeerSession(
      record.peerId,
      record.sessionId,
      restoredHub,
      undefined,
      restoredState(record),
    );
    const restoredPeers = new Map<string, PeerSession>();
    retainRejectionPeer(restoredPeers, restored, store);
    bindOutboundRejectionPeer(restored, restoredPeers, record.createdAt, store);

    restored.reliableTransport.replayUnacked();
    restored.reliableTransport.replayUnacked(true);
    expect(restoredHub.sendToPeer).toHaveBeenCalledTimes(2);
    expect(store.records.size).toBe(1);

    restored.reliableTransport.receiveAck(1n);
    await restored.reliableTransport.flushPending();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(store.records.size).toBe(0);
    expect(restored.isDestroyed()).toBe(true);
  });

  it('drains cancelled handshake traffic and acknowledges the peer rejection', async () => {
    const hub = mockHub();
    const peer = new PeerSession('peer-1', sessionId, hub);
    peer.reliableState.remoteNumber = 1n;
    const peers = new Map<string, PeerSession>();
    const store = makeStore();

    await transferOutboundRejection(peer, peers, () => {}, store);
    hub.sendToPeer.mockClear();
    expect(peer.reliableTransport.receiveData(2n, new Uint8Array([0xaa]))).toBe(true);
    expect(
      peer.reliableTransport.receiveData(3n, encodePeerAppMessage({ type: 'session_reject' })),
    ).toBe(true);
    await peer.reliableTransport.flushPending();

    expect(peer.reliableState.remoteNumber).toBe(3n);
    expect(peer.reliableState.unackedMessages).toHaveLength(1);
    expect(hub.sendToPeer).toHaveBeenCalledTimes(2);
    expect(hub.sendToPeer.mock.calls.map((call) => (call[1] as Uint8Array)[0])).toEqual([
      0x02, 0x02,
    ]);
    expect([...store.records.values()][0]).toMatchObject({
      remoteNumber: 3n,
      kind: 'outbound-reject',
    });
  });

  it('replaces the same-key owner without deleting its new durable record', async () => {
    const store = makeStore();
    const peers = new Map<string, PeerSession>();
    const oldPeer = new PeerSession('peer-1', sessionId, mockHub());
    const replacement = new PeerSession('peer-1', sessionId, mockHub());

    retainRejectionPeer(peers, oldPeer, store);
    retainRejectionPeer(peers, replacement, store);

    expect(oldPeer.isDestroyed()).toBe(true);
    expect(peers.get(JSON.stringify(['peer-1', sessionId]))).toBe(replacement);
    expect(store.delete).not.toHaveBeenCalled();
  });
});
