import { Program } from 'clvm-lib';
import {
  reduceSpacepokerFeatureState,
  reduceSpacepokerDurableState,
  reduceSpacepokerSettlementState,
  spacepokerRegistration,
} from '@games/spacepoker/ui/adapter';
import { reduceCalpokerDurableState, reduceCalpokerFeatureState } from '@games/calpoker/ui/adapter';
import { calpokerStateCodec } from '@games/calpoker/ui/stateCodec';
import { reduceKrunkDurableState, reduceKrunkFeatureState } from '@games/krunk/ui/adapter';
import { initialKrunkGameState, KrunkHandler, krunkStateCodec } from '@games/krunk/ui/stateCodec';
import { spacepokerStateCodec, type SpacepokerHandState } from '@games/spacepoker/ui/stateCodec';
import type { DurableGameStateEvent } from '@games/host';
import { resetProtocolIds, setProtocolIds } from '../gameIdentities';
import { TEST_PROTOCOL_IDS } from './protocolIdentities';

const text = (value: string) => Program.fromBytes(new TextEncoder().encode(value));
const ints = (values: bigint[]) => Program.fromList(values.map(Program.fromBigInt));
const readable = (...items: Program[]) => Program.fromList(items).serialize();

const status = (
  payload: Uint8Array | null,
  moverShare: string | null = '0',
): DurableGameStateEvent => ({
  type: 'game-status',
  id: 'space-1',
  status: 'my-turn',
  readable: payload,
  moverShare,
  iStarted: false,
});

function assertCodecValid(state: SpacepokerHandState | null): SpacepokerHandState {
  expect(state).not.toBeNull();
  const restored = spacepokerStateCodec.decode(spacepokerStateCodec.encode(state!));
  expect(restored).toEqual(state);
  return restored!;
}

const acceptedSpacepoker = (): DurableGameStateEvent => ({
  type: 'accepted-group',
  id: 'space-1',
  groupIds: ['space-1'],
  iStarted: false,
  isMyTurn: true,
  origin: 'local',
  terms: {
    gameType: 'spacepoker',
    myContribution: 1_000n,
    theirContribution: 1_000n,
    gameTimeout: 15n,
    unitSizeMojos: 10n,
  },
});

function applyReadable(state: SpacepokerHandState, payload: Uint8Array): SpacepokerHandState {
  const projected = reduceSpacepokerFeatureState(state, {
    type: 'opponent-moved',
    readable: payload,
  });
  const durable = reduceSpacepokerDurableState(state, status(payload));
  expect(durable).toEqual(projected);
  return assertCodecValid(durable);
}

describe('canonical feature gameplay reducers', () => {
  it.each([
    ['local', 'alice', 'bob'],
    ['peer', 'bob', 'alice'],
  ] as const)('assigns ordered Krunk roles from %s proposal origin', (origin, first, second) => {
    const state = reduceKrunkDurableState(null, {
      type: 'accepted-group',
      id: 'krunk-1',
      groupIds: ['krunk-1', 'krunk-2'],
      iStarted: false,
      isMyTurn: true,
      origin,
      terms: {
        gameType: 'krunk',
        myContribution: 100n,
        theirContribution: 100n,
        gameTimeout: 15n,
      },
    });

    expect(state?.games['krunk-1'].role).toBe(first);
    expect(state?.games['krunk-2'].role).toBe(second);
  });

  it('initializes Space Poker while protocol identities are bound', () => {
    setProtocolIds(TEST_PROTOCOL_IDS);
    try {
      const state = reduceSpacepokerDurableState(null, acceptedSpacepoker());
      expect(state?.unitSizeMojos).toBe(10n);
      expect(spacepokerStateCodec.gameType).toBe('spacepoker');
    } finally {
      resetProtocolIds();
    }
  });

  it('keeps Space Poker streets, board, betting, and codec projection identical at every step', () => {
    let state = reduceSpacepokerDurableState(null, acceptedSpacepoker());
    state = assertCodecValid(state);
    state = applyReadable(state, readable());
    state = applyReadable(
      state,
      readable(text('deal'), ...[0n, 1n, 1n, 1n].map(Program.fromBigInt)),
    );
    state = applyReadable(
      state,
      readable(text('open'), ...[20n, 30n, 0n, 1n, 1n].map(Program.fromBigInt)),
    );
    expect(state).toMatchObject({
      gameState: { handler: 3n, myTurn: true, N: 4n },
      halfPot: 3n,
      lastRaise: 2n,
    });
    state = applyReadable(
      state,
      readable(
        text('call'),
        Program.fromBigInt(50n),
        Program.fromBigInt(4n),
        ...[2n, 3n, 4n].map(Program.fromBigInt),
      ),
    );
    expect(state.communityCards).toEqual([2n, 3n, 4n, null, null]);
    state = applyReadable(
      state,
      readable(text('open'), Program.fromBigInt(0n), Program.fromBigInt(50n)),
    );
    state = applyReadable(
      state,
      readable(
        text('call'),
        Program.fromBigInt(50n),
        Program.fromBigInt(3n),
        Program.fromBigInt(5n),
      ),
    );
    expect(state.communityCards).toEqual([2n, 3n, 4n, 5n, null]);
    state = applyReadable(
      state,
      readable(text('open'), Program.fromBigInt(0n), Program.fromBigInt(50n)),
    );
    state = applyReadable(
      state,
      readable(
        text('call'),
        Program.fromBigInt(50n),
        Program.fromBigInt(2n),
        Program.fromBigInt(6n),
      ),
    );
    expect(state.communityCards).toEqual([2n, 3n, 4n, 5n, 6n]);
    expect(state.handHistory.map(({ action }) => action)).toEqual([
      'raise',
      'call',
      'check',
      'check',
      'check',
      'check',
    ]);
  });

  it('accepts legal repeated Space Poker ranks through the flop and turn', () => {
    let state = assertCodecValid(reduceSpacepokerDurableState(null, acceptedSpacepoker()));
    state = applyReadable(state, readable());
    state = applyReadable(
      state,
      readable(text('deal'), ...[8n, 8n, 0n, 1n].map(Program.fromBigInt)),
    );
    state = applyReadable(
      state,
      readable(text('open'), Program.fromBigInt(0n), Program.fromBigInt(10n)),
    );
    state = applyReadable(
      state,
      readable(
        text('call'),
        Program.fromBigInt(10n),
        Program.fromBigInt(4n),
        ...[8n, 5n, 5n].map(Program.fromBigInt),
      ),
    );
    expect(state.communityCards).toEqual([8n, 5n, 5n, null, null]);

    state = applyReadable(
      state,
      readable(text('open'), Program.fromBigInt(0n), Program.fromBigInt(10n)),
    );
    state = applyReadable(
      state,
      readable(
        text('call'),
        Program.fromBigInt(10n),
        Program.fromBigInt(3n),
        Program.fromBigInt(5n),
      ),
    );
    expect(state.communityCards).toEqual([8n, 5n, 5n, 5n, null]);
  });

  it('accepts a turn advisory whose rank matches a visible hole card', () => {
    let state = assertCodecValid(reduceSpacepokerDurableState(null, acceptedSpacepoker()));
    state = applyReadable(state, readable());
    state = applyReadable(
      state,
      readable(text('deal'), ...[8n, 9n, 0n, 1n].map(Program.fromBigInt)),
    );
    state = applyReadable(
      state,
      readable(text('open'), Program.fromBigInt(0n), Program.fromBigInt(10n)),
    );
    state = applyReadable(
      state,
      readable(
        text('call'),
        Program.fromBigInt(10n),
        Program.fromBigInt(4n),
        ...[2n, 3n, 4n].map(Program.fromBigInt),
      ),
    );
    state = applyReadable(
      state,
      readable(text('open'), Program.fromBigInt(0n), Program.fromBigInt(10n)),
    );
    state = assertCodecValid({
      ...state,
      gameState: { handler: 2n, myTurn: false, N: 2n },
      handHistory: [...state.handHistory, { player: 'you', action: 'check', endsStreet: true }],
    });

    const next = reduceSpacepokerDurableState(
      state,
      status(readable(text('cards'), Program.fromBigInt(8n)), null),
    );

    expect(assertCodecValid(next).communityCards).toEqual([2n, 3n, 4n, 8n, null]);
  });

  it('places delayed Space Poker card advisories by street instead of duplicating a board card', () => {
    const current = assertCodecValid({
      ...reduceSpacepokerDurableState(null, acceptedSpacepoker())!,
      gameState: { handler: 2n, myTurn: true, N: 2n },
      playerHoleCards: [0n, 1n],
      communityCards: [2n, 3n, 4n, 5n, null],
      coinTossIOpen: true,
    });
    const delayedTurnAdvisory = readable(text('cards'), Program.fromBigInt(5n));

    const next = reduceSpacepokerFeatureState(current, {
      type: 'game-message',
      readable: delayedTurnAdvisory,
    });

    expect(assertCodecValid(next)).toEqual(current);
  });

  it('keeps Bob-local winning call and end readables positively oriented', () => {
    let state = assertCodecValid(reduceSpacepokerDurableState(null, acceptedSpacepoker()));
    state = applyReadable(
      state,
      readable(text('deal'), ...[0n, 1n, 1n, 1n].map(Program.fromBigInt)),
    );
    const call = readable(
      text('call'),
      Program.fromBigInt(80n),
      Program.fromBigInt(1n),
      // Bob: J,Q with board 9,3,J,4,Q — two pair, Queens and Jacks.
      ints([11n, 12n, 9n, 3n, 11n, 4n, 12n]),
      Program.fromBigInt(0n),
      // Alice: 7,T with the same board — Queen high.
      ints([7n, 10n, 9n, 3n, 11n, 4n, 12n]),
      Program.fromBigInt(0n),
      ints([11n, 12n, 9n, 11n, 12n]),
      ints([2n, 2n, 1n, 0n, 12n, 11n, 9n]),
      ints([7n, 10n, 9n, 11n, 12n]),
      ints([1n, 1n, 1n, 1n, 1n, 0n, 12n, 11n, 10n, 9n, 7n]),
      Program.fromBigInt(1n),
    );
    state = applyReadable(state, call);
    expect(state).toMatchObject({
      gameState: { handler: 4n, myTurn: true, N: 1n },
      opponentHoleCards: [7n, 10n],
      opponentBoost: false,
      communityCards: [9n, 3n, 11n, 4n, 12n],
      halfPot: 8n,
      outcome: {
        result: 1n,
        playerHandCards: [11n, 12n, 9n, 11n, 12n],
        playerHandEval: [2n, 2n, 1n, 0n, 12n, 11n, 9n],
        opponentHandCards: [7n, 10n, 9n, 11n, 12n],
        opponentHandEval: [1n, 1n, 1n, 1n, 1n, 0n, 12n, 11n, 10n, 9n, 7n],
      },
    });

    const restoredAtCall = spacepokerStateCodec.decode(spacepokerStateCodec.encode(state));
    expect(restoredAtCall).toEqual(state);

    const end = readable(
      text('end'),
      ints([11n, 12n, 9n, 11n, 12n]),
      ints([2n, 2n, 1n, 0n, 12n, 11n, 9n]),
      ints([7n, 10n, 9n, 11n, 12n]),
      ints([1n, 1n, 1n, 1n, 1n, 0n, 12n, 11n, 10n, 9n, 7n]),
      Program.fromBigInt(1n),
      Program.fromBigInt(7n),
      Program.fromBigInt(10n),
      Program.fromBigInt(0n),
    );
    state = applyReadable(state, end);
    expect(state).toMatchObject({
      gameState: { handler: 5n, myTurn: false, N: 0n },
      opponentHoleCards: [7n, 10n],
      opponentBoost: false,
      terminalState: 'revealed',
      outcome: {
        result: 1n,
        playerHandCards: [11n, 12n, 9n, 11n, 12n],
        opponentHandCards: [7n, 10n, 9n, 11n, 12n],
      },
    });

    const settled = reduceSpacepokerSettlementState(state, 'settled_cleanly');
    expect(settled).toEqual(state);

    const persisted = spacepokerRegistration.stateCodec.encode(settled);
    expect(spacepokerRegistration.stateCodec.decode(persisted)).toEqual(settled);
  });

  it('preserves fold and concede terminal presentation through immediate settlement restore', () => {
    let state = assertCodecValid(reduceSpacepokerDurableState(null, acceptedSpacepoker()));
    state = applyReadable(
      state,
      readable(text('deal'), ...[0n, 1n, 0n, 1n].map(Program.fromBigInt)),
    );
    state = applyReadable(
      state,
      readable(text('open'), Program.fromBigInt(10n), Program.fromBigInt(20n)),
    );
    const folded = reduceSpacepokerDurableState(state, {
      type: 'settled',
      id: 'space-1',
      terminal: {
        type: 'settled',
        outcome: 'we_accepted',
        label: 'You accepted',
        myReward: '0',
        rewardCoinHex: null,
      },
    });
    expect(folded).toEqual(reduceSpacepokerSettlementState(state, 'we_accepted'));
    expect(assertCodecValid(folded).terminalState).toBe('folded-by-you');

    const endState = { ...state, gameState: { handler: 4n as const, myTurn: true, N: 1n } };
    const conceded = reduceSpacepokerSettlementState(endState, 'we_accepted');
    expect(assertCodecValid(conceded).terminalState).toBe('conceded-by-you');
  });

  it('projects an on-chain Space Poker opponent timeout as a preserved-board action failure', () => {
    const state = assertCodecValid({
      ...reduceSpacepokerDurableState(null, acceptedSpacepoker())!,
      gameState: { handler: 3n, myTurn: false, N: 2n },
      playerHoleCards: [1n, 2n],
      communityCards: [3n, 4n, 5n, 6n, null],
      handHistory: [{ player: 'you', action: 'check' }],
      coinTossIOpen: true,
    });

    const settled = assertCodecValid(reduceSpacepokerSettlementState(state, 'opponent_timed_out'));

    expect(settled).toMatchObject({
      gameState: { handler: 6n, myTurn: false, N: 2n },
      terminalState: 'won-by-opponent-failure',
      playerHoleCards: [1n, 2n],
      communityCards: [3n, 4n, 5n, 6n, null],
      handHistory: [
        { player: 'you', action: 'check' },
        { player: 'opponent', action: 'failed' },
      ],
    });
  });

  it('projects an on-chain Space Poker flag after final hands as an opponent concession', () => {
    const outcome = {
      result: 1n,
      playerHandCards: [2n, 3n, 4n, 5n, 6n],
      playerHandEval: [6n, 14n],
      opponentHandCards: [2n, 3n, 4n, 5n, 6n],
      opponentHandEval: [5n, 13n],
    };
    const state = assertCodecValid({
      ...reduceSpacepokerDurableState(null, acceptedSpacepoker())!,
      gameState: { handler: 4n, myTurn: false, N: 1n },
      playerHoleCards: [8n, 9n],
      opponentHoleCards: [10n, 11n],
      opponentBoost: false,
      communityCards: [2n, 3n, 4n, 5n, 6n],
      handHistory: [{ player: 'you', action: 'check', endsStreet: true }],
      outcome,
      coinTossIOpen: true,
    });

    const settled = assertCodecValid(reduceSpacepokerSettlementState(state, 'opponent_timed_out'));

    expect(settled).toMatchObject({
      gameState: { handler: 5n, myTurn: false, N: 1n },
      terminalState: 'conceded-by-opponent',
      playerHoleCards: [8n, 9n],
      opponentHoleCards: [10n, 11n],
      communityCards: [2n, 3n, 4n, 5n, 6n],
      outcome,
      handHistory: [
        { player: 'you', action: 'check', endsStreet: true },
        { player: 'opponent', action: 'concede' },
      ],
    });
  });

  it('changes failed opponent eyes to a red X after an on-chain reveal timeout', () => {
    const outcome = {
      result: -1n,
      playerHandCards: [2n, 3n, 4n, 5n, 6n],
      playerHandEval: [5n, 13n],
      opponentHandCards: [2n, 3n, 4n, 5n, 6n],
      opponentHandEval: [6n, 14n],
    };
    const state = assertCodecValid({
      ...reduceSpacepokerDurableState(null, acceptedSpacepoker())!,
      gameState: { handler: 4n, myTurn: false, N: 1n },
      playerHoleCards: [8n, 9n],
      opponentHoleCards: [10n, 11n],
      opponentBoost: false,
      communityCards: [2n, 3n, 4n, 5n, 6n],
      handHistory: [{ player: 'you', action: 'check', endsStreet: true }],
      outcome,
      coinTossIOpen: true,
    });

    const settled = assertCodecValid(reduceSpacepokerSettlementState(state, 'opponent_timed_out'));

    expect(settled).toMatchObject({
      terminalState: 'won-by-opponent-failure',
      outcome,
      handHistory: [
        { player: 'you', action: 'check', endsStreet: true },
        { player: 'opponent', action: 'failed' },
      ],
    });
  });

  it('preserves an opponent on-chain reveal and appends a local flag on all-in forfeit', () => {
    const outcome = {
      result: 1n,
      playerHandCards: [2n, 3n, 4n, 5n, 6n],
      playerHandEval: [6n, 14n],
      opponentHandCards: [2n, 3n, 4n, 5n, 6n],
      opponentHandEval: [5n, 13n],
    };
    const state = assertCodecValid({
      ...reduceSpacepokerDurableState(null, acceptedSpacepoker())!,
      gameState: { handler: 5n, myTurn: false, N: 1n },
      playerHoleCards: [8n, 9n],
      opponentHoleCards: [10n, 11n],
      opponentBoost: false,
      communityCards: [2n, 3n, 4n, 5n, 6n],
      handHistory: [{ player: 'opponent', action: 'reveal' }],
      outcome,
      terminalState: 'revealed',
      coinTossIOpen: true,
    });

    const settled = assertCodecValid(
      reduceSpacepokerSettlementState(state, 'forfeited_skipped_reveal'),
    );

    expect(settled).toMatchObject({
      terminalState: 'conceded-by-you',
      playerHoleCards: [8n, 9n],
      opponentHoleCards: [10n, 11n],
      communityCards: [2n, 3n, 4n, 5n, 6n],
      outcome,
      handHistory: [
        { player: 'opponent', action: 'reveal' },
        { player: 'you', action: 'concede' },
      ],
    });
  });

  it('uses the same Calpoker reducer for durable and mounted readable projection', () => {
    const current = {
      playerHand: [],
      opponentHand: [],
      cardSelections: [],
      moveNumber: 1n,
      isPlayerTurn: false,
    };
    const cards = readable(ints([0n, 1n, 2n]), ints([3n, 4n, 5n]));
    const projected = reduceCalpokerFeatureState(current, {
      type: 'opponent-moved',
      readable: cards,
      iStarted: false,
    });
    const durable = reduceCalpokerDurableState(current, {
      ...status(cards),
      iStarted: false,
    });
    expect(durable).toEqual(projected);
    expect(calpokerStateCodec.decode(calpokerStateCodec.encode(durable!))).toEqual(projected);
  });

  it.each([
    {
      role: 'on-chain loser',
      iStarted: true,
      playerHand: [32n, 36n, 41n, 49n, 33n, 37n, 42n, 50n],
      opponentHand: [2n, 6n, 9n, 13n, 3n, 7n, 10n, 14n],
      moveNumber: 2n,
      winDirection: -1n,
      expectedWinner: 'ai',
    },
    {
      role: 'on-chain winner',
      iStarted: false,
      playerHand: [2n, 6n, 9n, 13n, 3n, 7n, 10n, 14n],
      opponentHand: [32n, 36n, 41n, 49n, 33n, 37n, 42n, 50n],
      moveNumber: 2n,
      winDirection: 1n,
      expectedWinner: 'player',
    },
  ])('durably projects the final Calpoker display for the $role before settlement', (testCase) => {
    const finalReadable = readable(
      Program.fromBigInt(15n),
      Program.fromBigInt(31n),
      Program.fromBigInt(31n),
      ints([1n, 1n, 1n, 1n, 1n, 14n, 13n, 12n, 11n, 10n]),
      ints([1n, 1n, 1n, 1n, 1n, 10n, 9n, 8n, 7n, 6n]),
      Program.fromBigInt(testCase.winDirection),
    );
    const current = {
      playerHand: testCase.playerHand,
      opponentHand: testCase.opponentHand,
      cardSelections: testCase.playerHand.slice(0, 4),
      moveNumber: testCase.moveNumber,
      isPlayerTurn: false,
    };

    const projected = reduceCalpokerDurableState(current, {
      ...status(finalReadable),
      id: 'calpoker-1',
      iStarted: testCase.iStarted,
    });

    expect(projected?.displaySnapshot).toMatchObject({
      gameState: 'final',
      winner: testCase.expectedWinner,
    });
    expect(projected?.displaySnapshot?.playerDisplayText).not.toBe('');
    expect(projected?.displaySnapshot?.opponentDisplayText).not.toBe('');
    expect(projected?.playerHand).not.toEqual(current.playerHand);
    expect(projected?.opponentHand).not.toEqual(current.opponentHand);
    expect(calpokerStateCodec.decode(calpokerStateCodec.encode(projected!))).toEqual(projected);
  });

  it('rejects a final Calpoker readable before local selections reach stage 2', () => {
    const playerHand = [2n, 6n, 9n, 13n, 3n, 7n, 10n, 14n];
    const finalReadable = readable(
      Program.fromBigInt(15n),
      Program.fromBigInt(31n),
      Program.fromBigInt(31n),
      ints([1n, 1n, 1n, 1n, 1n, 14n, 13n, 12n, 11n, 10n]),
      ints([1n, 1n, 1n, 1n, 1n, 10n, 9n, 8n, 7n, 6n]),
      Program.fromBigInt(-1n),
    );

    expect(() =>
      reduceCalpokerDurableState(
        {
          playerHand,
          opponentHand: [32n, 36n, 41n, 49n, 33n, 37n, 42n, 50n],
          cardSelections: playerHand.slice(0, 4),
          moveNumber: 1n,
          isPlayerTurn: false,
        },
        { ...status(finalReadable), id: 'calpoker-1', iStarted: false },
      ),
    ).toThrow('before local selections were submitted');
  });

  it('does not invent a Calpoker final display when timeout settles before an outcome readable', () => {
    const current = {
      playerHand: [0n, 1n, 2n, 3n, 4n, 5n, 6n, 7n],
      opponentHand: [8n, 9n, 10n, 11n, 12n, 13n, 14n, 15n],
      cardSelections: [0n, 1n, 2n, 3n],
      moveNumber: 2n,
      isPlayerTurn: true,
    };

    expect(
      reduceCalpokerDurableState(current, {
        type: 'settled',
        id: 'calpoker-1',
        terminal: {
          type: 'settled',
          outcome: 'timed_out_waiting_for_our_move',
          label: 'Timed out waiting for our move',
          myReward: '0',
          rewardCoinHex: null,
        },
      }),
    ).toEqual({ ...current, isPlayerTurn: false });
  });

  it('durably applies Calpoker and Space Poker advisory messages with game-message semantics', () => {
    const cards = readable(ints([0n, 1n, 2n]), ints([3n, 4n, 5n]));
    const calpoker = {
      playerHand: [],
      opponentHand: [],
      cardSelections: [],
      moveNumber: 1n,
      isPlayerTurn: false,
    };
    expect(
      reduceCalpokerDurableState(calpoker, {
        ...status(cards, null),
        iStarted: true,
      }),
    ).toEqual(
      reduceCalpokerFeatureState(calpoker, {
        type: 'game-message',
        readable: cards,
        iStarted: true,
      }),
    );

    const accepted = assertCodecValid(reduceSpacepokerDurableState(null, acceptedSpacepoker()));
    const deal = readable(
      text('deal'),
      Program.fromBigInt(10n),
      Program.fromBigInt(11n),
      Program.fromBigInt(1n),
      Program.fromBigInt(0n),
    );
    expect(reduceSpacepokerDurableState(accepted, status(deal, null))).toEqual(
      reduceSpacepokerFeatureState(accepted, {
        type: 'game-message',
        readable: deal,
      }),
    );
  });

  it('uses the same Krunk reducer for durable and mounted clue projection', () => {
    const pending = {
      ...initialKrunkGameState('bob'),
      handler: KrunkHandler.BobWaiting,
      myTurn: false,
      guesses: [{ word: 'CRANE', clue: [-1n, -1n, -1n, -1n, -1n] as const }],
    };
    const clue = ints([2n, 0n, 1n, 0n, 0n]).serialize();
    const projected = reduceKrunkFeatureState(pending, {
      type: 'opponent-moved',
      readable: clue,
      moverShare: '0',
    });
    const durable = reduceKrunkDurableState(
      { games: { 'krunk-1': pending } },
      {
        type: 'game-status',
        id: 'krunk-1',
        status: 'my-turn',
        readable: clue,
        moverShare: '0',
        iStarted: true,
      },
    );
    expect(durable?.games['krunk-1']).toEqual(projected);
    expect(krunkStateCodec.decode(krunkStateCodec.encode(durable!))).toEqual(durable);
  });

  it('keeps Krunk gameplay outcome and mover share intact after a later settlement', () => {
    const terminal = {
      ...initialKrunkGameState('bob'),
      handler: KrunkHandler.Terminal,
      myTurn: false,
      revealedWord: 'CRANE',
      outcome: 'win' as const,
      moverShare: '20',
    };

    const projected = reduceKrunkFeatureState(terminal, {
      type: 'settled',
    });
    const durable = reduceKrunkDurableState(
      {
        games: {
          'krunk-1': terminal,
          'krunk-2': initialKrunkGameState('alice'),
        },
      },
      {
        type: 'settled',
        id: 'krunk-1',
        terminal: {
          type: 'settled',
          outcome: 'settled_cleanly',
          label: 'Settled cleanly',
          myReward: '100',
          rewardCoinHex: null,
        },
      },
    );

    expect(projected.moverShare).toBe('20');
    expect(projected.outcome).toBe('win');
    expect(durable?.games['krunk-1']).toEqual(projected);
    expect(Object.keys(durable!.games)).toEqual(['krunk-1', 'krunk-2']);
  });

  it('replaces a completed Krunk hand while preserving duplicate acceptance state', () => {
    const completed = {
      ...initialKrunkGameState('alice'),
      handler: KrunkHandler.Terminal,
      myTurn: false,
      secretWord: 'CRANE',
    };
    const firstAcceptance: DurableGameStateEvent = {
      type: 'accepted-group',
      id: 'krunk-3',
      groupIds: ['krunk-3', 'krunk-4'],
      iStarted: true,
      isMyTurn: true,
      origin: 'local',
      terms: {
        gameType: 'krunk',
        myContribution: 100n,
        theirContribution: 100n,
        gameTimeout: 15n,
      },
    };

    let state = reduceKrunkDurableState(
      {
        games: {
          'krunk-1': completed,
          'krunk-2': { ...completed, role: 'bob' },
        },
      },
      firstAcceptance,
    );
    expect(Object.keys(state!.games)).toEqual(['krunk-3', 'krunk-4']);

    const progressed = {
      ...state!.games['krunk-3'],
      handler: KrunkHandler.AliceWaiting,
      secretWord: 'SLATE',
    };
    state = reduceKrunkDurableState(
      { games: { ...state!.games, 'krunk-3': progressed } },
      { ...firstAcceptance, id: 'krunk-4' },
    );

    expect(Object.keys(state!.games)).toEqual(['krunk-3', 'krunk-4']);
    expect(state!.games['krunk-3']).toEqual(progressed);
  });
});
