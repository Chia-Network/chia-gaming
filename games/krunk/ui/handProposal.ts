import {
  equalHandProposalBase,
  type GameFeatureRegistration,
  type HandProposal,
  type ProposalParameterCodec,
} from '../../host';
import {
  decodeKrunkGameState,
  krunkStateCodec,
  reduceKrunkDurableState,
  type KrunkGameState,
  type KrunkHandState,
} from './serialize';

export {
  applyKrunkMoveRejected,
  krunkOutcomeFromPlay,
  reduceKrunkDurableState,
  reduceKrunkFeatureState,
} from './serialize';

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

const registration: GameFeatureRegistration<
  KrunkHandState,
  KrunkGameState,
  { amount: bigint },
  KrunkFactoryParameters
> = {
  gameType: 'krunk',
  displayName: 'Krunk',
  stateCodec: krunkStateCodec,
  proposalParameters: krunkProposalParameters,
  describeHandProposal: (handProposal, { formatMojos }) =>
    `Stake ${formatMojos(handProposal.myContribution)} each`,
  handMembershipDescription:
    'exactly two ordered currentHandGameIds whose payload IDs exactly match currentHandGameIds in order',
  validateHandMembership(gameIds, state) {
    if (gameIds.length !== 2) return false;
    if (state === null) return true;
    const payloadIds = Object.keys(state.games);
    return (
      payloadIds.length === 2 &&
      payloadIds.every((id, index) => id === gameIds[index]) &&
      state.games[gameIds[0]].role !== state.games[gameIds[1]].role
    );
  },
  decodeFeatureState: decodeKrunkGameState,
  selectOutcome: (state, gameId) => {
    const outcome = state.games[gameId]?.outcome;
    return outcome ? { my_win_outcome: outcome } : null;
  },
  lifecycle: {
    proposalSenderGoesFirst: (iStarted) => !iStarted,
  },
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
  persistence: {
    encodeExtras: () => ({}),
    decodeExtras(base) {
      const handProposal = { gameType: 'krunk', ...base };
      return validateKrunkHandProposal(handProposal) ? handProposal : null;
    },
  },
  durableState: {
    initialize(current, input) {
      return reduceKrunkDurableState(current, input)!;
    },
    reduceInput(current, input) {
      return reduceKrunkDurableState(current, input)!;
    },
    applyFeatureState(current, gameId, state) {
      return { games: { ...current.games, [gameId]: state } };
    },
  },
};

export const krunkRegistration = registration;
export default registration;
