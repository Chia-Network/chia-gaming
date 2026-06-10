import type { SessionPhase } from '../types/ChiaGaming';
import type { RestoreStatus } from '../hooks/WasmBlobWrapper';

export function isRestoreBlocked(
  restoring: boolean,
  restoreStatus: RestoreStatus,
  trackerReconciled: boolean,
): boolean {
  return restoring && (restoreStatus !== 'restored' || !trackerReconciled);
}

export function shouldAutoGoOnChain(
  peerConnected: boolean | null,
  sessionPhase: SessionPhase,
  restoreBlocked: boolean,
): boolean {
  return peerConnected === false && sessionPhase === 'off-chain' && !restoreBlocked;
}

export function shouldAdvertiseAvailable(
  sessionPhase: SessionPhase,
  restoreBlocked: boolean,
): boolean {
  return !restoreBlocked && (sessionPhase === 'none' || sessionPhase === 'resolved');
}
