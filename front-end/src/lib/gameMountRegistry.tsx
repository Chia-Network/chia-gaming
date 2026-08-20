import type { ReactElement } from 'react';
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
import { selectIProposedHand } from './session/selectors';
import type { SessionModel } from './session/model';

export function requireLiveGameHandSource(source: GameHandSource): SessionController {
  return requireLiveController(source) as SessionController;
}

export function frozenGameViewFromModel(model: SessionModel): FrozenGameView {
  const lastTerms = model.betweenHand.lastTerms;
  if (lastTerms === null) {
    throw new Error('Frozen game view requires lastTerms');
  }
  return {
    lastDisplayedId: model.game.lastDisplayedId,
    currentHandIds: model.game.currentHandIds,
    activeIds: model.game.activeIds,
    handState: model.game.handState,
    lastTerms,
    instances: Object.fromEntries(
      Object.entries(model.game.instances).map(([id, instance]) => [
        id,
        { terminal: instance.terminal, amount: instance.amount },
      ]),
    ),
    iProposedHand: selectIProposedHand(model),
  };
}

export function renderLiveGameMount(
  session: UseGameSessionResult,
  names: GameMountNames,
): ReactElement {
  return packageFor(session.gameSpecificView.gameType).renderLive(session as LiveGameView, names);
}

export function renderFrozenGameMount(
  model: SessionModel,
  options: FrozenGameMountOptions,
): ReactElement {
  const gameType = model.game.handState?.gameType ?? model.game.activeGameType;
  if (!isCatalogGameType(gameType)) throw new Error(`Unsupported game mount: ${gameType}`);
  return packageFor(gameType).renderFrozen(frozenGameViewFromModel(model), options);
}
