import type { ReactElement } from 'react';
import { calpokerMountRegistration } from '../features/calPoker/LiveMount';
import { krunkMountRegistration } from '../features/krunk/LiveMount';
import { spacepokerMountRegistration } from '../features/spacePoker/LiveMount';
import type { UseGameSessionResult } from '../hooks/useGameSession';
import type { SessionController } from '../hooks/SessionController';
import type { FrozenGameMountOptions, GameMountNames, GameMountRegistration } from './gameMount';
import type { SessionModel } from './session/model';
import type { RegisteredGameType } from './session/types';

export const GAME_MOUNTS = {
  calpoker: calpokerMountRegistration,
  spacepoker: spacepokerMountRegistration,
  krunk: krunkMountRegistration,
} satisfies Record<RegisteredGameType, GameMountRegistration>;

export function hasGameMount(gameType: string): gameType is RegisteredGameType {
  return Object.hasOwn(GAME_MOUNTS, gameType);
}

export function renderLiveGameMount(
  session: UseGameSessionResult,
  names: GameMountNames,
): ReactElement {
  return GAME_MOUNTS[session.gameSpecificView.gameType].renderLive(session, names);
}

export function renderFrozenGameMount(
  model: SessionModel,
  gameObject: SessionController,
  options: FrozenGameMountOptions,
): ReactElement {
  const gameType = model.game.handState?.gameType ?? model.game.activeGameType;
  if (!hasGameMount(gameType)) throw new Error(`Unsupported game mount: ${gameType}`);
  return GAME_MOUNTS[gameType].renderFrozen(model, gameObject, options);
}
