import type { PersistedGameState } from './save';
import type { SessionController } from './SessionController';

/**
 * Minimal stand-in for SessionController after WASM teardown.
 * Enough for game hooks to hydrate from handState and no-op moves.
 */
export function createFrozenHandBridge(
  initialHandState: PersistedGameState | null,
): SessionController {
  let handState: PersistedGameState | null = initialHandState;
  const bridge = {
    get handState() {
      return handState;
    },
    set handState(next: PersistedGameState | null) {
      handState = next;
    },
    setHandState(next: PersistedGameState | null) {
      handState = next;
    },
    isChannelReady() {
      return false;
    },
    makeMove(_gameId: string, _move: unknown) {
      // Frozen: ignore autofire / stray UI actions.
    },
    acceptSettlement(_gameId: string) {},
    cheat(_gameId: string, _moverShare: bigint) {},
    nerf() {},
  };
  return bridge as unknown as SessionController;
}
