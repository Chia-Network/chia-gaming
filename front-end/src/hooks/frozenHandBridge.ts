import type { PersistedGameState } from './save';
import type { SessionController } from './SessionController';

/**
 * Presentation-only controller for a persisted terminal hand. It exposes the
 * saved state to feature hooks but cannot resume protocol or chain activity.
 */
export function createFrozenHandBridge(
  initialHandState: PersistedGameState | null,
): SessionController {
  let handState = initialHandState;
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
    makeMove(_gameId: string, _move: unknown) {},
    acceptSettlement(_gameId: string) {},
    cheat(_gameId: string, _moverShare: bigint) {},
    nerf() {},
  };
  return bridge as unknown as SessionController;
}
