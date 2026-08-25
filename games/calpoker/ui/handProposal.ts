import {
  equalHandProposalBase,
  type GameFeatureRegistration,
  type HandProposal,
  type ProposalParameterCodec,
} from '../../host';
import {
  calpokerStateCodec,
  reduceCalpokerDurableState,
  type CalpokerHandState,
} from './serialize';

export {
  calpokerOutcomeFromState,
  isCalpokerOutcomeReadable,
  reduceCalpokerDurableState,
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

const registration: GameFeatureRegistration<
  CalpokerHandState,
  CalpokerHandState,
  { amount: bigint },
  CalpokerFactoryParameters
> = {
  gameType: 'calpoker',
  displayName: 'California Poker',
  stateCodec: calpokerStateCodec,
  proposalParameters: calpokerProposalParameters,
  describeHandProposal: (handProposal, { formatMojos }) =>
    `Stake ${formatMojos(handProposal.myContribution)} each`,
  handMembershipDescription: 'exactly one currentHandGameId',
  validateHandMembership: (gameIds) => gameIds.length === 1,
  decodeFeatureState: (value) => (calpokerStateCodec.isState(value) ? value : null),
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
  durableState: {
    initialize(current, input) {
      return reduceCalpokerDurableState(current, input)!;
    },
    reduceInput(current, input) {
      return reduceCalpokerDurableState(current, input)!;
    },
    applyFeatureState: (_current, _gameId, state) => state,
  },
};

export const calpokerRegistration = registration;
export default registration;
