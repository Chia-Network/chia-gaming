import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { EMPTY, Subject } from 'rxjs';
import {
  KrunkHandler,
  applyKrunkMoveRejected,
  canDraftKrunkGuess,
  canQueueKrunkGuess,
  isKrunkDictionaryRejectionError,
  krunkBoardNotice,
  krunkGuessesWithQueued,
  krunkGuessSubmissionMode,
  krunkTerminalStatus,
  krunkWinMessage,
  type KrunkGameState,
} from './useKrunkHand';
import { isValidKrunkStake } from './handProposal';
import {
  formatKrunkHandLog,
  krunkGameSlots,
  krunkLetterStatuses,
  newlyResolvedKrunkIndex,
  type KrunkProps,
} from './Krunk';
import Krunk from './Krunk';
import { initialKrunkGameState, krunkStateCodec } from './serialize';
import {
  type GameTerminalModel,
  type GameplayEvent,
  type LiveGamePort,
  type LocalGameActionRequest,
} from '../../host';

function terminal(
  outcome: GameTerminalModel['outcome'] = null,
  myReward: string | null = null,
): GameTerminalModel {
  return {
    type: outcome === null ? 'none' : 'settled',
    outcome,
    label: null,
    myReward,
    rewardCoinHex: null,
  };
}

describe('Krunk terms', () => {
  it('requires positive 100-mojo stake increments', () => {
    expect(isValidKrunkStake(0n)).toBe(false);
    expect(isValidKrunkStake(99n)).toBe(false);
    expect(isValidKrunkStake(100n)).toBe(true);
    expect(isValidKrunkStake(200n)).toBe(true);
    expect(isValidKrunkStake(201n)).toBe(false);
  });
});

describe('Krunk draft continuity', () => {
  it('preserves the picker entry area across both timeouts and terminal presentation', () => {
    const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
      },
    });
    const persisted = krunkStateCodec.encode({
      games: {
        picker: {
          ...initialKrunkGameState('alice'),
          handler: KrunkHandler.WaitingCommit,
          secretWord: null,
        },
        guesser: {
          ...initialKrunkGameState('bob'),
          handler: KrunkHandler.BobWaiting,
        },
      },
    });
    const gameplay = new Subject<GameplayEvent>();
    const renderPhases: string[] = [];
    const controller = {
      handState: persisted,
      makeMove: jest.fn(),
      commitLocalGameAction: jest.fn(),
      transitionFeatureState: jest.fn((_, __, state) => state),
    } as unknown as LiveGamePort;
    const baseProps = {
      handSource: { interactionMode: 'live' as const, handState: persisted, port: controller },
      currentHandGameIds: ['picker', 'guesser'],
      activeGameIds: ['picker', 'guesser'],
      gameplayEvent$: gameplay,
      onTurnChanged: () => {},
      onGameLog: () => {},
      terminalsById: {},
      amountsById: { picker: '100', guesser: '100' },
      opponentName: 'Peer',
    };
    const renderKrunk = (props: KrunkProps) =>
      React.createElement(
        React.Profiler,
        {
          id: 'krunk-hand',
          onRender: (_id, phase) => renderPhases.push(phase),
        },
        React.createElement(Krunk, props),
      );
    let renderer: ReactTestRenderer;

    act(() => {
      renderer = create(renderKrunk(baseProps));
    });
    for (const letter of ['C', 'R', 'A']) {
      const key = renderer!.root
        .findAllByType('button')
        .find((button) => button.props.children === letter);
      act(() => key!.props.onClick());
    }
    const draftLetters = () =>
      renderer!.root
        .findAll(
          (node) =>
            typeof node.props.className === 'string' &&
            node.props.className.includes('border-dashed') &&
            typeof node.props.children === 'string' &&
            node.props.children !== '',
        )
        .map((node) => node.props.children);
    expect(draftLetters()).toEqual(['C', 'R', 'A']);

    const pickerTimeout = terminal('opponent_timed_out', '100');
    act(() => {
      gameplay.next({
        Settled: { gameId: 'picker', outcome: 'opponent_timed_out', ourShare: '100' },
      });
      renderer!.update(
        renderKrunk({
          ...baseProps,
          activeGameIds: ['guesser'],
          terminalsById: { picker: pickerTimeout },
        }),
      );
    });
    expect(
      renderer!.root.findAll((node) => node.props.children === 'Peer got nothing due to timeout.'),
    ).toHaveLength(1);

    const guesserTimeout = terminal('timed_out_waiting_for_our_move', '0');
    act(() => {
      gameplay.next({
        Settled: {
          gameId: 'guesser',
          outcome: 'timed_out_waiting_for_our_move',
          ourShare: '0',
        },
      });
      renderer!.update(
        renderKrunk({
          ...baseProps,
          activeGameIds: [],
          terminalsById: { picker: pickerTimeout, guesser: guesserTimeout },
        }),
      );
    });
    expect(
      renderer!.root.findAll((node) => node.props.children === 'You got nothing due to timeout.'),
    ).toHaveLength(1);

    act(() => {
      renderer!.update(
        renderKrunk({
          ...baseProps,
          activeGameIds: [],
          terminalsById: { picker: pickerTimeout, guesser: guesserTimeout },
          handSource: { interactionMode: 'terminal', handState: persisted },
        }),
      );
    });
    expect(
      renderer!.root.findAll((node) => node.props['data-testid'] === 'finished-session-game-view'),
    ).toHaveLength(0);
    expect(renderPhases.filter((phase) => phase === 'mount')).toHaveLength(1);
    expect(draftLetters()).toEqual(['C', 'R', 'A']);

    act(() => renderer!.unmount());
    if (windowDescriptor) {
      Object.defineProperty(globalThis, 'window', windowDescriptor);
    } else {
      delete (globalThis as { window?: unknown }).window;
    }
  });

  it('does not retry a feature transition when durable authority rejects the commit', () => {
    const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
      },
    });
    const makeMove = jest.fn();
    const transitionFeatureState = jest.fn(() => false);
    const commitLocalGameAction = jest.fn(() => {
      throw new Error('word rejected');
    });
    const persisted = krunkStateCodec.encode({
      games: {
        picker: initialKrunkGameState('alice'),
        guesser: initialKrunkGameState('bob'),
      },
    });
    let renderer: ReactTestRenderer;

    act(() => {
      renderer = create(
        React.createElement(Krunk, {
          handSource: {
            interactionMode: 'live',
            handState: persisted,
            port: {
              makeMove,
              commitLocalGameAction,
              transitionFeatureState,
            } as unknown as LiveGamePort,
          },
          currentHandGameIds: ['picker', 'guesser'],
          activeGameIds: ['picker', 'guesser'],
          gameplayEvent$: EMPTY,
          onTurnChanged: () => {},
          onGameLog: () => {},
          terminalsById: {},
          amountsById: { picker: '100', guesser: '100' },
        }),
      );
    });

    const root = renderer!.root;
    for (const letter of ['C', 'R', 'A', 'N', 'E']) {
      const key = root.findAllByType('button').find((button) => button.props.children === letter);
      act(() => key!.props.onClick());
    }
    const pick = root.findAllByType('button').find((button) => button.props.children === 'Pick');
    expect(() => act(() => pick!.props.onClick())).toThrow('word rejected');

    expect(commitLocalGameAction).toHaveBeenCalledTimes(1);
    expect(transitionFeatureState).not.toHaveBeenCalled();
    expect(makeMove).not.toHaveBeenCalled();
    act(() => renderer!.unmount());
    if (windowDescriptor) {
      Object.defineProperty(globalThis, 'window', windowDescriptor);
    } else {
      delete (globalThis as { window?: unknown }).window;
    }
  });

  it('keeps current-hand picker input available when activeIds omits its game', () => {
    const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
      },
    });
    const makeMove = jest.fn();
    const transitionFeatureState = jest.fn(() => true);
    const commitLocalGameAction = jest.fn((request: LocalGameActionRequest) => {
      if (request.command.type !== 'make-move') throw new Error('unexpected command');
      makeMove(request.id, request.command.readable);
    });
    const persisted = krunkStateCodec.encode({
      games: {
        picker: initialKrunkGameState('alice'),
        guesser: initialKrunkGameState('bob'),
      },
    });
    let renderer: ReactTestRenderer;

    act(() => {
      renderer = create(
        React.createElement(Krunk, {
          handSource: {
            interactionMode: 'live',
            handState: persisted,
            port: {
              makeMove,
              commitLocalGameAction,
              transitionFeatureState,
            } as unknown as LiveGamePort,
          },
          currentHandGameIds: ['picker', 'guesser'],
          activeGameIds: ['guesser'],
          gameplayEvent$: EMPTY,
          onTurnChanged: () => {},
          onGameLog: () => {},
          terminalsById: {},
          amountsById: { picker: '100', guesser: '100' },
        }),
      );
    });

    const root = renderer!.root;
    for (const letter of ['C', 'R', 'A', 'N', 'E']) {
      const key = root.findAllByType('button').find((button) => button.props.children === letter);
      expect(key).toBeDefined();
      act(() => key!.props.onClick());
    }
    const pick = root.findAllByType('button').find((button) => button.props.children === 'Pick');
    expect(pick).toBeDefined();
    expect(pick!.props.disabled).toBe(false);
    act(() => pick!.props.onClick());

    expect(commitLocalGameAction).toHaveBeenCalledWith(
      expect.objectContaining({
        gameType: 'krunk',
        id: 'picker',
        state: expect.objectContaining({
          handler: KrunkHandler.AliceWaiting,
          secretWord: 'CRANE',
        }),
      }),
    );
    expect(makeMove).toHaveBeenCalledWith('picker', expect.anything());
    act(() => renderer!.unmount());
    if (windowDescriptor) {
      Object.defineProperty(globalThis, 'window', windowDescriptor);
    } else {
      delete (globalThis as { window?: unknown }).window;
    }
  });

  it('supplies the new clue index during the render that resolves it', () => {
    expect(newlyResolvedKrunkIndex(1, 0)).toBe(0);
    expect(newlyResolvedKrunkIndex(3, 2)).toBe(2);
    expect(newlyResolvedKrunkIndex(2, 2)).toBeUndefined();
  });

  it('keeps durable role slots stable after one sibling ends', () => {
    const current = ['0', '1'];
    const active = ['1'];
    const aliceFirst = krunkStateCodec.encode({
      games: {
        '0': initialKrunkGameState('alice'),
        '1': initialKrunkGameState('bob'),
      },
    });

    expect(krunkGameSlots(current, active, aliceFirst)).toEqual({
      aliceGameId: '0',
      bobGameId: '1',
      aliceActive: false,
      bobActive: true,
    });
    const bobFirst = krunkStateCodec.encode({
      games: {
        '0': initialKrunkGameState('bob'),
        '1': initialKrunkGameState('alice'),
      },
    });
    expect(krunkGameSlots(current, active, bobFirst)).toEqual({
      aliceGameId: '1',
      bobGameId: '0',
      aliceActive: true,
      bobActive: false,
    });
  });

  it('uses persisted roles on finished restore', () => {
    const alice = {
      ...initialKrunkGameState('alice'),
      handler: KrunkHandler.Terminal,
      myTurn: false,
      secretWord: 'CRANE',
      outcome: 'win' as const,
    };
    const bob = {
      ...initialKrunkGameState('bob'),
      handler: KrunkHandler.Terminal,
      myTurn: false,
      outcome: 'lose' as const,
    };
    const persisted = krunkStateCodec.encode({ games: { '0': alice, '1': bob } });

    expect(krunkGameSlots(['0', '1'], [], persisted)).toEqual({
      aliceGameId: '0',
      bobGameId: '1',
      aliceActive: false,
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
      'You got nothing due to timeout.',
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
    ).toBe('Peer got nothing due to timeout.');
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
        terminal('settled_cleanly', '0'),
        '100',
      ),
    ).toBe("You didn't win anything.");
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
    expect(krunkTerminalStatus(bobWin, 'Peer', terminal())).toBe('You won 100 mojo!');
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

  it.each(
    (['accept_settlement', 'we_accepted', 'settled_cleanly'] as const).flatMap((settlement) =>
      (['alice', 'bob'] as const).flatMap((role) =>
        (['win', 'lose'] as const).map((outcome) => ({ settlement, role, outcome })),
      ),
    ),
  )(
    'shows the per-game winner for $settlement / $role / $outcome',
    ({ settlement, role, outcome }) => {
      const state: KrunkGameState = {
        handler: KrunkHandler.Terminal,
        myTurn: false,
        role,
        guesses: role === 'bob' ? [{ word: 'CRANE', clue: [2n, 2n, 2n, 2n, 2n] }] : [],
        secretWord: role === 'alice' ? 'CRANE' : null,
        revealedWord: 'CRANE',
        outcome,
        moverShare: null,
        error: null,
      };

      const expected =
        role === 'alice'
          ? outcome === 'win'
            ? "Peer didn't win anything."
            : 'Peer won 20 mojo!'
          : outcome === 'win'
            ? 'You won 20 mojo!'
            : "You didn't win anything.";
      expect(
        krunkBoardNotice(
          state,
          'Peer',
          terminal(settlement, outcome === 'win' ? '20' : '80'),
          '100',
        ),
      ).toEqual({
        text: expected,
        kind: role === 'bob' && outcome === 'win' ? 'win' : 'info',
      });
    },
  );

  it.each([
    ['opponent_timed_out', 'Peer got nothing due to timeout.'],
    ['timed_out_waiting_for_our_move', 'Peer got 100 mojo due to timeout.'],
    ['lost', 'We lost.'],
  ] as const)('keeps %s copy ahead of reward display', (outcome, text) => {
    const won: KrunkGameState = {
      handler: KrunkHandler.Terminal,
      myTurn: false,
      role: 'alice',
      guesses: [],
      secretWord: 'CRANE',
      revealedWord: 'CRANE',
      outcome: 'win',
      moverShare: '100',
      error: null,
    };

    expect(krunkBoardNotice(won, 'Peer', terminal(outcome, '100'), '100')).toEqual({
      text,
      kind: 'info',
    });
  });

  it('shows the local guesser receiving the full amount when the picker times out', () => {
    const bob: KrunkGameState = {
      handler: KrunkHandler.Terminal,
      myTurn: false,
      role: 'bob',
      guesses: [],
      secretWord: null,
      revealedWord: null,
      outcome: 'win',
      moverShare: null,
      error: null,
    };

    expect(krunkBoardNotice(bob, 'Peer', terminal('opponent_timed_out', '100'), '100')).toEqual({
      text: 'You got 100 mojo due to timeout.',
      kind: 'info',
    });
  });

  it('formats bob win amounts as mojo below 1e6 and chia at or above', () => {
    expect(krunkWinMessage('100')).toBe('You won 100 mojo!');
    expect(krunkWinMessage('999999')).toBe('You won 999999 mojo!');
    expect(krunkWinMessage('1000000')).toBe('You won 0.000001 chia!');
    expect(krunkWinMessage('1000000000000')).toBe('You won 1 chia!');
  });

  it('formats an opponent clean win in chia from game amount minus our share', () => {
    const lost: KrunkGameState = {
      handler: KrunkHandler.Terminal,
      myTurn: false,
      role: 'alice',
      guesses: [{ word: 'CRANE', clue: [2n, 2n, 2n, 2n, 2n] }],
      secretWord: 'CRANE',
      revealedWord: 'CRANE',
      outcome: 'lose',
      moverShare: null,
      error: null,
    };
    expect(
      krunkBoardNotice(
        lost,
        'Bob',
        terminal('accept_settlement', '1000000000000'),
        '2000000000000',
      ),
    ).toEqual({ text: 'Bob won 1 chia!', kind: 'info' });
  });

  it('derives the clean winner from completed play when outcome projection is late', () => {
    const late: KrunkGameState = {
      handler: KrunkHandler.Terminal,
      myTurn: false,
      role: 'alice',
      guesses: [{ word: 'CRANE', clue: [2n, 2n, 2n, 2n, 2n] }],
      secretWord: 'CRANE',
      revealedWord: null,
      outcome: null,
      moverShare: null,
      error: null,
    };
    expect(krunkBoardNotice(late, 'Bob', terminal('settled_cleanly', '80'), '100')).toEqual({
      text: 'Bob won 20 mojo!',
      kind: 'info',
    });
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
});
