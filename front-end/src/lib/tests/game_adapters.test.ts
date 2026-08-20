import { Program } from 'clvm-lib';
import calpokerPackage from '@games/calpoker/ui/package';
import { calpokerRegistration } from '@games/calpoker/ui/adapter';
import { krunkRegistration, isValidKrunkStake } from '@games/krunk/ui/adapter';
import { spacepokerRegistration } from '@games/spacepoker/ui/adapter';
import { resolveSpacepokerUnitSize } from '@games/spacepoker/ui/unitSize';
import {
  decodeGameTerms,
  decodePersistedGameTerms,
  encodeGameProposalParameters,
  encodeGameTermsExtras,
  gameTermsEqual,
  packageFor,
  REGISTERED_GAMES,
  isCatalogGameType,
  validateGameTerms,
} from '../gameRegistry';
import {
  catalogGameTypeFromWire,
  protocolIdForCatalog,
  resetProtocolIds,
  setProtocolIds,
} from '../gameIdentities';
import { TEST_PROTOCOL_IDS } from './protocolIdentities';

const BOUND_IDS = TEST_PROTOCOL_IDS;

const base = {
  myContribution: 100n,
  theirContribution: 100n,
  gameTimeout: 15n,
};

describe('pure game registrations', () => {
  it('derives display metadata from the keyed registration source', () => {
    expect(
      REGISTERED_GAMES.map(({ gameType, displayName }) => ({
        gameType,
        displayName,
      })),
    ).toEqual([
      { gameType: 'calpoker', displayName: 'California Poker' },
      { gameType: 'spacepoker', displayName: 'Space Poker' },
      { gameType: 'krunk', displayName: 'Krunk' },
    ]);
    expect(packageFor('calpoker')).toBe(calpokerPackage);
  });

  it('exposes a factory-parameter codec on each game package', () => {
    const calParams = calpokerRegistration.toFactoryParameters(
      { gameType: 'calpoker', ...base },
      true,
    );
    const spaceParams = spacepokerRegistration.toFactoryParameters(
      { gameType: 'spacepoker', ...base, unitSizeMojos: 10n },
      true,
    );
    const krunkParams = krunkRegistration.toFactoryParameters({ gameType: 'krunk', ...base }, true);
    expect(calParams).toEqual({ perPlayerStake: 100n, senderGoesFirst: false });
    expect(spaceParams).toEqual({
      perPlayerStake: 100n,
      betUnit: 10n,
      senderGoesFirst: false,
    });
    expect(krunkParams).toEqual({ stake: 100n });
    expect(
      calpokerRegistration.factoryParameters.decode(
        calpokerRegistration.factoryParameters.encode(calParams).serialize(),
      ),
    ).toEqual(calParams);
    expect(
      spacepokerRegistration.factoryParameters.decode(
        spacepokerRegistration.factoryParameters.encode(spaceParams).serialize(),
      ),
    ).toEqual(spaceParams);
    expect(
      krunkRegistration.factoryParameters.decode(
        krunkRegistration.factoryParameters.encode(krunkParams).serialize(),
      ),
    ).toEqual(krunkParams);
    expect(
      calpokerRegistration.factoryParameters.decode(
        spacepokerRegistration.factoryParameters.encode(spaceParams).serialize(),
      ),
    ).toBeNull();
    expect(
      spacepokerRegistration.factoryParameters.decode(
        krunkRegistration.factoryParameters.encode(krunkParams).serialize(),
      ),
    ).toBeNull();
    expect(
      krunkRegistration.factoryParameters.decode(
        calpokerRegistration.factoryParameters.encode(calParams).serialize(),
      ),
    ).toBeNull();
    const formatMojos = (mojos: bigint) => `${mojos} MOJO`;
    expect(
      calpokerRegistration.describeTerms({ gameType: 'calpoker', ...base }, { formatMojos }),
    ).toBe('Stake 100 MOJO each');
    expect(
      spacepokerRegistration.describeTerms(
        { gameType: 'spacepoker', ...base, unitSizeMojos: 10n },
        { formatMojos },
      ),
    ).toBe('Stake 100 MOJO each · unit 10 MOJO · stack 10');
    expect(krunkRegistration.describeTerms({ gameType: 'krunk', ...base }, { formatMojos })).toBe(
      'Stake 100 MOJO each',
    );
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

  it('round-trips each game through its own factory decoder', () => {
    const cal = encodeGameProposalParameters({ gameType: 'calpoker', ...base }, true).serialize();
    const space = encodeGameProposalParameters(
      { gameType: 'spacepoker', ...base, unitSizeMojos: 10n },
      true,
    ).serialize();
    const krunk = encodeGameProposalParameters({ gameType: 'krunk', ...base }, true).serialize();
    expect(decodeGameTerms('calpoker', base, cal)).toEqual({ gameType: 'calpoker', ...base });
    expect(decodeGameTerms('spacepoker', base, space)).toEqual({
      gameType: 'spacepoker',
      ...base,
      unitSizeMojos: 10n,
    });
    expect(decodeGameTerms('krunk', base, krunk)).toEqual({ gameType: 'krunk', ...base });
    expect(decodeGameTerms('calpoker', base, space)).toBeNull();
    expect(decodeGameTerms('calpoker', base, krunk)).toBeNull();
    expect(decodeGameTerms('spacepoker', base, cal)).toBeNull();
    expect(decodeGameTerms('spacepoker', base, krunk)).toBeNull();
    expect(decodeGameTerms('krunk', base, cal)).toBeNull();
    expect(decodeGameTerms('krunk', base, space)).toBeNull();
    expect(decodeGameTerms('spacepoker', base, undefined)).toBeNull();
    expect(decodeGameTerms('spacepoker', base, Program.fromBigInt(10n).serialize())).toBeNull();
    expect(decodeGameTerms('spacepoker', base, Program.fromList([]).serialize())).toBeNull();
  });

  it('keeps package keys in the model after protocol identities are ready', () => {
    resetProtocolIds();
    expect(() => protocolIdForCatalog('calpoker')).toThrow(/No protocol identity/);
    expect(isCatalogGameType(BOUND_IDS[0].id)).toBe(false);
    expect(catalogGameTypeFromWire(BOUND_IDS[0].id)).toBeNull();
    setProtocolIds(BOUND_IDS);
    try {
      expect(packageFor('calpoker').gameType).toBe('calpoker');
      expect(isCatalogGameType(BOUND_IDS[0].id)).toBe(false);
      expect(calpokerRegistration.stateCodec.gameType).toBe('calpoker');
      expect(protocolIdForCatalog('calpoker')).toBe(BOUND_IDS[0].id);
      expect(catalogGameTypeFromWire('calpoker')).toBeNull();
      expect(catalogGameTypeFromWire(BOUND_IDS[0].id)).toBe('calpoker');
      expect(REGISTERED_GAMES.map((game) => game.gameType)).toEqual([
        'calpoker',
        'spacepoker',
        'krunk',
      ]);
      const cal = encodeGameProposalParameters({ gameType: 'calpoker', ...base }, true).serialize();
      expect(decodeGameTerms('calpoker', base, cal)).toEqual({
        gameType: 'calpoker',
        ...base,
      });
    } finally {
      resetProtocolIds();
    }
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
        encodeGameProposalParameters({ gameType: 'calpoker', ...base }, true).serialize(),
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
    expect(
      decodeGameTerms(
        'calpoker',
        invalid,
        Program.fromList([
          Program.fromBigInt(invalid.myContribution),
          Program.fromBigInt(1n),
        ]).serialize(),
      ),
    ).toBeNull();
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
        ? Program.fromList([
            Program.fromBigInt(invalid.myContribution),
            Program.fromBigInt(BigInt(unit)),
            Program.fromBigInt(1n),
          ]).serialize()
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
        encodedParameterState: encodeGameProposalParameters(terms, true).serialize(),
      }),
    ).toBe(10n);
    expect(
      resolveSpacepokerUnitSize({
        terms,
        encodedParameterState: encodeGameProposalParameters(
          { ...terms, unitSizeMojos: 20n },
          true,
        ).serialize(),
      }),
    ).toBeNull();
  });
});
