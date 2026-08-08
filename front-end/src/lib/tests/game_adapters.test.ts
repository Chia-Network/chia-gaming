import { Program } from 'clvm-lib';
import { calpokerAdapter } from '../../features/calPoker/adapter';
import { krunkAdapter, isValidKrunkStake } from '../../features/krunk/adapter';
import { spacepokerAdapter } from '../../features/spacePoker/adapter';
import { resolveSpacepokerUnitSize } from '../../features/spacePoker/unitSize';
import {
  decodeGameTerms,
  decodePersistedGameTerms,
  encodeGameProposalParameters,
  encodeGameTermsExtras,
  gameInitialTurn,
  gameTermsEqual,
  validateGameTerms,
} from '../gameRegistry';

const base = {
  myContribution: 100n,
  theirContribution: 100n,
  gameTimeout: 15n,
};

describe('pure game adapters', () => {
  it('encodes each factory parameter shape and lifecycle policy', () => {
    expect(
      encodeGameProposalParameters({ gameType: 'calpoker', ...base }, true).toList(),
    ).toHaveLength(2);
    expect(
      encodeGameProposalParameters({ gameType: 'spacepoker', ...base, unitSizeMojos: 10n }, true)
        .toList()
        .map((item) => item.toBigInt()),
    ).toEqual([100n, 10n, 0n]);
    expect(encodeGameProposalParameters({ gameType: 'krunk', ...base }, true).toBigInt()).toBe(
      100n,
    );
    expect(gameInitialTurn('calpoker', true)).toBe('their-turn');
    expect(gameInitialTurn('spacepoker', false)).toBe('my-turn');
    expect(gameInitialTurn('krunk', true)).toBe('their-turn');
  });

  it('decodes Space Poker only with a positive encoded unit', () => {
    expect(decodeGameTerms('spacepoker', base, Program.fromBigInt(10n).serialize())).toEqual({
      gameType: 'spacepoker',
      ...base,
      unitSizeMojos: 10n,
    });
    expect(decodeGameTerms('spacepoker', base, undefined)).toBeNull();
    expect(decodeGameTerms('spacepoker', base, Program.fromBigInt(0n).serialize())).toBeNull();
    expect(decodeGameTerms('spacepoker', base, Program.fromList([]).serialize())).toBeNull();
  });

  it('validates and compares terms through their owning adapter', () => {
    const spaceTerms = { gameType: 'spacepoker' as const, ...base, unitSizeMojos: 10n };
    expect(validateGameTerms(spaceTerms)).toBe(true);
    expect(gameTermsEqual(spaceTerms, { ...spaceTerms })).toBe(true);
    expect(gameTermsEqual(spaceTerms, { ...spaceTerms, unitSizeMojos: 20n })).toBe(false);
    expect(isValidKrunkStake(100n)).toBe(true);
    expect(isValidKrunkStake(101n)).toBe(false);
    expect(
      krunkAdapter.validateTerms({ gameType: 'krunk', ...base, theirContribution: 200n }),
    ).toBe(false);
    expect(calpokerAdapter.stateCodec.gameType).toBe('calpoker');
    expect(spacepokerAdapter.stateCodec.gameType).toBe('spacepoker');
  });

  it('round-trips persistence extras without manufacturing a unit', () => {
    const terms = { gameType: 'spacepoker' as const, ...base, unitSizeMojos: 25n };
    const extras = encodeGameTermsExtras(terms);
    expect(extras).toEqual({ spacepoker_unit_size: '25' });
    expect(decodePersistedGameTerms('spacepoker', base, extras)).toEqual(terms);
    expect(decodePersistedGameTerms('spacepoker', base, {})).toBeNull();
  });

  it('uses one resolver for terms, parameter bytes, and persisted state', () => {
    const terms = { gameType: 'spacepoker' as const, ...base, unitSizeMojos: 10n };
    expect(resolveSpacepokerUnitSize({ terms })).toBe(10n);
    expect(
      resolveSpacepokerUnitSize({
        terms,
        encodedParameterState: Program.fromBigInt(10n).serialize(),
      }),
    ).toBe(10n);
    expect(
      resolveSpacepokerUnitSize({
        terms,
        encodedParameterState: Program.fromBigInt(20n).serialize(),
      }),
    ).toBeNull();
  });
});
