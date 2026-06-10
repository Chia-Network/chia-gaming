import type { SessionPhase } from '../types/ChiaGaming';
import type { RestoreStatus } from '../hooks/WasmBlobWrapper';
import {
  createSessionModel,
  selectRestoreBlocked,
  selectShouldAdvertiseAvailable,
  selectShouldAutoGoOnChain,
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

export function shouldAutoGoOnChain(
  peerConnected: boolean | null,
  sessionPhase: SessionPhase,
  restoreBlocked: boolean,
): boolean {
  return selectShouldAutoGoOnChain(createSessionModel({
    restore: {
      restoring: restoreBlocked,
      status: restoreBlocked ? 'restoring' : 'restored',
      trackerReconciled: !restoreBlocked,
      error: null,
    },
    peer: { connected: peerConnected },
  }), sessionPhase);
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
