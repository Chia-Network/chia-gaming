import { type HandProposal, type ProposalParameterCodec } from '../../host';
function positive(value: bigint | undefined): bigint | null {
  return value !== undefined && value > 0n ? value : null;
}

export type SpacepokerTerms = HandProposal & { unitSizeMojos: bigint };

export function spacepokerTermsOf(handProposal: HandProposal): SpacepokerTerms | null {
  if (handProposal.gameType !== 'spacepoker') return null;
  const unitSizeMojos = (handProposal as SpacepokerTerms).unitSizeMojos;
  return positive(unitSizeMojos) ? (handProposal as SpacepokerTerms) : null;
}

export type SpacepokerFactoryParameters = {
  perPlayerStake: bigint;
  betUnit: bigint;
  senderGoesFirst: boolean;
};

export const spacepokerProposalParameters: ProposalParameterCodec<SpacepokerFactoryParameters> = {
  decode(value) {
    if (
      !Array.isArray(value) ||
      value.length !== 3 ||
      typeof value[0] !== 'bigint' ||
      typeof value[1] !== 'bigint' ||
      typeof value[2] !== 'boolean' ||
      value[0] <= 0n ||
      value[1] <= 0n ||
      value[0] % value[1] !== 0n
    ) {
      return null;
    }
    const [perPlayerStake, betUnit, senderGoesFirst] = value;
    return { perPlayerStake, betUnit, senderGoesFirst };
  },
  encode: (params) => [params.perPlayerStake, params.betUnit, params.senderGoesFirst],
};

export function decodeSpacepokerUnitSize(value: unknown): bigint | null {
  return spacepokerProposalParameters.decode(value)?.betUnit ?? null;
}

/**
 * The sole resolver for Space Poker's protocol unit. Every source is validated,
 * and multiple available sources must agree.
 */
export function resolveSpacepokerUnitSize(input: {
  terms?: HandProposal | null;
  encodedParameterState?: unknown;
}): bigint | null {
  const candidates: bigint[] = [];
  if (input.terms && input.terms.gameType === 'spacepoker') {
    const terms = spacepokerTermsOf(input.terms);
    if (!terms) return null;
    candidates.push(terms.unitSizeMojos);
  }
  if (input.encodedParameterState !== undefined) {
    const value = decodeSpacepokerUnitSize(input.encodedParameterState);
    if (!value) return null;
    candidates.push(value);
  }
  if (candidates.length === 0) return null;
  return candidates.every((value) => value === candidates[0]) ? candidates[0] : null;
}
