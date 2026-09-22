import type { SessionController, RestoreStatus } from '../../hooks/SessionController';
import { log } from '../../services/log';
import type { ReliableCommitCoordinator } from '../../services/PeerSession';
import type { WasmEvent } from '../../types/ChiaGaming';
import { dispatchWasmNotification } from './gameSessionEvents';
import { SessionMachineInterpreter } from './sessionMachineInterpreter';
import { buildDurableApplicationState } from './sessionMachinePersist';
import { reduceSessionMachine } from './sessionMachine';
import { storageRepository } from './storageRepository';
import type { ActiveGameHandContext } from './sessionMachineGame';
import type {
  LocalGameActionRequest,
  SessionMachineEvent,
  SessionMachineState,
} from './sessionMachineTypes';
import type { RegisteredGameType } from './types';
import type { coinIdHex } from './gameSessionEvents';
import { StorageAuthorityLostError } from './indexedDb';
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
  bindControllerEvents?: boolean;
  persist?(state: SessionMachineState): Promise<void>;
  enrichCoin?: typeof coinIdHex;
}

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
}

interface ResultDeferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

type PendingControllerWork =
  | { readonly kind: 'fire-and-forget'; readonly run: () => void }
  | {
      readonly kind: 'result';
      readonly run: () => void;
      readonly reject: (error: unknown) => void;
    };

interface PendingExternalEffect {
  readonly launcher: () => Promise<void>;
  readonly deferred: Deferred;
}

export class SessionRuntimeRetiredError extends Error {
  readonly code = 'SESSION_RUNTIME_RETIRED';

  constructor() {
    super('Session runtime was retired before queued work could start');
    this.name = 'SessionRuntimeRetiredError';
  }
}

function createDeferred(): Deferred {
  let resolvePromise!: () => void;
  let rejectPromise!: (error: unknown) => void;
  let settled = false;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  void promise.catch(() => {});
  return {
    promise,
    resolve: () => {
      if (settled) return;
      settled = true;
      resolvePromise();
    },
    reject: (error) => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    },
  };
}

function createResultDeferred<T>(): ResultDeferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  void promise.catch(() => {});
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

export class SessionMachineRuntime implements ReliableCommitCoordinator {
  private state: SessionMachineState;
  private render: (state: SessionMachineState) => void = () => {};
  private readonly interpreter: SessionMachineInterpreter;
  private readonly controller: SessionController;
  private readonly iStarted: boolean;
  private readonly restoring: boolean;
  private readonly getRestoreStatus: () => RestoreStatus;
  private readonly getRestoreError: () => string | null;
  private readonly bindControllerEvents: boolean;
  private controllerEventsUnsubscribe: (() => void) | null = null;
  private restoreStatusUnsubscribe: (() => void) | null = null;
  private activeHand: RegisteredGameHand | null = null;
  private readonly activeHandContext: ActiveGameHandContext = {
    create: (gameType, init) => {
      this.activeHand = packageFor(gameType).createHand(init);
      return snapshotRegisteredGameHand(gameType, this.activeHand);
    },
    receive: (update) => {
      this.requireActiveHand().receive(update);
      return this.snapshotActiveHand();
    },
    clear: () => {
      this.activeHand = null;
    },
  };
  private draining = false;
  private readonly pendingEvents: SessionMachineEvent[] = [];
  private readonly pendingControllerWork: PendingControllerWork[] = [];
  private readonly pendingExternalEffects = new Map<string, PendingExternalEffect>();
  private committing = false;
  private durabilityDirty = false;
  private durabilityDegraded = false;
  private projectionPending = false;
  private commitTimer: ReturnType<typeof setTimeout> | null = null;
  private commitPromise: Promise<void> = Promise.resolve();
  private readonly persistOverride?: (state: SessionMachineState) => Promise<void>;
  private readonly onError: (error: unknown) => void;
  private detachStorageRuntime: (() => void) | null = null;
  private activated = false;
  private retired = false;

  constructor(initial: SessionMachineState, dependencies: SessionMachineRuntimeDependencies) {
    this.state = initial;
    this.controller = dependencies.controller;
    this.iStarted = dependencies.iStarted;
    this.restoring = dependencies.restoring;
    this.getRestoreStatus = dependencies.getRestoreStatus;
    this.getRestoreError = dependencies.getRestoreError;
    this.bindControllerEvents = dependencies.bindControllerEvents ?? false;
    this.onError = dependencies.onError;
    this.restoreHandFrom(initial.model.game.handState);
    this.persistOverride = dependencies.persist;
    this.interpreter = new SessionMachineInterpreter({
      controller: dependencies.controller,
      iStarted: dependencies.iStarted,
      getState: () => this.state,
      dispatch: (event) => this.dispatch(event),
      onError: dependencies.onError,
      enrichCoin: dependencies.enrichCoin,
    });
  }

  getState(): SessionMachineState {
    return this.state;
  }

  snapshotModel(): SessionMachineState['model'] {
    return structuredClone(this.state.model);
  }

  activate(): void {
    if (this.activated || this.retired) return;
    this.activated = true;
    this.controller.commitSessionRuntime(this);
    if (!this.retired) this.detachStorageRuntime = storageRepository.attachRuntime(this);
    if (this.retired || !this.bindControllerEvents) return;
    const subscription = this.controller.getObservable().subscribe({
      next: (event: WasmEvent) => this.dispatchControllerEvent(event),
    });
    this.controllerEventsUnsubscribe = () => subscription.unsubscribe();
    this.restoreStatusUnsubscribe = this.controller.onRestoreStatusChange(() => {
      this.dispatchHostProjection();
    });
  }

  setRender(render: (state: SessionMachineState) => void): void {
    this.render = render;
  }

  clearRender(): void {
    this.render = () => {};
  }

  retire(): void {
    if (this.retired) return;
    this.retired = true;
    if (this.commitTimer !== null) {
      clearTimeout(this.commitTimer);
      this.commitTimer = null;
    }
    const error = new SessionRuntimeRetiredError();
    for (const work of this.pendingControllerWork.splice(0)) {
      if (work.kind === 'result') work.reject(error);
    }
    for (const effect of this.pendingExternalEffects.values()) {
      effect.deferred.reject(error);
    }
    this.pendingExternalEffects.clear();
    this.pendingEvents.length = 0;
    this.controllerEventsUnsubscribe?.();
    this.controllerEventsUnsubscribe = null;
    this.restoreStatusUnsubscribe?.();
    this.restoreStatusUnsubscribe = null;
    this.detachStorageRuntime?.();
    this.detachStorageRuntime = null;
  }

  private dispatchControllerEvent(event: WasmEvent): void {
    switch (event.type) {
      case 'notification':
        dispatchWasmNotification(
          event.data,
          (notification) =>
            this.dispatch({
              type: 'wasm-notification',
              notification,
              iStarted: this.iStarted,
            }),
          (error) =>
            this.dispatch({ type: 'enqueue-error', kind: 'infra-error', message: String(error) }),
        );
        this.dispatchHostProjection();
        break;
      case 'error':
        this.dispatch({ type: 'enqueue-error', kind: 'infra-error', message: event.error });
        break;
      case 'game-action-error':
        this.dispatch({ type: 'enqueue-error', kind: 'action-failed', message: event.error });
        break;
      case 'durability-error':
        this.dispatch({ type: 'enqueue-error', kind: 'durability-error', message: event.error });
        break;
      case 'recoverable-internal-error':
        this.dispatch({
          type: 'enqueue-error',
          kind: 'recoverable-internal-error',
          message: event.error,
        });
        this.dispatchHostProjection();
        break;
      case 'log':
        log(`[wasm] ${event.message}`);
        this.dispatchHostProjection();
        break;
      case 'address':
        break;
    }
  }

  private dispatchHostProjection(): void {
    const status = this.controller.getRestoreStatus();
    this.dispatch({
      type: 'host-projection',
      restore: {
        restoring: this.restoring,
        status,
        error: this.controller.getRestoreError(),
      },
      wasmNotificationHistory: this.controller.wasmNotificationHistory,
      diagnosticLog: this.controller.diagnosticLog,
    });
  }

  private isDurabilityProjection(event: SessionMachineEvent): boolean {
    return (
      (event.type === 'enqueue-error' && event.kind === 'durability-error') ||
      ((event.type === 'dismiss-channel' || event.type === 'dismiss-channel-notification') &&
        this.state.model.channel.queue[0]?.kind === 'durability-error')
    );
  }

  dispatch(event: SessionMachineEvent): void {
    if (this.retired) return;
    const durabilityProjection = this.isDurabilityProjection(event);
    this.pendingEvents.push(event);
    if (this.committing && durabilityProjection) {
      return;
    }
    if (this.committing) return;
    if (this.draining) return;
    this.runTransaction(undefined, !durabilityProjection);
    if (durabilityProjection && this.projectionPending) {
      this.projectionPending = false;
      try {
        this.render(this.state);
      } catch (error) {
        this.onError(error);
      }
    }
  }

  private drainMachineEvents(): void {
    while (this.pendingEvents.length > 0) {
      const next = this.pendingEvents.shift()!;
      const previous = this.state;
      const transition = reduceSessionMachine(previous, next, this.activeHandContext);
      this.state = transition.state;
      if (this.state !== previous) {
        this.projectionPending = true;
        if (transition.durability === 'durable') this.durabilityDirty = true;
      }
      for (const effect of transition.effects) {
        this.interpreter.run(effect);
      }
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
    this.dispatch({ type: 'hand-state-changed', handState: this.snapshotActiveHand() });
  }

  commitLocalGameAction(request: LocalGameActionRequest): void {
    const checkpoint = structuredClone(this.state.model.game.handState);
    const stateCheckpoint = this.state;
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
          this.restoreAndProject(checkpoint, stateCheckpoint);
          return;
        }
        this.dispatch({
          type: 'local-game-action-committed',
          id: request.id,
          handState: this.snapshotActiveHand(),
        });
      });
    } catch (error) {
      this.restoreAndProject(checkpoint, stateCheckpoint);
      throw error;
    }
  }

  persist(): Promise<void> {
    return this.flush();
  }

  private requireActiveHand(): RegisteredGameHand {
    if (this.activeHand === null) {
      throw new Error('Game update requires an active hand instance');
    }
    return this.activeHand;
  }

  private snapshotActiveHand() {
    return snapshotRegisteredGameHand(
      this.state.model.game.activeGameType,
      this.requireActiveHand(),
    );
  }

  private restoreHandFrom(checkpoint: ReturnType<typeof this.snapshotActiveHand> | null): void {
    if (checkpoint === null) {
      this.activeHand = null;
      return;
    }
    const gameType = checkpoint.gameType as RegisteredGameType;
    this.activeHand = restoreRegisteredGameHandState(gameType, checkpoint);
  }

  private restoreAndProject(
    checkpoint: ReturnType<typeof this.snapshotActiveHand> | null,
    stateCheckpoint: SessionMachineState,
  ): void {
    this.restoreHandFrom(checkpoint);
    this.state = stateCheckpoint;
    this.projectionPending = true;
    this.scheduleCommit(false);
  }

  enqueue(work: () => void): void {
    if (this.retired) return;
    if (this.committing) {
      this.pendingControllerWork.push({ kind: 'fire-and-forget', run: work });
      return;
    }
    this.runTransaction(work);
  }

  enqueueResult<T>(work: () => T): Promise<T> {
    const deferred = createResultDeferred<T>();
    if (this.retired) {
      deferred.reject(new SessionRuntimeRetiredError());
      return deferred.promise;
    }
    const run = () => {
      try {
        deferred.resolve(work());
      } catch (error) {
        deferred.reject(error);
      }
    };
    if (this.committing) {
      this.pendingControllerWork.push({ kind: 'result', run, reject: deferred.reject });
    } else {
      this.runTransaction(run);
    }
    return deferred.promise;
  }

  releaseAfterPersistence(key: string, launcher: () => Promise<void>): Promise<void> {
    if (this.retired) {
      const deferred = createDeferred();
      deferred.reject(new SessionRuntimeRetiredError());
      return deferred.promise;
    }
    const pending = this.pendingExternalEffects.get(key);
    if (pending) return pending.deferred.promise;
    const effect = { launcher, deferred: createDeferred() };
    this.pendingExternalEffects.set(key, effect);
    this.scheduleCommit(true);
    return effect.deferred.promise;
  }

  private runTransaction(work?: () => void, requestCommit = true): void {
    if (this.retired) return;
    if (this.draining) {
      work?.();
      return;
    }
    this.draining = true;
    try {
      work?.();
      for (;;) {
        this.drainMachineEvents();
        this.controller.flushDeferredWork();
        if (this.pendingEvents.length === 0 && !(this.controller.hasDeferredWork?.() ?? false))
          break;
      }
    } catch (error) {
      this.pendingEvents.length = 0;
      throw error;
    } finally {
      this.draining = false;
    }
    if (requestCommit) this.scheduleCommit(false);
  }

  requestCommit(): void {
    this.scheduleCommit(true);
  }

  private scheduleCommit(markDirty: boolean): void {
    if (this.retired) return;
    if (markDirty) this.durabilityDirty = true;
    if (!this.durabilityDirty && !this.projectionPending) return;
    if (this.committing || this.draining || this.commitTimer !== null) return;
    this.commitTimer = setTimeout(() => {
      this.commitTimer = null;
      this.startCommit();
    }, 0);
    if (typeof this.commitTimer === 'object' && 'unref' in this.commitTimer) {
      this.commitTimer.unref();
    }
  }

  private startCommit(): void {
    if (
      this.retired ||
      this.committing ||
      this.draining ||
      (!this.durabilityDirty && !this.projectionPending)
    ) {
      return;
    }
    this.runTransaction(undefined, false);
    if (this.committing || this.draining || (!this.durabilityDirty && !this.projectionPending)) {
      return;
    }
    const projectedState = this.state;
    const shouldProject = this.projectionPending;
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
    const externalEffects = [...this.pendingExternalEffects.entries()];
    const recoveringDurability = this.durabilityDegraded;
    const persistenceState = recoveringDurability
      ? reduceSessionMachine(
          structuredClone(projectedState),
          { type: 'clear-durability-error' },
          this.activeHandContext,
        ).state
      : structuredClone(projectedState);
    this.durabilityDirty = false;
    this.projectionPending = false;
    this.committing = true;
    let write: Promise<void>;
    try {
      const rejectionWrite = this.controller.persistInboundSessionRejectIfNeeded?.();
      if (rejectionWrite) {
        write = rejectionWrite;
      } else if (this.persistOverride) {
        write = this.persistOverride(persistenceState);
      } else {
        const snapshot = buildDurableApplicationState({
          kind: 'live',
          controller: this.controller,
          state: persistenceState,
          restoring: this.restoring,
          getRestoreStatus: this.getRestoreStatus,
          getRestoreError: this.getRestoreError,
        });
        write = snapshot ? storageRepository.write(snapshot) : Promise.resolve();
      }
    } catch (error) {
      write = Promise.reject(error);
    }
    const releaseExternalEffects = () => {
      for (const [key, effect] of externalEffects) {
        if (this.pendingExternalEffects.get(key) !== effect) continue;
        this.pendingExternalEffects.delete(key);
        let completion: Promise<void>;
        try {
          completion = effect.launcher();
        } catch (error) {
          effect.deferred.reject(error);
          continue;
        }
        void Promise.resolve(completion).then(effect.deferred.resolve, effect.deferred.reject);
      }
    };
    let writeFailed = false;
    let activityDirtyBeforeFailure = false;
    this.commitPromise = write
      .then(
        () => {
          if (this.retired) return;
          const renderedState = recoveringDurability
            ? reduceSessionMachine(
                this.state,
                { type: 'clear-durability-error' },
                this.activeHandContext,
              ).state
            : projectedState;
          if (recoveringDurability) {
            this.durabilityDegraded = false;
            this.controller.clearDurabilityError?.();
            this.state = renderedState;
          }
          if (shouldProject) {
            try {
              this.render(renderedState);
            } catch (error) {
              this.onError(error);
            }
          }
          try {
            this.controller.completeReliableCommit(reliableCommit, true);
          } catch (error) {
            this.onError(error);
          }
          releaseExternalEffects();
        },
        (error) => {
          if (this.retired) throw error;
          if (error instanceof StorageAuthorityLostError) {
            this.retire();
            throw error;
          }
          writeFailed = true;
          activityDirtyBeforeFailure = this.durabilityDirty;
          this.durabilityDirty = true;
          this.durabilityDegraded = true;
          this.controller.reportDurabilityError?.(error);
          if (shouldProject) {
            try {
              this.render(projectedState);
            } catch (renderError) {
              this.onError(renderError);
            }
          }
          try {
            this.controller.completeReliableCommit(reliableCommit, false);
          } catch (releaseError) {
            this.onError(releaseError);
          }
          releaseExternalEffects();
          throw error;
        },
      )
      .finally(() => {
        this.committing = false;
        if (this.retired) return;
        if (this.pendingControllerWork.length > 0 || this.pendingEvents.length > 0) {
          const work = this.pendingControllerWork.splice(0);
          const queuedActivity =
            work.length > 0 ||
            this.pendingEvents.some((event) => !this.isDurabilityProjection(event));
          this.runTransaction(
            () => {
              for (const task of work) task.run();
            },
            !writeFailed || activityDirtyBeforeFailure || queuedActivity,
          );
          if (writeFailed && !activityDirtyBeforeFailure && !queuedActivity) {
            this.projectionPending = false;
            try {
              this.render(this.state);
            } catch (error) {
              this.onError(error);
            }
          }
        } else if (!writeFailed || activityDirtyBeforeFailure) {
          this.scheduleCommit(false);
        }
      });
    void this.commitPromise.catch(() => {});
  }

  async flush(): Promise<void> {
    if (this.retired) return;
    if (this.commitTimer !== null) {
      clearTimeout(this.commitTimer);
      this.commitTimer = null;
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
      this.pendingControllerWork.length > 0 ||
      this.pendingExternalEffects.size > 0
    ) {
      return this.flush();
    }
  }
}
