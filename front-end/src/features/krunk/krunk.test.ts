import {
  KrunkHandler,
  applyKrunkMoveRejected,
  canDraftKrunkGuess,
  canQueueKrunkGuess,
  isKrunkDictionaryRejectionError,
  krunkGuessesWithQueued,
  krunkGuessSubmissionMode,
  krunkTerminalStatus,
  krunkWinMessage,
  type KrunkGameState,
} from './useKrunkHand';
import {
  activeIdsAfterProposalAccepted,
  clearProposalTracking,
  gameplayEventForMoveRejected,
  gameplayEventsForGameStatus,
  parseTermsFromNotificationValue,
} from '../../hooks/useGameSession';
import { isValidKrunkStake } from './adapter';
import {
  formatKrunkHandLog,
  krunkGameSlots,
  krunkLetterStatuses,
  newlyResolvedKrunkIndex,
} from './Krunk';
import type { GameTerminalModel } from '../../lib/session/types';

function terminal(outcome: GameTerminalModel['outcome'] = null): GameTerminalModel {
  return {
    type: outcome === null ? 'none' : 'settled',
    outcome,
    label: null,
    myReward: null,
    rewardCoinHex: null,
  };
}

describe('Krunk terms', () => {
  it('clears proposal terms, group links, and outgoing refs together', () => {
    const terms = {
      gameType: 'krunk',
      myContribution: 100n,
      theirContribution: 100n,
      gameTimeout: 15n,
    } as const;
    const termsById = { '1': terms, '3': terms, stale: terms };
    const groupsById = { '1': ['1', '3'], '3': ['1', '3'], stale: ['stale'] };
    const outgoing = new Set(['1', '3', 'stale']);

    clearProposalTracking(['1'], termsById, groupsById, outgoing);

    expect(termsById).toEqual({ stale: terms });
    expect(groupsById).toEqual({ stale: ['stale'] });
    expect(outgoing).toEqual(new Set(['stale']));
  });

  it('requires positive 100-mojo stake increments', () => {
    expect(isValidKrunkStake(0n)).toBe(false);
    expect(isValidKrunkStake(99n)).toBe(false);
    expect(isValidKrunkStake(100n)).toBe(true);
    expect(isValidKrunkStake(200n)).toBe(true);
    expect(isValidKrunkStake(201n)).toBe(false);
  });

  it('keeps the aggregate per-player contributions from a grouped proposal', () => {
    expect(
      parseTermsFromNotificationValue(
        {
          my_contribution: { Amount: '300' },
          their_contribution: { Amount: '300' },
          timeout: 15,
        },
        'krunk',
      ),
    ).toEqual({
      gameType: 'krunk',
      myContribution: 300n,
      theirContribution: 300n,
      gameTimeout: 15n,
    });
  });
});

describe('Krunk first guess drafting', () => {
  it('supplies the new clue index during the render that resolves it', () => {
    expect(newlyResolvedKrunkIndex(1, 0)).toBe(0);
    expect(newlyResolvedKrunkIndex(3, 2)).toBe(2);
    expect(newlyResolvedKrunkIndex(2, 2)).toBeUndefined();
  });

  it('keeps factory-order role slots stable after one sibling ends', () => {
    const current = ['0', '1'];
    const active = ['1'];

    expect(krunkGameSlots(current, true, active)).toEqual({
      aliceGameId: '0',
      bobGameId: '1',
      aliceActive: false,
      bobActive: true,
    });
    expect(krunkGameSlots(current, false, active)).toEqual({
      aliceGameId: '1',
      bobGameId: '0',
      aliceActive: true,
      bobActive: false,
    });
  });

  it('allows drafting after our word commit while their commit is pending', () => {
    expect(canDraftKrunkGuess(true, KrunkHandler.BobWaiting, 0)).toBe(true);
    expect(canQueueKrunkGuess(true, KrunkHandler.BobWaiting, 0)).toBe(true);
    expect(canDraftKrunkGuess(false, KrunkHandler.BobWaiting, 0)).toBe(false);
    expect(canQueueKrunkGuess(false, KrunkHandler.BobWaiting, 0)).toBe(false);
  });

  it('allows drafting and queuing more guesses while waiting on a clue', () => {
    expect(canDraftKrunkGuess(true, KrunkHandler.BobWaiting, 1)).toBe(true);
    expect(canQueueKrunkGuess(true, KrunkHandler.BobWaiting, 1)).toBe(true);
    expect(canDraftKrunkGuess(true, KrunkHandler.BobGuess, 1)).toBe(true);
    expect(canQueueKrunkGuess(true, KrunkHandler.BobGuess, 1)).toBe(false);
    expect(canDraftKrunkGuess(true, KrunkHandler.BobWaiting, 5)).toBe(false);
    expect(canQueueKrunkGuess(true, KrunkHandler.BobWaiting, 5)).toBe(false);
  });

  it('queues early guesses and sends once the guess phase starts', () => {
    expect(krunkGuessSubmissionMode(false, true)).toBe('queue');
    expect(krunkGuessSubmissionMode(true, false)).toBe('send');
    expect(krunkGuessSubmissionMode(false, false)).toBeNull();
  });

  it('appends queued guesses as pending rows after committed guesses', () => {
    expect(krunkGuessesWithQueued([], ['CRANE'])).toEqual([
      { word: 'CRANE', clue: [-1n, -1n, -1n, -1n, -1n] },
    ]);
    expect(
      krunkGuessesWithQueued([{ word: 'CRANE', clue: [0n, 0n, 0n, 0n, 1n] }], ['SLATE', 'AUDIO']),
    ).toEqual([
      { word: 'CRANE', clue: [0n, 0n, 0n, 0n, 1n] },
      { word: 'SLATE', clue: [-1n, -1n, -1n, -1n, -1n] },
      { word: 'AUDIO', clue: [-1n, -1n, -1n, -1n, -1n] },
    ]);
    expect(krunkGuessesWithQueued([], [])).toEqual([]);
  });

  it('treats dictionary rejection errors as a signal to drop later queued guesses', () => {
    expect(isKrunkDictionaryRejectionError('XXXXX is not in the dictionary.')).toBe(true);
    expect(isKrunkDictionaryRejectionError('network failed')).toBe(false);
    expect(isKrunkDictionaryRejectionError(null)).toBe(false);
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
      moverShare: null,
      error: null,
    };
    expect(
      applyKrunkMoveRejected(alice, {
        tag: 'not_in_dictionary',
        message: 'xxxxx',
      }),
    ).toMatchObject({
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
      guesses: [{ word: 'XXXXX', clue: [-1n, -1n, -1n, -1n, -1n] }],
    };
    expect(
      applyKrunkMoveRejected(bob, {
        tag: 'not_in_dictionary',
        message: 'xxxxx',
      }),
    ).toMatchObject({
      handler: KrunkHandler.BobGuess,
      myTurn: true,
      guesses: [],
      error: 'XXXXX is not in the dictionary.',
    });
  });

  it('maps settlement outcomes to terminal status copy', () => {
    const timedOut: KrunkGameState = {
      handler: KrunkHandler.Terminal,
      myTurn: false,
      role: 'bob',
      guesses: [],
      secretWord: null,
      revealedWord: null,
      outcome: 'lose',
      moverShare: null,
      error: null,
    };

    expect(krunkTerminalStatus(timedOut, 'Peer', terminal('timed_out_waiting_for_our_move'))).toBe(
      'We timed out.',
    );
    expect(
      krunkTerminalStatus(
        {
          ...timedOut,
          role: 'alice',
        },
        'Peer',
        terminal('opponent_timed_out'),
      ),
    ).toBe('Peer timed out.');
    expect(
      krunkTerminalStatus(
        {
          ...timedOut,
        },
        'Peer',
        terminal('forfeited_skipped_reveal'),
      ),
    ).toBe('We forfeited.');
    expect(
      krunkTerminalStatus(
        {
          ...timedOut,
        },
        'Peer',
        terminal('settled_cleanly'),
      ),
    ).toBe('Settled.');
  });

  it('leaves bob correct-guess copy to the win-amount UI', () => {
    const bobWin: KrunkGameState = {
      handler: KrunkHandler.Terminal,
      myTurn: false,
      role: 'bob',
      guesses: [{ word: 'CRANE', clue: [2n, 2n, 2n, 2n, 2n] }],
      secretWord: null,
      revealedWord: 'CRANE',
      outcome: 'win',
      moverShare: '100',
      error: null,
    };
    expect(krunkTerminalStatus(bobWin, 'Peer', terminal())).toBeNull();
    expect(
      krunkTerminalStatus(
        {
          ...bobWin,
          outcome: 'lose',
          moverShare: null,
          revealedWord: 'CRANE',
        },
        'Peer',
        terminal(),
      ),
    ).toBe('Out of guesses.');
  });

  it('formats bob win amounts as mojo below 1e6 and chia at or above', () => {
    expect(krunkWinMessage('100')).toBe('You won 100 mojo!');
    expect(krunkWinMessage('999999')).toBe('You won 999999 mojo!');
    expect(krunkWinMessage('1000000')).toBe('You won 0.000001 chia!');
    expect(krunkWinMessage('1000000000000')).toBe('You won 1 chia!');
  });

  it('aggregates keyboard letter statuses with NYT green-over-amber priority', () => {
    expect(
      krunkLetterStatuses([
        { word: 'CRANE', clue: [0n, 0n, 0n, 0n, 1n] }, // E present
        { word: 'EAGER', clue: [2n, 0n, 0n, 0n, 0n] }, // E correct
      ]),
    ).toEqual({
      C: 'absent',
      R: 'absent',
      A: 'absent',
      N: 'absent',
      E: 'correct',
      G: 'absent',
    });
  });

  it('formats a solved guessing hand for session history', () => {
    expect(
      formatKrunkHandLog(
        'bob',
        10_000_000_000n, // 0.01 XCH
        [
          { word: 'RATES', clue: [0n, 0n, 0n, 0n, 1n] },
          { word: 'SPOIL', clue: [1n, 0n, 1n, 0n, 0n] },
          { word: 'MOUSY', clue: [0n, 2n, 0n, 2n, 2n] },
          { word: 'BOSSY', clue: [2n, 2n, 2n, 2n, 2n] },
        ],
        'BOSSY',
      ),
    ).toEqual([
      'Krunk (guessing) 0.01 XCH',
      '⬛⬛⬛⬛🟧RATES',
      '🟧⬛🟧⬛⬛SPOIL',
      '⬛🟩⬛🟩🟩MOUSY',
      '🟩🟩🟩🟩🟩BOSSY',
    ]);
  });

  it('formats a missed picking hand with a gray reveal line', () => {
    expect(
      formatKrunkHandLog(
        'alice',
        10_000_000_000n,
        [
          { word: 'RATES', clue: [1n, 0n, 0n, 0n, 0n] },
          { word: 'GROIN', clue: [0n, 2n, 2n, 0n, 2n] },
          { word: 'BROWN', clue: [0n, 2n, 2n, 2n, 2n] },
          { word: 'DROWN', clue: [0n, 2n, 2n, 2n, 2n] },
          { word: 'CROWN', clue: [0n, 2n, 2n, 2n, 2n] },
        ],
        'FROWN',
      ),
    ).toEqual([
      'Krunk (picking) 0.01 XCH',
      '🟧⬛⬛⬛⬛RATES',
      '⬛🟩🟩⬛🟩GROIN',
      '⬛🟩🟩🟩🟩BROWN',
      '⬛🟩🟩🟩🟩DROWN',
      '⬛🟩🟩🟩🟩CROWN',
      '⬛⬛⬛⬛⬛FROWN',
    ]);
  });

  it('omits the reveal line when a guess is all green', () => {
    expect(
      formatKrunkHandLog(
        'bob',
        10_000_000_000n,
        [
          { word: 'RATES', clue: [1n, 0n, 0n, 0n, 0n] },
          { word: 'GROIN', clue: [0n, 2n, 2n, 0n, 2n] },
          { word: 'BROWN', clue: [0n, 2n, 2n, 2n, 2n] },
          { word: 'DROWN', clue: [0n, 2n, 2n, 2n, 2n] },
          { word: 'FROWN', clue: [2n, 2n, 2n, 2n, 2n] },
        ],
        'FROWN',
      ),
    ).toEqual([
      'Krunk (guessing) 0.01 XCH',
      '🟧⬛⬛⬛⬛RATES',
      '⬛🟩🟩⬛🟩GROIN',
      '⬛🟩🟩🟩🟩BROWN',
      '⬛🟩🟩🟩🟩DROWN',
      '🟩🟩🟩🟩🟩FROWN',
    ]);
  });

  it('routes a typed move rejection with its game id, tag, and message', () => {
    expect(
      gameplayEventForMoveRejected({
        id: 7n,
        tag: 'not_in_dictionary',
        message: 'xxxxx',
      }),
    ).toEqual({
      MoveRejected: {
        gameId: '7',
        tag: 'not_in_dictionary',
        message: 'xxxxx',
      },
    });
  });

  it('exposes the guesser game on the first atomic-group acceptance', () => {
    // First ProposalAccepted seeds activeIds and currentHandGameIds with the
    // full atomic group so both Krunk panels wire immediately.
    const activeIds = activeIdsAfterProposalAccepted([], '1', ['1', '3']);
    expect(activeIds).toEqual(['1', '3']);
    expect(activeIdsAfterProposalAccepted(activeIds, '3', ['1', '3'])).toEqual(['1', '3']);

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
          moverShare: '0',
        },
      },
    ]);
  });
});
