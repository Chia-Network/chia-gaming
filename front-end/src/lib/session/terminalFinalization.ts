import type { CoinOfInterestEntry } from '../../types/ChiaGaming';
import type { SessionController } from '../../hooks/SessionController';
import { markSavedSession } from '../../hooks/saveCoordination';
import { destroyFlushedTerminalSessionController } from '../../hooks/blobSingleton';
import { selectDashboardCoins } from './selectors';
import type { SessionModel } from './types';
import {
  captureDurableApplicationState,
  type PreparedDurableApplicationStateCapture,
  type TerminalCapture,
} from './sessionMachinePersist';
import { StorageAuthorityLostError, StorageAuthorityRequiredError } from './indexedDb';

export interface TerminalSessionIdentity {
  myName: string;
  opponentName?: string;
  iStarted: boolean;
}

export interface TerminalFinalizationDependencies {
  captureTerminal: (capture: TerminalCapture) => PreparedDurableApplicationStateCapture;
  updateMarker: () => void;
  teardown: (controller: SessionController) => void;
}

const defaultDependencies: TerminalFinalizationDependencies = {
  captureTerminal: (capture) => captureDurableApplicationState(capture)!,
  updateMarker: markSavedSession,
  teardown: destroyFlushedTerminalSessionController,
};

const pendingFinalizations = new WeakMap<SessionController, Promise<TerminalFinalizationResult>>();

export interface TerminalFinalizationResult {
  model: SessionModel;
  identity: TerminalSessionIdentity;
  coins: CoinOfInterestEntry[];
}

export function finalizeTerminalSession(
  args: {
    controller: SessionController;
    identity: TerminalSessionIdentity;
  },
  dependencies: TerminalFinalizationDependencies = defaultDependencies,
): Promise<TerminalFinalizationResult> {
  const existing = pendingFinalizations.get(args.controller);
  if (existing) return existing;

  const identity = { ...args.identity };

  const finalization = (async () => {
    const snapshot = await args.controller.quiesceForTerminalFinalization();
    const model = structuredClone(snapshot.model);
    const coins = selectDashboardCoins(model, snapshot.coinsOfInterest);
    const capture: TerminalCapture = {
      kind: 'terminal',
      controller: args.controller,
      model,
      identity: {
        iStarted: identity.iStarted,
        myAlias: identity.myName,
        opponentAlias: identity.opponentName ?? null,
      },
      coinsOfInterest: coins,
    };
    try {
      await dependencies.captureTerminal(capture).write();
    } catch (error) {
      if (
        error instanceof StorageAuthorityLostError ||
        error instanceof StorageAuthorityRequiredError
      ) {
        throw error;
      }
      args.controller.reportDurabilityError(error);
    }
    dependencies.updateMarker();
    dependencies.teardown(args.controller);
    return { model, identity, coins };
  })();
  pendingFinalizations.set(args.controller, finalization);
  void finalization.then(
    () => pendingFinalizations.delete(args.controller),
    () => pendingFinalizations.delete(args.controller),
  );
  return finalization;
}
