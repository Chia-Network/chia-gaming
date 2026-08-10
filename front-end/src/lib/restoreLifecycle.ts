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

/**
 * Without a wallet the player cannot fund or resolve a channel, so we advertise
 * busy to the hub regardless of session phase — the lobby must not offer matches
 * we cannot play. The same applies until the blockchain backend reports it is
 * ready for play (`blockchainReady`); the backend owns that computation (e.g.
 * WalletConnect waits for a verified full-node peer). With a wallet and a ready
 * backend, busy tracks the broader session obligation.
 */
export function shouldReportHubBusy(
  sessionPhase: SessionPhase,
  walletConnected = true,
  blockchainReady = true,
): boolean {
  if (!walletConnected || !blockchainReady) return true;
  return sessionPhase !== 'none' && sessionPhase !== 'resolved';
}

/**
 * Full hub presence busy signal (matches Shell getPresence).
 *
 * During restore, `sessionPhase` is often still `none` until WASM reports, so
 * phase alone is not enough: a non-terminal cradle (serialized session or
 * pairing token) must keep us busy so the lobby does not offer matches
 * mid-resume. Terminal Failed/Resolved* cradles do not. A backend that is not
 * yet ready for play (`blockchainReady === false`) also stays busy.
 */
export function shouldReportHubBusyPresence(
  sessionPhase: SessionPhase,
  walletConnected: boolean,
  opts: {
    restoring: boolean;
    terminalSave: boolean;
    hasCradle: boolean;
    blockchainReady?: boolean;
  },
): boolean {
  return (
    shouldReportHubBusy(sessionPhase, walletConnected, opts.blockchainReady ?? true) ||
    (opts.restoring && !opts.terminalSave && opts.hasCradle)
  );
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
 * Whether inbound matchmaking may open a consent prompt.
 * Must stay aligned with `shouldReportHubBusy` for session + wallet + backend
 * readiness, and also exclude temporary local matchmaking state that does not
 * always set hub `busy` (pending advisory/proposal, live peer session, reserved
 * peer).
 */
export function isAvailableForNewSessionPrompt(
  sessionPhase: SessionPhase,
  pendingAdvisory: boolean,
  pendingProposal: boolean,
  hasLivePeerSession: boolean,
  hasReservedPeerId: boolean,
  walletConnected: boolean,
  blockchainReady: boolean,
): boolean {
  return (
    !shouldReportHubBusy(sessionPhase, walletConnected, blockchainReady) &&
    !pendingAdvisory &&
    !pendingProposal &&
    !hasLivePeerSession &&
    !hasReservedPeerId
  );
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
