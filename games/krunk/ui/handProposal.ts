import {
  equalHandProposalBase,
  type GamePackageRegistration,
  type HandProposal,
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

export type KrunkFactoryParameters = {
  stake: bigint;
};

export const krunkProposalParameters: ProposalParameterCodec<KrunkFactoryParameters> = {
  decode(value) {
    return typeof value === 'bigint' && value > 0n ? { stake: value } : null;
  },
  encode: (params) => params.stake,
};

export function isValidKrunkStake(stake: bigint): boolean {
  return stake > 0n && stake % 100n === 0n;
}

export function validateKrunkHandProposal(handProposal: HandProposal): boolean {
  return (
    handProposal.myContribution === handProposal.theirContribution &&
    isValidKrunkStake(handProposal.myContribution) &&
    handProposal.gameTimeout > 0n
  );
}

const registration: GamePackageRegistration<
  KrunkHandState,
  KrunkHand,
  { amount: bigint },
  KrunkFactoryParameters
> = {
  gameType: 'krunk',
  displayName: 'Krunk',
  createHand: createKrunkHand,
  restoreHand: restoreKrunkHand,
  proposalParameters: krunkProposalParameters,
  describeHandProposal: (handProposal) =>
    `Stake ${formatKrunkMojos(handProposal.myContribution)} each`,
  draft: {
    default: () => ({ amount: 100n }),
    fromHandProposal: (handProposal) => ({ amount: handProposal.myContribution }),
    update: (current, update) => ({ ...current, ...update }),
    toHandProposal(draft, gameTimeout) {
      const handProposal = {
        gameType: 'krunk',
        myContribution: draft.amount,
        theirContribution: draft.amount,
        gameTimeout,
      };
      return validateKrunkHandProposal(handProposal) ? handProposal : null;
    },
  },
  toProposalParameters: (handProposal) => ({ stake: handProposal.myContribution }),
  decodeHandProposal(base, params) {
    if (params.stake !== base.myContribution) return null;
    const handProposal = { gameType: 'krunk', ...base };
    return validateKrunkHandProposal(handProposal) ? handProposal : null;
  },
  validateHandProposal: validateKrunkHandProposal,
  handProposalsEqual: equalHandProposalBase,
};

export const krunkRegistration = registration;
export default registration;
