import type { GameHandOrigin, GameHandSource, GameHandState } from '@games/host';

export function terminalGameHandSource<TState>(
  hand: GameHandState<TState> | null,
): Extract<GameHandSource<TState>, { interactionMode: 'terminal' }> {
  return Object.freeze({ interactionMode: 'terminal', hand });
}

export function liveGameHandOrigin(
  restoredHandKey: number | null,
  currentHandKey: number,
): Exclude<GameHandOrigin, 'terminal'> {
  return restoredHandKey === currentHandKey ? 'restored' : 'fresh';
}
