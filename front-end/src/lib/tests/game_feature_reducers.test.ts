import { Program } from 'clvm-lib';
import {
  reduceSpacepokerFeatureState,
  reduceSpacepokerSettlementState,
} from '@games/spacepoker/ui/handProposal';
import { reduceCalpokerFeatureState } from '@games/calpoker/ui/handProposal';
import { calpokerStateCodec } from '@games/calpoker/ui/serialize';
import { reduceKrunkFeatureState } from '@games/krunk/ui/handProposal';
import {
  createKrunkHand,
  initialKrunkGameState,
  KrunkHandler,
  krunkStateCodec,
  restoreKrunkHand,
  type KrunkHandState,
} from '@games/krunk/ui/serialize';
import {
  createSpacepokerHand,
  restoreSpacepokerHand,
  spacepokerStateCodec,
  type SpacepokerHandState,
} from '@games/spacepoker/ui/serialize';
import { restoreCalpokerHand, type CalpokerHandState } from '@games/calpoker/ui/serialize';
import type { GameHandInitialization, GameUpdate } from '@games/host';
import { resetProtocolIds, setProtocolIds } from '../gameIdentities';
import { TEST_PROTOCOL_IDS } from './protocolIdentities';

const text = (value: string) => Program.fromBytes(new TextEncoder().encode(value));
const ints = (values: bigint[]) => Program.fromList(values.map(Program.fromBigInt));
const readable = (...items: Program[]) => Program.fromList(items);

const status = (payload: Program, moverShare: bigint | null = 0n): GameUpdate =>
  moverShare === null
    ? { type: 'message-readable', memberIndex: 0, readable: payload }
    : {
        type: 'move-readable',
        memberIndex: 0,
        readable: payload,
        moverShare,
      };

function assertCodecValid(state: SpacepokerHandState | null): SpacepokerHandState {
  expect(state).not.toBeNull();
  const restored = spacepokerStateCodec.decode(spacepokerStateCodec.encode(state!));
  expect(restored).toEqual(state);
  return restored!;
}

const spacepokerInit = (): GameHandInitialization => ({
  parameters: 10n,
  members: [{ playerAContribution: 1_000n, playerBContribution: 1_000n, ourTurn: true }],
});

function freshSpacepokerState(): SpacepokerHandState {
  return createSpacepokerHand(spacepokerInit()).getState();
}

function advanceSpacepokerHand(
  state: SpacepokerHandState,
  update: GameUpdate,
): SpacepokerHandState {
  const hand = restoreSpacepokerHand(state);
  hand.receive(update);
  return hand.getState();
}

function advanceCalpokerHand(state: CalpokerHandState, update: GameUpdate): CalpokerHandState {
  const hand = restoreCalpokerHand(state);
  hand.receive(update);
  return hand.getState();
}

function calpokerState(overrides: Partial<CalpokerHandState> = {}): CalpokerHandState {
  return {
    perPlayerStake: 100n,
    playerHand: [],
    opponentHand: [],
    cardSelections: [],
    moveNumber: 0n,
    isPlayerTurn: true,
    iStarted: false,
    settlementOutcome: null,
    ...overrides,
  };
}

function freshKrunkHand(init: GameHandInitialization): KrunkHandState {
  return createKrunkHand(init).getState();
}

function advanceKrunkHand(state: KrunkHandState, update: GameUpdate): KrunkHandState {
  const hand = restoreKrunkHand(state);
  hand.receive(update);
  return hand.getState();
}

function applyReadable(state: SpacepokerHandState, payload: Program): SpacepokerHandState {
  const projected = reduceSpacepokerFeatureState(state, {
    type: 'opponent-moved',
    readable: payload,
  });
  const durable = advanceSpacepokerHand(state, status(payload));
  expect(durable).toEqual(projected);
  return assertCodecValid(durable);
}

describe('canonical feature gameplay reducers', () => {
  it('fails loudly when trusted handler readables are malformed', () => {
    expect(() =>
      advanceSpacepokerHand(freshSpacepokerState(), status(readable(text('unknown')))),
    ).toThrow('Unsupported Space Poker move readable tag');
    expect(() =>
      advanceSpacepokerHand(
        freshSpacepokerState(),
        status(readable(text('deal'), Program.fromBigInt(1n)), null),
      ),
    ).toThrow('Unsupported Space Poker game message readable tag: deal');
    expect(() =>
      advanceSpacepokerHand(
        freshSpacepokerState(),
        status(readable(text('unknown-message')), null),
      ),
    ).toThrow('Unsupported Space Poker game message readable tag');
    expect(() => advanceSpacepokerHand(freshSpacepokerState(), status(readable(), null))).toThrow(
      'Unsupported Space Poker game message readable tag: null',
    );
    const krunk = freshKrunkHand({
      parameters: null,
      members: [
        { playerAContribution: 100n, playerBContribution: 0n, ourTurn: true },
        { playerAContribution: 0n, playerBContribution: 100n, ourTurn: false },
      ],
    });
    expect(() => advanceKrunkHand(krunk, status(readable(Program.fromBigInt(1n)), 0n))).toThrow(
      'Krunk handler returned 1 readable fields',
    );
  });

  it.each([
    [[true, false], 'alice', 'bob'],
    [[false, true], 'bob', 'alice'],
  ] as const)('assigns ordered Krunk roles from approved turns', (turns, first, second) => {
    const state = freshKrunkHand({
      parameters: null,
      members: turns.map((ourTurn, index) => ({
        playerAContribution: index === 0 ? 100n : 0n,
        playerBContribution: index === 0 ? 0n : 100n,
        ourTurn,
      })),
    });

    expect(state?.members[0].role).toBe(first);
    expect(state?.members[1].role).toBe(second);
  });

  it('initializes Space Poker while protocol identities are bound', () => {
    setProtocolIds(TEST_PROTOCOL_IDS);
    try {
      const state = freshSpacepokerState();
      expect(state?.unitSizeMojos).toBe(10n);
      expect(spacepokerStateCodec.gameType).toBe('spacepoker');
    } finally {
      resetProtocolIds();
    }
  });

  it('keeps Space Poker streets, board, betting, and codec projection identical at every step', () => {
    let state = freshSpacepokerState();
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
    let state = assertCodecValid(freshSpacepokerState());
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
    let state = assertCodecValid(freshSpacepokerState());
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

    const next = advanceSpacepokerHand(
      state,
      status(readable(text('cards'), Program.fromBigInt(8n)), null),
    );

    expect(assertCodecValid(next).communityCards).toEqual([2n, 3n, 4n, 8n, null]);
  });

  it('places delayed Space Poker card advisories by street instead of duplicating a board card', () => {
    const current = assertCodecValid({
      ...freshSpacepokerState()!,
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
    let state = assertCodecValid(freshSpacepokerState());
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

    const persisted = spacepokerStateCodec.encode(settled);
    expect(spacepokerStateCodec.decode(persisted)).toEqual(settled);
  });

  it('preserves fold and concede terminal presentation through immediate settlement restore', () => {
    let state = assertCodecValid(freshSpacepokerState());
    state = applyReadable(
      state,
      readable(text('deal'), ...[0n, 1n, 0n, 1n].map(Program.fromBigInt)),
    );
    state = applyReadable(
      state,
      readable(text('open'), Program.fromBigInt(10n), Program.fromBigInt(20n)),
    );
    const folded = advanceSpacepokerHand(state, {
      type: 'hand-ended',
      memberIndex: 0,
      outcome: 'we_accepted',
    });
    expect(folded).toEqual({
      ...reduceSpacepokerSettlementState(state, 'we_accepted'),
      settlementOutcome: 'we_accepted',
    });
    expect(assertCodecValid(folded).terminalState).toBe('folded-by-you');

    const endState = { ...state, gameState: { handler: 4n as const, myTurn: true, N: 1n } };
    const conceded = reduceSpacepokerSettlementState(endState, 'we_accepted');
    expect(assertCodecValid(conceded).terminalState).toBe('conceded-by-you');
  });

  it('projects an on-chain Space Poker opponent timeout as a preserved-board action failure', () => {
    const state = assertCodecValid({
      ...freshSpacepokerState()!,
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
      ...freshSpacepokerState()!,
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
      ...freshSpacepokerState()!,
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
      ...freshSpacepokerState()!,
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
    const current = calpokerState({
      moveNumber: 1n,
      isPlayerTurn: false,
    });
    const cards = readable(ints([0n, 1n, 2n]), ints([3n, 4n, 5n]));
    const projected = reduceCalpokerFeatureState(current, {
      type: 'opponent-moved',
      readable: cards,
    });
    const durable = advanceCalpokerHand(current, status(cards));
    expect(durable).toEqual(projected);
    expect(calpokerStateCodec.decode(calpokerStateCodec.encode(durable!))).toEqual(projected);
  });

  it.each([
    {
      role: 'on-chain loser',
      iStarted: true,
      settlementOutcome: null,
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
    const current = calpokerState({
      playerHand: testCase.playerHand,
      opponentHand: testCase.opponentHand,
      cardSelections: testCase.playerHand.slice(0, 4),
      moveNumber: testCase.moveNumber,
      isPlayerTurn: false,
      iStarted: testCase.iStarted,
    });

    const projected = advanceCalpokerHand(current, {
      ...status(finalReadable),
      memberIndex: 0,
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
      advanceCalpokerHand(
        calpokerState({
          playerHand,
          opponentHand: [32n, 36n, 41n, 49n, 33n, 37n, 42n, 50n],
          cardSelections: playerHand.slice(0, 4),
          moveNumber: 1n,
          isPlayerTurn: false,
        }),
        { ...status(finalReadable), id: 'calpoker-1', iStarted: false },
      ),
    ).toThrow('before local selections were submitted');
  });

  it('does not invent a Calpoker final display when timeout settles before an outcome readable', () => {
    const current = calpokerState({
      playerHand: [0n, 1n, 2n, 3n, 4n, 5n, 6n, 7n],
      opponentHand: [8n, 9n, 10n, 11n, 12n, 13n, 14n, 15n],
      cardSelections: [0n, 1n, 2n, 3n],
      moveNumber: 2n,
      isPlayerTurn: true,
      iStarted: true,
    });

    expect(
      advanceCalpokerHand(current, {
        type: 'hand-ended',
        memberIndex: 0,
        outcome: 'timed_out_waiting_for_our_move',
      }),
    ).toEqual({
      ...current,
      isPlayerTurn: false,
      settlementOutcome: 'timed_out_waiting_for_our_move',
    });
  });

  it('durably applies Calpoker and Space Poker advisory messages with game-message semantics', () => {
    const cards = readable(ints([0n, 1n, 2n]), ints([3n, 4n, 5n]));
    const calpoker = calpokerState({
      moveNumber: 1n,
      isPlayerTurn: false,
      iStarted: true,
    });
    expect(
      advanceCalpokerHand(calpoker, {
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

    const accepted = assertCodecValid(freshSpacepokerState());
    const deal = readable(
      text('deal'),
      Program.fromBigInt(10n),
      Program.fromBigInt(11n),
      Program.fromBigInt(1n),
      Program.fromBigInt(0n),
    );
    expect(advanceSpacepokerHand(accepted, status(deal, null))).toEqual(
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
    const clue = ints([2n, 0n, 1n, 0n, 0n]);
    const projected = reduceKrunkFeatureState(pending, {
      type: 'opponent-moved',
      readable: clue,
      moverShare: 0n,
    });
    const durable = advanceKrunkHand(
      {
        perPlayerStake: 100n,
        members: [pending, initialKrunkGameState('alice')],
      },
      {
        type: 'move-readable',
        memberIndex: 0,
        readable: clue,
        moverShare: 0n,
      },
    );
    expect(durable?.members[0]).toEqual(projected);
    expect(krunkStateCodec.decode(krunkStateCodec.encode(durable!))).toEqual(durable);
  });

  it('keeps Krunk gameplay outcome and mover share intact after a later settlement', () => {
    const terminal = {
      ...initialKrunkGameState('bob'),
      handler: KrunkHandler.Terminal,
      myTurn: false,
      revealedWord: 'CRANE',
      outcome: 'win' as const,
      moverShare: 20n,
    };

    const projected = reduceKrunkFeatureState(terminal, {
      type: 'settled',
    });
    const durable = advanceKrunkHand(
      {
        perPlayerStake: 100n,
        members: [terminal, initialKrunkGameState('alice')],
      },
      {
        type: 'hand-ended',
        memberIndex: 0,
        outcome: 'settled_cleanly',
      },
    );

    expect(projected.moverShare).toBe(20n);
    expect(projected.outcome).toBe('win');
    expect(durable?.members[0]).toEqual({
      ...projected,
      settlementOutcome: 'settled_cleanly',
    });
    expect(durable!.members).toHaveLength(2);
  });

  it('restores a replacement Krunk hand directly from complete local state', () => {
    const init: GameHandInitialization = {
      parameters: null,
      members: [
        { playerAContribution: 100n, playerBContribution: 0n, ourTurn: true },
        { playerAContribution: 0n, playerBContribution: 100n, ourTurn: false },
      ],
    };

    const fresh = createKrunkHand(init);
    let state = fresh.getState();
    expect(state!.members).toHaveLength(2);

    const progressed = {
      ...state!.members[0],
      handler: KrunkHandler.AliceWaiting,
      myTurn: false,
      secretWord: 'SLATE',
    };
    const hand = restoreKrunkHand({
      ...state,
      members: [progressed, state.members[1]],
    });
    state = hand.getState();

    expect(state!.members).toHaveLength(2);
    expect(state!.members[0]).toEqual(progressed);
  });
});
