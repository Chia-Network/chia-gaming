import type { ReactElement } from 'react';
import type { SessionController } from '../hooks/SessionController';
import type { UseGameSessionResult } from '../hooks/useGameSession';
import type { SessionModel } from './session/model';

export interface GameMountNames {
  myName?: string;
  opponentName?: string;
}

export type GameInteractionMode = 'live' | 'terminal';
export type GameHandOrigin = 'fresh' | 'restored' | 'terminal';

export function liveGameHandOrigin(
  restoredHandKey: number | null,
  currentHandKey: number,
): Exclude<GameHandOrigin, 'terminal'> {
  return restoredHandKey === currentHandKey ? 'restored' : 'fresh';
}

export interface FrozenGameMountOptions extends GameMountNames {
  iStarted: boolean;
  iProposedHand: boolean;
}

export interface GameMountRegistration {
  renderLive(session: UseGameSessionResult, names: GameMountNames): ReactElement;
  renderFrozen(
    model: SessionModel,
    gameObject: SessionController,
    options: FrozenGameMountOptions,
  ): ReactElement;
}
