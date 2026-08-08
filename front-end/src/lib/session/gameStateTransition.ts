import type { SessionController } from '../../hooks/SessionController';
import type { GameStateCodec } from './gameStateCodec';

export type StateUpdate<T> = T | ((current: T) => T);

export function resolveStateUpdate<T>(current: T, update: StateUpdate<T>): T {
  return typeof update === 'function' ? (update as (current: T) => T)(current) : update;
}

/**
 * Commit game-owned state before asking React to render it. The controller is
 * the durability authority; React state is only its live projection.
 */
export function commitGameStateTransition<T>(
  controller: SessionController,
  codec: GameStateCodec<T>,
  current: T,
  update: StateUpdate<T>,
  render: (next: T) => void,
): T {
  const next = resolveStateUpdate(current, update);
  controller.setHandState(codec.encode(next));
  render(next);
  return next;
}
