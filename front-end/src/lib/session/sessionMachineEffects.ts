import type {
  SessionMachineEffect,
  SessionMachineState,
  SessionMachineTransition,
} from './sessionMachineTypes';

export interface SessionMachineEffectController {
  clearDerivedGamePresentation(): void;
}

export interface SessionMachineEffectRunner {
  setAuthority(state: SessionMachineState): void;
  getAuthority(): SessionMachineState;
  controller: SessionMachineEffectController;
  runCommand(
    effect: Exclude<SessionMachineEffect, { type: 'clear-derived-game-presentation' }>,
  ): void;
  render(state: SessionMachineState): void;
}

/**
 * Applies an already-reduced transition. Reduction is pure; once authority is
 * advanced there is no rollback fiction if an effect throws.
 *
 * Ordering is strict:
 * 1. publish the next synchronous dispatch authority;
 * 2. run controller/protocol commands and persistence in reducer order;
 * 3. schedule React's projection.
 */
export function runSessionMachineTransition(
  transition: SessionMachineTransition,
  runner: SessionMachineEffectRunner,
): void {
  runner.setAuthority(transition.state);
  try {
    for (const effect of transition.effects) {
      if (effect.type === 'clear-derived-game-presentation') {
        runner.controller.clearDerivedGamePresentation();
      } else {
        runner.runCommand(effect);
      }
    }
  } finally {
    runner.render(runner.getAuthority());
  }
}
