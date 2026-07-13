import {
  KrunkHandler,
  applyKrunkMoveRejected,
  canDraftKrunkGuess,
  krunkGuessesWithQueued,
  krunkGuessSubmissionMode,
  type KrunkGameState,
} from '../../hooks/useKrunkHand';
import {
  activeIdsAfterProposalAccepted,
  gameplayEventForMoveRejected,
  gameplayEventsForGameStatus,
  isValidKrunkStake,
  parseTermsFromNotificationValue,
} from '../../hooks/useGameSession';

describe('Krunk terms', () => {
  it('requires positive 100-mojo stake increments', () => {
    expect(isValidKrunkStake(0n)).toBe(false);
    expect(isValidKrunkStake(99n)).toBe(false);
    expect(isValidKrunkStake(100n)).toBe(true);
    expect(isValidKrunkStake(200n)).toBe(true);
    expect(isValidKrunkStake(201n)).toBe(false);
  });

  it('keeps the aggregate per-player contributions from a grouped proposal', () => {
    expect(parseTermsFromNotificationValue({
      my_contribution: { Amount: '300' },
      their_contribution: { Amount: '300' },
      timeout: 15,
    }, 'krunk')).toEqual({
      gameType: 'krunk',
      myContribution: 300n,
      theirContribution: 300n,
      gameTimeout: 15n,
    });
  });
});

describe('Krunk first guess drafting', () => {
  it('allows drafting after our word commit while their commit is pending', () => {
    expect(canDraftKrunkGuess(true, KrunkHandler.BobWaiting, 0)).toBe(true);
    expect(canDraftKrunkGuess(false, KrunkHandler.BobWaiting, 0)).toBe(false);
    expect(canDraftKrunkGuess(true, KrunkHandler.BobWaiting, 1)).toBe(false);
    expect(canDraftKrunkGuess(true, KrunkHandler.BobGuess, 0)).toBe(false);
  });

  it('queues an early first guess and sends it once the guess phase starts', () => {
    expect(krunkGuessSubmissionMode(false, true)).toBe('queue');
    expect(krunkGuessSubmissionMode(true, false)).toBe('send');
    expect(krunkGuessSubmissionMode(false, false)).toBeNull();
  });

  it('shows one pending row for a queued first guess only until real guesses exist', () => {
    expect(krunkGuessesWithQueued([], 'CRANE')).toEqual([
      { word: 'CRANE', clue: [-1, -1, -1, -1, -1] },
    ]);

    const pending = [{ word: 'CRANE', clue: [-1, -1, -1, -1, -1] as const }];
    expect(krunkGuessesWithQueued(pending, 'CRANE')).toBe(pending);
    expect(krunkGuessesWithQueued(pending, null)).toBe(pending);
    expect(krunkGuessesWithQueued([], null)).toEqual([]);
  });

  it('rolls back optimistic dictionary-rejected commits and guesses', () => {
    const alice: KrunkGameState = {
      handler: KrunkHandler.AliceWaiting,
      myTurn: false,
      role: 'alice',
      guesses: [],
      secretWord: 'XXXXX',
      revealedWord: null,
      outcome: null,
      error: null,
    };
    expect(applyKrunkMoveRejected(alice, {
      tag: 'not_in_dictionary',
      message: 'xxxxx',
    })).toMatchObject({
      handler: KrunkHandler.WaitingCommit,
      myTurn: true,
      secretWord: null,
      error: 'XXXXX is not in the dictionary.',
    });

    const bob: KrunkGameState = {
      ...alice,
      handler: KrunkHandler.BobWaiting,
      role: 'bob',
      secretWord: null,
      guesses: [{ word: 'XXXXX', clue: [-1, -1, -1, -1, -1] }],
    };
    expect(applyKrunkMoveRejected(bob, {
      tag: 'not_in_dictionary',
      message: 'xxxxx',
    })).toMatchObject({
      handler: KrunkHandler.BobGuess,
      myTurn: true,
      guesses: [],
      error: 'XXXXX is not in the dictionary.',
    });
  });

  it('routes a typed move rejection with its game id, tag, and message', () => {
    expect(gameplayEventForMoveRejected({
      id: 7n,
      tag: 'not_in_dictionary',
      message: 'xxxxx',
    })).toEqual({
      MoveRejected: {
        gameId: '7',
        tag: 'not_in_dictionary',
        message: 'xxxxx',
      },
    });
  });

  it('exposes the guesser game on the first atomic-group acceptance', () => {
    const activeIds = activeIdsAfterProposalAccepted([], '1', ['1', '3']);
    expect(activeIds).toEqual(['1', '3']);
    expect(activeIdsAfterProposalAccepted(activeIds, '3', ['1', '3']))
      .toEqual(['1', '3']);

    const opponentCommit = {
      GameStatus: {
        id: '3',
        status: 'my-turn',
        coin_id: null,
        other_params: {
          readable: [0x80],
          mover_share: '0',
        },
      },
    };
    expect(gameplayEventsForGameStatus(opponentCommit, activeIds, null)).toEqual([
      {
        OpponentMoved: {
          readable: Uint8Array.from([0x80]),
          gameId: '3',
        },
      },
    ]);
  });
});
