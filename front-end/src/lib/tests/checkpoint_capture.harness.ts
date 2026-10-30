import type { RestoreStatus, SessionController } from '../session/SessionController';
import { buildDurableApplicationState } from '../session/sessionMachinePersist';
import type { SessionMachineState } from '../session/sessionMachineTypes';
import { storageRepository } from '../session/storageRepository';
import type { TerminalCapture } from '../session/terminalFinalization';
export type { TerminalCapture };
export interface SessionPersistDependencies {
  controller: SessionController;
  state: SessionMachineState;
  restoring: boolean;
  getRestoreStatus(): RestoreStatus;
  getRestoreError(): string | null;
}
export function installCapturedState(
  capture: ({ kind: 'live' } & SessionPersistDependencies) | TerminalCapture,
) {
  const input =
    capture.kind === 'terminal'
      ? { ...capture, walletProviderScope: capture.controller.getWalletProviderScope() }
      : {
          kind: 'live' as const,
          wasm: capture.controller.getWasmFields(),
          model: capture.state.model,
          walletProviderScope: capture.controller.getWalletProviderScope(),
          restoring: capture.restoring,
          restoreStatus: capture.getRestoreStatus(),
          restoreError: capture.getRestoreError(),
        };
  if (input.kind === 'live' && !input.wasm) return null;
  return storageRepository.patchApplicationState((root) =>
    buildDurableApplicationState(root, input)!,
  );
}
