import { Program } from 'clvm-lib';
import { equalBaseTerms, type GameAdapter } from '../../lib/gameAdapter';
import { calpokerStateCodec, type CalpokerHandState } from './stateCodec';

export const calpokerAdapter: GameAdapter<'calpoker', CalpokerHandState> = {
  gameType: 'calpoker',
  displayName: 'California Poker',
  stateCodec: calpokerStateCodec,
  lifecycle: {
    proposalSenderGoesFirst: (iStarted) => !iStarted,
    initialTurn: (iStarted) => (iStarted ? 'their-turn' : 'my-turn'),
  },
  compose: {
    defaultAmount: (_currentGameType, currentAmount) => currentAmount,
  },
  decodeProposalTerms: (base) => ({ gameType: 'calpoker', ...base }),
  encodeProposalParameters(terms, iStarted) {
    return Program.fromList([
      Program.fromBigInt(terms.myContribution),
      Program.fromBigInt(this.lifecycle.proposalSenderGoesFirst(iStarted) ? 1n : 0n),
    ]);
  },
  validateTerms: (terms) =>
    terms.myContribution > 0n && terms.theirContribution > 0n && terms.gameTimeout > 0n,
  termsEqual: equalBaseTerms,
  persistence: {
    encodeExtras: () => ({}),
    decodeExtras: (base) => ({ gameType: 'calpoker', ...base }),
  },
};
