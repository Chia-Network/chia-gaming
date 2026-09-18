import type { PendingProposalLifecycle, PendingProposalModel } from './types';

export function isUncancelledProposalLifecycle(lifecycle: PendingProposalLifecycle): boolean {
  return lifecycle !== 'local-cancel-queued' && lifecycle !== 'peer-cancel-queued';
}

export function isUncancelledProposal(proposal: PendingProposalModel): boolean {
  return isUncancelledProposalLifecycle(proposal.lifecycle);
}
