import type { PeerCarrier } from '../../services/HubConnection';
import { decodeReliableFrame, PeerSession } from '../../services/PeerSession';
import { StorageAuthorityLostError, StorageAuthorityRequiredError } from '../session/indexedDb';
import { DEFAULT_SESSION_RECEIVE_POLICY } from '../session/receivePolicy';
import {
  MAX_DURABLE_REJECTION_TRANSPORTS,
  rejectionTransportKey,
  type DurableApplicationState,
  type DurableRejectionTransport,
} from '../session/saveEnvelope';
import { storageRepository } from '../session/storageRepository';

export interface SessionRejectionOptions {
  getPrimaryPeer(): PeerSession | null;
  releasePrimaryPeer(peer: PeerSession): void;
}

type RejectionStore = {
  write(tombstone: DurableRejectionTransport): Promise<void>;
  delete(peerId: string, sessionId: string): Promise<void>;
};

const repositoryStore: RejectionStore = {
  write: (tombstone) => storageRepository.persistRejectionTransport(tombstone),
  delete: (peerId, sessionId) =>
    writeRejectionTransform((state) => ({
      ...state,
      rejectionTransports: state.rejectionTransports.filter(
        (record) => record.peerId !== peerId || record.sessionId !== sessionId,
      ),
    })),
};

function writeRejectionTransform(
  transform: (state: DurableApplicationState) => DurableApplicationState,
): Promise<void> {
  return storageRepository.write(storageRepository.patchApplicationState(transform));
}

export function createSessionRejection(options: SessionRejectionOptions) {
  const peers = new Map<string, PeerSession>();

  const retain = (peer: PeerSession, store: RejectionStore = repositoryStore) => {
    const key = rejectionTransportKey(peer.peerId, peer.sessionId);
    const replaced = peers.get(key);
    if (replaced && replaced !== peer) {
      replaced.destroy();
      peers.delete(key);
    }
    if (!peers.has(key) && peers.size >= MAX_DURABLE_REJECTION_TRANSPORTS) {
      const oldestKey = peers.keys().next().value as string;
      const oldest = peers.get(oldestKey)!;
      oldest.destroy();
      peers.delete(oldestKey);
      void store.delete(oldest.peerId, oldest.sessionId);
    }
    peers.set(key, peer);
  };

  const bindOutbound = (
    peer: PeerSession,
    createdAt: number,
    store: RejectionStore = repositoryStore,
  ) => {
    const key = rejectionTransportKey(peer.peerId, peer.sessionId);
    peer.reliableTransport.attachConsumer({
      isReady: () => true,
      mode: 'rejection',
      deliver: () => {},
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
      rejectionAcknowledged: () => {
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
            console.error('[rejection] failed to retire tombstone', error);
          });
      },
      failure: (reason) => {
        console.error('[rejection] invalid tombstone traffic', reason);
      },
    });
  };

  const routeFrame = (fromId: string, payload: Uint8Array): boolean => {
    const frame = decodeReliableFrame(payload);
    if (!frame) return false;
    const peer = peers.get(rejectionTransportKey(fromId, frame.sessionId));
    if (!peer) return false;
    peer.deliverRawPeerMessage(fromId, payload);
    return true;
  };

  const rejectUnknownProposal = (
    conn: PeerCarrier,
    fromId: string,
    sessionId: string,
    payload: Uint8Array,
  ): void => {
    const key = rejectionTransportKey(fromId, sessionId);
    const existing = peers.get(key);
    if (existing) {
      existing.deliverRawPeerMessage(fromId, payload);
      return;
    }
    const peer = new PeerSession(fromId, sessionId, conn, DEFAULT_SESSION_RECEIVE_POLICY, {
      messageNumber: 1n,
      remoteNumber: 0n,
      unackedMessages: [],
      disposition: 'outbound-reject',
    });
    retain(peer);
    bindOutbound(peer, Date.now());
    peer.deliverRawPeerMessage(fromId, payload);
    void peer.reliableTransport.flushPending().catch((error) => {
      console.error('[rejection] failed to persist unknown-session rejection', error);
    });
  };

  const installInboundReceipt = (
    conn: PeerCarrier,
    peerId: string,
    sessionId: string,
    messageNumber: bigint,
    remoteNumber: bigint,
  ) => {
    retain(
      new PeerSession(peerId, sessionId, conn, DEFAULT_SESSION_RECEIVE_POLICY, {
        messageNumber,
        remoteNumber,
        unackedMessages: [],
        disposition: 'inbound-reject',
      }),
    );
  };

  const persistInboundReceipt = (peer: PeerSession, remoteNumber: bigint) =>
    storageRepository.persistRejectionTransport({
      kind: 'inbound-receipt',
      peerId: peer.peerId,
      sessionId: peer.sessionId,
      messageNumber: peer.reliableState.messageNumber,
      remoteNumber,
      unackedMessages: [],
      createdAt: Date.now(),
    });

  const bindInboundProposal = (args: {
    conn: PeerCarrier;
    peer: PeerSession;
    persistProposal(): Promise<void>;
    rejected(): void;
    failed(reason: string): void;
  }) => {
    let rejectionPersisted = false;
    args.peer.reliableTransport.attachConsumer({
      mode: 'proposal',
      isReady: () => true,
      deliver: () => {},
      persist: async () => {
        if (args.peer.reliableState.disposition !== 'inbound-reject') {
          await args.persistProposal();
          return;
        }
        await persistInboundReceipt(args.peer, args.peer.reliableState.remoteNumber);
        rejectionPersisted = true;
      },
      committed: () => {
        if (!rejectionPersisted) return;
        rejectionPersisted = false;
        installInboundReceipt(
          args.conn,
          args.peer.peerId,
          args.peer.sessionId,
          args.peer.reliableState.messageNumber,
          args.peer.reliableState.remoteNumber,
        );
        args.rejected();
      },
      failure: args.failed,
    });
  };

  const sendSessionReject = (peerId: string): Promise<void> => {
    const peer = options.getPrimaryPeer();
    if (!peer || peer.peerId !== peerId || peer.isDestroyed()) return Promise.resolve();
    bindOutbound(peer, Date.now());
    retain(peer);
    options.releasePrimaryPeer(peer);
    peer.reliableTransport.rejectSession();
    return peer.reliableTransport.flushPending().catch((error) => {
      console.error('[rejection] failed to persist session rejection', error);
    });
  };

  const bindPrimaryRetirement = (peer: PeerSession) => {
    peer.reliableTransport.attachConsumer({
      mode: 'retiring',
      isReady: () => true,
      deliver: () => {},
      persist: async () => {
        await storageRepository.patchPreHandshakeTransport({
          ...peer.reliableState,
          terminalHandoff: null,
        });
        await storageRepository.checkpointDomainMutations();
      },
      rejectionAcknowledged: () => {
        void peer.reliableTransport
          .flushPending()
          .then(() => storageRepository.clearSession())
          .then(() => {
            if (options.getPrimaryPeer() !== peer) return;
            peer.destroy();
            options.releasePrimaryPeer(peer);
          })
          .catch((error) => {
            console.error('[rejection] failed to retire primary rejection', error);
          });
      },
      keepalive: () => {},
      failure: (reason) => {
        console.error('[rejection] invalid primary acknowledgement', reason);
      },
    });
  };

  const replay = (peerId?: string) => {
    for (const peer of peers.values()) {
      if (peer.isDestroyed() || (peerId !== undefined && peer.peerId !== peerId)) continue;
      if (peer.reliableTransport.hasPendingDurability()) {
        void peer.reliableTransport.flushPending().catch((error) => {
          console.error('[rejection] failed to persist rejection', error);
        });
      } else {
        peer.reliableTransport.connectivity('registered');
      }
    }
  };

  const restore = async (conn: PeerCarrier, descriptors: readonly DurableRejectionTransport[]) => {
    const tombstones = structuredClone(descriptors);
    for (const tombstone of tombstones) {
      const peer = new PeerSession(
        tombstone.peerId,
        tombstone.sessionId,
        conn,
        DEFAULT_SESSION_RECEIVE_POLICY,
        {
          messageNumber: tombstone.messageNumber,
          remoteNumber: tombstone.remoteNumber,
          unackedMessages: tombstone.unackedMessages,
          disposition: tombstone.kind === 'outbound-reject' ? 'outbound-reject' : 'inbound-reject',
        },
      );
      if (peer.reliableTransport.state.rejectionComplete) {
        try {
          await repositoryStore.delete(tombstone.peerId, tombstone.sessionId);
        } catch (error) {
          if (
            error instanceof StorageAuthorityLostError ||
            error instanceof StorageAuthorityRequiredError
          ) {
            throw error;
          }
          console.error('[rejection] failed to retire tombstone', error);
        }
        peer.destroy();
        continue;
      }
      retain(peer);
      if (tombstone.kind === 'outbound-reject') {
        bindOutbound(peer, tombstone.createdAt);
        peer.reliableTransport.connectivity('registered');
      }
    }
  };

  const dispose = () => {
    for (const peer of peers.values()) peer.destroy();
    peers.clear();
  };

  return {
    dispose,
    bindInboundProposal,
    bindPrimaryRetirement,
    installInboundReceipt,
    persistInboundReceipt,
    rejectUnknownProposal,
    replay,
    restore,
    routeFrame,
    sendSessionReject,
  };
}
