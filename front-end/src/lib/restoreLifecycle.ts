import type { SessionPhase } from '../types/ChiaGaming';
import type { RestoreStatus } from '../hooks/WasmBlobWrapper';
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
