import type { ProposalMadePayload } from '../../types/ChiaGaming';
import { catalogGameTypeFromWire } from '../gameIdentities';
import { isProposalParameterValue, packageFor } from '../gameRegistry';
import { parseAmount } from '../wasm/parseAmount';
import type { ProposalGroupModel } from './types';

export function proposalGroupFromProposalMade(
  payload: ProposalMadePayload | undefined,
): ProposalGroupModel | null {
  if (!payload) return null;
  const playerA = parseAmount(payload.player_a_contribution);
  const playerB = parseAmount(payload.player_b_contribution);
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
    !playerA ||
    !playerB ||
    !gameType ||
    timeout <= 0n ||
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
      playerAContribution: playerA,
      playerBContribution: playerB,
      senderIsPlayerA: payload.sender_is_player_a,
      gameTimeout: timeout,
      parameters: payload.parameters,
    },
    origin: 'peer',
    disposition: 'incoming-cached',
  };
}
