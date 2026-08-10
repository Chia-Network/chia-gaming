import type { SessionController, RestoreStatus } from '../../hooks/SessionController';
import { runSessionMachineTransition } from './sessionMachineEffects';
import { SessionMachineInterpreter } from './sessionMachineInterpreter';
import { persistSessionSnapshot } from './sessionMachinePersist';
import { reduceSessionMachine } from './sessionMachine';
import type { GameplayEvent } from './gameSessionEvents';
import type { SessionMachineEvent, SessionMachineState } from './sessionMachineTypes';
import type { RegisteredGameType } from './types';
import type { coinIdHex } from './gameSessionEvents';

export interface SessionMachineRuntimeDependencies {
  controller: SessionController;
  iStarted: boolean;
  restoring: boolean;
  getRestoreStatus(): RestoreStatus;
  getRestoreError(): string | null;
  emitGameplay(event: GameplayEvent): void;
  onError(error: unknown): void;
  persist?(): Promise<void>;
  enrichCoin?: typeof coinIdHex;
}

export class SessionMachineRuntime {
  private state: SessionMachineState;
  private render: (state: SessionMachineState) => void = () => {};
  private readonly interpreter: SessionMachineInterpreter;
  private readonly controller: SessionController;
  private dispatching = false;
  private readonly pendingEvents: SessionMachineEvent[] = [];

  constructor(initial: SessionMachineState, dependencies: SessionMachineRuntimeDependencies) {
    this.state = initial;
    this.controller = dependencies.controller;
    this.interpreter = new SessionMachineInterpreter({
      controller: dependencies.controller,
      iStarted: dependencies.iStarted,
      getState: () => this.state,
      dispatch: (event) => this.dispatch(event),
      persist:
        dependencies.persist ??
        (() =>
          persistSessionSnapshot({
            controller: dependencies.controller,
            getState: () => this.state,
            restoring: dependencies.restoring,
            getRestoreStatus: dependencies.getRestoreStatus,
            getRestoreError: dependencies.getRestoreError,
          })),
      emitGameplay: dependencies.emitGameplay,
      onError: dependencies.onError,
      enrichCoin: dependencies.enrichCoin,
    });
  }

  getState(): SessionMachineState {
    return this.state;
  }

  setRender(render: (state: SessionMachineState) => void): void {
    this.render = render;
  }

  dispatch(event: SessionMachineEvent): void {
    this.pendingEvents.push(event);
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      while (this.pendingEvents.length > 0) {
        const next = this.pendingEvents.shift()!;
        const transition = reduceSessionMachine(this.state, next);
        runSessionMachineTransition(transition, {
          setAuthority: (state) => {
            this.state = state;
          },
          getAuthority: () => this.state,
          controller: {
            setHandState: (state) => this.controller.setHandState(state),
            clearDerivedGamePresentation: () => this.controller.clearDerivedGamePresentation(),
          },
          runCommand: (effect) => this.interpreter.run(effect),
          render: this.render,
        });
      }
    } catch (error) {
      this.pendingEvents.length = 0;
      throw error;
    } finally {
      this.dispatching = false;
    }
  }

  transitionFeatureState(gameType: RegisteredGameType, id: string, state: unknown): boolean {
    const game = this.state.model.game;
    if (game.activeGameType !== gameType || !game.currentHandIds.includes(id)) return false;
    this.dispatch({ type: 'feature-state', gameType, id, state });
    return true;
  }

  persist(): Promise<void> {
    return persistSessionSnapshot({
      controller: this.controller,
      getState: () => this.state,
      restoring: this.state.model.restore.restoring,
      getRestoreStatus: () => this.controller.getRestoreStatus(),
      getRestoreError: () => this.controller.getRestoreError(),
    });
  }

  dispose(): void {
    this.interpreter.dispose();
  }
}
