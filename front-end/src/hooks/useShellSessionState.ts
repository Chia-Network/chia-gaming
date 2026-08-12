import { useCallback, useReducer } from 'react';
import {
  initialShellSessionState,
  shellSessionReducer,
  type ShellSessionAction,
  type ShellSessionState,
  type ShellSessionTransitionReason,
} from '../lib/session/shellSessionState';

export type TransitionWork = () => void | Promise<void>;

export interface UseShellSessionStateResult {
  state: ShellSessionState;
  dispatch: React.Dispatch<ShellSessionAction>;
  /**
   * Start an Accept transition (clears consent atomically) and run work.
   * Completes when `completeTransition(readyKey)` fires, or ends on throw.
   */
  beginAcceptTransition: (
    reason: ShellSessionTransitionReason,
    readyKey: string,
    work: TransitionWork,
  ) => Promise<void>;
  completeTransition: (readyKey: string) => void;
  cancelTransition: () => void;
}

/**
 * Shell session fields + Accept session-pane transition bookkeeping.
 * Accept abort/persist/epoch live in `useAcceptLifecycle`.
 */
export function useShellSessionState(): UseShellSessionStateResult {
  const [state, dispatch] = useReducer(shellSessionReducer, initialShellSessionState);

  const beginAcceptTransition = useCallback(
    async (
      reason: ShellSessionTransitionReason,
      readyKey: string,
      work: TransitionWork,
    ): Promise<void> => {
      dispatch({ type: 'beginAccept', reason, readyKey });
      try {
        await work();
      } catch (error) {
        dispatch({ type: 'endTransition' });
        throw error;
      }
    },
    [dispatch],
  );

  const completeTransition = useCallback((readyKey: string) => {
    dispatch({ type: 'completeTransition', readyKey });
  }, []);
  const cancelTransition = useCallback(() => {
    dispatch({ type: 'endTransition' });
  }, []);

  return {
    state,
    dispatch,
    beginAcceptTransition,
    completeTransition,
    cancelTransition,
  };
}
