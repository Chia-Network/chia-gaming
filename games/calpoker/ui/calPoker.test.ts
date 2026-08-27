import React, { createRef, useEffect } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Program } from 'clvm-lib';
import { cardIdToRankSuit, handValueToDescription } from './types';
import {
  shouldAutoFireCalpokerMove,
  calpokerResponderFinishesAtReveal,
  shouldRestoreCalpokerSelection,
  useCalpokerHand,
} from './useCalpokerHand';
import { calpokerSettlementVerb, calpokerTimeoutBadge, isForfeitOutcome } from './settlement';
import {
  type GameHandOrigin,
  type GameIntent,
  type GameMountView,
  type GameProposalFormHandle,
  type LiveGamePort,
  type PersistedGameState,
} from '../../host';
import { HandProposalForm } from './handProposalForm';
import {
  calpokerStateCodec,
  isCalpokerHandState,
  restoreCalpokerHand,
  type CalpokerHand,
  type CalpokerHandState,
} from './serialize';
import CaliforniaPoker from './components/CaliforniaPoker';
import {
  GAME_STATES,
  PRE_SWAP_REVEAL_DURATION,
  SWAP_ANIMATION_DURATION,
} from './components/constants/constants';
import { CalpokerOutcome, projectCalpokerFinalDisplay } from './outcome';
import type { CaliforniapokerProps, CalpokerOutcomeView } from './types/CaliforniapokerProps';

jest.mock('./components/components/GameBottomBar', () => () => null);
jest.mock('./components/components', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    HandDisplay: (props: { timeoutBadge?: string | null }) =>
      React.createElement('div', { 'data-timeout-badge': props.timeoutBadge ?? '' }),
    MovingCard: (props: { cardData: { direction: string } }) =>
      React.createElement('div', {
        'data-moving-card': 'true',
        'data-moving-direction': props.cardData.direction,
      }),
  };
});

type TestLiveGamePort = LiveGamePort & {
  handState: PersistedGameState<CalpokerHandState>;
};
const testHands = new WeakMap<TestLiveGamePort, CalpokerHand>();

describe('Calpoker hand restoration', () => {
  const savedState: CalpokerHandState = {
    perPlayerStake: 100n,
    playerHand: [],
    opponentHand: [],
    cardSelections: [],
    moveNumber: 0n,
    isPlayerTurn: true,
    iStarted: false,
    settlementOutcome: null,
  };

  it('restores a valid saved state', () => {
    expect(restoreCalpokerHand(savedState).getState()).toBe(savedState);
  });

  it('rejects malformed saved state before constructing a hand', () => {
    expect(() => restoreCalpokerHand({ ...savedState, perPlayerStake: 0n })).toThrow(
      'Cannot restore California Poker hand: saved state is invalid',
    );
  });
});

function makeDispatch(makeMove: jest.Mock) {
  return (intent: GameIntent) => {
    if (intent.type === 'state-changed') return;
    if (intent.type !== 'make-move') {
      throw new Error(`Unexpected test intent ${intent.type}`);
    }
    makeMove(intent.memberIndex, intent.readable);
  };
}

function liveSource(
  port: TestLiveGamePort,
  handOrigin: Exclude<GameHandOrigin, 'terminal'> = 'fresh',
): GameMountView<CalpokerHand> {
  let hand = testHands.get(port);
  if (!hand) {
    hand = {
      receive: (update) => {
        const restored = restoreCalpokerHand(calpokerStateCodec.decode(port.handState)!);
        restored.receive(update);
        port.handState = calpokerStateCodec.encode(restored.getState());
      },
      getState: () => calpokerStateCodec.decode(port.handState)!,
      update: (reducer) => {
        port.handState = calpokerStateCodec.encode(
          reducer(calpokerStateCodec.decode(port.handState)!),
        );
      },
    };
    testHands.set(port, hand);
  }
  return {
    frozen: false,
    hand,
    port,
    handOrigin,
    appendGameLog: jest.fn(),
  };
}

describe('Calpoker bigint domain helpers', () => {
  it('owns proposal form state and exposes it through getProposal', () => {
    const ref = createRef<GameProposalFormHandle<Record<string, never>>>();
    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(
        React.createElement(HandProposalForm, {
          ref,
          disabled: false,
          maxPerHandMojos: 200n,
          defaultContribution: 100n,
          initialProposal: null,
          onSubmit: () => {},
        }),
      );
    });
    expect(ref.current?.getProposal()).toEqual({
      ok: true,
      senderContribution: 100n,
      receiverContribution: 100n,
      parameters: {},
    });
    act(() => renderer!.unmount());
  });

  it('accepts bigint card ids at display boundaries', () => {
    expect(cardIdToRankSuit(51n)).toEqual({ rank: 14, suit: 4 });
  });

  it('describes bigint hand values', () => {
    const desc = handValueToDescription([2n, 1n, 1n, 1n, 14n, 13n, 12n, 11n], [0n]);
    expect(desc).toEqual({
      name: 'Pair',
      values: [14n, 13n, 12n, 11n],
    });
  });

  it('does not auto-fire final reveal after hand is already finished', () => {
    expect(shouldAutoFireCalpokerMove(true, true, 2n)).toBe(false);
    expect(shouldAutoFireCalpokerMove(false, true, 2n)).toBe(true);
  });

  it('at the endgame reveal, only the responder finishes; the terminal mover (Alice) still plays step e', () => {
    // iStarted === false is the first mover ("Alice"), who owes the terminal
    // move e and must NOT be marked finished, or her autofire never fires.
    expect(calpokerResponderFinishesAtReveal(false)).toBe(false);
    // iStarted === true is the responder ("Bob"), who gives up and must not
    // send a phantom sixth move.
    expect(calpokerResponderFinishesAtReveal(true)).toBe(true);
  });

  it('preserves a terminal snapshot at move 1', () => {
    expect(shouldRestoreCalpokerSelection('1', false, true)).toBe(false);
  });

  it('restores an active move-1 hand to card selection', () => {
    expect(shouldRestoreCalpokerSelection('1', false, false)).toBe(true);
  });

  it('does not describe an off-chain settlement as a timeout', () => {
    expect(calpokerTimeoutBadge('accept_settlement', 'ours')).toBeNull();
    expect(calpokerTimeoutBadge('accept_settlement', 'theirs')).toBeNull();
    expect(calpokerTimeoutBadge('timed_out_waiting_for_our_move', 'ours')).toBe('timeout');
    expect(calpokerTimeoutBadge('opponent_timed_out', 'ours')).toBe('winner');
  });

  it('does not show a timeout badge after a completed hand settles on-chain', () => {
    expect(calpokerTimeoutBadge('timed_out_waiting_for_our_move', 'ours', true)).toBeNull();
    expect(calpokerTimeoutBadge('opponent_timed_out', 'theirs', true)).toBeNull();
  });

  it('distinguishes an ordinary terminal loss from a real forfeit', () => {
    expect(isForfeitOutcome('lost')).toBe(false);
    expect(calpokerSettlementVerb('lost')).toBe('loses');
    expect(calpokerTimeoutBadge('lost', 'ours')).toBeNull();
    expect(calpokerTimeoutBadge('lost', 'theirs')).toBeNull();
    expect(isForfeitOutcome('forfeited_skipped_reveal')).toBe(true);
    expect(isForfeitOutcome('forfeited_we_accepted')).toBe(true);
  });
});

describe('Calpoker fresh hand startup', () => {
  let renderer: ReactTestRenderer | null = null;

  afterEach(() => {
    if (renderer) act(() => renderer?.unmount());
    renderer = null;
  });

  it('submits the opening nil move when fresh durable state is already installed', () => {
    const makeMove = jest.fn();
    const dispatch = jest.fn(makeDispatch(makeMove));
    const controller = {
      handState: calpokerStateCodec.encode({
        perPlayerStake: 100n,
        playerHand: [],
        opponentHand: [],
        cardSelections: [],
        moveNumber: 0n,
        isPlayerTurn: true,
        iStarted: false,
        settlementOutcome: null,
        error: null,
      }),
      isChannelReady: () => true,
      dispatch,
    };

    function Harness() {
      useCalpokerHand(liveSource(controller));
      return null;
    }

    act(() => {
      renderer = create(React.createElement(Harness));
    });

    expect(makeMove).toHaveBeenCalledTimes(1);
    expect(makeMove).toHaveBeenCalledWith(0, null);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'make-move',
        memberIndex: 0,
        readable: null,
      }),
    );
  });

  it('does not project or submit when the session rejects the opening state commit', () => {
    const makeMove = jest.fn();
    const controller = {
      handState: calpokerStateCodec.encode({
        perPlayerStake: 100n,
        playerHand: [],
        opponentHand: [],
        cardSelections: [],
        moveNumber: 0n,
        isPlayerTurn: true,
        iStarted: false,
        settlementOutcome: null,
        error: null,
      }),
      isChannelReady: () => true,
      dispatch: () => {
        throw new Error('opening rejected');
      },
    };
    function Harness() {
      useCalpokerHand(liveSource(controller));
      return null;
    }

    expect(() =>
      act(() => {
        renderer = create(React.createElement(Harness));
      }),
    ).toThrow('opening rejected');
    expect(makeMove).not.toHaveBeenCalled();
  });

  it('retries the opening nil move when restored state still requires it', () => {
    const makeMove = jest.fn();
    const controller = {
      handState: calpokerStateCodec.encode({
        perPlayerStake: 100n,
        playerHand: [],
        opponentHand: [],
        cardSelections: [],
        moveNumber: 0n,
        isPlayerTurn: true,
        iStarted: false,
        settlementOutcome: null,
        error: null,
      }),
      isChannelReady: () => true,
      dispatch: makeDispatch(makeMove),
    };

    function Harness() {
      useCalpokerHand(liveSource(controller, 'restored'));
      return null;
    }

    act(() => {
      renderer = create(React.createElement(Harness));
    });

    expect(makeMove).toHaveBeenCalledTimes(1);
    expect(makeMove).toHaveBeenCalledWith(0, null);
  });

  it('auto-fires a new hand after a restored hand on the same controller', () => {
    const makeMove = jest.fn();
    const controller = {
      handState: calpokerStateCodec.encode({
        perPlayerStake: 100n,
        playerHand: [],
        opponentHand: [],
        cardSelections: [],
        moveNumber: 0n,
        isPlayerTurn: true,
        iStarted: false,
        settlementOutcome: null,
        error: null,
      }),
      isChannelReady: () => true,
      dispatch: makeDispatch(makeMove),
    };

    function Harness({ handOrigin }: { handOrigin: GameHandOrigin }) {
      useCalpokerHand(liveSource(controller, handOrigin));
      return null;
    }
    const mount = (key: number, handOrigin: GameHandOrigin) =>
      React.createElement(Harness, { key, handOrigin });

    act(() => {
      renderer = create(mount(1, 'restored'));
    });
    expect(makeMove).toHaveBeenCalledTimes(1);
    expect(makeMove).toHaveBeenLastCalledWith(0, null);

    act(() => {
      controller.handState = calpokerStateCodec.encode({
        perPlayerStake: 100n,
        playerHand: [],
        opponentHand: [],
        cardSelections: [],
        moveNumber: 0n,
        isPlayerTurn: true,
        iStarted: false,
        settlementOutcome: null,
        error: null,
      });
      renderer!.update(mount(2, 'fresh'));
    });
    expect(makeMove).toHaveBeenCalledTimes(2);
    expect(makeMove).toHaveBeenLastCalledWith(0, null);
  });
});

describe('Calpoker terminal hand projection', () => {
  let renderer: ReactTestRenderer | null = null;

  afterEach(() => {
    if (renderer) act(() => renderer?.unmount());
    renderer = null;
  });

  it('keeps the swapped terminal hand codec-valid', () => {
    const playerHand = [0n, 1n, 2n, 3n, 4n, 5n, 6n, 7n];
    const opponentHand = [8n, 9n, 10n, 11n, 12n, 13n, 14n, 15n];
    const rejectedPayloads: unknown[] = [];
    const makeMove = jest.fn();
    const controller = {
      handState: calpokerStateCodec.encode({
        perPlayerStake: 100n,
        playerHand,
        opponentHand,
        cardSelections: playerHand.slice(0, 4),
        moveNumber: 2n,
        isPlayerTurn: true,
        iStarted: false,
        settlementOutcome: null,
        error: null,
      }),
      isChannelReady: () => true,
      dispatch: (intent: GameIntent) => {
        if (!isCalpokerHandState(controller.handState.state)) {
          rejectedPayloads.push(controller.handState.state);
          throw new Error('Calpoker test received invalid local action state');
        }
        if (intent.type === 'make-move') {
          makeMove(intent.memberIndex, intent.readable);
        }
      },
    };
    let hand: ReturnType<typeof useCalpokerHand> | undefined;

    function Harness() {
      hand = useCalpokerHand(liveSource(controller, 'restored'));
      return null;
    }

    act(() => {
      renderer = create(React.createElement(Harness));
    });
    act(() => {
      hand!.setHandOrder(
        [...opponentHand.slice(0, 4), ...playerHand.slice(4)],
        [...playerHand.slice(0, 4), ...opponentHand.slice(4)],
      );
      hand!.handleMakeMove();
      renderer!.update(React.createElement(Harness));
    });

    expect(rejectedPayloads).toEqual([]);
    expect(hand!.cardSelections).toEqual([]);
    expect(makeMove).toHaveBeenCalledTimes(1);
    expect(makeMove).toHaveBeenCalledWith(0, null);
  });

  it('finishes the normal swap animation and keeps final descriptions after terminal loss', () => {
    jest.useFakeTimers();
    const originalDocument = globalThis.document;
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        querySelector: (selector: string) => {
          const match = selector.match(/data-card-id="(?:player|ai)-(\d+)"/);
          if (!match) return null;
          const cardId = Number(match[1]);
          return {
            getBoundingClientRect: () => ({
              left: cardId * 10,
              top: cardId,
              width: 8,
              height: 12,
            }),
          };
        },
      },
    });
    const playerHand = [32n, 36n, 41n, 49n, 33n, 37n, 42n, 50n];
    const opponentHand = [2n, 6n, 9n, 13n, 3n, 7n, 10n, 14n];
    const readable = Program.fromList([
      Program.fromBigInt(15n),
      Program.fromBigInt(31n),
      Program.fromBigInt(31n),
      Program.fromList([1n, 1n, 1n, 1n, 1n, 14n, 13n, 12n, 11n, 10n].map(Program.fromBigInt)),
      Program.fromList([1n, 1n, 1n, 1n, 1n, 10n, 9n, 8n, 7n, 6n].map(Program.fromBigInt)),
      Program.fromBigInt(-1n),
    ]).serialize();
    const outcome = new CalpokerOutcome(true, 15n, opponentHand, playerHand, readable);
    const outcomeView: CalpokerOutcomeView = {
      my_win_outcome: outcome.my_win_outcome,
      my_cards: outcome.my_cards.map(String),
      their_cards: outcome.their_cards.map(String),
      my_final_hand: outcome.my_final_hand.map(String),
      their_final_hand: outcome.their_final_hand.map(String),
      my_used_cards: outcome.my_used_cards.map(String),
      their_used_cards: outcome.their_used_cards.map(String),
      my_hand_value: outcome.my_hand_value.map(String),
      their_hand_value: outcome.their_hand_value.map(String),
    };
    const onSnapshotChange = jest.fn();
    const setHandOrder = jest.fn();
    const mountCount = jest.fn();
    const baseProps: CaliforniapokerProps = {
      outcome: undefined,
      moveNumber: '2',
      playerNumber: 1,
      playerHand: playerHand.map(String),
      opponentHand: opponentHand.map(String),
      cardSelections: playerHand.slice(0, 4).map(String),
      setCardSelections: () => {},
      setHandOrder,
      handleMakeMove: () => {},
      onGameLog: () => {},
      onSnapshotChange,
      initialSnapshot: {
        gameState: GAME_STATES.SELECTING,
        winner: null,
        playerBestHandCardIds: [],
        opponentBestHandCardIds: [],
        playerHaloCardIds: playerHand.slice(0, 4).map(String),
        opponentHaloCardIds: [],
        playerDisplayText: '',
        opponentDisplayText: '',
      },
      myName: 'Bob',
      opponentName: 'Alice',
      terminalOutcome: null,
      frozen: true,
    };
    function MountedPoker(props: CaliforniapokerProps) {
      useEffect(() => {
        mountCount();
      }, []);
      return React.createElement(CaliforniaPoker, props);
    }
    const finalDisplay = projectCalpokerFinalDisplay(outcomeView);

    try {
      act(() => {
        renderer = create(React.createElement(MountedPoker, baseProps));
      });
      act(() => {
        renderer!.update(
          React.createElement(MountedPoker, {
            ...baseProps,
            outcome: outcomeView,
            playerHand: finalDisplay.playerCards,
            opponentHand: finalDisplay.opponentCards,
            terminalOutcome: 'lost',
          }),
        );
      });

      expect(mountCount).toHaveBeenCalledTimes(1);
      const presentation = () =>
        renderer!.root.find((node) => node.props['data-calpoker-game-state'] !== undefined);
      expect(presentation().props['data-calpoker-game-state']).toBe(GAME_STATES.REVEALING_SWAP);
      expect(presentation().props['data-calpoker-interaction-mode']).toBe('terminal');
      expect(
        renderer!.root.findAll((node) => node.props['data-moving-card'] === 'true'),
      ).toHaveLength(0);

      act(() => {
        jest.advanceTimersByTime(PRE_SWAP_REVEAL_DURATION);
      });
      const movingCards = renderer!.root.findAll(
        (node) => node.props['data-moving-card'] === 'true',
      );
      expect(movingCards).toHaveLength(16);
      expect(
        movingCards.filter((node) => node.props['data-moving-direction'] === 'playerToAi'),
      ).toHaveLength(4);
      expect(
        movingCards.filter((node) => node.props['data-moving-direction'] === 'aiToPlayer'),
      ).toHaveLength(4);
      expect(presentation().props['data-calpoker-game-state']).toBe(GAME_STATES.SWAPPING);
      act(() => {
        jest.advanceTimersByTime(SWAP_ANIMATION_DURATION);
      });
      expect(presentation().props['data-calpoker-game-state']).toBe(GAME_STATES.FINAL);
      const markup = JSON.stringify(renderer!.toJSON());
      expect(markup).toContain(`Alice wins (${finalDisplay.opponentDisplayText})`);
      expect(markup).toContain(`Bob loses (${finalDisplay.playerDisplayText})`);
      expect(markup).not.toContain('forfeit');
      expect(setHandOrder).not.toHaveBeenCalled();
      expect(onSnapshotChange).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
      Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: originalDocument,
      });
    }
  });

  it('keeps the complete skipped-reveal terminal hand on the existing mount', () => {
    jest.useFakeTimers();
    const originalDocument = globalThis.document;
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        querySelector: (selector: string) => {
          const match = selector.match(/data-card-id="(?:player|ai)-(\d+)"/);
          if (!match) return null;
          const cardId = Number(match[1]);
          return {
            getBoundingClientRect: () => ({
              left: cardId * 10,
              top: cardId,
              width: 8,
              height: 12,
            }),
          };
        },
      },
    });
    const playerHand = [2n, 6n, 9n, 13n, 3n, 7n, 10n, 14n];
    const opponentHand = [32n, 36n, 41n, 49n, 33n, 37n, 42n, 50n];
    const selections = playerHand.slice(0, 4);
    const finalReadable = Program.fromList([
      Program.fromBigInt(15n),
      Program.fromBigInt(31n),
      Program.fromBigInt(31n),
      Program.fromList([1n, 1n, 1n, 1n, 1n, 14n, 13n, 12n, 11n, 10n].map(Program.fromBigInt)),
      Program.fromList([1n, 1n, 1n, 1n, 1n, 10n, 9n, 8n, 7n, 6n].map(Program.fromBigInt)),
      Program.fromBigInt(-1n),
    ]).serialize();
    const dispatch = jest.fn();
    const makeMove = jest.fn();
    const controller = {
      handState: calpokerStateCodec.encode({
        perPlayerStake: 100n,
        playerHand,
        opponentHand,
        cardSelections: selections,
        moveNumber: 2n,
        isPlayerTurn: false,
        iStarted: false,
        settlementOutcome: null,
        error: null,
      }),
      isChannelReady: () => true,
      dispatch,
    };
    const mountCount = jest.fn();
    let terminalHand: GameHand<CalpokerHandState> | null = null;

    function Harness({ terminalOutcome }: { terminalOutcome: 'forfeited_skipped_reveal' | null }) {
      useEffect(() => {
        mountCount();
      }, []);
      const hand = useCalpokerHand(
        terminalOutcome === null
          ? liveSource(controller)
          : {
              frozen: true,
              hand: terminalHand!,
              handOrigin: 'terminal',
            },
      );
      const outcomeViewValue: CalpokerOutcomeView | undefined = hand.outcome
        ? {
            my_win_outcome: hand.outcome.my_win_outcome,
            my_cards: hand.outcome.my_cards.map(String),
            their_cards: hand.outcome.their_cards.map(String),
            my_final_hand: hand.outcome.my_final_hand.map(String),
            their_final_hand: hand.outcome.their_final_hand.map(String),
            my_used_cards: hand.outcome.my_used_cards.map(String),
            their_used_cards: hand.outcome.their_used_cards.map(String),
            my_hand_value: hand.outcome.my_hand_value.map(String),
            their_hand_value: hand.outcome.their_hand_value.map(String),
          }
        : undefined;
      return React.createElement(CaliforniaPoker, {
        outcome: outcomeViewValue,
        moveNumber: String(hand.moveNumber),
        playerNumber: 2,
        playerHand: hand.playerHand.map(String),
        opponentHand: hand.opponentHand.map(String),
        cardSelections: hand.cardSelections.map(String),
        setCardSelections: () => {},
        setHandOrder: (player, opponent) =>
          hand.setHandOrder(player.map(BigInt), opponent?.map(BigInt)),
        handleMakeMove: hand.handleMakeMove,
        onGameLog: () => {},
        onSnapshotChange: () => {},
        initialSnapshot: {
          gameState: GAME_STATES.SELECTING,
          winner: null,
          playerBestHandCardIds: [],
          opponentBestHandCardIds: [],
          playerHaloCardIds: selections.map(String),
          opponentHaloCardIds: [],
          playerDisplayText: '',
          opponentDisplayText: '',
        },
        myName: 'Alice',
        opponentName: 'Bob',
        terminalOutcome,
        frozen: true,
      });
    }

    try {
      act(() => {
        renderer = create(React.createElement(Harness, { terminalOutcome: null }));
      });
      act(() => {
        const current = calpokerStateCodec.decode(controller.handState)!;
        const gameHand = restoreCalpokerHand(current);
        gameHand.receive({
          type: 'move-readable',
          memberIndex: 0,
          readable: finalReadable,
          moverShare: 0n,
        });
        gameHand.receive({
          type: 'hand-ended',
          memberIndex: 0,
          outcome: 'forfeited_skipped_reveal',
        });
        terminalHand = gameHand;
        controller.handState = calpokerStateCodec.encode(gameHand.getState());
        renderer!.update(
          React.createElement(Harness, {
            terminalOutcome: 'forfeited_skipped_reveal',
          }),
        );
      });

      const presentation = () =>
        renderer!.root.find((node) => node.props['data-calpoker-game-state'] !== undefined);
      expect(mountCount).toHaveBeenCalledTimes(1);
      expect(presentation().props['data-calpoker-interaction-mode']).toBe('terminal');
      expect(terminalHand!.getState().displaySnapshot).toMatchObject({
        gameState: 'final',
        winner: 'ai',
      });
      expect(() => JSON.stringify(renderer!.toJSON())).not.toThrow();
      expect(dispatch).not.toHaveBeenCalled();
      expect(makeMove).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
      Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: originalDocument,
      });
    }
  });

  it('cold-restores final hand descriptions without replaying the swap animation', () => {
    const props: CaliforniapokerProps = {
      outcome: undefined,
      moveNumber: '2',
      playerNumber: 1,
      playerHand: ['2', '6', '9', '13', '32', '36', '41', '49'],
      opponentHand: ['3', '7', '10', '14', '33', '37', '42', '50'],
      cardSelections: [],
      setCardSelections: () => {},
      setHandOrder: () => {},
      handleMakeMove: () => {},
      onGameLog: () => {},
      onSnapshotChange: () => {},
      initialSnapshot: {
        gameState: GAME_STATES.FINAL,
        winner: 'ai',
        playerBestHandCardIds: ['2', '6', '9', '13', '32'],
        opponentBestHandCardIds: ['3', '7', '10', '14', '33'],
        playerHaloCardIds: ['32', '36', '41', '49'],
        opponentHaloCardIds: ['2', '6', '9', '13'],
        playerDisplayText: 'Pair, Eights. Ace, King, Nine kickers',
        opponentDisplayText: 'Straight, Ace High',
      },
      myName: 'Bob',
      opponentName: 'Alice',
      terminalOutcome: 'lost',
      frozen: true,
    };

    act(() => {
      renderer = create(React.createElement(CaliforniaPoker, props));
    });

    const markup = JSON.stringify(renderer!.toJSON());
    expect(markup).toContain('Alice wins (Straight, Ace High)');
    expect(markup).toContain('Bob loses (Pair, Eights. Ace, King, Nine kickers)');
    expect(markup).not.toContain('forfeit');
    expect(
      renderer!.root.findAll((node) => node.props['data-moving-card'] === 'true'),
    ).toHaveLength(0);
    expect(
      renderer!.root.find((node) => node.props['data-calpoker-game-state'] !== undefined).props[
        'data-calpoker-game-state'
      ],
    ).toBe(GAME_STATES.FINAL);
  });
});
