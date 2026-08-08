import { Program } from 'clvm-lib';
import { equalBaseTerms, type GameAdapter } from '../../lib/gameAdapter';
import { krunkStateCodec, type KrunkHandState } from './stateCodec';

export function isValidKrunkStake(stake: bigint): boolean {
  return stake > 0n && stake % 100n === 0n;
}

export const krunkAdapter: GameAdapter<'krunk', KrunkHandState> = {
  gameType: 'krunk',
  displayName: 'Krunk',
  stateCodec: krunkStateCodec,
  lifecycle: {
    proposalSenderGoesFirst: (iStarted) => !iStarted,
    initialTurn: (iStarted) => (iStarted ? 'their-turn' : 'my-turn'),
  },
  compose: {
    defaultAmount: (currentGameType, currentAmount) =>
      currentGameType === 'krunk' ? currentAmount : 100n,
  },
  decodeProposalTerms: (base) => ({ gameType: 'krunk', ...base }),
  encodeProposalParameters: (terms) => Program.fromBigInt(terms.myContribution),
  validateTerms: (terms) =>
    terms.myContribution === terms.theirContribution &&
    isValidKrunkStake(terms.myContribution) &&
    terms.gameTimeout > 0n,
  termsEqual: equalBaseTerms,
  persistence: {
    encodeExtras: () => ({}),
    decodeExtras: (base) => ({ gameType: 'krunk', ...base }),
  },
};
