import {
  type GamePackageRegistration,
  type ProposalParameterCodec,
} from '../../host';
import {
  createCalpokerHand,
  restoreCalpokerHand,
  type CalpokerHand,
  type CalpokerHandState,
} from './serialize';
import { formatCalpokerMojos } from './formatting';

export { reduceCalpokerFeatureState } from './serialize';

export type CalpokerFactoryParameters = bigint;

export const calpokerProposalParameters: ProposalParameterCodec<CalpokerFactoryParameters> = {
  decode: (value) => (typeof value === 'bigint' && value > 0n ? value : null),
  encode: (value) => value,
};

const registration: GamePackageRegistration<
  CalpokerHandState,
  CalpokerHand,
  CalpokerFactoryParameters
> = {
  displayName: 'California Poker',
  createHand: createCalpokerHand,
  restoreHand: restoreCalpokerHand,
  proposalParameters: calpokerProposalParameters,
  describeHandProposal(handProposal) {
    const stake = calpokerProposalParameters.decode(handProposal.parameters);
    if (stake === null) {
      throw new Error('California Poker proposal parameters are invalid');
    }
    return `Stake ${formatCalpokerMojos(stake)} each`;
  },
};

export default registration;
