import type { SessionController } from '../../hooks/SessionController';
import { createSessionModel } from '../session/model';
import { createSessionMachineState, reduceSessionMachine } from '../session/sessionMachine';
import { SessionMachineRuntime } from '../session/sessionMachineRuntime';
import type {
  SessionMachineEffect,
  SessionMachineEvent,
  SessionMachineState,
  SessionMachineTransition,
} from '../session/sessionMachineTypes';
import type { HandProposal, ProposalOrigin } from '../session/types';
import {
  createRegisteredGameHand,
  restoreRegisteredGameHandState,
  snapshotRegisteredGameHand,
  type RegisteredGameHand,
} from '../gameRegistry';

export function reduceSessionMachineForTest(
  state: SessionMachineState,
  event: SessionMachineEvent,
): ReturnType<typeof reduceSessionMachine> {
  let gameType = state.model.game.activeGameType;
  let hand: RegisteredGameHand | null =
    state.model.game.handState === null
      ? null
      : restoreRegisteredGameHandState(gameType, state.model.game.handState);
  return reduceSessionMachine(state, event, {
    create: (nextGameType, init) => {
      gameType = nextGameType;
      hand = createRegisteredGameHand(gameType, init);
      return snapshotRegisteredGameHand(gameType, hand);
    },
    receive: (update) => {
      if (hand === null) throw new Error('Test game update requires an active hand');
      hand.receive(update);
      return snapshotRegisteredGameHand(gameType, hand);
    },
    clear: () => {
      hand = null;
    },
  });
}

interface SessionMachineEffectRunner {
  setAuthority(state: SessionMachineState): void;
  getAuthority(): SessionMachineState;
  runCommand(effect: SessionMachineEffect): void;
  render(state: SessionMachineState): void;
}

export function runSessionMachineTransition(
  transition: SessionMachineTransition,
  runner: SessionMachineEffectRunner,
): void {
  runner.setAuthority(transition.state);
  try {
    for (const effect of transition.effects) {
      runner.runCommand(effect);
    }
  } finally {
    runner.render(runner.getAuthority());
  }
}

export const CALPOKER_TERMS = {
  gameType: 'calpoker' as const,
  senderIsPlayerA: false,
  gameTimeout: 15n,
  parameters: 10n,
};

export const KRUNK_TERMS = {
  gameType: 'krunk' as const,
  senderIsPlayerA: true,
  gameTimeout: 15n,
  parameters: 100n,
};

export function send(
  state: ReturnType<typeof createSessionMachineState>,
  event: Parameters<typeof reduceSessionMachine>[1],
) {
  return reduceSessionMachineForTest(state, event).state;
}

export function trackProposal(
  state: ReturnType<typeof createSessionMachineState>,
  id: string,
  handProposal: HandProposal,
  origin: ProposalOrigin = 'local',
) {
  return send(state, {
    type: 'upsert-pending-proposal',
    proposal: {
      id,
      handProposal,
      lifecycle: origin === 'local' ? 'local-outgoing' : 'peer-cached',
    },
  });
}

export function run(
  state: ReturnType<typeof createSessionMachineState>,
  event: Parameters<typeof reduceSessionMachine>[1],
  order: string[] = [],
) {
  const transition = reduceSessionMachineForTest(state, event);
  let authority = state;
  runSessionMachineTransition(transition, {
    setAuthority: (next) => {
      order.push('authority');
      authority = next;
    },
    getAuthority: () => authority,
    runCommand: () => order.push('command'),
    render: () => order.push('react'),
  });
  return authority;
}

export function activeMachineState() {
  return createSessionMachineState(createSessionModel());
}

export function createCoordinatorOnlySessionMachineRuntime(
  controller: SessionController,
  persist: () => void | Promise<void> = () => {},
): SessionMachineRuntime {
  const runtime = new SessionMachineRuntime(createSessionMachineState(createSessionModel()), {
    controller,
    iStarted: controller.iStarted,
    restoring: false,
    getRestoreStatus: () => controller.getRestoreStatus(),
    getRestoreError: () => controller.getRestoreError(),
    onError: (error) => controller.reportRuntimeError(error),
    persist: async () => {
      await persist();
    },
  });
  runtime.activate();
  return runtime;
}
