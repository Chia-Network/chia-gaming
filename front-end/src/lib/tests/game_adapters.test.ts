import { Program } from 'clvm-lib';
import { calpokerRegistration } from '../../features/calPoker/adapter';
import { krunkRegistration, isValidKrunkStake } from '../../features/krunk/adapter';
import { spacepokerRegistration } from '../../features/spacePoker/adapter';
import { resolveSpacepokerUnitSize } from '../../features/spacePoker/unitSize';
import {
  decodeGameTerms,
  decodePersistedGameTerms,
  encodeGameProposalParameters,
  encodeGameTermsExtras,
  gameTermsEqual,
  GAME_REGISTRATIONS,
  REGISTERED_GAMES,
  validateGameTerms,
} from '../gameRegistry';

const base = {
  myContribution: 100n,
  theirContribution: 100n,
  gameTimeout: 15n,
};

describe('pure game registrations', () => {
  it('derives display metadata from the keyed registration source', () => {
    expect(REGISTERED_GAMES).toEqual([
      { gameType: 'calpoker', displayName: 'California Poker' },
      { gameType: 'spacepoker', displayName: 'Space Poker' },
      { gameType: 'krunk', displayName: 'Krunk' },
    ]);
    expect(GAME_REGISTRATIONS.calpoker).toBe(calpokerRegistration);
  });

  it('encodes each factory parameter shape', () => {
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
    expect(
      calpokerRegistration.validateTerms({
        gameType: 'calpoker',
        ...base,
        theirContribution: 200n,
      }),
    ).toBe(false);
    expect(
      decodeGameTerms(
        'calpoker',
        { ...base, theirContribution: 200n },
        Program.fromList([]).serialize(),
      ),
    ).toBeNull();
    expect(
      decodePersistedGameTerms('calpoker', { ...base, theirContribution: 200n }, {}),
    ).toBeNull();
    expect(
      spacepokerRegistration.validateTerms({
        ...spaceTerms,
        theirContribution: 200n,
      }),
    ).toBe(false);
    expect(
      spacepokerRegistration.validateTerms({
        ...spaceTerms,
        myContribution: 101n,
        theirContribution: 101n,
      }),
    ).toBe(false);
    expect(gameTermsEqual(spaceTerms, { ...spaceTerms })).toBe(true);
    expect(gameTermsEqual(spaceTerms, { ...spaceTerms, unitSizeMojos: 20n })).toBe(false);
    expect(isValidKrunkStake(100n)).toBe(true);
    expect(isValidKrunkStake(101n)).toBe(false);
    expect(
      krunkRegistration.validateTerms({ gameType: 'krunk', ...base, theirContribution: 200n }),
    ).toBe(false);
    expect(calpokerRegistration.stateCodec.gameType).toBe('calpoker');
    expect(spacepokerRegistration.stateCodec.gameType).toBe('spacepoker');
  });

  it('round-trips persistence extras without manufacturing a unit', () => {
    const terms = { gameType: 'spacepoker' as const, ...base, unitSizeMojos: 25n };
    const extras = encodeGameTermsExtras(terms);
    expect(extras).toEqual({ spacepoker_unit_size: '25' });
    expect(decodePersistedGameTerms('spacepoker', base, extras)).toEqual(terms);
    expect(decodePersistedGameTerms('spacepoker', base, {})).toBeNull();
  });

  it.each([
    ['zero contribution', { ...base, myContribution: 0n, theirContribution: 0n }],
    ['unequal contribution', { ...base, theirContribution: 99n }],
  ])('rejects invalid Calpoker %s in proposal and persistence decoders', (_label, invalid) => {
    expect(decodeGameTerms('calpoker', invalid, undefined)).toBeNull();
    expect(decodePersistedGameTerms('calpoker', invalid, {})).toBeNull();
  });

  it.each([
    ['zero contribution', { ...base, myContribution: 0n, theirContribution: 0n }, '10'],
    ['unequal contribution', { ...base, theirContribution: 90n }, '10'],
    ['nondivisible contribution', { ...base, myContribution: 101n, theirContribution: 101n }, '10'],
    ['zero timeout', { ...base, gameTimeout: 0n }, '10'],
    ['negative timeout', { ...base, gameTimeout: -1n }, '10'],
    ['zero unit', base, '0'],
    ['negative unit', base, '-10'],
    ['invalid unit', base, 'not-a-unit'],
  ])(
    'rejects invalid Space Poker %s in proposal and persistence decoders',
    (_label, invalid, unit) => {
      const parameterState = /^-?\d+$/.test(unit)
        ? Program.fromBigInt(BigInt(unit)).serialize()
        : new Uint8Array([0xff]);
      expect(decodeGameTerms('spacepoker', invalid, parameterState)).toBeNull();
      expect(
        decodePersistedGameTerms('spacepoker', invalid, { spacepoker_unit_size: unit }),
      ).toBeNull();
    },
  );

  it('keeps valid Calpoker and Space Poker terms round-trippable', () => {
    const calTerms = { gameType: 'calpoker' as const, ...base };
    const spaceTerms = { gameType: 'spacepoker' as const, ...base, unitSizeMojos: 20n };
    expect(decodePersistedGameTerms('calpoker', base, encodeGameTermsExtras(calTerms))).toEqual(
      calTerms,
    );
    expect(decodePersistedGameTerms('spacepoker', base, encodeGameTermsExtras(spaceTerms))).toEqual(
      spaceTerms,
    );
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
