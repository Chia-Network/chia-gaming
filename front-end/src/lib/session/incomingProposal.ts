import type { ProposalMadePayload } from '../../types/ChiaGaming';
import { decodeProposalMadeTerms } from '../gameProposalCodec';
import type { ProposalGroupModel } from './types';

export function proposalGroupFromProposalMade(
  payload: ProposalMadePayload | undefined,
): ProposalGroupModel | null {
  if (!payload) return null;
  const terms = decodeProposalMadeTerms(payload);
  const memberIds = Array.isArray(payload.group_ids) ? payload.group_ids.map(String) : [];
  if (!terms || payload.id == null || memberIds.length === 0) return null;
  return {
    primaryId: String(payload.id),
    memberIds,
    handProposal: terms,
    origin: 'peer',
    disposition: 'incoming-cached',
  };
}
