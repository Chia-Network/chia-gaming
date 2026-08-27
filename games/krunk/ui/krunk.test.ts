import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import {
  KrunkHandler,
  canDraftKrunkGuess,
  canQueueKrunkGuess,
  krunkBoardNotice,
  krunkGuessesWithQueued,
  krunkGuessSubmissionMode,
  krunkTerminalStatus,
  krunkWinMessage,
  useKrunkHand,
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
import {
  initialKrunkGameState,
  krunkStateCodec,
  restoreKrunkHand,
  type KrunkHand,
} from './serialize';
import type { GameMountView, LiveGamePort } from '../../host';

function testHand(persisted: ReturnType<typeof krunkStateCodec.encode>): KrunkHand {
  return restoreKrunkHand(krunkStateCodec.decode(persisted)!);
}

function liveView(
  persisted: ReturnType<typeof krunkStateCodec.encode>,
  port: LiveGamePort,
): GameMountView<KrunkHand> {
  return {
    frozen: false,
    hand: testHand(persisted),
    handOrigin: 'fresh',
    port,
    appendGameLog: jest.fn(),
  };
}

function frozenView(
  persisted: ReturnType<typeof krunkStateCodec.encode>,
): GameMountView<KrunkHand> {
  return { frozen: true, hand: testHand(persisted), handOrigin: 'terminal' };
}

describe('Krunk hand restoration', () => {
  const savedState = {
    perPlayerStake: 100n,
    members: [initialKrunkGameState('alice'), initialKrunkGameState('bob')],
  } as const;

  it('restores a valid saved state', () => {
    expect(restoreKrunkHand(savedState).getState()).toBe(savedState);
  });

  it('rejects malformed saved state before constructing a hand', () => {
    expect(() => restoreKrunkHand({ ...savedState, members: savedState.members.slice(0, 1) })).toThrow(
      'Cannot restore Krunk hand: saved state is invalid',
    );
  });
});

describe('Krunk terms', () => {
  it('requires positive 100-mojo stake increments', () => {
    expect(isValidKrunkStake(0n)).toBe(false);
    expect(isValidKrunkStake(99n)).toBe(false);
    expect(isValidKrunkStake(100n)).toBe(true);
    expect(isValidKrunkStake(200n)).toBe(true);
    expect(isValidKrunkStake(201n)).toBe(false);
  });
});

describe('Krunk automatic moves', () => {
  let renderer: ReactTestRenderer | null = null;

  afterEach(() => {
    if (renderer) act(() => renderer?.unmount());
    renderer = null;
  });

  it('fires an automatic clue from restored semantic state', () => {
    const dispatch = jest.fn();
    const persisted = krunkStateCodec.encode({
      perPlayerStake: 100n,
      members: [
        {
          ...initialKrunkGameState('alice'),
          handler: KrunkHandler.AliceClue,
          myTurn: true,
        },
        initialKrunkGameState('bob'),
      ],
    });

    function Harness() {
      useKrunkHand(
        liveView(persisted, { isChannelReady: () => true, dispatch }),
        0,
      );
      return null;
    }

    act(() => {
      renderer = create(React.createElement(Harness));
    });

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'make-move',
        memberIndex: 0,
        readable: null,
      }),
    );
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
      perPlayerStake: 100n,
      members: [
        {
          ...initialKrunkGameState('alice'),
          handler: KrunkHandler.WaitingCommit,
          secretWord: null,
        },
        {
          ...initialKrunkGameState('bob'),
          handler: KrunkHandler.BobWaiting,
        },
      ],
    });
    const renderPhases: string[] = [];
    const controller = { dispatch: jest.fn() } as LiveGamePort;
    const baseProps = {
      view: liveView(persisted, controller),
      onGameLog: () => {},
    };
    baseProps.view.opponentName = 'Peer';
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

    const initial = krunkStateCodec.decode(persisted) as KrunkHandState;
    const pickerSettled = krunkStateCodec.encode({
      ...initial,
      members: [
        {
          ...initial.members[0],
          handler: KrunkHandler.Terminal,
          myTurn: false,
          outcome: 'win',
          settlementOutcome: 'opponent_timed_out',
        },
        initial.members[1],
      ],
    });
    act(() => {
      renderer!.update(
        renderKrunk({
          ...baseProps,
          view: { ...liveView(pickerSettled, controller), opponentName: 'Peer' },
        }),
      );
    });
    expect(
      renderer!.root.findAll((node) => node.props.children === 'Peer got nothing due to timeout.'),
    ).toHaveLength(1);

    const pickerState = krunkStateCodec.decode(pickerSettled) as KrunkHandState;
    const bothSettled = krunkStateCodec.encode({
      ...krunkStateCodec.decode(pickerSettled)!,
      members: [
        pickerState.members[0],
        {
          ...pickerState.members[1],
          handler: KrunkHandler.Terminal,
          myTurn: false,
          outcome: 'lose',
          settlementOutcome: 'timed_out_waiting_for_our_move',
        },
      ],
    });
    act(() => {
      renderer!.update(
        renderKrunk({
          ...baseProps,
          view: { ...liveView(bothSettled, controller), opponentName: 'Peer' },
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
          view: { ...frozenView(bothSettled), opponentName: 'Peer' },
        }),
      );
    });
    expect(
      renderer!.root.findAll((node) => node.props['data-testid'] === 'finished-session-game-view'),
    ).toHaveLength(0);
    expect(renderPhases.filter((phase) => phase === 'mount')).toHaveLength(1);
    expect(draftLetters()).toEqual([]);

    act(() => renderer!.unmount());
    if (windowDescriptor) {
      Object.defineProperty(globalThis, 'window', windowDescriptor);
    } else {
      delete (globalThis as { window?: unknown }).window;
    }
  });

  it('does not keep a local durable projection when intent dispatch fails', () => {
    const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
      },
    });
    const dispatch = jest.fn(() => {
      throw new Error('word rejected');
    });
    const persisted = krunkStateCodec.encode({
      perPlayerStake: 100n,
      members: [initialKrunkGameState('alice'), initialKrunkGameState('bob')],
    });
    let renderer: ReactTestRenderer;

    act(() => {
      renderer = create(
        React.createElement(Krunk, {
          view: liveView(persisted, { isChannelReady: () => true, dispatch }),
          onGameLog: () => {},
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

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'make-move',
        memberIndex: 0,
      }),
    );
    act(() => renderer!.unmount());
    if (windowDescriptor) {
      Object.defineProperty(globalThis, 'window', windowDescriptor);
    } else {
      delete (globalThis as { window?: unknown }).window;
    }
  });

  it('keeps picker input available from game-owned member state', () => {
    const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
      },
    });
    const dispatch = jest.fn();
    const persisted = krunkStateCodec.encode({
      perPlayerStake: 100n,
      members: [initialKrunkGameState('alice'), initialKrunkGameState('bob')],
    });
    let renderer: ReactTestRenderer;

    act(() => {
      renderer = create(
        React.createElement(Krunk, {
          view: liveView(persisted, { isChannelReady: () => true, dispatch }),
          onGameLog: () => {},
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

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'make-move',
        memberIndex: 0,
      }),
    );
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
    const aliceFirst = krunkStateCodec.encode({
      perPlayerStake: 100n,
      members: [
        {
          ...initialKrunkGameState('alice'),
          handler: KrunkHandler.Terminal,
          myTurn: false,
        },
        initialKrunkGameState('bob'),
      ],
    });

    expect(krunkGameSlots(krunkStateCodec.decode(aliceFirst)!)).toEqual({
      aliceMemberIndex: 0,
      bobMemberIndex: 1,
      aliceActive: false,
      bobActive: true,
    });
    const bobFirst = krunkStateCodec.encode({
      perPlayerStake: 100n,
      members: [
        {
          ...initialKrunkGameState('bob'),
          handler: KrunkHandler.Terminal,
          myTurn: false,
        },
        initialKrunkGameState('alice'),
      ],
    });
    expect(krunkGameSlots(krunkStateCodec.decode(bobFirst)!)).toEqual({
      aliceMemberIndex: 1,
      bobMemberIndex: 0,
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
    const persisted = krunkStateCodec.encode({
      perPlayerStake: 100n,
      members: [alice, bob],
    });

    expect(krunkGameSlots(krunkStateCodec.decode(persisted)!)).toEqual({
      aliceMemberIndex: 0,
      bobMemberIndex: 1,
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

  it('maps settlement outcomes to terminal status copy', () => {
    const timedOut: KrunkGameState = {
      handler: KrunkHandler.Terminal,
      myTurn: false,
      role: 'bob',
      guesses: [],
      secretWord: null,
      revealedWord: null,
      outcome: 'lose',
      settlementOutcome: 'timed_out_waiting_for_our_move',
      moverShare: null,
      error: null,
    };

    expect(krunkTerminalStatus(timedOut, 'Peer', 100n)).toBe(
      'You got nothing due to timeout.',
    );
    expect(
      krunkTerminalStatus(
        {
          ...timedOut,
          role: 'alice',
          settlementOutcome: 'opponent_timed_out',
        },
        'Peer',
        100n,
      ),
    ).toBe('Peer got nothing due to timeout.');
    expect(
      krunkTerminalStatus(
        {
          ...timedOut,
          settlementOutcome: 'forfeited_skipped_reveal',
        },
        'Peer',
        100n,
      ),
    ).toBe('We forfeited.');
    expect(
      krunkTerminalStatus(
        {
          ...timedOut,
          settlementOutcome: 'settled_cleanly',
        },
        'Peer',
        100n,
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
      settlementOutcome: null,
      moverShare: 100n,
      error: null,
    };
    expect(krunkTerminalStatus(bobWin, 'Peer', 100n)).toBe('You won 100 mojo!');
    expect(
      krunkTerminalStatus(
        {
          ...bobWin,
          outcome: 'lose',
          moverShare: null,
          revealedWord: 'CRANE',
        },
        'Peer',
        100n,
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
        settlementOutcome: settlement,
        moverShare: null,
        error: null,
      };

      const expected =
        role === 'alice'
          ? outcome === 'win'
            ? "Peer didn't win anything."
            : 'Peer won 100 mojo!'
          : outcome === 'win'
            ? 'You won 100 mojo!'
            : "You didn't win anything.";
      expect(
        krunkBoardNotice(state, 'Peer', 100n),
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
      settlementOutcome: outcome,
      moverShare: 100n,
      error: null,
    };

    expect(krunkBoardNotice(won, 'Peer', 100n)).toEqual({
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
      settlementOutcome: 'opponent_timed_out',
      moverShare: null,
      error: null,
    };

    expect(krunkBoardNotice(bob, 'Peer', 100n)).toEqual({
      text: 'You got 100 mojo due to timeout.',
      kind: 'info',
    });
  });

  it('formats bob win amounts as mojo below 1e6 and chia at or above', () => {
    expect(krunkWinMessage(100n)).toBe('You won 100 mojo!');
    expect(krunkWinMessage(999999n)).toBe('You won 999999 mojo!');
    expect(krunkWinMessage(1000000n)).toBe('You won 0.000001 chia!');
    expect(krunkWinMessage(1000000000000n)).toBe('You won 1 chia!');
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
      settlementOutcome: 'accept_settlement',
      moverShare: null,
      error: null,
    };
    expect(
      krunkBoardNotice(lost, 'Bob', 1_000_000_000_000n),
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
      settlementOutcome: 'settled_cleanly',
      moverShare: null,
      error: null,
    };
    expect(krunkBoardNotice(late, 'Bob', 100n)).toEqual({
      text: 'Bob won 100 mojo!',
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
