import { type ProposalParameterCodec } from '../../host';

export type SpacepokerFactoryParameters = {
  stackSize: bigint;
  betUnitMojos: bigint;
};

export const spacepokerProposalParameters: ProposalParameterCodec<SpacepokerFactoryParameters> = {
  decode(value) {
    if (
      !Array.isArray(value) ||
      value.length !== 2 ||
      typeof value[0] !== 'bigint' ||
      value[0] < 0n ||
      typeof value[1] !== 'bigint' ||
      value[1] <= 0n
    ) {
      return null;
    }
    return { stackSize: value[0], betUnitMojos: value[1] };
  },
  encode: (params) => [params.stackSize, params.betUnitMojos],
};
