import { Program } from 'clvm-lib';
import { equalBaseTerms, type GameAdapter } from '../../lib/gameAdapter';
import { spacepokerStateCodec, type SpacepokerHandState } from './stateCodec';
import { resolveSpacepokerUnitSize } from './unitSize';

export const spacepokerAdapter: GameAdapter<'spacepoker', SpacepokerHandState> = {
  gameType: 'spacepoker',
  displayName: 'Space Poker',
  stateCodec: spacepokerStateCodec,
  lifecycle: {
    proposalSenderGoesFirst: (iStarted) => !iStarted,
    initialTurn: (iStarted) => (iStarted ? 'their-turn' : 'my-turn'),
  },
  compose: {
    defaultAmount: (_currentGameType, currentAmount) => currentAmount,
  },
  decodeProposalTerms(base, parameterState) {
    const unitSizeMojos = resolveSpacepokerUnitSize({ encodedParameterState: parameterState });
    return unitSizeMojos ? { gameType: 'spacepoker', ...base, unitSizeMojos } : null;
  },
  encodeProposalParameters(terms, iStarted) {
    const unitSizeMojos = resolveSpacepokerUnitSize({ terms });
    if (!unitSizeMojos || !this.validateTerms(terms)) {
      throw new Error('Space Poker proposal requires a valid positive unit size');
    }
    return Program.fromList([
      Program.fromBigInt(terms.myContribution),
      Program.fromBigInt(unitSizeMojos),
      Program.fromBigInt(this.lifecycle.proposalSenderGoesFirst(iStarted) ? 1n : 0n),
    ]);
  },
  validateTerms: (terms) =>
    terms.myContribution > 0n &&
    terms.theirContribution > 0n &&
    terms.gameTimeout > 0n &&
    resolveSpacepokerUnitSize({ terms }) !== null,
  termsEqual: (a, b) => equalBaseTerms(a, b) && a.unitSizeMojos === b.unitSizeMojos,
  persistence: {
    encodeExtras: (terms) => ({ spacepoker_unit_size: terms.unitSizeMojos.toString() }),
    decodeExtras(base, extras) {
      const raw = extras.spacepoker_unit_size;
      if (raw === undefined) return null;
      try {
        const unitSizeMojos = BigInt(raw);
        const terms = { gameType: 'spacepoker' as const, ...base, unitSizeMojos };
        return spacepokerAdapter.validateTerms(terms) ? terms : null;
      } catch {
        return null;
      }
    },
  },
};
