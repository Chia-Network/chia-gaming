import type { SessionPhase } from '../types/ChiaGaming';
import type { RestoreStatus } from '../hooks/SessionController';
import {
  createSessionModel,
  selectRestoreBlocked,
  selectShouldAdvertiseAvailable,
} from './session/model';

export function isRestoreBlocked(
  restoring: boolean,
  restoreStatus: RestoreStatus,
  trackerReconciled: boolean,
): boolean {
  return selectRestoreBlocked(createSessionModel({
    restore: { restoring, status: restoreStatus, trackerReconciled, error: null },
  }));
}

export function shouldAdvertiseAvailable(
  sessionPhase: SessionPhase,
  restoreBlocked: boolean,
): boolean {
  return selectShouldAdvertiseAvailable(createSessionModel({
    restore: {
      restoring: restoreBlocked,
      status: restoreBlocked ? 'restoring' : 'restored',
      trackerReconciled: !restoreBlocked,
      error: null,
    },
  }), sessionPhase);
}

export function shouldReportTrackerBusy(sessionPhase: SessionPhase): boolean {
  return sessionPhase !== 'none' && sessionPhase !== 'resolved';
}

/** Channel states that already finished — resume must not keep the lobby busy. */
export function isTerminalChannelStatus(state: string | null | undefined): boolean {
  return state === 'ResolvedClean'
    || state === 'ResolvedUnrolled'
    || state === 'ResolvedStale'
    || state === 'Failed';
}

const PRE_ACTIVE_CHANNEL_STATES: ReadonlySet<string> = new Set([
  'Handshaking', 'WaitingForHeightToOffer', 'WaitingForHeightToAccept',
  'OurWalletMakingOffer', 'OurWalletMakingOfferAcceptance', 'OfferSent', 'TransactionPending',
]);

/**
 * Whether a hard peer disconnect (session_reject / delivery_failure) should
 * abort the attempt. Pre-Active matchmaking/setup cancels; once the channel is
 * Active (or further), delivery_failure only degrades peer liveness — the peer
 * may be mid-reload. See CONNECTIVITY.md peer degradation.
 */
export function shouldCancelOnPeerUnreachable(
  sessionPhase: SessionPhase,
  channelState: string | null | undefined,
): boolean {
  const isPreActive = !channelState || PRE_ACTIVE_CHANNEL_STATES.has(channelState);
  return sessionPhase === 'none' || isPreActive;
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

export function shouldSwitchToTrackerOnResolved(
  previousPhase: SessionPhase,
  hasError: boolean,
): boolean {
  return previousPhase !== 'none' && previousPhase !== 'on-chain' && !hasError;
}
