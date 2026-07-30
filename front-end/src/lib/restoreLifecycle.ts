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

export function shouldReportHubBusy(sessionPhase: SessionPhase): boolean {
  return sessionPhase !== 'none' && sessionPhase !== 'resolved';
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
 * the dashboard freeze and terminal save must stay for Resume. A null channel
 * state is otherwise treated as pre-active, so phase must win here.
 */
export function shouldCancelOnPeerUnreachable(
  sessionPhase: SessionPhase,
  channelState: string | null | undefined,
  abandoning = false,
): boolean {
  if (abandoning) return false;
  if (sessionPhase === 'resolved') return false;
  const isPreActive = isPreActiveChannelStatus(channelState);
  return sessionPhase === 'none' || isPreActive;
}

/**
 * Hub/wallet disconnect should hard-cancel only a real pre-active matchmaking
 * attempt. A pending advisory/proposal alone is not enough — after a resolved
 * game, consent prompts are allowed while the finished freeze + terminal save
 * must remain for Resume.
 */
export function shouldCancelAttemptOnHubDisconnect(
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
