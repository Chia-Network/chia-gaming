import { equalHandProposalBase, type GamePackageRegistration } from '../../host';
import {
  createSpacepokerHand,
  restoreSpacepokerHand,
  type SpacepokerHand,
  type SpacepokerHandState,
} from './serialize';
import { formatSpacepokerMojos } from './formatting';
import {
  spacepokerProposalParameters,
  type SpacepokerFactoryParameters,
} from './unitSize';

export {
  reduceSpacepokerHandState,
  reduceSpacepokerFeatureState,
  reduceSpacepokerSettlementState,
} from './serialize';

const registration: GamePackageRegistration<
  SpacepokerHandState,
  SpacepokerHand,
  SpacepokerFactoryParameters
> = {
  gameType: 'spacepoker',
  displayName: 'Space Poker',
  createHand: createSpacepokerHand,
  restoreHand: restoreSpacepokerHand,
  proposalParameters: spacepokerProposalParameters,
  describeHandProposal(handProposal) {
    const params = spacepokerProposalParameters.decode(handProposal.parameters);
    if (!params) {
      throw new Error('Space Poker proposal parameters are invalid');
    }
    const stake = handProposal.playerAContribution;
    const stack = stake / params.betUnitMojos;
    return `Stake ${formatSpacepokerMojos(stake)} each · bet unit ${formatSpacepokerMojos(params.betUnitMojos)} · stack ${String(stack)}`;
  },
  handProposalsEqual: equalHandProposalBase,
};

export const spacepokerRegistration = registration;
export default registration;
