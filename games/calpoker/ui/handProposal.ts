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

export type CalpokerFactoryParameters = Record<string, never>;

export const calpokerProposalParameters: ProposalParameterCodec<CalpokerFactoryParameters> = {
  decode: (value) => (value === null ? {} : null),
  encode: () => null,
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
    if (calpokerProposalParameters.decode(handProposal.parameters) === null) {
      throw new Error('California Poker proposal parameters are invalid');
    }
    return `Stake ${formatCalpokerMojos(handProposal.playerAContribution)} each`;
  },
};

export default registration;
