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
