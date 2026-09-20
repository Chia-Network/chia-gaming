import { useCallback, useEffect, useRef, useState } from 'react';

import {
  claimAndHydrateSession,
  clearAutoResumeOnce,
  ensureHubIdentity,
  hydrateSessionCacheFromDisk,
  isLeaseConflict,
  markSavedSession,
  peekAutoResumeOnce,
  peekSession,
  shouldOfferResumeOrStartOver,
  hardReset,
} from '../lib/session/sessionCache';
import {
  reloadAfterSuccessfulHardReset,
  startPendingWalletConnectWipe,
} from '../hooks/saveHardReset';
import type { SessionSave } from '../lib/session/saveEnvelope';
import { storageCoordinator } from '../lib/session/storageCoordinator';

export type BootRecoveryState =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'autoResuming' }
  | { kind: 'resumeDialog'; loadError: string | null }
  | { kind: 'tabConflict'; save: SessionSave | null; midSession: boolean }
  | { kind: 'tabDead' };

export type BootRestoreSource = 'manual' | 'automatic' | 'takeover';

export interface BootRecoveryBoundaryDependencies {
  onSessionId: (sessionId: string) => void;
  onRestore: (
    save: SessionSave,
    source: BootRestoreSource,
  ) => void | { deferReady: boolean } | Promise<void | { deferReady: boolean }>;
  onFreshClaim: (save: SessionSave | null, source: 'boot' | 'takeover') => void | Promise<void>;
  onAuthorityLost: () => void;
  beforeHardReset: () => void | Promise<void>;
  reload?: () => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unavailableSavedSession(): BootRecoveryState {
  return {
    kind: 'resumeDialog',
    loadError: 'The saved session is unsupported or could not be loaded.',
  };
}

function isDurableSession(
  save: SessionSave | null,
): save is Exclude<SessionSave, { phase: 'preferences' }> {
  return save !== null && save.phase !== 'preferences';
}

export function useBootRecoveryBoundary(dependencies: BootRecoveryBoundaryDependencies): {
  state: BootRecoveryState;
  resuming: boolean;
  startingOver: boolean;
  resume: () => Promise<void>;
  takeOver: () => Promise<void>;
  closeTab: () => void;
  retryHardReset: () => Promise<void>;
  revealReady: () => void;
} {
  const dependenciesRef = useRef(dependencies);
  dependenciesRef.current = dependencies;
  const [state, setState] = useState<BootRecoveryState>({ kind: 'loading' });
  const stateRef = useRef(state);
  stateRef.current = state;
  const [resuming, setResuming] = useState(false);
  const [startingOver, setStartingOver] = useState(false);
  const autoResumeStartedRef = useRef(false);
  const claimedRecoveryRef = useRef<SessionSave | null>(null);
  const recoveryGenerationRef = useRef(0);
  const nextRecoveryGeneration = useCallback(() => {
    recoveryGenerationRef.current += 1;
    return recoveryGenerationRef.current;
  }, []);
  const recoveryIsCurrent = useCallback(
    (generation: number) => recoveryGenerationRef.current === generation,
    [],
  );

  useEffect(() => {
    let cancelled = false;
    const generation = nextRecoveryGeneration();
    void (async () => {
      const pendingWipe = await startPendingWalletConnectWipe();
      if (cancelled || !recoveryIsCurrent(generation)) return;
      if (!pendingWipe.success) {
        markSavedSession();
        setState({
          kind: 'resumeDialog',
          loadError:
            'A pending hard reset is still blocked. Close other app tabs and wallet connections, then retry.',
        });
        return;
      }

      const hydration = await hydrateSessionCacheFromDisk();
      if (cancelled || !recoveryIsCurrent(generation)) return;
      if (hydration.status === 'failed') {
        clearAutoResumeOnce();
        markSavedSession();
        setState({ kind: 'resumeDialog', loadError: hydration.error });
        return;
      }
      if (hydration.durableSession || shouldOfferResumeOrStartOver()) {
        markSavedSession();
        setState(
          peekAutoResumeOnce()
            ? { kind: 'autoResuming' }
            : { kind: 'resumeDialog', loadError: null },
        );
        return;
      }
      if (isLeaseConflict()) {
        setState({ kind: 'tabConflict', save: null, midSession: false });
        return;
      }

      try {
        const save = await claimAndHydrateSession();
        if (cancelled || !recoveryIsCurrent(generation)) return;
        if (isDurableSession(save)) {
          claimedRecoveryRef.current = save;
          markSavedSession();
          setState(
            peekAutoResumeOnce()
              ? { kind: 'autoResuming' }
              : { kind: 'resumeDialog', loadError: null },
          );
          return;
        }
        const sessionId = await ensureHubIdentity();
        if (cancelled || !recoveryIsCurrent(generation)) return;
        dependenciesRef.current.onSessionId(sessionId);
        if (cancelled || !recoveryIsCurrent(generation)) return;
        await dependenciesRef.current.onFreshClaim(save, 'boot');
        if (!cancelled && recoveryIsCurrent(generation)) setState({ kind: 'ready' });
      } catch (error) {
        if (cancelled || !recoveryIsCurrent(generation)) return;
        clearAutoResumeOnce();
        markSavedSession();
        setState({ kind: 'resumeDialog', loadError: errorMessage(error) });
      }
    })();
    return () => {
      cancelled = true;
      if (recoveryIsCurrent(generation)) nextRecoveryGeneration();
    };
  }, [nextRecoveryGeneration, recoveryIsCurrent]);

  useEffect(() => {
    const authorityLost = () => {
      nextRecoveryGeneration();
      claimedRecoveryRef.current = null;
      dependenciesRef.current.onAuthorityLost();
      setState((current) => {
        if (current.kind === 'tabDead') return current;
        if (current.kind === 'tabConflict') return current;
        return {
          kind: 'tabConflict',
          save: null,
          midSession: current.kind === 'ready',
        };
      });
      setResuming(false);
    };
    storageCoordinator.onAuthorityLost(authorityLost);
    return () => storageCoordinator.offAuthorityLost(authorityLost);
  }, [nextRecoveryGeneration]);

  const restoreClaimed = useCallback(
    async (save: SessionSave, source: BootRestoreSource, generation: number): Promise<void> => {
      const sessionId = await ensureHubIdentity();
      if (!recoveryIsCurrent(generation)) return;
      dependenciesRef.current.onSessionId(sessionId);
      if (!recoveryIsCurrent(generation)) return;
      const presentation = await dependenciesRef.current.onRestore(save, source);
      if (!recoveryIsCurrent(generation)) return;
      clearAutoResumeOnce();
      if (!presentation || !presentation.deferReady) setState({ kind: 'ready' });
    },
    [recoveryIsCurrent],
  );

  const resume = useCallback(async () => {
    const current = stateRef.current;
    if (
      (current.kind !== 'resumeDialog' && current.kind !== 'autoResuming') ||
      (current.kind === 'resumeDialog' && current.loadError !== null)
    ) {
      return;
    }
    const source: BootRestoreSource = current.kind === 'autoResuming' ? 'automatic' : 'manual';
    const generation = nextRecoveryGeneration();
    setResuming(true);
    try {
      const alreadyClaimed = claimedRecoveryRef.current;
      if (alreadyClaimed) {
        await restoreClaimed(alreadyClaimed, source, generation);
        if (recoveryIsCurrent(generation)) claimedRecoveryRef.current = null;
        return;
      }
      const inspected = await peekSession();
      if (!recoveryIsCurrent(generation)) return;
      if (!inspected) {
        clearAutoResumeOnce();
        markSavedSession();
        setState(unavailableSavedSession());
        return;
      }
      if (isLeaseConflict()) {
        clearAutoResumeOnce();
        setState({ kind: 'tabConflict', save: inspected, midSession: false });
        return;
      }
      const claimed = await claimAndHydrateSession();
      if (!recoveryIsCurrent(generation)) return;
      if (!claimed) {
        clearAutoResumeOnce();
        markSavedSession();
        setState(unavailableSavedSession());
        return;
      }
      await restoreClaimed(claimed, source, generation);
    } catch (error) {
      if (!recoveryIsCurrent(generation)) return;
      clearAutoResumeOnce();
      markSavedSession();
      setState({ kind: 'resumeDialog', loadError: errorMessage(error) });
    } finally {
      if (recoveryIsCurrent(generation)) setResuming(false);
    }
  }, [nextRecoveryGeneration, recoveryIsCurrent, restoreClaimed]);

  useEffect(() => {
    if (state.kind !== 'autoResuming' || autoResumeStartedRef.current) return;
    autoResumeStartedRef.current = true;
    void resume();
  }, [resume, state.kind]);

  const takeOver = useCallback(async () => {
    if (stateRef.current.kind !== 'tabConflict') return;
    claimedRecoveryRef.current = null;
    const generation = nextRecoveryGeneration();
    setResuming(true);
    try {
      const claimed = await claimAndHydrateSession();
      if (!recoveryIsCurrent(generation)) return;
      const sessionId = await ensureHubIdentity();
      if (!recoveryIsCurrent(generation)) return;
      dependenciesRef.current.onSessionId(sessionId);
      if (!recoveryIsCurrent(generation)) return;
      if (claimed) {
        const presentation = await dependenciesRef.current.onRestore(claimed, 'takeover');
        if (!recoveryIsCurrent(generation)) return;
        if (presentation?.deferReady) return;
      } else {
        await dependenciesRef.current.onFreshClaim(null, 'takeover');
        if (!recoveryIsCurrent(generation)) return;
      }
      setState({ kind: 'ready' });
    } catch (error) {
      if (!recoveryIsCurrent(generation)) return;
      clearAutoResumeOnce();
      markSavedSession();
      setState({ kind: 'resumeDialog', loadError: errorMessage(error) });
    } finally {
      if (recoveryIsCurrent(generation)) setResuming(false);
    }
  }, [nextRecoveryGeneration, recoveryIsCurrent]);

  const retryHardReset = useCallback(async () => {
    setStartingOver(true);
    try {
      await dependenciesRef.current.beforeHardReset();
      const result = await hardReset();
      if (!result.success) {
        const blocked = result.failures.some((failure) => failure.reason === 'blocked');
        markSavedSession();
        setState({
          kind: 'resumeDialog',
          loadError: blocked
            ? 'Hard reset is blocked. Close other app tabs and wallet connections, then retry.'
            : 'Hard reset could not delete all local databases. Close other app tabs and wallet connections, then retry.',
        });
        return;
      }
      reloadAfterSuccessfulHardReset(
        result,
        dependenciesRef.current.reload ?? (() => window.location.reload()),
      );
    } catch (error) {
      console.error('[BootRecoveryBoundary] hard reset failed:', error);
      markSavedSession();
      setState({
        kind: 'resumeDialog',
        loadError:
          'Hard reset failed. Close other app tabs and wallet connections, then retry hard reset.',
      });
    } finally {
      setStartingOver(false);
    }
  }, []);

  return {
    state,
    resuming,
    startingOver,
    resume,
    takeOver,
    closeTab: () => {
      nextRecoveryGeneration();
      claimedRecoveryRef.current = null;
      setState({ kind: 'tabDead' });
    },
    retryHardReset,
    revealReady: () =>
      setState((current) => (current.kind === 'autoResuming' ? { kind: 'ready' } : current)),
  };
}
