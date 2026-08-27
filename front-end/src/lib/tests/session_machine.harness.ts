import { createSessionModel } from '../session/model';
import { createSessionMachineState, reduceSessionMachine } from '../session/sessionMachine';
import { runSessionMachineTransition } from '../session/sessionMachineEffects';
import type { HandProposal, ProposalGroupOrigin } from '../session/types';

export const CALPOKER_TERMS = {
  gameType: 'calpoker' as const,
  myContribution: 10n,
  theirContribution: 10n,
  gameTimeout: 15n,
};

export const KRUNK_TERMS = {
  gameType: 'krunk' as const,
  myContribution: 100n,
  theirContribution: 100n,
  gameTimeout: 15n,
};

export function send(
  state: ReturnType<typeof createSessionMachineState>,
  event: Parameters<typeof reduceSessionMachine>[1],
) {
  return reduceSessionMachine(state, event).state;
}

export function trackProposal(
  state: ReturnType<typeof createSessionMachineState>,
  memberIds: string[],
  handProposal: HandProposal,
  origin: ProposalGroupOrigin = 'local',
) {
  return send(state, {
    type: 'upsert-proposal-group',
    group: {
      primaryId: memberIds[0],
      memberIds,
      handProposal,
      origin,
      disposition: origin === 'local' ? 'outgoing' : 'incoming-cached',
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
