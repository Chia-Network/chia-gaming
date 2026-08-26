import type { GameHandOrigin, GameHandState, LiveGamePort } from '@games/host';

export type GameHandSource<TState = unknown> =
  | {
      readonly frozen: false;
      readonly hand: GameHandState<TState> | null;
      readonly port: LiveGamePort;
    }
  | {
      readonly frozen: true;
      readonly hand: GameHandState<TState> | null;
    };

export function terminalGameHandSource<TState>(
  hand: GameHandState<TState> | null,
): Extract<GameHandSource<TState>, { frozen: true }> {
  return Object.freeze({ frozen: true, hand });
}

export function liveGameHandOrigin(
  restoredHandKey: number | null,
  currentHandKey: number,
): Exclude<GameHandOrigin, 'terminal'> {
  return restoredHandKey === currentHandKey ? 'restored' : 'fresh';
}
