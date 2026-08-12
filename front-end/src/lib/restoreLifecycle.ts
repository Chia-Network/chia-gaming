import type { SessionPhase } from '../types/ChiaGaming';
import type { RestoreStatus } from '../hooks/SessionController';
import {
  createSessionModel,
  isPreActiveChannelStatus,
  selectRestoreBlocked,
  selectShouldAdvertiseAvailable,
} from './session/model';

export function isRestoreBlocked(
  restoring: boolean,
  restoreStatus: RestoreStatus,
  hubReconciled: boolean,
): boolean {
  return selectRestoreBlocked(
    createSessionModel({
      restore: { restoring, status: restoreStatus, hubReconciled, error: null },
    }),
  );
}

/**
 * After live terminal finalization the GameSession mount is no longer a restore.
 * Clearing `restoring` prevents re-arming the "Restoring session..." gate when
 * finishResolvedSessionDisplay resets status/hubReconciled — a resumed session
 * otherwise keeps params.restoring=true forever and would flash that UI on slash
 * (or any error resolution that stays on the game tab).
 */
export function restoreGateAfterTerminalFinalization(): {
  restoring: false;
  restoreStatus: 'idle';
  hubReconciled: false;
} {
  return { restoring: false, restoreStatus: 'idle', hubReconciled: false };
}

/**
 * GameSession's "Restoring session..." placeholder is only for an in-progress
 * restore. Once Shell has a terminal presentation, the finished freeze must show.
 */
export function shouldSuppressPhaseReporting(
  restoreBlocked: boolean,
  hasTerminalPresentation: boolean,
): boolean {
  return restoreBlocked && !hasTerminalPresentation;
}

export function shouldAdvertiseAvailable(
  sessionPhase: SessionPhase,
  restoreBlocked: boolean,
): boolean {
  return selectShouldAdvertiseAvailable(
    createSessionModel({
      restore: {
        restoring: restoreBlocked,
        status: restoreBlocked ? 'restoring' : 'restored',
        hubReconciled: !restoreBlocked,
        error: null,
      },
    }),
    sessionPhase,
  );
}

/**
 * Without a wallet the player cannot fund or resolve a channel, so we advertise
 * busy to the hub regardless of session phase — the lobby must not offer matches
 * we cannot play. With a wallet, busy tracks the broader session obligation.
 */
export function shouldReportHubBusy(sessionPhase: SessionPhase, walletConnected = true): boolean {
  if (!walletConnected) return true;
  return sessionPhase !== 'none' && sessionPhase !== 'resolved';
}

/**
 * Full hub presence busy signal (matches Shell getPresence).
 *
 * During restore, `sessionPhase` is often still `none` until WASM reports, so
 * phase alone is not enough: a non-terminal cradle (serialized session or
 * pairing token) must keep us busy so the lobby does not offer matches
 * mid-resume. Terminal Failed/Resolved* cradles do not.
 */
export function shouldReportHubBusyPresence(
  sessionPhase: SessionPhase,
  walletConnected: boolean,
  opts: {
    restoring: boolean;
    terminalSave: boolean;
    hasCradle: boolean;
  },
): boolean {
  return (
    shouldReportHubBusy(sessionPhase, walletConnected) ||
    (opts.restoring && !opts.terminalSave && opts.hasCradle)
  );
}

export async function transitionToFreshSession(dependencies: {
  persistLiveCheckpoint: () => Promise<void>;
  retireTerminalDisplay: () => void;
  mountLiveSession: () => void;
  reportBusy: () => void;
  /** When true after persist, skip retire/mount — caller already cancelled. */
  shouldAbort?: () => boolean;
}): Promise<'completed' | 'aborted'> {
  dependencies.reportBusy();
  await dependencies.persistLiveCheckpoint();
  if (dependencies.shouldAbort?.()) {
    return 'aborted';
  }
  dependencies.retireTerminalDisplay();
  dependencies.mountLiveSession();
  return 'completed';
}

/**
 * Phase reports are terminal lifecycle inputs to Shell. A restored save is only
 * a persisted projection until WASM restoration and hub reconciliation finish,
 * so it must not cause terminal cleanup. Once unblocked, a resolved phase is
 * reported once from the current session projection.
 */
export function shouldReportSessionPhase(
  sessionPhase: Exclude<SessionPhase, 'none'>,
  restoreBlocked: boolean,
  resolvedReported: boolean,
): boolean {
  return !restoreBlocked && (sessionPhase !== 'resolved' || !resolvedReported);
}

/**
 * Whether a hard peer disconnect (session_reject / delivery_failure) should
 * abort the attempt. Pre-Active matchmaking/setup cancels; once the channel is
 * Active (or further), delivery_failure only degrades peer liveness — the peer
 * may be mid-reload. See CONNECTIVITY.md peer degradation.
 *
 * Resolved finished sessions never cancel: invites are allowed afterward while
 * the dashboard freeze and terminal save must stay for Resume. A null/undefined
 * channel state is treated as pre-active; a known Active/post-active channel wins
 * over the 'none' phase so that a blocked restore is not mistaken for a pre-active
 * attempt.
 */
export function shouldCancelOnPeerUnreachable(
  sessionPhase: SessionPhase,
  channelState: string | null | undefined,
  abandoning = false,
): boolean {
  if (abandoning) return false;
  if (sessionPhase === 'resolved') return false;
  return isPreActiveChannelStatus(channelState);
}

/**
 * Wallet or hub disconnect should hard-cancel only a real pre-active
 * matchmaking attempt. A pending advisory/proposal alone is not enough — after
 * a resolved game, consent prompts are allowed while the finished freeze +
 * terminal save must remain for Resume.
 */
export function shouldCancelAttemptOnDisconnect(
  hasAttempt: boolean,
  sessionPhase: SessionPhase,
  channelState: string | null | undefined,
  abandoning = false,
): boolean {
  return hasAttempt && shouldCancelOnPeerUnreachable(sessionPhase, channelState, abandoning);
}

/**
 * Settlement already submitted: peer unreachable must not push on-chain
 * escalation — wait for the clean-shutdown transaction to confirm.
 * (Live-session delivery_failure also degrades rather than marking dead.)
 */
export function shouldAwaitShutdownOnPeerUnreachable(
  channelState: string | null | undefined,
): boolean {
  return channelState === 'ShutdownTransactionPending';
}

export function shouldMountGameSession(
  sessionCanMount: boolean,
  walletConnected: boolean,
  restoring: boolean,
  sessionStarted: boolean,
): { startSession: boolean; keepSession: boolean } {
  const startSession = sessionCanMount && (walletConnected || restoring);
  return {
    startSession,
    keepSession: sessionCanMount && (sessionStarted || startSession),
  };
}

export function shouldSwitchToHubOnResolved(
  previousPhase: SessionPhase,
  hasError: boolean,
): boolean {
  return previousPhase !== 'none' && previousPhase !== 'on-chain' && !hasError;
}
