import { useCallback, useReducer } from 'react';
import {
  initialShellSessionState,
  shellSessionReducer,
  type ShellSessionAction,
  type ShellSessionState,
  type ShellSessionTransitionReason,
  type ShellSessionTransitionScope,
} from '../lib/session/shellSessionState';

export type TransitionWork = () => void | Promise<void>;
export type TransitionOptions =
  | {
      scope: ShellSessionTransitionScope;
      waitForReady?: false;
    }
  | {
      scope: ShellSessionTransitionScope;
      waitForReady: true;
      readyKey: string;
    };

export interface UseShellSessionTransitionResult {
  state: ShellSessionState;
  dispatch: React.Dispatch<ShellSessionAction>;
  runTransition: (
    reason: ShellSessionTransitionReason,
    work: TransitionWork,
    options: TransitionOptions,
  ) => Promise<void>;
  completeTransition: (readyKey: string) => void;
  cancelTransition: () => void;
}

export function useShellSessionTransition(): UseShellSessionTransitionResult {
  const [state, dispatch] = useReducer(shellSessionReducer, initialShellSessionState);

  const runTransition = useCallback(
    async (
      reason: ShellSessionTransitionReason,
      work: TransitionWork,
      options: TransitionOptions,
    ): Promise<void> => {
      dispatch({
        type: 'startTransition',
        reason,
        scope: options.scope,
        readyKey: options.waitForReady ? options.readyKey : null,
      });
      try {
        await work();
      } catch (error) {
        dispatch({ type: 'endTransition' });
        throw error;
      } finally {
        if (!options.waitForReady) {
          dispatch({ type: 'endTransition' });
        }
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
    runTransition,
    completeTransition,
    cancelTransition,
  };
}
