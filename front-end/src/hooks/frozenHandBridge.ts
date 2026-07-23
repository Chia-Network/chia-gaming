import type { OpaqueHandState } from './save';
import type { SessionController } from './SessionController';

/**
 * Minimal stand-in for SessionController after WASM teardown.
 * Enough for game hooks to hydrate from handState and no-op moves.
 */
export function createFrozenHandBridge(
  initialHandState: OpaqueHandState | null,
  onHandStateChange?: (state: OpaqueHandState | null) => void,
): SessionController {
  let handState: OpaqueHandState | null = initialHandState;
  const bridge = {
    get handState() {
      return handState;
    },
    set handState(next: OpaqueHandState | null) {
      handState = next;
      onHandStateChange?.(next);
    },
    setHandState(next: OpaqueHandState | null) {
      handState = next;
      onHandStateChange?.(next);
    },
    isChannelReady() {
      return false;
    },
    makeMove(_gameId: string, _move: unknown) {
      // Frozen: ignore autofire / stray UI actions.
    },
    acceptSettlement(_gameId: string) {},
    cheat(_gameId: string, _moverShare: bigint) {},
  };
  return bridge as unknown as SessionController;
}
