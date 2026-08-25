import type { SessionController, RestoreStatus } from '../../hooks/SessionController';
import { runSessionMachineTransition } from './sessionMachineEffects';
import { SessionMachineInterpreter } from './sessionMachineInterpreter';
import { persistSessionSnapshot } from './sessionMachinePersist';
import { reduceSessionMachine } from './sessionMachine';
import type { ActiveGameHandContext } from './sessionMachineGame';
import type {
  LocalGameActionRequest,
  SessionMachineEvent,
  SessionMachineState,
} from './sessionMachineTypes';
import type { RegisteredGameType } from './types';
import type { coinIdHex } from './gameSessionEvents';
import {
  packageFor,
  restoreRegisteredGameHandState,
  snapshotRegisteredGameHand,
  type RegisteredGameHand,
} from '../gameRegistry';

export interface SessionMachineRuntimeDependencies {
  controller: SessionController;
  iStarted: boolean;
  restoring: boolean;
  getRestoreStatus(): RestoreStatus;
  getRestoreError(): string | null;
  onError(error: unknown): void;
  persist?(): Promise<void>;
  enrichCoin?: typeof coinIdHex;
}

export class SessionMachineRuntime {
  private state: SessionMachineState;
  private render: (state: SessionMachineState) => void = () => {};
  private readonly interpreter: SessionMachineInterpreter;
  private readonly controller: SessionController;
  private activeHand: RegisteredGameHand | null = null;
  private activeHandGameType: RegisteredGameType | null = null;
  private readonly activeHandContext: ActiveGameHandContext = {
    create: (gameType, init) => {
      this.activeHand = packageFor(gameType).createHand(init);
      this.activeHandGameType = gameType;
      return this.snapshotActiveHand();
    },
    receive: (update) => {
      this.requireActiveHand().receive(update);
      return this.snapshotActiveHand();
    },
    restore: (checkpoint) => {
      this.restoreHandFrom(checkpoint);
    },
    clear: () => {
      this.activeHand = null;
      this.activeHandGameType = null;
    },
  };
  private dispatching = false;
  private readonly pendingEvents: SessionMachineEvent[] = [];

  constructor(initial: SessionMachineState, dependencies: SessionMachineRuntimeDependencies) {
    this.state = initial;
    this.controller = dependencies.controller;
    this.restoreActiveHand(initial);
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
        const next = this.prepareGameEvent(this.pendingEvents.shift()!);
        const transition = reduceSessionMachine(this.state, next, this.activeHandContext);
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

  getGameHand(): RegisteredGameHand | null {
    return this.activeHand;
  }

  commitHandStateChanged(gameType: RegisteredGameType): void {
    const game = this.state.model.game;
    if (game.activeGameType !== gameType) {
      throw new Error(
        `Internal hand state gameType ${gameType} does not match active ${game.activeGameType}`,
      );
    }
    const state = this.requireActiveHand().getState();
    this.dispatch({ type: 'hand-state-changed', gameType, state });
  }

  commitLocalGameAction(request: LocalGameActionRequest): void {
    const checkpoint = this.state.model.game.handState;
    try {
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
      if (game.pendingCandidates[request.id]) {
        throw new Error(`Internal local action game ${request.id} already has a pending candidate`);
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
      const action =
        request.command.type === 'make-move'
          ? 'make_move'
          : request.command.type === 'accept-settlement'
            ? 'accept_settlement'
            : 'cheat';
      const disposition = this.interpreter.runLocalGameCommand(request.command, request.id);
      if (disposition === 'rejected') {
        this.restoreAndRender(checkpoint);
        return;
      }
      const candidate = this.snapshotActiveHand();
      this.dispatch({
        type: disposition === 'applied' ? 'local-game-action-applied' : 'local-game-action-staged',
        gameType: request.gameType,
        id: request.id,
        action,
        state: candidate.state,
      });
    } catch (error) {
      this.restoreAndRender(checkpoint);
      throw error;
    }
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

  private restoreActiveHand(state: SessionMachineState): void {
    const game = state.model.game;
    const pending = game.currentHandIds
      .map((gameId) => game.pendingCandidates[gameId])
      .find((candidate) => candidate !== undefined);
    const saved = pending ? { gameType: pending.gameType, state: pending.state } : game.handState;
    this.restoreHandFrom(saved);
  }

  private requireActiveHand(): RegisteredGameHand {
    if (this.activeHand === null || this.activeHandGameType === null) {
      throw new Error('Game update requires an active hand instance');
    }
    return this.activeHand;
  }

  private snapshotActiveHand() {
    return snapshotRegisteredGameHand(this.activeHandGameType!, this.requireActiveHand());
  }

  private prepareGameEvent(event: SessionMachineEvent): SessionMachineEvent {
    switch (event.type) {
      case 'hand-state-changed':
      case 'local-game-action-staged':
      case 'local-game-action-applied':
        return { ...event, handState: this.snapshotActiveHand() } as SessionMachineEvent;
      default:
        return event;
    }
  }

  private restoreHandFrom(checkpoint: ReturnType<typeof this.snapshotActiveHand> | null): void {
    if (checkpoint === null) {
      this.activeHand = null;
      this.activeHandGameType = null;
      return;
    }
    const gameType = checkpoint.gameType as RegisteredGameType;
    this.activeHand = restoreRegisteredGameHandState(gameType, checkpoint);
    this.activeHandGameType = gameType;
  }

  private restoreAndRender(checkpoint: ReturnType<typeof this.snapshotActiveHand> | null): void {
    this.restoreHandFrom(checkpoint);
    this.render({ ...this.state });
  }
}
