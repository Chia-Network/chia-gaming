import type {
  SessionMachineEffect,
  SessionMachineState,
  SessionMachineTransition,
} from './sessionMachineTypes';

export interface SessionMachineEffectController {
  setHandState(state: SessionMachineState['model']['game']['handState']): void;
  clearDerivedGamePresentation(): void;
}

export interface SessionMachineEffectRunner {
  setAuthority(state: SessionMachineState): void;
  getAuthority(): SessionMachineState;
  controller: SessionMachineEffectController;
  runCommand(
    effect: Exclude<
      SessionMachineEffect,
      | { type: 'set-hand-state' }
      | {
          type: 'clear-derived-game-presentation';
        }
    >,
  ): void;
  render(state: SessionMachineState): void;
}

/**
 * Applies an already-reduced transition. Reduction is pure; once authority is
 * advanced there is no rollback fiction if an effect throws.
 *
 * Ordering is strict:
 * 1. publish the next synchronous dispatch authority;
 * 2. commit controller-owned durable payload state;
 * 3. run remaining controller/protocol commands in reducer order;
 * 4. schedule React's projection.
 */
export function runSessionMachineTransition(
  transition: SessionMachineTransition,
  runner: SessionMachineEffectRunner,
): void {
  runner.setAuthority(transition.state);
  try {
    for (const effect of transition.effects) {
      if (effect.type === 'set-hand-state') {
        runner.controller.setHandState(effect.state);
      } else if (effect.type === 'clear-derived-game-presentation') {
        runner.controller.clearDerivedGamePresentation();
      }
    }
    for (const effect of transition.effects) {
      if (effect.type !== 'set-hand-state' && effect.type !== 'clear-derived-game-presentation') {
        runner.runCommand(effect);
      }
    }
  } finally {
    runner.render(runner.getAuthority());
  }
}
