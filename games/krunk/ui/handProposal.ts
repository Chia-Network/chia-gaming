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

export { krunkOutcomeFromPlay, reduceKrunkFeatureState } from './serialize';

export type KrunkFactoryParameters = bigint;

export const krunkProposalParameters: ProposalParameterCodec<KrunkFactoryParameters> = {
  decode: (value) => (typeof value === 'bigint' && isValidKrunkStake(value) ? value : null),
  encode: (value) => value,
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
    const stake = krunkProposalParameters.decode(handProposal.parameters);
    if (stake === null) {
      throw new Error('Krunk proposal parameters are invalid');
    }
    return `Stake ${formatKrunkMojos(stake)} each`;
  },
};

export default registration;
