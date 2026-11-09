import { startFailureDisposition } from '../session/acceptLifecycle';
import type { ShellSessionTransition } from '../session/shellSessionState';
import {
  initialShellSessionState,
  isAcceptSessionTransition,
  shellSessionReducer,
  type ShellSessionAction,
  type ShellSessionTransitionReason,
} from '../session/shellSessionState';
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

export function createShellSessionState(changed: () => void) {
  let state = initialShellSessionState;
  const dispatch = (action: ShellSessionAction) => {
    state = shellSessionReducer(state, action);
    changed();
  };
  return {
    get state() {
      return state;
    },
    dispatch,
    async beginAcceptTransition(
      reason: ShellSessionTransitionReason,
      readyKey: string,
      work: () => void | Promise<void>,
    ) {
      dispatch({ type: 'beginAccept', reason, readyKey });
      try {
        await work();
      } catch (error) {
        dispatch({ type: 'endTransition' });
        throw error;
      }
    },
    completeTransition: (readyKey: string) => dispatch({ type: 'completeTransition', readyKey }),
    cancelTransition: () => dispatch({ type: 'endTransition' }),
  };
}

export function createAcceptLifecycle() {
  let epoch = 0;
  let committed = false;
  let persisting = false;
  return {
    get epoch() {
      return epoch;
    },
    get committed() {
      return committed;
    },
    get persisting() {
      return persisting;
    },
    bumpStartEpoch() {
      epoch++;
      committed = false;
    },
    beginPersistFlight() {
      committed = false;
      persisting = true;
    },
    endPersistFlight() {
      persisting = false;
    },
    markPersistCommitted() {
      committed = true;
    },
    abortAccept(handlers: AcceptAbortHandlers, options?: AcceptAbortOptions): boolean {
      if (!isAcceptSessionTransition(handlers.getTransition())) return false;
      if (options?.peerId) handlers.sendSessionReject(options.peerId);
      if (startFailureDisposition(committed) === 'abandon-peer-only')
        handlers.abandonPeerOnly(options);
      else handlers.cancelAttempt(options);
      return true;
    },
  };
}
