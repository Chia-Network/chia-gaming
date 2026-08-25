import type { CoinOfInterestEntry } from '../../types/ChiaGaming';
import type { SessionController } from '../../hooks/SessionController';
import {
  discardStagedTerminalSession,
  flushSessionSave,
  markSavedSession,
  stageTerminalSession,
  type SessionPresentationSave,
  type TerminalSessionSave,
} from '../../hooks/save';
import { destroyFlushedTerminalSessionController } from '../../hooks/blobSingleton';
import { channelStatusPayloadFromModel } from './normalization';
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
  stageTerminal: stageTerminalSession,
  flushSave: flushSessionSave,
  discardTerminal: discardStagedTerminalSession,
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
    model: SessionModel;
    identity: TerminalSessionIdentity;
    coins: CoinOfInterestEntry[];
  },
  dependencies: TerminalFinalizationDependencies = defaultDependencies,
): Promise<TerminalFinalizationResult> {
  const existing = pendingFinalizations.get(args.controller);
  if (existing) return existing;

  const identity = { ...args.identity };
  const coins = args.coins.map((coin) => ({ ...coin }));

  const finalization = (async () => {
    await args.controller.flushPendingSave();
    const handState = structuredClone(args.model.game.handState);
    const model: SessionModel = {
      ...args.model,
      game: { ...args.model.game, handState, pendingCandidates: {} },
    };
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
    await dependencies.stageTerminal(terminalFields);
    try {
      await dependencies.flushSave();
    } catch (error) {
      dependencies.discardTerminal();
      throw error;
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
