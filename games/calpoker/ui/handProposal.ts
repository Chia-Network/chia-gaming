import {
  equalHandProposalBase,
  type GamePackageRegistration,
  type HandProposal,
  type ProposalParameterCodec,
} from '../../host';
import {
  createCalpokerHand,
  restoreCalpokerHand,
  type CalpokerHand,
  type CalpokerHandState,
} from './serialize';
import { formatCalpokerMojos } from './formatting';

export {
  calpokerOutcomeFromState,
  isCalpokerOutcomeReadable,
  reduceCalpokerHandState,
  reduceCalpokerFeatureState,
} from './serialize';

export type CalpokerFactoryParameters = {
  perPlayerStake: bigint;
  senderGoesFirst: boolean;
};

export const calpokerProposalParameters: ProposalParameterCodec<CalpokerFactoryParameters> = {
  decode(value) {
    if (
      !Array.isArray(value) ||
      value.length !== 2 ||
      typeof value[0] !== 'bigint' ||
      value[0] <= 0n ||
      typeof value[1] !== 'boolean'
    ) {
      return null;
    }
    const [perPlayerStake, senderGoesFirst] = value;
    return { perPlayerStake, senderGoesFirst };
  },
  encode: (params) => [params.perPlayerStake, params.senderGoesFirst],
};

export function validateCalpokerHandProposal(handProposal: HandProposal): boolean {
  return (
    handProposal.myContribution === handProposal.theirContribution &&
    handProposal.myContribution > 0n &&
    handProposal.gameTimeout > 0n
  );
}

const registration: GamePackageRegistration<
  CalpokerHandState,
  CalpokerHand,
  { amount: bigint },
  CalpokerFactoryParameters
> = {
  gameType: 'calpoker',
  displayName: 'California Poker',
  canRemountFinished: true,
  createHand: createCalpokerHand,
  restoreHand: restoreCalpokerHand,
  proposalParameters: calpokerProposalParameters,
  describeHandProposal: (handProposal) =>
    `Stake ${formatCalpokerMojos(handProposal.myContribution)} each`,
  validateHandIds: (gameIds) => gameIds.length === 1,
  selectOutcome: (state) =>
    state.outcome ? { my_win_outcome: state.outcome.my_win_outcome } : null,
  lifecycle: {
    proposalSenderGoesFirst: (iStarted) => !iStarted,
  },
  draft: {
    default: (perGameAmount) => ({ amount: perGameAmount }),
    fromHandProposal: (handProposal) => ({ amount: handProposal.myContribution }),
    update: (current, update) => ({ ...current, ...update }),
    toHandProposal(draft, gameTimeout) {
      const handProposal = {
        gameType: 'calpoker',
        myContribution: draft.amount,
        theirContribution: draft.amount,
        gameTimeout,
      };
      return validateCalpokerHandProposal(handProposal) ? handProposal : null;
    },
  },
  toProposalParameters(handProposal, iStarted) {
    return {
      perPlayerStake: handProposal.myContribution,
      senderGoesFirst: this.lifecycle.proposalSenderGoesFirst(iStarted),
    };
  },
  decodeHandProposal(base, params, context) {
    if (
      params.perPlayerStake !== base.myContribution ||
      params.senderGoesFirst !== context.expectedSenderGoesFirst
    ) {
      return null;
    }
    const handProposal = { gameType: 'calpoker', ...base };
    return validateCalpokerHandProposal(handProposal) ? handProposal : null;
  },
  validateHandProposal: validateCalpokerHandProposal,
  handProposalsEqual: equalHandProposalBase,
  persistence: {
    encodeExtras: () => ({}),
    decodeExtras(base) {
      const handProposal = { gameType: 'calpoker', ...base };
      return validateCalpokerHandProposal(handProposal) ? handProposal : null;
    },
  },
};

export const calpokerRegistration = registration;
export default registration;
