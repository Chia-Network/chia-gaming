import {
  equalHandProposalBase,
  type GameFeatureRegistration,
  type HandProposal,
} from '../../host';
import { reduceSpacepokerDurableState, spacepokerStateCodec, type SpacepokerHandState } from './serialize';
import {
  resolveSpacepokerUnitSize,
  spacepokerFactoryParameters,
  spacepokerTermsOf,
  type SpacepokerFactoryParameters,
} from './unitSize';

export {
  reduceSpacepokerDurableState,
  reduceSpacepokerFeatureState,
  reduceSpacepokerSettlementState,
} from './serialize';

export function validateSpacepokerHandProposal(handProposal: HandProposal): boolean {
  const space = spacepokerTermsOf(handProposal);
  return (
    space !== null &&
    space.myContribution === space.theirContribution &&
    space.myContribution > 0n &&
    space.gameTimeout > 0n &&
    resolveSpacepokerUnitSize({ terms: space }) !== null &&
    space.myContribution % space.unitSizeMojos === 0n
  );
}

const registration: GameFeatureRegistration<
  SpacepokerHandState,
  SpacepokerHandState,
  { unitSize: bigint; stackSize: bigint },
  SpacepokerFactoryParameters
> = {
  gameType: 'spacepoker',
  displayName: 'Space Poker',
  stateCodec: spacepokerStateCodec,
  factoryParameters: spacepokerFactoryParameters,
  describeHandProposal(handProposal, { formatMojos }) {
    const space = spacepokerTermsOf(handProposal);
    if (!space) return `Stake ${formatMojos(handProposal.myContribution)} each`;
    const stack = space.myContribution / space.unitSizeMojos;
    return `Stake ${formatMojos(space.myContribution)} each · unit ${formatMojos(space.unitSizeMojos)} · stack ${String(stack)}`;
  },
  handMembershipDescription: 'exactly one currentHandGameId',
  validateHandMembership: (gameIds) => gameIds.length === 1,
  decodeFeatureState: (value) => (spacepokerStateCodec.isState(value) ? value : null),
  lifecycle: {
    proposalSenderGoesFirst: (iStarted) => !iStarted,
  },
  draft: {
    default: () => ({ unitSize: 1n, stackSize: 10n }),
    fromHandProposal: (handProposal) => {
      const unitSize = spacepokerTermsOf(handProposal)?.unitSizeMojos ?? 1n;
      return {
        unitSize,
        stackSize: unitSize > 0n ? handProposal.myContribution / unitSize : 10n,
      };
    },
    update: (current, update) => ({ ...current, ...update }),
    toHandProposal(draft, gameTimeout) {
      if (draft.stackSize > BigInt(Number.MAX_SAFE_INTEGER) || draft.stackSize <= 0n) return null;
      const amount = draft.unitSize * draft.stackSize;
      const handProposal = {
        gameType: 'spacepoker',
        myContribution: amount,
        theirContribution: amount,
        gameTimeout,
        unitSizeMojos: draft.unitSize,
      };
      return validateSpacepokerHandProposal(handProposal) ? handProposal : null;
    },
  },
  toFactoryParameters(handProposal, iStarted) {
    const betUnit = resolveSpacepokerUnitSize({ terms: handProposal });
    if (!betUnit || !this.validateHandProposal(handProposal)) {
      throw new Error('Space Poker proposal requires a valid positive unit size');
    }
    return {
      perPlayerStake: handProposal.myContribution,
      betUnit,
      senderGoesFirst: this.lifecycle.proposalSenderGoesFirst(iStarted),
    };
  },
  decodeHandProposal(base, params) {
    if (params.perPlayerStake !== base.myContribution) return null;
    const handProposal = {
      gameType: 'spacepoker',
      ...base,
      unitSizeMojos: params.betUnit,
    };
    return validateSpacepokerHandProposal(handProposal) ? handProposal : null;
  },
  validateHandProposal: validateSpacepokerHandProposal,
  handProposalsEqual: (a, b) => {
    const left = spacepokerTermsOf(a);
    const right = spacepokerTermsOf(b);
    return (
      left !== null &&
      right !== null &&
      equalHandProposalBase(left, right) &&
      left.unitSizeMojos === right.unitSizeMojos
    );
  },
  persistence: {
    encodeExtras: (handProposal) => {
      const space = spacepokerTermsOf(handProposal);
      return space === null ? {} : { spacepoker_unit_size: space.unitSizeMojos.toString() };
    },
    decodeExtras(base, extras) {
      const raw = extras.spacepoker_unit_size;
      if (raw === undefined) return null;
      try {
        const unitSizeMojos = BigInt(raw);
        const handProposal = { gameType: 'spacepoker', ...base, unitSizeMojos };
        return validateSpacepokerHandProposal(handProposal) ? handProposal : null;
      } catch {
        return null;
      }
    },
  },
  durableState: {
    reduceEvent: reduceSpacepokerDurableState,
  },
};

export const spacepokerRegistration = registration;
export default registration;
