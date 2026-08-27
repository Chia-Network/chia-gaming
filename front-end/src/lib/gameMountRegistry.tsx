import { cloneElement, type ReactElement } from 'react';
import { type GameHandState, type GameMountNames, type GameMountView } from '@games/host';
import { isCatalogGameType, packageFor, restoreRegisteredGameHand } from './gameRegistry';
import type { UseGameSessionResult } from '../hooks/useGameSession';
import type { SessionModel } from './session/model';

export type FrozenGameMountOptions = GameMountNames;

export function renderLiveGameMount(
  session: UseGameSessionResult,
  names: GameMountNames,
): ReactElement {
  const gameType = session.gameSpecificView.gameType;
  if (!isCatalogGameType(gameType)) throw new Error(`Unsupported game mount: ${gameType}`);
  if (session.handSource.hand === null) {
    throw new Error('Cannot mount a game before its hand instance exists');
  }
  const common = {
    hand: session.handSource.hand,
    ...names,
  };
  const view: GameMountView<GameHandState<unknown>> = session.handSource.frozen
    ? { ...common, frozen: true }
    : {
        ...common,
        frozen: false,
        port: session.handSource.port,
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
  const hand = restoreRegisteredGameHand(model);
  if (hand === null) throw new Error('Cannot mount a frozen game without saved hand state');
  const view: GameMountView<GameHandState<unknown>> = {
    frozen: true,
    hand,
    myName: options.myName,
    opponentName: options.opponentName,
  };
  return cloneElement(packageFor(gameType).render(view), {
    key: model.game.handKey,
  });
}
