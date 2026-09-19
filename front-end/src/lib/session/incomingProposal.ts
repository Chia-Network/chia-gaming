import type { ProposalMadePayload } from '../../types/ChiaGaming';
import { catalogGameTypeFromWire } from '../gameIdentities';
import { isProposalParameterValue, packageFor } from '../gameRegistry';
import { isValidGameTimeoutBlocks } from './gameTimeout';
import type { PendingProposalModel } from './types';

export function pendingProposalFromProposalMade(
  payload: ProposalMadePayload | undefined,
): PendingProposalModel | null {
  if (!payload) return null;
  const gameType =
    typeof payload.game_type === 'string' ? catalogGameTypeFromWire(payload.game_type) : null;
  let timeout: bigint;
  try {
    timeout = BigInt(String(payload.timeout));
  } catch {
    return null;
  }
  if (
    !gameType ||
    !isValidGameTimeoutBlocks(timeout) ||
    typeof payload.sender_is_player_a !== 'boolean' ||
    !isProposalParameterValue(payload.parameters) ||
    payload.id == null
  ) {
    return null;
  }
  return {
    id: String(payload.id),
    handProposal: {
      gameType,
      senderIsPlayerA: payload.sender_is_player_a,
      gameTimeout: timeout,
      parameters: payload.parameters,
    },
    lifecycle:
      packageFor(gameType).decodeProposalParameters(payload.parameters) === null
        ? 'peer-cancel-queued'
        : 'peer-cached',
  };
}
