import calpokerPackage from '@games/calpoker/ui/handProposal';
import { calpokerRegistration } from '@games/calpoker/ui/handProposal';
import { krunkRegistration, isValidKrunkStake } from '@games/krunk/ui/handProposal';
import { spacepokerRegistration } from '@games/spacepoker/ui/handProposal';
import { resolveSpacepokerUnitSize } from '@games/spacepoker/ui/unitSize';
import {
  decodeHandProposal,
  decodePersistedHandProposal,
  encodeHandProposalExtras,
  handProposalsEqual,
  packageFor,
  createRegisteredGameHand,
  REGISTERED_GAMES,
  isCatalogGameType,
  validateHandProposal,
} from '../gameRegistry';
import { encodeGameProposalParameters, decodeProposalMadeTerms } from '../gameProposalCodec';
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
const peerSenderSecond = { iStarted: false, origin: 'peer' as const };
const peerSenderFirst = { iStarted: true, origin: 'peer' as const };

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
    expect(packageFor('calpoker').gameType).toBe(calpokerPackage.gameType);
    expect(packageFor('calpoker').displayName).toBe(calpokerPackage.displayName);
  });

  it('exposes a structured proposal-parameter codec on each game package', () => {
    const calParams = calpokerRegistration.toProposalParameters(
      { gameType: 'calpoker', ...base },
      true,
    );
    const spaceParams = spacepokerRegistration.toProposalParameters(
      { gameType: 'spacepoker', ...base, unitSizeMojos: 10n },
      true,
    );
    const krunkParams = krunkRegistration.toProposalParameters(
      { gameType: 'krunk', ...base },
      true,
    );
    expect(calParams).toEqual({ perPlayerStake: 100n, senderGoesFirst: false });
    expect(spaceParams).toEqual({
      perPlayerStake: 100n,
      betUnit: 10n,
      senderGoesFirst: false,
    });
    expect(krunkParams).toEqual({ stake: 100n });
    expect(
      calpokerRegistration.proposalParameters.decode(
        calpokerRegistration.proposalParameters.encode(calParams),
      ),
    ).toEqual(calParams);
    expect(
      spacepokerRegistration.proposalParameters.decode(
        spacepokerRegistration.proposalParameters.encode(spaceParams),
      ),
    ).toEqual(spaceParams);
    expect(
      krunkRegistration.proposalParameters.decode(
        krunkRegistration.proposalParameters.encode(krunkParams),
      ),
    ).toEqual(krunkParams);
    expect(
      calpokerRegistration.proposalParameters.decode(
        spacepokerRegistration.proposalParameters.encode(spaceParams),
      ),
    ).toBeNull();
    expect(
      spacepokerRegistration.proposalParameters.decode(
        krunkRegistration.proposalParameters.encode(krunkParams),
      ),
    ).toBeNull();
    expect(
      krunkRegistration.proposalParameters.decode(
        calpokerRegistration.proposalParameters.encode(calParams),
      ),
    ).toBeNull();
    expect(calpokerRegistration.proposalParameters.decode([100n, 0n])).toBeNull();
    expect(calpokerRegistration.proposalParameters.decode([100n, false, 1n])).toBeNull();
    expect(spacepokerRegistration.proposalParameters.decode([100n, 10n, 0n])).toBeNull();
    expect(calpokerRegistration.describeHandProposal({ gameType: 'calpoker', ...base })).toBe(
      'Stake 100 mojos each',
    );
    expect(
      spacepokerRegistration.describeHandProposal({
        gameType: 'spacepoker',
        ...base,
        unitSizeMojos: 10n,
      }),
    ).toBe('Stake 100 mojos each · unit 10 mojos · stack 10');
    expect(krunkRegistration.describeHandProposal({ gameType: 'krunk', ...base })).toBe(
      'Stake 100 mojos each',
    );
  });

  it('encodes each structured proposal parameter shape', () => {
    expect(encodeGameProposalParameters({ gameType: 'calpoker', ...base }, true)).toEqual([
      100n,
      false,
    ]);
    expect(
      encodeGameProposalParameters({ gameType: 'spacepoker', ...base, unitSizeMojos: 10n }, true),
    ).toEqual([100n, 10n, false]);
    expect(encodeGameProposalParameters({ gameType: 'krunk', ...base }, true)).toBe(100n);
  });

  it('round-trips each game through its own factory decoder', () => {
    const cal = encodeGameProposalParameters({ gameType: 'calpoker', ...base }, true);
    const space = encodeGameProposalParameters(
      { gameType: 'spacepoker', ...base, unitSizeMojos: 10n },
      true,
    );
    const krunk = encodeGameProposalParameters({ gameType: 'krunk', ...base }, true);
    expect(decodeHandProposal('calpoker', base, cal, peerSenderSecond)).toEqual({
      gameType: 'calpoker',
      ...base,
    });
    expect(decodeHandProposal('spacepoker', base, space, peerSenderSecond)).toEqual({
      gameType: 'spacepoker',
      ...base,
      unitSizeMojos: 10n,
    });
    expect(decodeHandProposal('krunk', base, krunk, peerSenderSecond)).toEqual({
      gameType: 'krunk',
      ...base,
    });
    expect(decodeHandProposal('calpoker', base, space, peerSenderSecond)).toBeNull();
    expect(decodeHandProposal('calpoker', base, krunk, peerSenderSecond)).toBeNull();
    expect(decodeHandProposal('spacepoker', base, cal, peerSenderSecond)).toBeNull();
    expect(decodeHandProposal('spacepoker', base, krunk, peerSenderSecond)).toBeNull();
    expect(decodeHandProposal('krunk', base, cal, peerSenderSecond)).toBeNull();
    expect(decodeHandProposal('krunk', base, space, peerSenderSecond)).toBeNull();
    expect(decodeHandProposal('spacepoker', base, undefined, peerSenderSecond)).toBeNull();
    expect(decodeHandProposal('spacepoker', base, 10n, peerSenderSecond)).toBeNull();
    expect(decodeHandProposal('spacepoker', base, [], peerSenderSecond)).toBeNull();
  });

  it('creates a game-owned hand and restores complete state through its contract', () => {
    const handProposal = { gameType: 'calpoker' as const, ...base };
    const hand = createRegisteredGameHand('calpoker', {
      gameIds: ['7'],
      iStarted: true,
      origin: 'local',
      handProposal,
    });
    const initial = hand.getState();
    hand.installState(initial);
    expect(hand.getState()).toEqual(initial);
  });

  it.each([
    { iStarted: false, origin: 'local' as const, isMyTurn: true },
    { iStarted: false, origin: 'peer' as const, isMyTurn: true },
    { iStarted: true, origin: 'local' as const, isMyTurn: false },
    { iStarted: true, origin: 'peer' as const, isMyTurn: false },
  ])(
    'derives initial turns from accepted terms for $origin proposal with iStarted=$iStarted',
    ({ iStarted, origin, isMyTurn }) => {
      const calpoker = calpokerRegistration
        .createHand({
          gameIds: ['7'],
          iStarted,
          origin,
          handProposal: { gameType: 'calpoker', ...base },
        })
        .getState();
      const spacepoker = spacepokerRegistration
        .createHand({
          gameIds: ['9'],
          iStarted,
          origin,
          handProposal: { gameType: 'spacepoker', ...base, unitSizeMojos: 10n },
        })
        .getState();

      expect(calpoker).toMatchObject({
        gameId: '7',
        perPlayerStake: 100n,
        isPlayerTurn: isMyTurn,
      });
      expect(spacepoker).toMatchObject({
        gameId: '9',
        perPlayerStake: 100n,
        gameState: { myTurn: isMyTurn },
      });
    },
  );

  it('keeps package keys in the model after protocol identities are ready', () => {
    resetProtocolIds();
    expect(() => protocolIdForCatalog('calpoker')).toThrow(/No protocol identity/);
    expect(isCatalogGameType(BOUND_IDS[0].id)).toBe(false);
    expect(catalogGameTypeFromWire(BOUND_IDS[0].id)).toBeNull();
    setProtocolIds(BOUND_IDS);
    try {
      expect(packageFor('calpoker').gameType).toBe('calpoker');
      expect(isCatalogGameType(BOUND_IDS[0].id)).toBe(false);
      expect(calpokerRegistration.createHand).toEqual(expect.any(Function));
      expect(protocolIdForCatalog('calpoker')).toBe(BOUND_IDS[0].id);
      expect(catalogGameTypeFromWire('calpoker')).toBeNull();
      expect(catalogGameTypeFromWire(BOUND_IDS[0].id)).toBe('calpoker');
      expect(REGISTERED_GAMES.map((game) => game.gameType)).toEqual([
        'calpoker',
        'spacepoker',
        'krunk',
      ]);
      const cal = encodeGameProposalParameters({ gameType: 'calpoker', ...base }, true);
      expect(decodeHandProposal('calpoker', base, cal, peerSenderSecond)).toEqual({
        gameType: 'calpoker',
        ...base,
      });
    } finally {
      resetProtocolIds();
    }
  });

  it('validates and compares terms through their owning adapter', () => {
    const spaceTerms = { gameType: 'spacepoker' as const, ...base, unitSizeMojos: 10n };
    expect(validateHandProposal(spaceTerms)).toBe(true);
    expect(
      calpokerRegistration.validateHandProposal({
        gameType: 'calpoker',
        ...base,
        theirContribution: 200n,
      }),
    ).toBe(false);
    expect(
      decodeHandProposal(
        'calpoker',
        { ...base, theirContribution: 200n },
        encodeGameProposalParameters({ gameType: 'calpoker', ...base }, true),
        peerSenderSecond,
      ),
    ).toBeNull();
    expect(
      decodePersistedHandProposal('calpoker', { ...base, theirContribution: 200n }, {}),
    ).toBeNull();
    expect(
      spacepokerRegistration.validateHandProposal({
        ...spaceTerms,
        theirContribution: 200n,
      }),
    ).toBe(false);
    expect(
      spacepokerRegistration.validateHandProposal({
        ...spaceTerms,
        myContribution: 101n,
        theirContribution: 101n,
      }),
    ).toBe(false);
    expect(handProposalsEqual(spaceTerms, { ...spaceTerms })).toBe(true);
    expect(handProposalsEqual(spaceTerms, { ...spaceTerms, unitSizeMojos: 20n })).toBe(false);
    expect(isValidKrunkStake(100n)).toBe(true);
    expect(isValidKrunkStake(101n)).toBe(false);
    expect(
      krunkRegistration.validateHandProposal({
        gameType: 'krunk',
        ...base,
        theirContribution: 200n,
      }),
    ).toBe(false);
    expect(calpokerRegistration.createHand).toEqual(expect.any(Function));
    expect(spacepokerRegistration.createHand).toEqual(expect.any(Function));
  });

  it('round-trips persistence extras without manufacturing a unit', () => {
    const terms = { gameType: 'spacepoker' as const, ...base, unitSizeMojos: 25n };
    const extras = encodeHandProposalExtras(terms);
    expect(extras).toEqual({ spacepoker_unit_size: '25' });
    expect(decodePersistedHandProposal('spacepoker', base, extras)).toEqual(terms);
    expect(decodePersistedHandProposal('spacepoker', base, {})).toBeNull();
  });

  it.each([
    ['zero contribution', { ...base, myContribution: 0n, theirContribution: 0n }],
    ['unequal contribution', { ...base, theirContribution: 99n }],
  ])('rejects invalid Calpoker %s in proposal and persistence decoders', (_label, invalid) => {
    expect(
      decodeHandProposal('calpoker', invalid, [invalid.myContribution, true], peerSenderFirst),
    ).toBeNull();
    expect(decodePersistedHandProposal('calpoker', invalid, {})).toBeNull();
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
        ? [invalid.myContribution, BigInt(unit), true]
        : [invalid.myContribution, unit, true];
      expect(decodeHandProposal('spacepoker', invalid, parameterState, peerSenderFirst)).toBeNull();
      expect(
        decodePersistedHandProposal('spacepoker', invalid, { spacepoker_unit_size: unit }),
      ).toBeNull();
    },
  );

  it('keeps valid Calpoker and Space Poker terms round-trippable', () => {
    const calTerms = { gameType: 'calpoker' as const, ...base };
    const spaceTerms = { gameType: 'spacepoker' as const, ...base, unitSizeMojos: 20n };
    expect(
      decodePersistedHandProposal('calpoker', base, encodeHandProposalExtras(calTerms)),
    ).toEqual(calTerms);
    expect(
      decodePersistedHandProposal('spacepoker', base, encodeHandProposalExtras(spaceTerms)),
    ).toEqual(spaceTerms);
  });

  it('uses one resolver for terms, parameter values, and persisted state', () => {
    const terms = { gameType: 'spacepoker' as const, ...base, unitSizeMojos: 10n };
    expect(resolveSpacepokerUnitSize({ terms })).toBe(10n);
    expect(
      resolveSpacepokerUnitSize({
        terms,
        encodedParameterState: encodeGameProposalParameters(terms, true),
      }),
    ).toBe(10n);
    expect(
      resolveSpacepokerUnitSize({
        terms,
        encodedParameterState: encodeGameProposalParameters({ ...terms, unitSizeMojos: 20n }, true),
      }),
    ).toBeNull();
  });

  it('decodes ProposalMade envelopes through the proposal codec', () => {
    setProtocolIds(BOUND_IDS);
    try {
      const terms = {
        gameType: 'krunk' as const,
        myContribution: 300n,
        theirContribution: 300n,
        gameTimeout: 15n,
      };
      const parameters = encodeGameProposalParameters(terms, true);
      expect(
        decodeProposalMadeTerms(
          {
            id: '1',
            group_ids: ['1', '3'],
            my_contribution: { Amount: '300' },
            their_contribution: { Amount: '300' },
            timeout: 15,
            game_type: BOUND_IDS[2].id,
            parameters,
          },
          true,
        ),
      ).toEqual(terms);
      expect(
        decodeProposalMadeTerms(
          {
            id: '1',
            group_ids: ['1', '3'],
            my_contribution: '300',
            their_contribution: '300',
            timeout: { Timeout: '15' },
            game_type: BOUND_IDS[2].id,
            parameters: undefined as never,
          },
          true,
        ),
      ).toBeNull();
      expect(
        decodeProposalMadeTerms(
          {
            id: '1',
            group_ids: ['1', '3'],
            my_contribution: '300',
            their_contribution: '300',
            game_type: BOUND_IDS[2].id,
            parameters,
          },
          true,
        ),
      ).toBeNull();
      expect(
        decodeProposalMadeTerms(
          {
            id: '1',
            group_ids: ['1', '3'],
            my_contribution: '300',
            their_contribution: '300',
            timeout: 15,
            game_type: BOUND_IDS[2].id,
            parameters: [],
          },
          true,
        ),
      ).toBeNull();
      expect(
        decodeProposalMadeTerms(
          {
            id: '4',
            group_ids: ['4'],
            my_contribution: '100',
            their_contribution: '100',
            timeout: 15,
            game_type: BOUND_IDS[0].id,
            parameters: encodeGameProposalParameters({ gameType: 'calpoker', ...base }, false),
          },
          true,
        ),
      ).toEqual({ gameType: 'calpoker', ...base });
      expect(
        decodeProposalMadeTerms(
          {
            id: '4',
            group_ids: ['4'],
            my_contribution: '100',
            their_contribution: '100',
            timeout: 15,
            game_type: BOUND_IDS[0].id,
            parameters: encodeGameProposalParameters({ gameType: 'calpoker', ...base }, false),
          },
          false,
        ),
      ).toBeNull();
    } finally {
      resetProtocolIds();
    }
  });
});
