import React, { useEffect } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Program } from 'clvm-lib';
import { EMPTY, Subject } from 'rxjs';
import { cardIdToRankSuit, handValueToDescription } from './types';
import {
  shouldAutoFireCalpokerMove,
  shouldProcessCalpokerOpponentMoved,
  calpokerResponderFinishesAtReveal,
  shouldRestoreCalpokerSelection,
  useCalpokerHand,
} from './useCalpokerHand';
import {
  calpokerSettlementVerb,
  calpokerTimeoutBadge,
} from './settlement';
import {
  EMPTY_GAME_TERMINAL_MODEL,
  isForfeitOutcome,
  type GameHandOrigin,
  type GameplayEvent,
  type LiveGameController,
  type LocalGameActionRequest,
} from '../../host';
import { calpokerStateCodec } from './stateCodec';
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

function makeLocalActionCommit(makeMove: jest.Mock) {
  return (request: LocalGameActionRequest) => {
    if (request.command.type !== 'make-move') {
      throw new Error(`Unexpected test command ${request.command.type}`);
    }
    makeMove(request.id, request.command.readable);
  };
}

describe('Calpoker bigint domain helpers', () => {
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

  it('still accepts a late final readable move after terminal if no outcome was shown', () => {
    expect(shouldProcessCalpokerOpponentMoved(true, false)).toBe(true);
    expect(shouldProcessCalpokerOpponentMoved(true, true)).toBe(false);
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
    const commitLocalGameAction = jest.fn(makeLocalActionCommit(makeMove));
    const controller = {
      handState: calpokerStateCodec.encode({
        playerHand: [],
        opponentHand: [],
        cardSelections: [],
        moveNumber: 0n,
        isPlayerTurn: true,
      }),
      isChannelReady: () => true,
      transitionFeatureState: () => true,
      commitLocalGameAction,
      makeMove,
    } as unknown as LiveGameController;

    function Harness() {
      useCalpokerHand(
        { interactionMode: 'live', controller },
        '7',
        false,
        EMPTY,
        () => {},
        () => {},
        EMPTY_GAME_TERMINAL_MODEL,
      );
      return null;
    }

    act(() => {
      renderer = create(React.createElement(Harness));
    });

    expect(makeMove).toHaveBeenCalledTimes(1);
    expect(makeMove).toHaveBeenCalledWith('7', null);
    expect(commitLocalGameAction).toHaveBeenCalledWith(
      expect.objectContaining({
        gameType: 'calpoker',
        id: '7',
        command: { type: 'make-move', readable: null },
      }),
    );
  });

  it('does not project or submit when the session rejects the opening state commit', () => {
    const makeMove = jest.fn();
    const onTurnChanged = jest.fn();
    const controller = {
      handState: calpokerStateCodec.encode({
        playerHand: [],
        opponentHand: [],
        cardSelections: [],
        moveNumber: 0n,
        isPlayerTurn: true,
      }),
      isChannelReady: () => true,
      transitionFeatureState: () => false,
      commitLocalGameAction: () => {
        throw new Error('opening rejected');
      },
      makeMove,
    } as unknown as LiveGameController;
    function Harness() {
      useCalpokerHand(
        { interactionMode: 'live', controller },
        '7',
        false,
        EMPTY,
        () => {},
        onTurnChanged,
        EMPTY_GAME_TERMINAL_MODEL,
      );
      return null;
    }

    expect(() =>
      act(() => {
        renderer = create(React.createElement(Harness));
      }),
    ).toThrow('opening rejected');
    expect(makeMove).not.toHaveBeenCalled();
    expect(onTurnChanged).not.toHaveBeenCalled();
  });

  it('does not replay the opening nil move when mounting a restored session', () => {
    const makeMove = jest.fn();
    const controller = {
      handState: calpokerStateCodec.encode({
        playerHand: [],
        opponentHand: [],
        cardSelections: [],
        moveNumber: 0n,
        isPlayerTurn: true,
      }),
      isChannelReady: () => true,
      transitionFeatureState: () => true,
      commitLocalGameAction: makeLocalActionCommit(makeMove),
      makeMove,
    } as unknown as LiveGameController;

    function Harness() {
      useCalpokerHand(
        { interactionMode: 'live', controller },
        '7',
        false,
        EMPTY,
        () => {},
        () => {},
        EMPTY_GAME_TERMINAL_MODEL,
        'restored',
      );
      return null;
    }

    act(() => {
      renderer = create(React.createElement(Harness));
    });

    expect(makeMove).not.toHaveBeenCalled();
  });

  it('auto-fires a new hand after a restored hand on the same controller', () => {
    const makeMove = jest.fn();
    const controller = {
      handState: calpokerStateCodec.encode({
        playerHand: [],
        opponentHand: [],
        cardSelections: [],
        moveNumber: 0n,
        isPlayerTurn: true,
      }),
      getRestoreStatus: () => 'restored',
      isChannelReady: () => true,
      transitionFeatureState: () => true,
      commitLocalGameAction: makeLocalActionCommit(makeMove),
      makeMove,
    } as unknown as LiveGameController;

    function Harness({ gameId, handOrigin }: { gameId: string; handOrigin: GameHandOrigin }) {
      useCalpokerHand(
        { interactionMode: 'live', controller },
        gameId,
        false,
        EMPTY,
        () => {},
        () => {},
        EMPTY_GAME_TERMINAL_MODEL,
        handOrigin,
      );
      return null;
    }
    const mount = (key: number, gameId: string, handOrigin: GameHandOrigin) =>
      React.createElement(Harness, { key, gameId, handOrigin });

    act(() => {
      renderer = create(mount(1, '7', 'restored'));
    });
    expect(makeMove).not.toHaveBeenCalled();

    act(() => {
      renderer!.update(mount(2, '9', 'fresh'));
    });
    expect(makeMove).toHaveBeenCalledTimes(1);
    expect(makeMove).toHaveBeenCalledWith('9', null);
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
        playerHand,
        opponentHand,
        cardSelections: playerHand.slice(0, 4),
        moveNumber: 2n,
        isPlayerTurn: true,
      }),
      isChannelReady: () => true,
      transitionFeatureState: (_gameType: string, _gameId: string, state: unknown) => {
        if (!calpokerStateCodec.isState(state)) {
          rejectedPayloads.push(state);
          return false;
        }
        return true;
      },
      commitLocalGameAction: makeLocalActionCommit(makeMove),
      makeMove,
    } as unknown as LiveGameController;
    let hand: ReturnType<typeof useCalpokerHand> | undefined;

    function Harness() {
      hand = useCalpokerHand(
        { interactionMode: 'live', controller },
        '7',
        false,
        EMPTY,
        () => {},
        () => {},
        EMPTY_GAME_TERMINAL_MODEL,
        'restored',
      );
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
    });

    expect(rejectedPayloads).toEqual([]);
    expect(hand!.cardSelections).toEqual([]);
    expect(makeMove).toHaveBeenCalledTimes(1);
    expect(makeMove).toHaveBeenCalledWith('7', null);
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
      interactionMode: 'terminal',
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

  it('animates a skipped-reveal loser after local selections are submitted', () => {
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
    const transitionFeatureState = jest.fn(() => true);
    const makeMove = jest.fn();
    const controller = {
      handState: calpokerStateCodec.encode({
        playerHand,
        opponentHand,
        cardSelections: selections,
        moveNumber: 2n,
        isPlayerTurn: false,
      }),
      isChannelReady: () => true,
      transitionFeatureState,
      commitLocalGameAction: makeLocalActionCommit(makeMove),
      makeMove,
    } as unknown as LiveGameController;
    const gameplay = new Subject<GameplayEvent>();
    const onOutcome = jest.fn();
    const mountCount = jest.fn();

    function Harness({ terminalOutcome }: { terminalOutcome: 'forfeited_skipped_reveal' | null }) {
      useEffect(() => {
        mountCount();
      }, []);
      const hand = useCalpokerHand(
        terminalOutcome === null
          ? { interactionMode: 'live', controller }
          : { interactionMode: 'terminal', handState: controller.handState },
        '7',
        false,
        gameplay,
        onOutcome,
        () => {},
        terminalOutcome
          ? {
              type: 'settled',
              outcome: terminalOutcome,
              label: 'Forfeited',
              myReward: '0',
              rewardCoinHex: null,
            }
          : EMPTY_GAME_TERMINAL_MODEL,
        'restored',
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
        interactionMode: 'terminal',
      });
    }

    try {
      act(() => {
        renderer = create(React.createElement(Harness, { terminalOutcome: null }));
      });
      act(() => {
        gameplay.next({
          OpponentMoved: {
            gameId: '7',
            readable: finalReadable,
            moverShare: '0',
          },
        });
        renderer!.update(
          React.createElement(Harness, {
            terminalOutcome: 'forfeited_skipped_reveal',
          }),
        );
        gameplay.next({
          Settled: {
            gameId: '7',
            outcome: 'forfeited_skipped_reveal',
            ourShare: '0',
          },
        });
      });

      const presentation = () =>
        renderer!.root.find((node) => node.props['data-calpoker-game-state'] !== undefined);
      expect(mountCount).toHaveBeenCalledTimes(1);
      expect(onOutcome).toHaveBeenCalledTimes(1);
      expect(onOutcome.mock.calls[0][0].my_win_outcome).toBe('lose');
      expect(presentation().props['data-calpoker-game-state']).toBe(GAME_STATES.REVEALING_SWAP);
      expect(presentation().props['data-calpoker-interaction-mode']).toBe('terminal');

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
      expect(() => JSON.stringify(renderer!.toJSON())).not.toThrow();
      const markup = JSON.stringify(renderer!.toJSON());
      expect(markup).toContain('Bob wins (');
      expect(markup).toContain('Alice loses (');
      expect(markup).toContain('forfeit');
      expect(transitionFeatureState).not.toHaveBeenCalled();
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
      interactionMode: 'terminal',
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
