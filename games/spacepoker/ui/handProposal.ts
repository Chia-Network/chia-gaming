import type { GamePackageRegistration } from '../../host';
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
  reduceSpacepokerFeatureState,
  reduceSpacepokerSettlementState,
} from './serialize';

const registration: GamePackageRegistration<
  SpacepokerHandState,
  SpacepokerHand,
  SpacepokerFactoryParameters
> = {
  displayName: 'Space Poker',
  createHand: createSpacepokerHand,
  restoreHand: restoreSpacepokerHand,
  proposalParameters: spacepokerProposalParameters,
  describeHandProposal(handProposal) {
    const params = spacepokerProposalParameters.decode(handProposal.parameters);
    if (!params) {
      throw new Error('Space Poker proposal parameters are invalid');
    }
    if (params.stackSize === 0n) {
      return `No limit · minimum raise ${formatSpacepokerMojos(params.betUnitMojos)}`;
    }
    const stake = params.stackSize * params.betUnitMojos;
    return `Stake ${formatSpacepokerMojos(stake)} each · minimum raise ${formatSpacepokerMojos(params.betUnitMojos)} · stack ${String(params.stackSize)}`;
  },
};

export default registration;
