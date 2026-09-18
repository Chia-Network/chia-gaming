import type { Subscription } from 'rxjs';
import { WasmStateInit } from '../../hooks/WasmStateInit';
import { SessionController } from '../../hooks/SessionController';
import { restoreSession } from '../../hooks/blobSingleton';
import {
  _resetForTests as resetSaveState,
  flushSessionSave,
  peekSession,
  type LiveSessionSave,
} from '../../hooks/save';
import type { BlockchainPoller } from '../../hooks/BlockchainPoller';
import { dispatchWasmNotification } from '../session/gameSessionEvents';
import { sessionModelFromSave } from '../session/model';
import { createSessionMachineState } from '../session/sessionMachine';
import { SessionMachineRuntime } from '../session/sessionMachineRuntime';
import type { SessionModel } from '../session/types';
import {
  addActiveSubscription,
  fetchPreset,
  type SessionControllerAdapter,
} from './load_wasm.harness';

export interface ReloadableSessionLane {
  adapter: SessionControllerAdapter;
  controller: SessionController;
  runtime: SessionMachineRuntime;
  subscription: Subscription;
}

let reloadBarrier: Promise<void> | null = null;
let reloadController: SessionController | null = null;

function persistOutsideReload<T>(
  controller: SessionController,
  persist: () => Promise<T>,
): Promise<T> {
  return reloadBarrier && reloadController !== controller ? reloadBarrier.then(persist) : persist();
}

function bindRuntime(
  adapter: SessionControllerAdapter,
  controller: SessionController,
  model: SessionModel,
  iStarted: boolean,
  restoring: boolean,
): ReloadableSessionLane {
  const persist = () => persistOutsideReload(controller, () => runtime.persist());
  const runtime = new SessionMachineRuntime(
    createSessionMachineState(model, {
      firstGameAccepted: model.channel.status.state === 'Active',
    }),
    {
      controller,
      iStarted,
      restoring,
      getRestoreStatus: () => controller.getRestoreStatus(),
      getRestoreError: () => controller.getRestoreError(),
      onError: (error) => controller.reportRuntimeError(error),
      persist,
    },
  );
  const dispatchHostProjection = () => {
    const status = controller.getRestoreStatus();
    runtime.dispatch({
      type: 'host-projection',
      restore: {
        restoring,
        status,
        error: controller.getRestoreError(),
        hubReconciled: status === 'restored',
      },
      wasmNotificationHistory: controller.wasmNotificationHistory,
      diagnosticLog: controller.diagnosticLog,
    });
  };
  dispatchHostProjection();
  controller.onSaveNeeded = persist;
  const subscription = addActiveSubscription(
    controller.getObservable().subscribe((event) => {
      switch (event.type) {
        case 'notification':
          dispatchWasmNotification(
            event.data,
            (notification) =>
              runtime.dispatch({ type: 'wasm-notification', notification, iStarted }),
            (error) =>
              runtime.dispatch({
                type: 'enqueue-error',
                kind: 'infra-error',
                message: String(error),
              }),
          );
          dispatchHostProjection();
          break;
        case 'error':
          runtime.dispatch({ type: 'enqueue-error', kind: 'infra-error', message: event.error });
          break;
        case 'game-action-error':
          runtime.dispatch({ type: 'enqueue-error', kind: 'action-failed', message: event.error });
          break;
        case 'durability-error':
          runtime.dispatch({
            type: 'enqueue-error',
            kind: 'durability-error',
            message: event.error,
          });
          break;
        case 'address':
          break;
        case 'log':
          dispatchHostProjection();
          break;
      }
    }),
  );
  return { adapter, controller, runtime, subscription };
}

export function createReloadableSessionLane(
  adapter: SessionControllerAdapter,
  controller: SessionController,
  model: SessionModel,
): ReloadableSessionLane {
  return bindRuntime(adapter, controller, model, controller.iStarted, false);
}

export async function injectSessionReload(
  lane: ReloadableSessionLane,
  poller: BlockchainPoller,
  wasmStateInit = new WasmStateInit(fetchPreset),
): Promise<{ lane: ReloadableSessionLane; save: LiveSessionSave }> {
  await lane.controller.flushPendingWork();
  if (reloadBarrier) await reloadBarrier;
  let releaseReload!: () => void;
  reloadBarrier = new Promise<void>((resolve) => {
    releaseReload = resolve;
  });
  reloadController = lane.controller;
  let save: Awaited<ReturnType<typeof peekSession>>;
  try {
    await lane.runtime.persist();
    await flushSessionSave();
    resetSaveState();
    save = await peekSession();
  } finally {
    reloadController = null;
    reloadBarrier = null;
    releaseReload();
  }
  if (save?.phase !== 'live') {
    throw new Error(`reload injection expected a live session save, got ${save?.phase ?? 'none'}`);
  }

  const uniqueId = lane.controller.uniqueId;
  lane.subscription.unsubscribe();
  lane.runtime.setRender(() => {});
  lane.controller.onSaveNeeded = null;
  lane.controller.cleanup();

  const controller = new SessionController(
    poller,
    uniqueId,
    BigInt(save.pairing.myContribution),
    BigInt(save.pairing.theirContribution),
    lane.adapter.peerConnection,
  );
  controller.perGameAmount = BigInt(save.pairing.perGameAmount);
  controller.setPeerKeepalive(() => lane.adapter.peerConnection.sendKeepalive());
  lane.adapter.set_blob(controller);
  controller.attachBlockchain(poller);
  await controller.beginRestore(restoreSession(controller, save, wasmStateInit));

  return {
    lane: bindRuntime(
      lane.adapter,
      controller,
      sessionModelFromSave(save),
      save.pairing.iStarted,
      true,
    ),
    save,
  };
}
