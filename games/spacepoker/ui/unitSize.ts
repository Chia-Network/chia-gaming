import { type ProposalParameterCodec } from '../../host';

export type SpacepokerFactoryParameters = {
  betUnitMojos: bigint;
};

export const spacepokerProposalParameters: ProposalParameterCodec<SpacepokerFactoryParameters> = {
  decode(value) {
    if (typeof value !== 'bigint' || value <= 0n) {
      return null;
    }
    return { betUnitMojos: value };
  },
  encode: (params) => params.betUnitMojos,
};

export function decodeSpacepokerBetUnitMojos(value: unknown): bigint | null {
  return spacepokerProposalParameters.decode(value)?.betUnitMojos ?? null;
}
