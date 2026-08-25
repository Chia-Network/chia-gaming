import type { ProposalGroupOrigin } from '../../host';

/** Space Poker's proposal sender moves first exactly when they did not start the channel. */
export function spacepokerProposalSenderGoesFirst(
  iStarted: boolean,
  origin: ProposalGroupOrigin,
): boolean {
  const proposalSenderStarted = origin === 'local' ? iStarted : !iStarted;
  return !proposalSenderStarted;
}
