import { useCallback, useRef } from 'react';
import { startFailureDisposition, type AcceptReason } from '../lib/session/acceptLifecycle';
import { isAcceptSessionTransition } from '../lib/session/shellSessionState';
import type { ShellSessionTransition } from '../lib/session/shellSessionState';

export type AcceptAbortOptions = {
  error?: boolean;
  /** When set, Accept abort owns sending session_reject to this peer. */
  peerId?: string;
};

export type AcceptAbortHandlers = {
  getTransition: () => ShellSessionTransition;
  /** Peer-only abandon (pre-persist): clear provisional Accept without wiping freeze. */
  abandonPeerOnly: (options?: { error?: boolean }) => void;
  /** Full attempt teardown after persist committed. */
  cancelAttempt: (options?: { error?: boolean }) => void;
  sendSessionReject: (peerId: string) => void;
};

/**
 * Accept epoch + persist flags and the single abortAccept API.
 * beginAccept / startFreshSessionWithPeer stay composed in Shell with these refs.
 */
export function useAcceptLifecycle() {
  const sessionStartEpochRef = useRef(0);
  const freshStartPersistCommittedRef = useRef(false);
  const freshStartPersistInFlightRef = useRef(false);

  const bumpStartEpoch = useCallback(() => {
    sessionStartEpochRef.current += 1;
    freshStartPersistCommittedRef.current = false;
  }, []);

  const beginPersistFlight = useCallback(() => {
    freshStartPersistCommittedRef.current = false;
    freshStartPersistInFlightRef.current = true;
  }, []);

  const endPersistFlight = useCallback(() => {
    freshStartPersistInFlightRef.current = false;
  }, []);

  const markPersistCommitted = useCallback(() => {
    freshStartPersistCommittedRef.current = true;
  }, []);

  /**
   * Abort an in-flight Accept with freeze-safe disposition.
   * Owns session_reject when peerId is provided.
   * Returns false when no Accept transition is active.
   */
  const abortAccept = useCallback(
    (handlers: AcceptAbortHandlers, options?: AcceptAbortOptions): boolean => {
      if (!isAcceptSessionTransition(handlers.getTransition())) return false;
      if (options?.peerId) {
        handlers.sendSessionReject(options.peerId);
      }
      if (startFailureDisposition(freshStartPersistCommittedRef.current) === 'abandon-peer-only') {
        handlers.abandonPeerOnly(options);
      } else {
        handlers.cancelAttempt(options);
      }
      return true;
    },
    [],
  );

  return {
    sessionStartEpochRef,
    freshStartPersistCommittedRef,
    freshStartPersistInFlightRef,
    bumpStartEpoch,
    beginPersistFlight,
    endPersistFlight,
    markPersistCommitted,
    abortAccept,
  };
}

export type { AcceptReason };
