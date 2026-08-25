import type { ProposalGroupOrigin } from '../../host';

/** Calpoker's proposal sender moves first exactly when they did not start the channel. */
export function calpokerProposalSenderGoesFirst(
  iStarted: boolean,
  origin: ProposalGroupOrigin,
): boolean {
  const proposalSenderStarted = origin === 'local' ? iStarted : !iStarted;
  return !proposalSenderStarted;
}
