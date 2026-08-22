import { cloneElement, type ReactElement } from 'react';
import {
  type FrozenGameMountOptions,
  type GameMountNames,
  type GameMountView,
  requireLiveGameHandSource,
} from '@games/host';
import { isCatalogGameType, packageFor } from './gameRegistry';
import type { UseGameSessionResult } from '../hooks/useGameSession';
import type { SessionModel } from './session/model';

function gameInstances(model: SessionModel): GameMountView['instances'] {
  return Object.fromEntries(
    Object.entries(model.game.instances).map(([id, instance]) => [
      id,
      { terminal: instance.terminal, amount: instance.amount },
    ]),
  );
}

export function gameCanActById(model: SessionModel): GameMountView['canActById'] {
  return Object.fromEntries(
    Object.entries(model.game.instances).map(([id, instance]) => [
      id,
      !model.game.pendingCandidates[id] &&
        (instance.presentation === 'off-chain-my-turn' ||
          instance.presentation === 'on-chain-my-turn'),
    ]),
  );
}

export function renderLiveGameMount(
  session: UseGameSessionResult,
  names: GameMountNames,
): ReactElement {
  const gameType = session.gameSpecificView.gameType;
  if (!isCatalogGameType(gameType)) throw new Error(`Unsupported game mount: ${gameType}`);
  const common = {
    handOrigin: session.handOrigin,
    handState: session.handSource.handState,
    lastDisplayedId: session.sessionModel.game.lastDisplayedId,
    activeIds: session.sessionModel.game.activeIds,
    currentHandIds: session.sessionModel.game.currentHandIds,
    canActById: gameCanActById(session.sessionModel),
    iStarted: session.iStarted,
    playerNumber: session.playerNumber,
    instances: gameInstances(session.sessionModel),
    ...names,
  };
  const view: GameMountView =
    session.handSource.interactionMode === 'terminal'
      ? { ...common, frozen: true }
      : {
          ...common,
          frozen: false,
          port: requireLiveGameHandSource(session.handSource),
          appendGameLog: session.appendGameLog,
        };
  return cloneElement(packageFor(gameType).render(view), {
    key: session.handKey,
  });
}

export function renderFrozenGameMount(
  model: SessionModel,
  options: FrozenGameMountOptions,
): ReactElement {
  const gameType = model.game.handState?.gameType ?? model.game.activeGameType;
  if (!isCatalogGameType(gameType)) throw new Error(`Unsupported game mount: ${gameType}`);
  const view: GameMountView = {
    frozen: true,
    handOrigin: 'terminal',
    handState: model.game.handState,
    lastDisplayedId: model.game.lastDisplayedId,
    currentHandIds: model.game.currentHandIds,
    activeIds: model.game.activeIds,
    canActById: gameCanActById(model),
    instances: gameInstances(model),
    iStarted: options.iStarted,
    playerNumber: options.iStarted ? 1 : 2,
    myName: options.myName,
    opponentName: options.opponentName,
  };
  return cloneElement(packageFor(gameType).render(view), {
    key: model.game.handKey,
  });
}
