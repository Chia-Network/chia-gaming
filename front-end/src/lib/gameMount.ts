import type { ReactElement } from 'react';
import type { SessionController } from '../hooks/SessionController';
import type { UseGameSessionResult } from '../hooks/useGameSession';
import type { PersistedGameState } from './session/gameStateCodec';
import type { SessionModel } from './session/model';

export interface GameMountNames {
  myName?: string;
  opponentName?: string;
}

export type GameInteractionMode = 'live' | 'terminal';
export type GameHandOrigin = 'fresh' | 'restored' | 'terminal';

export type GameHandSource =
  | {
      readonly interactionMode: 'live';
      readonly controller: SessionController;
    }
  | {
      readonly interactionMode: 'terminal';
      readonly handState: Readonly<PersistedGameState> | null;
    };

export function terminalGameHandSource(
  handState: Readonly<PersistedGameState> | null,
): Extract<GameHandSource, { interactionMode: 'terminal' }> {
  const source = { interactionMode: 'terminal' } as Extract<
    GameHandSource,
    { interactionMode: 'terminal' }
  >;
  Object.defineProperty(source, 'handState', {
    value: handState,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return Object.freeze(source);
}

export function gameHandState(source: GameHandSource): Readonly<PersistedGameState> | null {
  return source.interactionMode === 'live' ? source.controller.handState : source.handState;
}

export function requireLiveGameHandSource(source: GameHandSource): SessionController {
  if (source.interactionMode !== 'live') {
    throw new Error('Protocol commands require a live game hand source');
  }
  return source.controller;
}

export function liveGameHandOrigin(
  restoredHandKey: number | null,
  currentHandKey: number,
): Exclude<GameHandOrigin, 'terminal'> {
  return restoredHandKey === currentHandKey ? 'restored' : 'fresh';
}

export interface FrozenGameMountOptions extends GameMountNames {
  iStarted: boolean;
}

export interface GameMountRegistration {
  renderLive(session: UseGameSessionResult, names: GameMountNames): ReactElement;
  renderFrozen(model: SessionModel, options: FrozenGameMountOptions): ReactElement;
}
