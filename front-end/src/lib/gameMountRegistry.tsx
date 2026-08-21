import { cloneElement, type ReactElement } from 'react';
import {
  requireLiveGameHandSource as requireLiveController,
  type FrozenGameMountOptions,
  type FrozenGameView,
  type GameHandSource,
  type GameMountNames,
  type LiveGameView,
} from '@games/host';
import { isCatalogGameType, packageFor } from './gameRegistry';
import type { UseGameSessionResult } from '../hooks/useGameSession';
import type { SessionController } from '../hooks/SessionController';
import type { SessionModel } from './session/model';

export function requireLiveGameHandSource(source: GameHandSource): SessionController {
  return requireLiveController(source) as SessionController;
}

export function frozenGameViewFromModel(model: SessionModel): FrozenGameView {
  return {
    lastDisplayedId: model.game.lastDisplayedId,
    currentHandIds: model.game.currentHandIds,
    activeIds: model.game.activeIds,
    handState: model.game.handState,
    instances: Object.fromEntries(
      Object.entries(model.game.instances).map(([id, instance]) => [
        id,
        { terminal: instance.terminal, amount: instance.amount },
      ]),
    ),
  };
}

export function renderLiveGameMount(
  session: UseGameSessionResult,
  names: GameMountNames,
): ReactElement {
  const gameType = session.gameSpecificView.gameType;
  if (!isCatalogGameType(gameType)) throw new Error(`Unsupported game mount: ${gameType}`);
  const view: LiveGameView = {
    handOrigin: session.handOrigin,
    handSource: session.handSource,
    activeGameId: session.activeGameId,
    activeGameIds: session.activeGameIds,
    currentHandGameIds: session.currentHandGameIds,
    iStarted: session.iStarted,
    playerNumber: session.playerNumber,
    gameplayEvent$: session.gameplayEvent$,
    appendGameLog: session.appendGameLog,
    onHandOutcome: session.onHandOutcome,
    onTurnChanged: session.onTurnChanged,
    gameSpecificView: {
      gameType,
      displayGameId: session.gameSpecificView.displayGameId,
      terminal: session.gameSpecificView.terminal,
      terminalsById: session.gameSpecificView.terminalsById,
      amountsById: session.gameSpecificView.amountsById,
    },
  };
  return cloneElement(packageFor(gameType).renderLive(view, names), {
    key: session.handKey,
  });
}

export function renderFrozenGameMount(
  model: SessionModel,
  options: FrozenGameMountOptions,
): ReactElement {
  const gameType = model.game.handState?.gameType ?? model.game.activeGameType;
  if (!isCatalogGameType(gameType)) throw new Error(`Unsupported game mount: ${gameType}`);
  return cloneElement(packageFor(gameType).renderFrozen(frozenGameViewFromModel(model), options), {
    key: model.game.handKey,
  });
}
