import type { SessionController, RestoreStatus } from '../../hooks/SessionController';
import { SessionMachineInterpreter } from './sessionMachineInterpreter';
import {
  prepareSessionPersistence,
  type PreparedSessionPersistence,
  type SessionPersistDependencies,
} from './sessionMachinePersist';
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
  persist?(state: SessionMachineState): Promise<void>;
  save?: SessionPersistDependencies['save'];
  saveTerminal?: SessionPersistDependencies['saveTerminal'];
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
  private commitActivityPending = false;
  private durabilityDirty = false;
  private projectionPending = false;
  private projectionOnlyLocalRejection = false;
  private projectionOnlyDurabilityBaseline = false;
  private commitScheduled = false;
  private commitTimer: ReturnType<typeof setTimeout> | null = null;
  private commitPromise: Promise<void> = Promise.resolve();
  private readonly preparePersistence: (
    state: SessionMachineState,
  ) => PreparedSessionPersistence | null;
  private readonly onError: (error: unknown) => void;
  private readonly commitCoordinator: ReliableCommitCoordinator;

  constructor(initial: SessionMachineState, dependencies: SessionMachineRuntimeDependencies) {
    this.state = initial;
    this.controller = dependencies.controller;
    this.onError = dependencies.onError;
    this.restoreActiveHand(initial);
    this.preparePersistence = dependencies.persist
      ? (state) => ({ write: () => dependencies.persist!(state) })
      : (state) =>
          prepareSessionPersistence({
            controller: dependencies.controller,
            getState: () => state,
            restoring: dependencies.restoring,
            getRestoreStatus: dependencies.getRestoreStatus,
            getRestoreError: dependencies.getRestoreError,
            save: dependencies.save,
            saveTerminal: dependencies.saveTerminal,
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
        if (this.state !== previous) {
          if (this.projectionOnlyLocalRejection && this.isMoveRejectedEvent(next)) {
            this.durabilityDirty = this.projectionOnlyDurabilityBaseline;
            this.projectionOnlyLocalRejection = false;
          } else {
            this.durabilityDirty = true;
          }
        }
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
    const durabilityBaseline = this.durabilityDirty;
    try {
      this.runTransaction(() => {
        const game = this.state.model.game;
        if (game.activeGameType !== request.gameType) {
          throw new Error(
            `Internal local action gameType ${request.gameType} does not match active ${game.activeGameType}`,
          );
        }
        if (!game.currentHandIds.includes(request.id)) {
          throw new Error(
            `Internal local action game id ${request.id} is not a current hand member`,
          );
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
          throw new Error(
            `Internal local action for game ${request.id} attempted outside our turn`,
          );
        }
        const disposition = this.interpreter.runLocalGameCommand(request.command, request.id);
        if (disposition === 'rejected') {
          this.projectionOnlyLocalRejection = true;
          this.projectionOnlyDurabilityBaseline = durabilityBaseline;
          this.durabilityDirty = durabilityBaseline;
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
      });
      this.projectionOnlyLocalRejection = false;
    } catch (error) {
      this.projectionOnlyLocalRejection = false;
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

  private isMoveRejectedEvent(event: SessionMachineEvent): boolean {
    return (
      event.type === 'wasm-notification' &&
      'MoveRejected' in event.notification &&
      event.notification.MoveRejected != null
    );
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
        if (this.pendingEvents.length === 0 && !(this.controller.hasDeferredWork?.() ?? false))
          break;
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
    if (markDirty) this.durabilityDirty = true;
    if (!this.durabilityDirty && !this.projectionPending) return;
    if (this.committing) {
      this.commitActivityPending = true;
      return;
    }
    if (this.transactionActive || this.commitScheduled) return;
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
    if (
      this.committing ||
      this.transactionActive ||
      (!this.durabilityDirty && !this.projectionPending)
    ) {
      return;
    }
    this.runTransaction(undefined, false);
    if (
      this.committing ||
      this.transactionActive ||
      (!this.durabilityDirty && !this.projectionPending)
    ) {
      return;
    }
    const projectedState = this.state;
    if (!this.durabilityDirty) {
      this.projectionPending = false;
      try {
        this.render(projectedState);
      } catch (error) {
        this.onError(error);
      }
      return;
    }
    const reliableCommit = this.controller.prepareReliableCommit();
    const persistenceState = structuredClone(projectedState);
    const persistence =
      this.controller.prepareInboundSessionRejectPersistence?.() ??
      this.preparePersistence(persistenceState);
    this.durabilityDirty = false;
    this.projectionPending = false;
    this.committing = true;
    this.commitActivityPending = false;
    let write: Promise<void>;
    try {
      write = persistence?.write() ?? Promise.resolve();
    } catch (error) {
      write = Promise.reject(error);
    }
    this.commitPromise = write
      .then(
        () => {
          try {
            this.render(projectedState);
          } catch (error) {
            this.onError(error);
          }
          try {
            this.controller.completeReliableCommit(reliableCommit);
          } catch (error) {
            this.onError(error);
          }
        },
        (error) => {
          this.durabilityDirty = true;
          this.projectionPending = true;
          this.controller.reportDurabilityError?.(error);
          throw error;
        },
      )
      .finally(() => {
        this.committing = false;
        const activityPending = this.commitActivityPending;
        this.commitActivityPending = false;
        if (this.pendingControllerWork.length > 0 || this.pendingEvents.length > 0) {
          const work = this.pendingControllerWork.splice(0);
          this.runTransaction(() => {
            for (const task of work) task();
          });
        } else if (activityPending) {
          this.scheduleCommit(false);
        }
      });
    void this.commitPromise.catch(() => {});
  }

  private async flush(): Promise<void> {
    if (this.commitTimer !== null) {
      clearTimeout(this.commitTimer);
      this.commitTimer = null;
      this.commitScheduled = false;
    }
    if (
      !this.committing &&
      (this.durabilityDirty || this.projectionPending || this.pendingEvents.length > 0)
    ) {
      this.startCommit();
    }
    await this.commitPromise;
    if (
      this.committing ||
      this.durabilityDirty ||
      this.projectionPending ||
      this.pendingEvents.length > 0 ||
      this.pendingControllerWork.length > 0
    ) {
      return this.flush();
    }
  }
}
