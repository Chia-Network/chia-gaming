import * as gameEvents from '../session/gameSessionEvents';
import { Subject } from 'rxjs';
import type { WasmEvent } from '../../types/ChiaGaming';
import { SessionController, type RestoreStatus } from '../session/SessionController';
import type { SessionMachineState } from '../session/sessionMachineTypes';
import { coinIdHex } from '../session/gameSessionEvents';

/** Configure the single owner, substituting Rust/wallet boundaries for focused tests. */
export function configureSessionExecution(
  initial: SessionMachineState,
  options: {
    controller: SessionController;
    iStarted: boolean;
    restoring: boolean;
    getRestoreStatus(): RestoreStatus;
    getRestoreError(): string | null;
    onError(error: unknown): void;
    bindControllerEvents?: boolean;
    persist?(state: SessionMachineState): Promise<unknown>;
    enrichCoin?: typeof coinIdHex;
  },
): SessionController {
  const source = options.controller;
  const real = source instanceof SessionController;
  const owner = real
    ? source
    : new SessionController(null, 'execution-test', 0n, 0n, {
        sendMessage: () => true,
        sendAck: () => true,
      });
  if (!real) {
    for (const key of Object.keys(source)) {
      Object.defineProperty(owner, key, {
        configurable: true,
        get: () => (source as any)[key],
        set: (value) => {
          (source as any)[key] = value;
        },
      });
    }
  }
  const internals = owner as any;
  internals.state = initial;
  owner.iStarted = options.iStarted;
  internals.restoring = options.restoring;
  if (!options.bindControllerEvents) {
    jest.spyOn(owner, 'receiveEvent').mockImplementation(() => {});
    jest.spyOn(internals, 'dispatchHostProjection').mockImplementation(() => {});
  }
  if (options.persist) jest.spyOn(internals, 'writeCheckpoint').mockImplementation(options.persist);
  else if (jest.isMockFunction(internals.writeCheckpoint)) internals.writeCheckpoint.mockRestore();
  if (!real) {
    internals.getRestoreStatus = options.getRestoreStatus;
    internals.getRestoreError = options.getRestoreError;
    internals.reportRuntimeError = options.onError;
  }
  if (options.enrichCoin)
    jest.spyOn(gameEvents, 'coinIdHex').mockImplementation(options.enrichCoin);
  internals.restoreHandFrom(initial.model.game.handState);
  internals.published = internals.presentation(initial);
  if (observed.has(owner)) observeWasmEvents(owner);
  return owner;
}

/** Observe raw Rust/effect inputs without a production observer loop back into the owner. */
const observed = new WeakMap<
  SessionController,
  {
    events: Subject<WasmEvent>;
    receive: (event: WasmEvent) => void;
  }
>();
export function observeWasmEvents(owner: SessionController): Subject<WasmEvent> {
  const previous = observed.get(owner);
  if (
    previous &&
    jest.isMockFunction(owner.receiveEvent) &&
    owner.receiveEvent.getMockImplementation() === previous.receive
  )
    return previous.events;
  const events = previous?.events ?? new Subject<WasmEvent>();
  const receive = (
    jest.isMockFunction(owner.receiveEvent)
      ? owner.receiveEvent.getMockImplementation()!
      : owner.receiveEvent
  ).bind(owner);
  const observe = (event: WasmEvent) => {
    receive(event);
    if (!(owner as any).retired) events.next(event);
  };
  observed.set(owner, { events, receive: observe });
  jest.spyOn(owner, 'receiveEvent').mockImplementation(observe);
  return events;
}
