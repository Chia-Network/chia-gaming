import type { ProposalParameterValue } from '@games/host';
import type { ProposalMadePayload } from '../types/ChiaGaming';
import { catalogGameTypeFromWire } from './gameIdentities';
import { decodeHandProposal, packageFor } from './gameRegistry';
import { parseAmount } from './wasm/parseAmount';
import type { HandProposal, RegisteredGameType } from './session/types';

export function encodeGameProposalParameters(
  handProposal: HandProposal,
  iStarted: boolean,
): ProposalParameterValue {
  const registration = packageFor(handProposal.gameType);
  return registration.encodeProposalParameters(handProposal, iStarted);
}

function parseTimeout(value: unknown): bigint | null {
  if (value == null) return null;
  const raw =
    typeof value === 'object' && value !== null && 'Timeout' in value
      ? (value as Record<string, unknown>).Timeout
      : value;
  try {
    const timeout = BigInt(String(raw));
    return timeout > 0n ? timeout : null;
  } catch {
    return null;
  }
}

function catalogTypeFromPayload(
  payload: ProposalMadePayload,
  gameTypeOverride?: RegisteredGameType,
): RegisteredGameType | null {
  if (gameTypeOverride) return gameTypeOverride;
  return typeof payload.game_type === 'string' ? catalogGameTypeFromWire(payload.game_type) : null;
}

export function decodeProposalMadeTerms(
  payload: ProposalMadePayload,
  iStarted: boolean,
  gameTypeOverride?: RegisteredGameType,
): HandProposal | null {
  const mine = parseAmount(payload.my_contribution);
  const theirs = parseAmount(payload.their_contribution);
  const resolvedType = catalogTypeFromPayload(payload, gameTypeOverride);
  const timeout = parseTimeout(payload.timeout);
  if (!mine || !theirs || !resolvedType || timeout == null || payload.parameters == null) {
    return null;
  }
  try {
    return decodeHandProposal(
      resolvedType,
      {
        myContribution: BigInt(mine),
        theirContribution: BigInt(theirs),
        gameTimeout: timeout,
      },
      payload.parameters,
      { iStarted, origin: 'peer' },
    );
  } catch {
    return null;
  }
}
