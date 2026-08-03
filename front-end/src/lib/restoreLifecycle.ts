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
  return selectRestoreBlocked(createSessionModel({
    restore: { restoring, status: restoreStatus, hubReconciled, error: null },
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
      hubReconciled: !restoreBlocked,
      error: null,
    },
  }), sessionPhase);
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
 * Whether WalletConnect presence should report busy because the wallet has no
 * full-node peer yet. Simulator never awaits a peer. The app still connects to
 * the hub normally; it just advertises busy until a peer is verified.
 */
export function isAwaitingFullNodePeer(
  blockchainType: 'simulator' | 'walletconnect' | undefined,
  hasFullNodePeer: boolean,
): boolean {
  return blockchainType === 'walletconnect' && !hasFullNodePeer;
}

/**
 * Hub busy bit for lobby presence: session obligation OR the WalletConnect
 * full-node-peer wait. Callers must not push `setBusy(false)` /
 * `shouldReportHubBusy(...)` alone — until a full node peer is verified the
 * WalletConnect wallet must keep advertising busy.
 */
export function shouldReportPresenceBusy(
  sessionPhase: SessionPhase,
  awaitingFullNodePeer: boolean,
): boolean {
  return shouldReportHubBusy(sessionPhase) || awaitingFullNodePeer;
}

/**
 * Whether inbound matchmaking may open a consent prompt.
 * Must stay aligned with `shouldReportPresenceBusy` for session + peer wait,
 * and also exclude temporary local matchmaking state that does not always
 * set hub `busy` (pending advisory/proposal, live peer session, reserved peer).
 */
export function isAvailableForNewSessionPrompt(
  sessionPhase: SessionPhase,
  pendingAdvisory: boolean,
  pendingProposal: boolean,
  hasLivePeerSession: boolean,
  hasReservedPeerId: boolean,
  awaitingFullNodePeer: boolean,
): boolean {
  return !shouldReportPresenceBusy(sessionPhase, awaitingFullNodePeer)
    && !pendingAdvisory
    && !pendingProposal
    && !hasLivePeerSession
    && !hasReservedPeerId;
}

/**
 * Whether a hard peer disconnect (session_reject / delivery_failure) should
 * abort the attempt. Pre-Active matchmaking/setup cancels; once the channel is
 * Active (or further), delivery_failure only degrades peer liveness — the peer
 * may be mid-reload. See CONNECTIVITY.md peer degradation.
 */
export function shouldCancelOnPeerUnreachable(
  sessionPhase: SessionPhase,
  channelState: string | null | undefined,
  abandoning = false,
): boolean {
  if (abandoning) return false;
  const isPreActive = isPreActiveChannelStatus(channelState);
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

export function shouldSwitchToHubOnResolved(
  previousPhase: SessionPhase,
  hasError: boolean,
): boolean {
  return previousPhase !== 'none' && previousPhase !== 'on-chain' && !hasError;
}
