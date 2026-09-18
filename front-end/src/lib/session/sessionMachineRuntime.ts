import type { SessionController, RestoreStatus } from '../../hooks/SessionController';
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
import type { ReliableCommitCoordinator } from '../../services/PeerSession';
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
  private readonly pendingControllerWork: Array<() => void> = [];
  private transactionActive = false;
  private committing = false;
  private dirty = false;
  private projectionPending = false;
  private commitScheduled = false;
  private commitTimer: ReturnType<typeof setTimeout> | null = null;
  private commitPromise: Promise<void> = Promise.resolve();
  private readonly persistSnapshot: (state: SessionMachineState) => Promise<void>;
  private readonly onError: (error: unknown) => void;
  private readonly commitCoordinator: ReliableCommitCoordinator;

  constructor(initial: SessionMachineState, dependencies: SessionMachineRuntimeDependencies) {
    this.state = initial;
    this.controller = dependencies.controller;
    this.onError = dependencies.onError;
    this.restoreActiveHand(initial);
    this.persistSnapshot = dependencies.persist
      ? () => dependencies.persist!()
      : (state) =>
          persistSessionSnapshot({
            controller: dependencies.controller,
            getState: () => state,
            restoring: dependencies.restoring,
            getRestoreStatus: dependencies.getRestoreStatus,
            getRestoreError: dependencies.getRestoreError,
          });
    this.interpreter = new SessionMachineInterpreter({
      controller: dependencies.controller,
      iStarted: dependencies.iStarted,
      getState: () => this.state,
      dispatch: (event) => this.dispatch(event),
      onError: dependencies.onError,
      enrichCoin: dependencies.enrichCoin,
    });
    this.commitCoordinator = {
      requestCommit: () => this.requestCommit(),
      flush: () => this.flush(),
      enqueue: (work) => this.enqueueControllerWork(work),
    };
    this.controller.attachTransactionCoordinator(this.commitCoordinator);
  }

  getState(): SessionMachineState {
    return this.state;
  }

  setRender(render: (state: SessionMachineState) => void): void {
    this.render = render;
  }

  clearRender(): void {
    this.render = () => {};
  }

  dispatch(event: SessionMachineEvent): void {
    this.pendingEvents.push(event);
    if (this.committing || this.transactionActive || this.dispatching) {
      this.scheduleCommit(false);
      return;
    }
    this.runTransaction();
  }

  private drainMachineEvents(): void {
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      while (this.pendingEvents.length > 0) {
        const next = this.prepareGameEvent(this.pendingEvents.shift()!);
        const previous = this.state;
        const transition = reduceSessionMachine(previous, next, this.activeHandContext);
        this.state = transition.state;
        if (this.state !== previous) this.dirty = true;
        for (const effect of transition.effects) {
          if (effect.type === 'clear-derived-game-presentation') {
            this.controller.clearDerivedGamePresentation();
          } else {
            this.interpreter.run(effect);
          }
        }
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
    const checkpoint = structuredClone(this.state.model.game.handState);
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
      const disposition = this.interpreter.runLocalGameCommand(request.command, request.id);
      if (disposition === 'rejected') {
        this.restoreAndProject(checkpoint);
        return;
      }
      const accepted = this.snapshotActiveHand();
      this.dispatch({
        type: 'local-game-action-committed',
        gameType: request.gameType,
        id: request.id,
        state: accepted.state,
      });
    } catch (error) {
      this.restoreAndProject(checkpoint);
      throw error;
    }
  }

  persist(): Promise<void> {
    return this.flush();
  }

  private restoreActiveHand(state: SessionMachineState): void {
    this.restoreHandFrom(state.model.game.handState);
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
      case 'local-game-action-committed':
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

  private restoreAndProject(checkpoint: ReturnType<typeof this.snapshotActiveHand> | null): void {
    this.restoreHandFrom(checkpoint);
    this.projectionPending = true;
    this.scheduleCommit(false);
  }

  private enqueueControllerWork(work: () => void): void {
    if (this.committing) {
      this.pendingControllerWork.push(work);
      return;
    }
    this.runTransaction(work);
  }

  private runTransaction(work?: () => void, requestCommit = true): void {
    if (this.transactionActive) {
      work?.();
      return;
    }
    this.transactionActive = true;
    try {
      work?.();
      for (;;) {
        this.drainMachineEvents();
        this.controller.flushDeferredWork();
        if (this.pendingEvents.length === 0) break;
      }
    } finally {
      this.transactionActive = false;
    }
    if (requestCommit) this.scheduleCommit(false);
  }

  private requestCommit(): void {
    this.scheduleCommit(true);
  }

  private scheduleCommit(markDirty: boolean): void {
    if (markDirty) this.dirty = true;
    if (!this.dirty && !this.projectionPending) return;
    if (this.committing || this.transactionActive || this.commitScheduled) return;
    this.commitScheduled = true;
    this.commitTimer = setTimeout(() => {
      this.commitTimer = null;
      this.commitScheduled = false;
      this.startCommit();
    }, 0);
    if (typeof this.commitTimer === 'object' && 'unref' in this.commitTimer) {
      this.commitTimer.unref();
    }
  }

  private startCommit(): void {
    if (this.committing || (!this.dirty && !this.projectionPending)) return;
    this.runTransaction(undefined, false);
    if (this.committing || (!this.dirty && !this.projectionPending)) return;
    const projectedState = this.state;
    if (!this.dirty) {
      this.projectionPending = false;
      try {
        this.render(projectedState);
      } catch (error) {
        this.onError(error);
      }
      return;
    }
    const reliableCommit = this.controller.prepareReliableCommit();
    this.dirty = false;
    this.projectionPending = false;
    this.committing = true;
    this.commitPromise = this.persistSnapshot(projectedState)
      .then(() => {
        this.render(projectedState);
        this.controller.completeReliableCommit(reliableCommit);
      })
      .catch((error) => {
        this.dirty = true;
        this.projectionPending = true;
        throw error;
      })
      .finally(() => {
        this.committing = false;
        if (this.pendingControllerWork.length > 0 || this.pendingEvents.length > 0) {
          const work = this.pendingControllerWork.splice(0);
          this.runTransaction(() => {
            for (const task of work) task();
          });
        } else if (this.projectionPending) {
          this.scheduleCommit(false);
        }
      });
    void this.commitPromise.catch(this.onError);
  }

  private async flush(): Promise<void> {
    if (this.commitTimer !== null) {
      clearTimeout(this.commitTimer);
      this.commitTimer = null;
      this.commitScheduled = false;
    }
    if (
      !this.committing &&
      (this.dirty || this.projectionPending || this.pendingEvents.length > 0)
    ) {
      this.startCommit();
    }
    await this.commitPromise;
    if (
      this.committing ||
      this.dirty ||
      this.projectionPending ||
      this.pendingEvents.length > 0 ||
      this.pendingControllerWork.length > 0
    ) {
      return this.flush();
    }
  }
}
