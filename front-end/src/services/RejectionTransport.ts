import {
  deleteRejectionTombstone,
  MAX_DURABLE_REJECTION_TOMBSTONES,
  rejectionTombstoneKey,
  writeRejectionTombstone,
  type DurableRejectionTombstone,
} from '../lib/session/indexedDb';
import { decodePeerAppMessage, encodePeerAppMessage, type PeerSession } from './PeerSession';

export type RejectionPeerPool = Map<string, PeerSession>;

type RejectionStore = {
  write: (tombstone: DurableRejectionTombstone) => Promise<void>;
  delete: (peerId: string, sessionId: string) => Promise<void>;
};

const durableRejectionStore: RejectionStore = {
  write: writeRejectionTombstone,
  delete: deleteRejectionTombstone,
};

export function retainRejectionPeer(
  peers: RejectionPeerPool,
  peer: PeerSession,
  store: RejectionStore = durableRejectionStore,
): void {
  const key = rejectionTombstoneKey(peer.peerId, peer.sessionId);
  const replaced = peers.get(key);
  if (replaced && replaced !== peer) {
    replaced.destroy();
    peers.delete(key);
  }
  if (!peers.has(key) && peers.size >= MAX_DURABLE_REJECTION_TOMBSTONES) {
    const oldestKey = peers.keys().next().value as string;
    const oldestPeer = peers.get(oldestKey)!;
    oldestPeer.destroy();
    peers.delete(oldestKey);
    void store.delete(oldestPeer.peerId, oldestPeer.sessionId);
  }
  peers.set(key, peer);
}

export function bindOutboundRejectionPeer(
  peer: PeerSession,
  peers: RejectionPeerPool,
  createdAt: number,
  store: RejectionStore = durableRejectionStore,
): void {
  const key = rejectionTombstoneKey(peer.peerId, peer.sessionId);
  peer.reliableTransport.attachConsumer({
    isReady: () => true,
    canDeliver: () => true,
    deliver: (msgno, body) => {
      let semantic = null;
      try {
        semantic = decodePeerAppMessage(body);
      } catch {}
      if (semantic?.type === 'session_reject') return;
      if (
        msgno === 1n &&
        semantic?.type === 'session_proposal' &&
        peer.reliableState.unackedMessages.length === 0
      ) {
        peer.reliableTransport.allocateOutbound(
          encodePeerAppMessage({ type: 'session_reject' }),
          'outbound-reject',
        );
      }
    },
    persist: () =>
      store.write({
        kind: 'outbound-reject',
        peerId: peer.peerId,
        sessionId: peer.sessionId,
        createdAt,
        messageNumber: peer.reliableState.messageNumber,
        remoteNumber: peer.reliableState.remoteNumber,
        unackedMessages: structuredClone(peer.reliableState.unackedMessages),
      }),
    acknowledged: () => {
      if (peer.reliableState.unackedMessages.length > 0) return;
      void peer.reliableTransport
        .flushPending()
        .then(async () => {
          if (peers.get(key) !== peer) return;
          await store.delete(peer.peerId, peer.sessionId);
          if (peers.get(key) !== peer) return;
          peers.delete(key);
          peer.destroy();
        })
        .catch((error) => {
          console.error('[Shell] failed to retire rejection tombstone', error);
        });
    },
    failure: (reason) => {
      console.error('[Shell] invalid rejection-tombstone traffic', reason);
    },
  });
}

export function transferOutboundRejection(
  peer: PeerSession,
  peers: RejectionPeerPool,
  releasePrimary: () => void,
  store: RejectionStore = durableRejectionStore,
): Promise<void> {
  bindOutboundRejectionPeer(peer, peers, Date.now(), store);
  retainRejectionPeer(peers, peer, store);
  releasePrimary();
  peer.reliableTransport.allocateOutbound(
    encodePeerAppMessage({ type: 'session_reject' }),
    'outbound-reject',
  );
  return peer.reliableTransport.flushPending();
}
