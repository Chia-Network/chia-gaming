import { observeWasmEvents } from './session_execution.harness';
import { configureSessionExecution } from './session_execution.harness';
import type { Subscription } from 'rxjs';
import { SessionController } from '../session/SessionController';
import { ensureWasmLoaded } from '../session/wasmLoader';
import { dispatchWasmNotification } from '../session/gameSessionEvents';
import { rehydrateDurableApplicationState } from '../session/persistence';
import { type DurableApplicationState, type LiveSessionSave } from '../session/saveEnvelope';
import { restoreSession } from '../session/sessionHost';
import { createSessionMachineState } from '../session/sessionMachine';

import { storageRepository } from '../session/storageRepository';
import type { SessionModel } from '../session/types';
import type { BlockchainPoller } from '../wallet/BlockchainPoller';
import { installCapturedState } from './checkpoint_capture.harness';
import {
  addActiveSubscription,
  fetchPreset,
  type SessionControllerAdapter,
} from './load_wasm.harness';
import { observeSessionProjection } from './session_frontend.harness';

export interface ReloadableSessionLane {
  adapter: SessionControllerAdapter;
  controller: SessionController;
  runtime: SessionController;
  subscription: Subscription;
}

function bindRuntime(
  adapter: SessionControllerAdapter,
  controller: SessionController,
  model: SessionModel,
  iStarted: boolean,
  restoring: boolean,
): ReloadableSessionLane {
  const runtime = configureSessionExecution(
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
    },
  );
  runtime.activate();
  adapter.bindRuntime(runtime);
  const dispatchHostProjection = () => {
    const status = controller.getRestoreStatus();
    runtime.dispatch({
      type: 'host-projection',
      restore: {
        restoring,
        status,
        error: controller.getRestoreError(),
      },
      wasmNotificationHistory: controller.wasmNotificationHistory,
      diagnosticLog: controller.diagnosticLog,
    });
  };
  dispatchHostProjection();
  const subscription = addActiveSubscription(
    observeWasmEvents(controller).subscribe((event) => {
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
  wasmConnection?: import('../../types/ChiaGaming').WasmConnection,
  whileReloaded?: () => Promise<void>,
): Promise<{
  lane: ReloadableSessionLane;
  save: DurableApplicationState & { session: LiveSessionSave };
}> {
  await lane.runtime.flush();
  await lane.controller.flushPendingWork();
  await lane.runtime.flush();
  await lane.runtime.flush();
  const snapshot = installCapturedState({
    kind: 'live',
    controller: lane.controller,
    state: lane.runtime.getState(),
    restoring: lane.controller.getRestoreStatus() !== 'idle',
    getRestoreStatus: () => lane.controller.getRestoreStatus(),
    getRestoreError: () => lane.controller.getRestoreError(),
  });
  if (snapshot) await storageRepository.write(snapshot);
  await storageRepository.checkpointDomainMutations();
  lane.subscription.unsubscribe();
  observeSessionProjection(lane.runtime, () => {});
  lane.controller.cleanup();
  await lane.controller.flushPendingWork();
  storageRepository._resetForTests();
  await storageRepository.claimApplicationState();
  const save = await storageRepository.readCurrentState();
  if (save?.session?.phase !== 'live') {
    throw new Error(
      `reload injection expected a live session save, got ${save?.session?.phase ?? 'none'}`,
    );
  }
  const live = save.session;

  const uniqueId = lane.controller.uniqueId;
  await whileReloaded?.();

  const controller = new SessionController(
    poller,
    uniqueId,
    BigInt(live.pairing.myContribution),
    BigInt(live.pairing.theirContribution),
    lane.adapter.peerConnection,
    undefined,
    save.walletContext ?? undefined,
  );
  controller.perGameAmount = BigInt(live.pairing.perGameAmount);
  controller.setPeerKeepalive(() => lane.adapter.peerConnection.sendKeepalive());
  lane.adapter.setRuntimeBlob(controller);
  const bootstrap = rehydrateDurableApplicationState(save);
  const restoredLane = bindRuntime(
    lane.adapter,
    controller,
    bootstrap.model,
    live.pairing.iStarted,
    true,
  );
  controller.attachBlockchain(poller);
  controller.kickSystem(2);
  await controller.beginRestore(
    restoreSession(controller, bootstrap, wasmConnection ?? (await ensureWasmLoaded(fetchPreset))),
  );

  return {
    lane: restoredLane,
    save,
  };
}
