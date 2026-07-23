import type { SessionModel } from './model';

/**
 * Keep persisted bigint payloads out of React's enumerable prop inspection.
 * The session shell deliberately does not inspect the game-owned payload.
 */
export function sessionModelForReactProps(model: SessionModel): SessionModel {
  const game = { ...model.game };
  const handState = game.handState;
  delete (game as { handState?: unknown }).handState;
  Object.defineProperty(game, 'handState', {
    value: handState,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return { ...model, game };
}

export interface FinishedSessionDisplay {
  terminalLabel: string | null;
  canRemountHand: boolean;
}

/** Shell-only decision: a validated feature mount receives the opaque payload. */
export function selectFinishedSessionDisplay(model: SessionModel): FinishedSessionDisplay {
  return {
    terminalLabel: model.game.terminal.label,
    canRemountHand: model.game.handState != null,
  };
}
