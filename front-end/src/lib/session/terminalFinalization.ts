import type { CoinOfInterestEntry } from '../../types/ChiaGaming';
import type { SessionController } from '../../hooks/SessionController';
import { type SessionPresentationSave, type TerminalSessionSave } from './saveEnvelope';
import { storageRepository } from './storageRepository';
import { markSavedSession } from '../../hooks/saveCoordination';
import { destroyFlushedTerminalSessionController } from '../../hooks/blobSingleton';
import { channelStatusPayloadFromModel } from './normalization';
import { selectDashboardCoins } from './selectors';
import { snapshotFromSessionModel } from './sessionSnapshot';
import type { SessionModel } from './types';

export interface TerminalSessionIdentity {
  myName: string;
  opponentName?: string;
  iStarted: boolean;
}

export interface TerminalFinalizationDependencies {
  stageTerminal: (fields: {
    terminal: TerminalSessionSave['terminal'];
    presentation: SessionPresentationSave;
  }) => Promise<void>;
  flushSave: () => Promise<void>;
  discardTerminal: () => void;
  updateMarker: () => void;
  teardown: (controller: SessionController) => void;
}

const defaultDependencies: TerminalFinalizationDependencies = {
  stageTerminal: storageRepository.stageTerminalSession.bind(storageRepository),
  flushSave: storageRepository.flushSessionSave.bind(storageRepository),
  discardTerminal: storageRepository.discardStagedTerminalSession.bind(storageRepository),
  updateMarker: markSavedSession,
  teardown: destroyFlushedTerminalSessionController,
};

const pendingFinalizations = new WeakMap<SessionController, Promise<TerminalFinalizationResult>>();

export class TerminalSessionStorageError extends Error {
  constructor(readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'TerminalSessionStorageError';
  }
}

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
    const terminalFields = structuredClone({
      terminal: {
        iStarted: identity.iStarted,
        coinsOfInterest: coins,
        myAlias: identity.myName,
        opponentAlias: identity.opponentName ?? null,
      },
      presentation: snapshotFromSessionModel(model, {
        channelStatus: channelStatusPayloadFromModel(model.channel.status),
        waitingStateEnteredAt: null,
        cleanShutdownGraceStartedAt: null,
      }),
    });
    try {
      await dependencies.stageTerminal(terminalFields);
      await dependencies.flushSave();
    } catch (error) {
      dependencies.discardTerminal();
      throw new TerminalSessionStorageError(error);
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
