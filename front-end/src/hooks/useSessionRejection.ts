import { useCallback, useEffect, useRef } from 'react';

import { DEFAULT_SESSION_RECEIVE_POLICY } from '../lib/session/receivePolicy';
import {
  MAX_DURABLE_REJECTION_TRANSPORTS,
  rejectionTransportKey,
  type DurableApplicationState,
  type DurableSessionPhase,
  type DurableRejectionTransport,
} from '../lib/session/saveEnvelope';
import { storageRepository } from '../lib/session/storageRepository';
import { captureDurableApplicationState } from '../lib/session/sessionMachinePersist';
import { freshSessionState } from '../lib/session/sessionStateTransitions';
import type { HubConnection } from '../services/HubConnection';
import {
  decodePeerAppMessage,
  decodeReliableFrame,
  encodePeerAppMessage,
  PeerSession,
} from '../services/PeerSession';

interface UseSessionRejectionOptions {
  getPrimaryPeer(): PeerSession | null;
  getDurableSession(): DurableSessionPhase | null;
  releasePrimaryPeer(peer: PeerSession): void;
}

type RejectionStore = {
  write(tombstone: DurableRejectionTransport): Promise<void>;
  delete(peerId: string, sessionId: string): Promise<void>;
};

const repositoryStore: RejectionStore = {
  write: (tombstone) => writeRejectionTransform((state) => addRejectionTransport(state, tombstone)),
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
  return captureDurableApplicationState({
    kind: 'transform',
    transform,
  })!.write();
}

function addRejectionTransport(
  state: DurableApplicationState,
  tombstone: DurableRejectionTransport,
): DurableApplicationState {
  return {
    ...state,
    rejectionTransports: [
      ...state.rejectionTransports.filter(
        (record) => record.peerId !== tombstone.peerId || record.sessionId !== tombstone.sessionId,
      ),
      structuredClone(tombstone),
    ]
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(-MAX_DURABLE_REJECTION_TRANSPORTS),
  };
}

function captureSessionRejection(tombstone: DurableRejectionTransport): Promise<void> {
  return writeRejectionTransform((state) =>
    addRejectionTransport(freshSessionState(state), tombstone),
  );
}

export function useSessionRejection(options: UseSessionRejectionOptions) {
  const peersRef = useRef(new Map<string, PeerSession>());
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const retain = useCallback((peer: PeerSession, store: RejectionStore = repositoryStore) => {
    const peers = peersRef.current;
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
  }, []);

  const bindOutbound = useCallback(
    (peer: PeerSession, createdAt: number, store: RejectionStore = repositoryStore) => {
      const key = rejectionTransportKey(peer.peerId, peer.sessionId);
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
              if (peersRef.current.get(key) !== peer) return;
              await store.delete(peer.peerId, peer.sessionId);
              if (peersRef.current.get(key) !== peer) return;
              peersRef.current.delete(key);
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
    },
    [],
  );

  const routeFrame = useCallback((fromId: string, payload: Uint8Array): boolean => {
    const frame = decodeReliableFrame(payload);
    if (!frame) return false;
    const peer = peersRef.current.get(rejectionTransportKey(fromId, frame.sessionId));
    if (!peer) return false;
    peer.deliverRawPeerMessage(fromId, payload);
    return true;
  }, []);

  const rejectUnknownProposal = useCallback(
    (conn: HubConnection, fromId: string, sessionId: string, payload: Uint8Array): void => {
      const key = rejectionTransportKey(fromId, sessionId);
      const existing = peersRef.current.get(key);
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
    },
    [bindOutbound, retain],
  );

  const installInboundReceipt = useCallback(
    (
      conn: HubConnection,
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
    },
    [retain],
  );

  const persistInboundReceipt = useCallback(
    (peer: PeerSession, remoteNumber: bigint) =>
      captureSessionRejection({
        kind: 'inbound-receipt',
        peerId: peer.peerId,
        sessionId: peer.sessionId,
        messageNumber: peer.reliableState.messageNumber,
        remoteNumber,
        unackedMessages: [],
        createdAt: Date.now(),
      }),
    [],
  );

  const bindInboundProposal = useCallback(
    (args: {
      conn: HubConnection;
      peer: PeerSession;
      persistProposal(): Promise<void>;
      rejected(): void;
      failed(reason: string): void;
    }) => {
      let rejected = false;
      let rejectionPersisted = false;
      const isSessionReject = (body: Uint8Array): boolean => {
        try {
          return decodePeerAppMessage(body)?.type === 'session_reject';
        } catch {
          return false;
        }
      };
      args.peer.reliableTransport.attachConsumer({
        isReady: () => !rejected,
        canDeliver: (msgno, body) => msgno === 1n || isSessionReject(body),
        canTerminateAt: (_msgno, body) => isSessionReject(body),
        deliver: (msgno, body) => {
          const semantic = decodePeerAppMessage(body);
          if (semantic?.type === 'session_reject') {
            rejected = true;
            args.peer.reliableState.disposition = 'inbound-reject';
            args.peer.reliableTransport.discardOutbound();
            return;
          }
          if (msgno !== 1n || semantic?.type !== 'session_proposal') {
            throw new Error('initial reliable message is not a session proposal');
          }
        },
        persist: async () => {
          if (!rejected) {
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
    },
    [installInboundReceipt, persistInboundReceipt],
  );

  const sendSessionReject = useCallback(
    (peerId: string): Promise<void> => {
      const peer = optionsRef.current.getPrimaryPeer();
      if (!peer || peer.peerId !== peerId || peer.isDestroyed()) return Promise.resolve();
      const session = optionsRef.current.getDurableSession();
      const ownsResumableSave =
        (session?.phase === 'live' || session?.phase === 'pre-handshake') &&
        session.pairing.peerId === peer.peerId &&
        session.pairing.gameSessionId === peer.sessionId;
      let replacedResumableSave = false;
      const store: RejectionStore = ownsResumableSave
        ? {
            write: async (tombstone) => {
              if (!replacedResumableSave) {
                await captureSessionRejection(tombstone);
                replacedResumableSave = true;
              } else {
                await repositoryStore.write(tombstone);
              }
            },
            delete: repositoryStore.delete,
          }
        : repositoryStore;
      bindOutbound(peer, Date.now(), store);
      retain(peer, store);
      optionsRef.current.releasePrimaryPeer(peer);
      peer.reliableTransport.allocateOutbound(
        encodePeerAppMessage({ type: 'session_reject' }),
        'outbound-reject',
      );
      return peer.reliableTransport.flushPending().catch((error) => {
        console.error('[rejection] failed to persist session rejection', error);
      });
    },
    [bindOutbound, retain],
  );

  const bindPrimaryRetirement = useCallback((peer: PeerSession) => {
    peer.reliableTransport.attachConsumer({
      isReady: () => true,
      deliver: () => {},
      persist: async () => {
        await storageRepository.patchPreHandshakeTransport({
          ...peer.reliableState,
          terminalHandoff: null,
        });
        await storageRepository.flushAggregate();
      },
      acknowledged: () => {
        if (peer.reliableState.unackedMessages.length > 0) return;
        void peer.reliableTransport
          .flushPending()
          .then(() => storageRepository.clearSession())
          .then(() => {
            if (optionsRef.current.getPrimaryPeer() !== peer) return;
            peer.destroy();
            optionsRef.current.releasePrimaryPeer(peer);
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
  }, []);

  const replay = useCallback((peerId?: string) => {
    for (const peer of peersRef.current.values()) {
      if (peer.isDestroyed() || (peerId !== undefined && peer.peerId !== peerId)) continue;
      if (peer.reliableTransport.hasPendingDurability()) {
        void peer.reliableTransport.flushPending().catch((error) => {
          console.error('[rejection] failed to persist rejection', error);
        });
      } else {
        peer.reliableTransport.replayUnacked();
      }
    }
  }, []);

  const restore = useCallback(
    async (conn: HubConnection, descriptors: readonly DurableRejectionTransport[]) => {
      const tombstones = structuredClone(descriptors);
      for (const tombstone of tombstones) {
        if (tombstone.kind === 'outbound-reject' && tombstone.unackedMessages.length === 0) {
          await repositoryStore.delete(tombstone.peerId, tombstone.sessionId);
          continue;
        }
        const peer = new PeerSession(
          tombstone.peerId,
          tombstone.sessionId,
          conn,
          DEFAULT_SESSION_RECEIVE_POLICY,
          {
            messageNumber: tombstone.messageNumber,
            remoteNumber: tombstone.remoteNumber,
            unackedMessages: tombstone.unackedMessages,
            disposition:
              tombstone.kind === 'outbound-reject' ? 'outbound-reject' : 'inbound-reject',
          },
        );
        retain(peer);
        if (tombstone.kind === 'outbound-reject') {
          bindOutbound(peer, tombstone.createdAt);
          peer.reliableTransport.replayUnacked();
        }
      }
    },
    [bindOutbound, retain],
  );

  useEffect(
    () => () => {
      for (const peer of peersRef.current.values()) peer.destroy();
      peersRef.current.clear();
    },
    [],
  );

  return {
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
