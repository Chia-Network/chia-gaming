import {
  clearAutoResumeOnce,
  isLeaseConflict,
  markSavedSession,
  peekAutoResumeOnce,
} from '../session/saveCoordination';
import type { DurableApplicationState } from '../session/saveEnvelope';
import {
  reloadAfterSuccessfulHardReset,
  startPendingWalletConnectWipe,
} from '../session/saveHardReset';
import { storageRepository } from '../session/storageRepository';

export type BootRecoveryState =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'autoResuming' }
  | { kind: 'resumeDialog'; loadError: string | null }
  | { kind: 'tabConflict'; save: DurableApplicationState | null; midSession: boolean }
  | { kind: 'tabDead' };

export type BootRestoreSource = 'manual' | 'automatic' | 'takeover';

export interface BootRecoveryBoundaryDependencies {
  onSessionId: (sessionId: string) => void;
  onRestore: (
    save: DurableApplicationState,
    source: BootRestoreSource,
  ) => void | { deferReady: boolean } | Promise<void | { deferReady: boolean }>;
  onFreshClaim: (
    save: DurableApplicationState,
    source: 'boot' | 'takeover',
  ) => void | Promise<void>;
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

export interface RecoveryView {
  state: BootRecoveryState;
  resuming: boolean;
  startingOver: boolean;
}

/** Application recovery and durable authority, independent of view attachment. */
export class Recovery {
  view: RecoveryView = { state: { kind: 'loading' }, resuming: false, startingOver: false };
  private claimedRecovery: DurableApplicationState | null = null;
  private generation = 0;
  private autoResumeStarted = false;
  constructor(
    public dependencies: BootRecoveryBoundaryDependencies,
    private readonly publish: (view: RecoveryView) => void,
  ) {}
  private nextRecoveryGeneration = () => ++this.generation;
  private recoveryIsCurrent = (generation: number) => this.generation === generation;
  private setState = (
    value: BootRecoveryState | ((current: BootRecoveryState) => BootRecoveryState),
  ) => {
    this.view = {
      ...this.view,
      state: typeof value === 'function' ? value(this.view.state) : value,
    };
    this.publish(this.view);
    if (this.view.state.kind === 'autoResuming' && !this.autoResumeStarted) {
      this.autoResumeStarted = true;
      void this.resume();
    }
  };
  private setResuming = (resuming: boolean) => {
    this.view = { ...this.view, resuming };
    this.publish(this.view);
  };
  private setStartingOver = (startingOver: boolean) => {
    this.view = { ...this.view, startingOver };
    this.publish(this.view);
  };
  start(): () => void {
    const unsubscribe = this.subscribeAuthority();
    let cancelled = false;
    const generation = this.nextRecoveryGeneration();
    void (async () => {
      const pendingWipe = await startPendingWalletConnectWipe();
      if (cancelled || !this.recoveryIsCurrent(generation)) return;
      if (!pendingWipe.success) {
        markSavedSession();
        this.setState({
          kind: 'resumeDialog',
          loadError:
            'A pending hard reset is still blocked. Close other app tabs and wallet connections, then retry.',
        });
        return;
      }

      const inspection = await storageRepository.inspect();
      if (cancelled || !this.recoveryIsCurrent(generation)) return;
      if (inspection.applicationStateError) {
        clearAutoResumeOnce();
        markSavedSession();
        this.setState({
          kind: 'resumeDialog',
          loadError: errorMessage(inspection.applicationStateError),
        });
        return;
      }
      const inspected = inspection.applicationState;
      if (inspected && storageRepository.shouldOfferResumeOrStartOver(inspected)) {
        markSavedSession();
        this.setState(
          peekAutoResumeOnce()
            ? { kind: 'autoResuming' }
            : { kind: 'resumeDialog', loadError: null },
        );
        return;
      }
      if (isLeaseConflict()) {
        this.setState({ kind: 'tabConflict', save: inspected, midSession: false });
        return;
      }

      try {
        const save = await storageRepository.claimApplicationState();
        if (cancelled || !this.recoveryIsCurrent(generation)) return;
        if (storageRepository.shouldOfferResumeOrStartOver(save)) {
          this.claimedRecovery = save;
          markSavedSession();
          this.setState(
            peekAutoResumeOnce()
              ? { kind: 'autoResuming' }
              : { kind: 'resumeDialog', loadError: null },
          );
          return;
        }
        const sessionId = await storageRepository.ensureHubIdentity();
        if (cancelled || !this.recoveryIsCurrent(generation)) return;
        this.dependencies.onSessionId(sessionId);
        if (cancelled || !this.recoveryIsCurrent(generation)) return;
        await this.dependencies.onFreshClaim(save, 'boot');
        if (!cancelled && this.recoveryIsCurrent(generation)) this.setState({ kind: 'ready' });
      } catch (error) {
        if (cancelled || !this.recoveryIsCurrent(generation)) return;
        clearAutoResumeOnce();
        markSavedSession();
        this.setState({ kind: 'resumeDialog', loadError: errorMessage(error) });
      }
    })();
    return () => {
      cancelled = true;
      unsubscribe();
      if (this.recoveryIsCurrent(generation)) this.nextRecoveryGeneration();
    };
  }
  private subscribeAuthority(): () => void {
    const authorityLost = () => {
      this.nextRecoveryGeneration();
      this.claimedRecovery = null;
      this.dependencies.onAuthorityLost();
      this.setState((current) => {
        if (current.kind === 'tabDead') return current;
        if (current.kind === 'tabConflict') return current;
        return {
          kind: 'tabConflict',
          save: null,
          midSession: current.kind === 'ready',
        };
      });
      this.setResuming(false);
    };
    return storageRepository.onAuthorityLost(authorityLost);
  }
  restoreClaimed = async (
    save: DurableApplicationState,
    source: BootRestoreSource,
    generation: number,
  ): Promise<void> => {
    const sessionId = await storageRepository.ensureHubIdentity();
    if (!this.recoveryIsCurrent(generation)) return;
    this.dependencies.onSessionId(sessionId);
    if (!this.recoveryIsCurrent(generation)) return;
    const presentation = await this.dependencies.onRestore(save, source);
    if (!this.recoveryIsCurrent(generation)) return;
    clearAutoResumeOnce();
    if (!presentation || !presentation.deferReady) this.setState({ kind: 'ready' });
  };

  resume = async () => {
    const current = this.view.state;
    if (
      (current.kind !== 'resumeDialog' && current.kind !== 'autoResuming') ||
      (current.kind === 'resumeDialog' && current.loadError !== null)
    ) {
      return;
    }
    const source: BootRestoreSource = current.kind === 'autoResuming' ? 'automatic' : 'manual';
    const generation = this.nextRecoveryGeneration();
    this.setResuming(true);
    try {
      const alreadyClaimed = this.claimedRecovery;
      if (alreadyClaimed) {
        await this.restoreClaimed(alreadyClaimed, source, generation);
        if (this.recoveryIsCurrent(generation)) this.claimedRecovery = null;
        return;
      }
      const inspection = await storageRepository.inspect();
      if (!this.recoveryIsCurrent(generation)) return;
      if (inspection.applicationStateError) throw inspection.applicationStateError;
      const inspected = inspection.applicationState;
      if (!inspected) {
        clearAutoResumeOnce();
        markSavedSession();
        this.setState(unavailableSavedSession());
        return;
      }
      if (isLeaseConflict()) {
        clearAutoResumeOnce();
        this.setState({ kind: 'tabConflict', save: inspected, midSession: false });
        return;
      }
      const claimed = await storageRepository.claimApplicationState();
      if (!this.recoveryIsCurrent(generation)) return;
      if (!storageRepository.shouldOfferResumeOrStartOver(claimed)) {
        const sessionId = await storageRepository.ensureHubIdentity();
        if (!this.recoveryIsCurrent(generation)) return;
        this.dependencies.onSessionId(sessionId);
        if (!this.recoveryIsCurrent(generation)) return;
        await this.dependencies.onFreshClaim(claimed, 'boot');
        if (!this.recoveryIsCurrent(generation)) return;
        clearAutoResumeOnce();
        this.setState({ kind: 'ready' });
        return;
      }
      await this.restoreClaimed(claimed, source, generation);
    } catch (error) {
      if (!this.recoveryIsCurrent(generation)) return;
      clearAutoResumeOnce();
      markSavedSession();
      this.setState({ kind: 'resumeDialog', loadError: errorMessage(error) });
    } finally {
      if (this.recoveryIsCurrent(generation)) this.setResuming(false);
    }
  };

  takeOver = async () => {
    if (this.view.state.kind !== 'tabConflict') return;
    this.claimedRecovery = null;
    const generation = this.nextRecoveryGeneration();
    this.setResuming(true);
    try {
      const claimed = await storageRepository.claimApplicationState();
      if (!this.recoveryIsCurrent(generation)) return;
      const sessionId = await storageRepository.ensureHubIdentity();
      if (!this.recoveryIsCurrent(generation)) return;
      this.dependencies.onSessionId(sessionId);
      if (!this.recoveryIsCurrent(generation)) return;
      if (storageRepository.shouldOfferResumeOrStartOver(claimed)) {
        const presentation = await this.dependencies.onRestore(claimed, 'takeover');
        if (!this.recoveryIsCurrent(generation)) return;
        if (presentation?.deferReady) return;
      } else {
        await this.dependencies.onFreshClaim(claimed, 'takeover');
        if (!this.recoveryIsCurrent(generation)) return;
      }
      this.setState({ kind: 'ready' });
    } catch (error) {
      if (!this.recoveryIsCurrent(generation)) return;
      clearAutoResumeOnce();
      markSavedSession();
      this.setState({ kind: 'resumeDialog', loadError: errorMessage(error) });
    } finally {
      if (this.recoveryIsCurrent(generation)) this.setResuming(false);
    }
  };

  retryHardReset = async () => {
    this.setStartingOver(true);
    try {
      await this.dependencies.beforeHardReset();
      const result = await storageRepository.hardReset();
      if (!result.success) {
        const blocked = result.failures.some((failure) => failure.reason === 'blocked');
        markSavedSession();
        this.setState({
          kind: 'resumeDialog',
          loadError: blocked
            ? 'Hard reset is blocked. Close other app tabs and wallet connections, then retry.'
            : 'Hard reset could not delete all local databases. Close other app tabs and wallet connections, then retry.',
        });
        return;
      }
      reloadAfterSuccessfulHardReset(
        result,
        this.dependencies.reload ?? (() => window.location.reload()),
      );
    } catch (error) {
      console.error('[BootRecoveryBoundary] hard reset failed:', error);
      markSavedSession();
      this.setState({
        kind: 'resumeDialog',
        loadError:
          'Hard reset failed. Close other app tabs and wallet connections, then retry hard reset.',
      });
    } finally {
      this.setStartingOver(false);
    }
  };
  closeTab = () => {
    this.nextRecoveryGeneration();
    this.claimedRecovery = null;
    this.setState({ kind: 'tabDead' });
  };
  revealReady = () =>
    this.setState((current) => (current.kind === 'autoResuming' ? { kind: 'ready' } : current));
}
