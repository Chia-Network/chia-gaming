import type { HandProposalBase } from '@games/host';

export type ProposalGroupOrigin = 'local' | 'peer';

export function proposalContributionForOrigin(
  handProposal: HandProposalBase,
  origin: ProposalGroupOrigin,
): bigint {
  const senderContribution = handProposal.senderIsPlayerA
    ? handProposal.playerAContribution
    : handProposal.playerBContribution;
  const receiverContribution = handProposal.senderIsPlayerA
    ? handProposal.playerBContribution
    : handProposal.playerAContribution;
  return origin === 'local' ? senderContribution : receiverContribution;
}
