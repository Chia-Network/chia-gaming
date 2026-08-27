import {
  type GamePackageRegistration,
  type ProposalParameterCodec,
} from '../../host';
import {
  createKrunkHand,
  restoreKrunkHand,
  type KrunkHand,
  type KrunkHandState,
} from './serialize';
import { formatKrunkMojos } from './formatting';

export { krunkOutcomeFromPlay, reduceKrunkHandState, reduceKrunkFeatureState } from './serialize';

export type KrunkFactoryParameters = Record<string, never>;

export const krunkProposalParameters: ProposalParameterCodec<KrunkFactoryParameters> = {
  decode: (value) => (value === null ? {} : null),
  encode: () => null,
};

export function isValidKrunkStake(stake: bigint): boolean {
  return stake > 0n && stake % 100n === 0n;
}

const registration: GamePackageRegistration<
  KrunkHandState,
  KrunkHand,
  KrunkFactoryParameters
> = {
  displayName: 'Krunk',
  createHand: createKrunkHand,
  restoreHand: restoreKrunkHand,
  proposalParameters: krunkProposalParameters,
  describeHandProposal(handProposal) {
    if (krunkProposalParameters.decode(handProposal.parameters) === null) {
      throw new Error('Krunk proposal parameters are invalid');
    }
    return `Stake ${formatKrunkMojos(handProposal.playerAContribution)} each`;
  },
};

export default registration;
