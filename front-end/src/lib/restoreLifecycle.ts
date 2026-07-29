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
 * Whether the WalletConnect full-node-peer gate should hold lobby presence
 * busy. Simulator never gates. A live-session resume skips the gate — cradle
 * or pairingToken checkpoint already cleared (or never needed) that pre-match
 * check. Callers must pass true for either durable field, not cradle alone.
 */
export function shouldActivatePeerGate(
  blockchainType: 'simulator' | 'walletconnect' | undefined,
  hasResumableSession: boolean,
): boolean {
  return blockchainType === 'walletconnect' && !hasResumableSession;
}

/**
 * Whether in-memory sessionConfig should skip the WalletConnect peer gate as a
 * live resume. Cradle restore sets `restoring`. pairingToken-only resume sets
 * `pairingToken` with a non-idle `restoreStatus` (performResume). Fresh accepts
 * also set `pairingToken` with `restoring=false` and `restoreStatus=idle` —
 * those must not skip, or the peer-gate re-eval deactivates the gate and the
 * sync-mirror clears the busy bit set by `startFreshSessionWithPeer`.
 */
export function shouldSkipPeerGateForSessionConfig(
  restoring: boolean | undefined,
  pairingToken: string | undefined,
  restoreStatus: RestoreStatus,
): boolean {
  return !!restoring || (!!pairingToken && restoreStatus !== 'idle');
}

/**
 * Idle/terminal clear after a session that skipped the peer gate must re-arm
 * it before `presenceBusy` / `setBusy`. The React re-eval effect runs only
 * after commit, so without this sync step the hub is told available while
 * `peerGateActive` is still false.
 *
 * If the gate is already active, keep the current peer-ready bit (do not
 * force a re-poll). Newly activated gates start unverified.
 */
export function peerGateAfterSessionClear(
  blockchainType: 'simulator' | 'walletconnect' | undefined,
  peerGateAlreadyActive: boolean,
  hasFullNodePeer: boolean,
): { peerGateActive: boolean; hasFullNodePeer: boolean } {
  if (peerGateAlreadyActive) {
    return { peerGateActive: true, hasFullNodePeer };
  }
  const gate = shouldActivatePeerGate(blockchainType, false);
  return {
    peerGateActive: gate,
    hasFullNodePeer: !gate,
  };
}

/**
 * Hub busy bit for lobby presence: session obligation OR the WalletConnect
 * full-node-peer gate. Callers must not push `setBusy(false)` /
 * `shouldReportHubBusy(...)` alone — after session end/cancel the gate can
 * still require busy until a full node peer is verified.
 */
export function shouldReportPresenceBusy(
  sessionPhase: SessionPhase,
  peerGateActive: boolean,
  hasFullNodePeer: boolean,
): boolean {
  return shouldReportHubBusy(sessionPhase) || (peerGateActive && !hasFullNodePeer);
}

/**
 * Whether inbound matchmaking may open a consent prompt.
 * Must stay aligned with `shouldReportPresenceBusy` for session + peer-gate,
 * and also exclude temporary local matchmaking state that does not always
 * set hub `busy` (pending advisory/proposal, live peer session, reserved peer).
 */
export function isAvailableForNewSessionPrompt(
  sessionPhase: SessionPhase,
  pendingAdvisory: boolean,
  pendingProposal: boolean,
  hasLivePeerSession: boolean,
  hasReservedPeerId: boolean,
  peerGateActive: boolean,
  hasFullNodePeer: boolean,
): boolean {
  return !shouldReportPresenceBusy(sessionPhase, peerGateActive, hasFullNodePeer)
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
