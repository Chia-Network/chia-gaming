import type { SessionController, RestoreStatus } from '../../hooks/SessionController';
import { runSessionMachineTransition } from './sessionMachineEffects';
import { SessionMachineInterpreter } from './sessionMachineInterpreter';
import { persistSessionSnapshot } from './sessionMachinePersist';
import { reduceSessionMachine } from './sessionMachine';
import type { GameplayEvent } from '@games/host';
import type {
  LocalGameActionRequest,
  SessionMachineEvent,
  SessionMachineState,
} from './sessionMachineTypes';
import type { RegisteredGameType } from './types';
import type { coinIdHex } from './gameSessionEvents';
import { decodeGameFeatureState } from '../gameRegistry';

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
  private readonly stopHandStateProjection: () => void;
  private dispatching = false;
  private readonly pendingEvents: SessionMachineEvent[] = [];

  constructor(initial: SessionMachineState, dependencies: SessionMachineRuntimeDependencies) {
    this.state = initial;
    this.controller = dependencies.controller;
    this.stopHandStateProjection = this.controller.projectHandState(
      () => this.state.model.game.handState,
    );
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

  transitionFeatureStateWithLocalTurn(
    gameType: RegisteredGameType,
    id: string,
    state: unknown,
    isMyTurn: boolean,
  ): boolean {
    const game = this.state.model.game;
    if (game.activeGameType !== gameType || !game.currentHandIds.includes(id)) return false;
    this.dispatch({ type: 'feature-state-with-local-turn', gameType, id, state, isMyTurn });
    return true;
  }

  commitLocalGameAction(request: LocalGameActionRequest): void {
    const game = this.state.model.game;
    if (game.activeGameType !== request.gameType) {
      throw new Error(
        `Internal local action gameType ${request.gameType} does not match active ${game.activeGameType}`,
      );
    }
    if (!game.currentHandIds.includes(request.id)) {
      throw new Error(`Internal local action game id ${request.id} is not a current hand member`);
    }
    if (!game.activeIds.includes(request.id)) {
      throw new Error(`Internal local action game id ${request.id} is not active`);
    }
    const instance = game.instances[request.id];
    if (!instance) {
      throw new Error(`Internal local action game id ${request.id} has no game instance`);
    }
    if (
      instance.presentation !== 'off-chain-my-turn' &&
      instance.presentation !== 'on-chain-my-turn'
    ) {
      throw new Error(`Internal local action for game ${request.id} attempted outside our turn`);
    }
    if (decodeGameFeatureState(request.gameType, request.state) === null) {
      throw new Error(`Internal local action payload is invalid for ${request.gameType}`);
    }

    this.interpreter.runLocalGameCommand(request.command, request.id);
    this.dispatch({
      type: 'local-game-action-committed',
      gameType: request.gameType,
      id: request.id,
      state: request.state,
    });
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
    this.stopHandStateProjection();
    this.interpreter.dispose();
  }
}
