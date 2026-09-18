import { createSessionModel } from '../session/model';
import { createSessionMachineState, reduceSessionMachine } from '../session/sessionMachine';
import { runSessionMachineTransition } from '../session/sessionMachineEffects';
import type { HandProposal, ProposalOrigin } from '../session/types';

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
  return reduceSessionMachine(state, event).state;
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
      origin,
      status: origin === 'local' ? 'outgoing' : 'incoming-cached',
    },
  });
}

export function run(
  state: ReturnType<typeof createSessionMachineState>,
  event: Parameters<typeof reduceSessionMachine>[1],
  order: string[] = [],
) {
  const transition = reduceSessionMachine(state, event);
  let authority = state;
  runSessionMachineTransition(transition, {
    setAuthority: (next) => {
      order.push('authority');
      authority = next;
    },
    getAuthority: () => authority,
    controller: {
      clearDerivedGamePresentation: () => order.push('controller-clear'),
    },
    runCommand: () => order.push('command'),
    render: () => order.push('react'),
  });
  return authority;
}

export function activeMachineState() {
  return createSessionMachineState(createSessionModel());
}
