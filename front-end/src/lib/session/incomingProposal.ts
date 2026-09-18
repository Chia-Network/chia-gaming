import type { ProposalMadePayload } from '../../types/ChiaGaming';
import { catalogGameTypeFromWire } from '../gameIdentities';
import { isProposalParameterValue, packageFor } from '../gameRegistry';
import { isValidGameTimeoutBlocks } from './gameTimeout';
import type { ProposalGroupModel } from './types';

export function proposalGroupFromProposalMade(
  payload: ProposalMadePayload | undefined,
): ProposalGroupModel | null {
  if (!payload) return null;
  const gameType =
    typeof payload.game_type === 'string' ? catalogGameTypeFromWire(payload.game_type) : null;
  let timeout: bigint;
  try {
    timeout = BigInt(String(payload.timeout));
  } catch {
    return null;
  }
  const memberIds = Array.isArray(payload.group_ids) ? payload.group_ids.map(String) : [];
  if (
    !gameType ||
    !isValidGameTimeoutBlocks(timeout) ||
    typeof payload.sender_is_player_a !== 'boolean' ||
    !isProposalParameterValue(payload.parameters) ||
    payload.id == null ||
    memberIds.length === 0
  ) {
    return null;
  }
  if (packageFor(gameType).decodeProposalParameters(payload.parameters) === null) {
    return null;
  }
  return {
    primaryId: String(payload.id),
    memberIds,
    handProposal: {
      gameType,
      senderIsPlayerA: payload.sender_is_player_a,
      gameTimeout: timeout,
      parameters: payload.parameters,
    },
    origin: 'peer',
    disposition: 'incoming-cached',
  };
}
