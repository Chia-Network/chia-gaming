import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { EMPTY } from 'rxjs';

import {
  isTerminalSpacepokerHandler,
  opponentTerminalAction,
  pendingTerminalActionMatchesFailure,
  reconcilePendingTerminalHistory,
  retainsRevealedTerminalPresentation,
  rollbackOptimisticTerminalHistory,
  SpHandler,
  terminalAutoSubmissionAllowed,
  terminalRecoveryAfterOpponentMove,
  retainsVoluntaryTerminalPresentation,
  voluntarySpacepokerSettlementAction,
  useSpacepokerHand,
  type UseSpacepokerHandResult,
} from './useSpacepokerHand';
import {
  spacePokerFooterStatus,
  spacePokerRankLabel,
  spacePokerTerminalBanners,
  spacePokerTerminalCommentary,
  spacePokerTransitionCommentary,
} from './SpacePoker';
import {
  gameplayEventForActionFailed,
  gameplayEventForGameActionError,
} from '../../hooks/useGameSession';
import type { SessionController } from '../../hooks/SessionController';
import { decodeGameFeatureState } from '../../lib/gameRegistry';
import { INITIAL_GAME_TERMINAL_MODEL } from '../../lib/session/model';
import { spacepokerStateCodec } from './stateCodec';

describe('Space Poker terminal UX', () => {
  it('uses a single-character ten rank', () => {
    expect(spacePokerRankLabel(10n)).toBe('T');
  });

  it('attributes only actual opponent folds and no-reveal flags', () => {
    expect(opponentTerminalAction({ handler: SpHandler.MidRound, myTurn: false, N: 2n })).toBe(
      'fold',
    );
    expect(opponentTerminalAction({ handler: SpHandler.End, myTurn: false, N: 1n })).toBe(
      'concede',
    );
    expect(opponentTerminalAction({ handler: SpHandler.End, myTurn: true, N: 1n })).toBeNull();
    expect(
      opponentTerminalAction({ handler: SpHandler.Showdown, myTurn: false, N: 0n }),
    ).toBeNull();
  });

  it('removes only the failed optimistic terminal action', () => {
    const history = [
      { player: 'opponent' as const, action: 'raise' as const, units: 2n },
      { player: 'you' as const, action: 'concede' as const },
    ];

    expect(rollbackOptimisticTerminalHistory(history, 'concede')).toEqual([
      { player: 'opponent', action: 'raise', units: 2n },
    ]);
    expect(rollbackOptimisticTerminalHistory(history, 'fold')).toEqual(history);
  });

  it('keeps eyes when clean settlement confirms a pending reveal', () => {
    const history = [
      { player: 'you' as const, action: 'check' as const },
      { player: 'you' as const, action: 'reveal' as const },
    ];

    expect(reconcilePendingTerminalHistory(history, 'reveal', 'settled_cleanly')).toEqual(history);
    expect(reconcilePendingTerminalHistory(history, null, 'settled_cleanly')).toEqual(history);
    expect(reconcilePendingTerminalHistory(history, 'reveal', 'attempt_to_move_failed')).toEqual([
      { player: 'you', action: 'check' },
      { player: 'you', action: 'failed' },
    ]);
  });

  it('recognizes terminal handlers', () => {
    expect(isTerminalSpacepokerHandler(SpHandler.Folded)).toBe(true);
    expect(isTerminalSpacepokerHandler(SpHandler.Showdown)).toBe(true);
    expect(isTerminalSpacepokerHandler(SpHandler.End)).toBe(false);
  });

  it('clears stale live-turn text when terminal commentary takes over', () => {
    expect(spacePokerFooterStatus(SpHandler.End, 'Your turn')).toBe('Your turn');
    expect(spacePokerFooterStatus(SpHandler.Showdown, 'Your turn')).toBe('');
    expect(spacePokerFooterStatus(SpHandler.Folded, 'Waiting for opponent…')).toBe('');
  });

  it('describes non-betting transitions near the start and end of a hand', () => {
    expect(spacePokerTransitionCommentary(SpHandler.CommitA, true)).toBe('Dealing cards…');
    expect(spacePokerTransitionCommentary(SpHandler.CommitB, false)).toBe('Dealing cards…');
    expect(spacePokerTransitionCommentary(SpHandler.End, true)).toBe('Finishing hand…');
    expect(spacePokerTransitionCommentary(SpHandler.End, false)).toBe(
      'Waiting for opponent to finish…',
    );
  });

  it('uses one commentary field with a message for every terminal hand', () => {
    expect(spacePokerTerminalCommentary('conceded-by-opponent', null, 'we_accepted')).toBe(
      'You revealed first and the opponent conceded.',
    );
    expect(spacePokerTerminalCommentary('revealed', 1n, 'settled_cleanly')).toBe(
      'You won at showdown.',
    );
    expect(spacePokerTerminalCommentary('revealed', -1n, 'settled_cleanly')).toBe(
      'The opponent won at showdown.',
    );
    expect(spacePokerTerminalCommentary('revealed', 0n, 'settled_cleanly')).toBe(
      'The showdown ended in a tie.',
    );
    expect(spacePokerTerminalCommentary('settled', null, 'opponent_timed_out')).toBe(
      'Opponent timed out.',
    );
    expect(spacePokerTerminalCommentary('settled', null, null)).toBe('The hand ended.');
  });

  it('shows a winner rather than fold/reveal iconography for an opponent action failure', () => {
    expect(spacePokerTerminalBanners('won-by-opponent-failure', null)).toEqual({
      player: 'win',
      opponent: null,
    });
  });

  it('forwards a scoped terminal action failure to gameplay', () => {
    expect(gameplayEventForGameActionError('42', 'accept-settlement', 'cannot accept')).toEqual({
      GameError: {
        gameId: '42',
        action: 'accept-settlement',
        reason: 'cannot accept',
        source: 'action',
      },
    });
  });

  it('forwards only scoped ActionFailed notifications to terminal rollback', () => {
    expect(
      gameplayEventForActionFailed({
        id: '42',
        action: 'make_move',
        reason: 'cannot reveal',
      }),
    ).toEqual({
      GameError: {
        gameId: '42',
        action: 'make-move',
        reason: 'cannot reveal',
        source: 'action',
      },
    });
    expect(gameplayEventForActionFailed({ reason: 'unscoped failure' })).toBeNull();
  });

  it('maps only voluntary settlement outcomes to terminal poker actions', () => {
    expect(
      voluntarySpacepokerSettlementAction('accept_settlement', {
        handler: SpHandler.MidRound,
        myTurn: false,
        N: 2n,
      }),
    ).toEqual({ player: 'opponent', action: 'fold' });
    expect(
      voluntarySpacepokerSettlementAction('we_accepted', {
        handler: SpHandler.End,
        myTurn: false,
        N: 1n,
      }),
    ).toEqual({ player: 'you', action: 'concede' });

    for (const outcome of [
      'settled_cleanly',
      'opponent_timed_out',
      'timed_out_waiting_for_our_move',
      'slashed_opponent',
      'opponent_slashed_us',
    ] as const) {
      expect(
        voluntarySpacepokerSettlementAction(outcome, {
          handler: SpHandler.MidRound,
          myTurn: false,
          N: 2n,
        }),
      ).toBeNull();
    }
  });

  it('models controller-to-hook synchronous terminal failure ordering', () => {
    const localReveal = {
      action: 'reveal' as const,
      submission: 'make-move' as const,
      previousTerminalState: 'none' as const,
      previousGameState: { handler: SpHandler.End, myTurn: true, N: 1n },
    };

    // A regular move error has no matching terminal intent, so the hook leaves
    // the playable hand untouched.
    expect(pendingTerminalActionMatchesFailure(null, 'make-move')).toBe(false);
    // A controller error emitted synchronously by local reveal clears the
    // pending intent before the submission callback may transition to Showdown.
    expect(pendingTerminalActionMatchesFailure(localReveal, 'make-move')).toBe(true);
    expect(pendingTerminalActionMatchesFailure(localReveal, 'accept-settlement')).toBe(false);
  });

  it('retains revealed UI only for voluntary settlement acknowledgement', () => {
    const localReveal = {
      action: 'reveal' as const,
      submission: 'make-move' as const,
      previousTerminalState: 'none' as const,
      previousGameState: { handler: SpHandler.End, myTurn: true, N: 1n },
    };

    // Successful local reveal settlement clears pending but preserves history.
    expect(retainsRevealedTerminalPresentation(localReveal, 'none', 'accept_settlement')).toBe(
      true,
    );
    expect(retainsRevealedTerminalPresentation(null, 'revealed', 'we_accepted')).toBe(true);
    expect(retainsRevealedTerminalPresentation(localReveal, 'revealed', 'opponent_timed_out')).toBe(
      false,
    );
    expect(retainsRevealedTerminalPresentation(localReveal, 'revealed', 'slashed_opponent')).toBe(
      false,
    );
    // A late action error cannot roll back after the acknowledgement cleared pending.
    expect(pendingTerminalActionMatchesFailure(null, 'make-move')).toBe(false);
  });

  it('retains restored fold and concede UI only for voluntary settlement acknowledgement', () => {
    for (const terminalState of [
      'folded-by-you',
      'folded-by-opponent',
      'conceded-by-you',
      'conceded-by-opponent',
    ] as const) {
      expect(retainsVoluntaryTerminalPresentation(terminalState, 'accept_settlement')).toBe(true);
      expect(retainsVoluntaryTerminalPresentation(terminalState, 'we_accepted')).toBe(true);
      expect(retainsVoluntaryTerminalPresentation(terminalState, 'opponent_timed_out')).toBe(false);
      expect(retainsVoluntaryTerminalPresentation(terminalState, 'slashed_opponent')).toBe(false);
    }
  });

  it('keeps concede separate from a showdown reveal', () => {
    expect(
      voluntarySpacepokerSettlementAction('accept_settlement', {
        handler: SpHandler.End,
        myTurn: true,
        N: 1n,
      }),
    ).toEqual({ player: 'you', action: 'concede' });
  });

  it('blocks automatic retry until a user retry or authoritative update', () => {
    expect(terminalAutoSubmissionAllowed('reveal')).toBe(false);
    expect(terminalAutoSubmissionAllowed('concede')).toBe(false);
    expect(terminalAutoSubmissionAllowed(null)).toBe(true);
  });

  it('preserves terminal recovery across unrelated opponent moves', () => {
    expect(terminalRecoveryAfterOpponentMove('reveal', false)).toBe('reveal');
    expect(terminalRecoveryAfterOpponentMove('concede', false)).toBe('concede');
    expect(terminalRecoveryAfterOpponentMove('reveal', true)).toBeNull();
  });
});

describe('Space Poker feature-state authority', () => {
  let renderer: ReactTestRenderer | null = null;

  afterEach(() => {
    if (renderer) act(() => renderer?.unmount());
    renderer = null;
  });

  it('does not project or submit when the session rejects a local action commit', () => {
    const makeMove = jest.fn();
    const onTurnChanged = jest.fn();
    const controller = {
      handState: spacepokerStateCodec.encode({
        gameState: { handler: SpHandler.MidRound, myTurn: true, N: 3n },
        playerHoleCards: [1n, 2n],
        playerBoost: false,
        opponentHoleCards: null,
        opponentBoost: null,
        communityCards: [3n, 4n, 5n, null, null],
        halfPot: 1n,
        lastRaise: 0n,
        iRaisedLast: false,
        handHistory: [],
        outcome: null,
        terminalState: 'none',
        terminalRecovery: null,
        coinTossIOpen: true,
        unitSizeMojos: 10n,
        displayMode: 'units',
      }),
      isChannelReady: () => true,
      transitionFeatureState: () => false,
      makeMove,
    } as unknown as SessionController;
    let hand: UseSpacepokerHandResult | undefined;

    function Harness() {
      hand = useSpacepokerHand(
        controller,
        '7',
        false,
        EMPTY,
        100n,
        10n,
        onTurnChanged,
        INITIAL_GAME_TERMINAL_MODEL,
        controller.handState ?? undefined,
      );
      return null;
    }

    act(() => {
      renderer = create(React.createElement(Harness));
    });
    act(() => {
      hand?.handleCheck();
    });

    expect(hand?.gameState).toEqual({ handler: SpHandler.MidRound, myTurn: true, N: 3n });
    expect(hand?.handHistory).toEqual([]);
    expect(makeMove).not.toHaveBeenCalled();
    expect(onTurnChanged).not.toHaveBeenCalled();
  });

  it('commits a fold and its terminal presentation as one codec-valid state', () => {
    const acceptSettlement = jest.fn();
    const transitions: unknown[] = [];
    const controller = {
      handState: spacepokerStateCodec.encode({
        gameState: { handler: SpHandler.MidRound, myTurn: true, N: 3n },
        playerHoleCards: [1n, 2n],
        playerBoost: false,
        opponentHoleCards: null,
        opponentBoost: null,
        communityCards: [3n, 4n, 5n, null, null],
        halfPot: 1n,
        lastRaise: 0n,
        iRaisedLast: false,
        handHistory: [],
        outcome: null,
        terminalState: 'none',
        terminalRecovery: null,
        coinTossIOpen: true,
        unitSizeMojos: 10n,
        displayMode: 'units',
      }),
      isChannelReady: () => true,
      transitionFeatureState: (_gameType: string, _gameId: string, state: unknown) => {
        transitions.push(state);
        return decodeGameFeatureState('spacepoker', state) !== null;
      },
      acceptSettlement,
    } as unknown as SessionController;
    let hand: UseSpacepokerHandResult | undefined;

    function Harness() {
      hand = useSpacepokerHand(
        controller,
        '7',
        false,
        EMPTY,
        100n,
        10n,
        jest.fn(),
        INITIAL_GAME_TERMINAL_MODEL,
        controller.handState ?? undefined,
      );
      return null;
    }

    act(() => {
      renderer = create(React.createElement(Harness));
    });
    act(() => {
      hand?.handleFold();
    });

    expect(transitions).toHaveLength(1);
    expect(decodeGameFeatureState('spacepoker', transitions[0])).toMatchObject({
      gameState: { handler: SpHandler.Folded, myTurn: false, N: 3n },
      terminalState: 'folded-by-you',
      handHistory: [{ player: 'you', action: 'fold' }],
    });
    expect(acceptSettlement).toHaveBeenCalledWith('7');
  });

  it('omits the check-only endsStreet flag when calling a raise', () => {
    const makeMove = jest.fn();
    const transitions: unknown[] = [];
    const controller = {
      handState: spacepokerStateCodec.encode({
        gameState: { handler: SpHandler.MidRound, myTurn: true, N: 3n },
        playerHoleCards: [1n, 2n],
        playerBoost: false,
        opponentHoleCards: null,
        opponentBoost: null,
        communityCards: [3n, 4n, 5n, null, null],
        halfPot: 3n,
        lastRaise: 2n,
        iRaisedLast: false,
        handHistory: [{ player: 'opponent', action: 'raise', units: 2n }],
        outcome: null,
        terminalState: 'none',
        terminalRecovery: null,
        coinTossIOpen: true,
        unitSizeMojos: 10n,
        displayMode: 'units',
      }),
      isChannelReady: () => true,
      transitionFeatureState: (_gameType: string, _gameId: string, state: unknown) => {
        transitions.push(state);
        return decodeGameFeatureState('spacepoker', state) !== null;
      },
      makeMove,
    } as unknown as SessionController;
    let hand: UseSpacepokerHandResult | undefined;

    function Harness() {
      hand = useSpacepokerHand(
        controller,
        '7',
        false,
        EMPTY,
        100n,
        10n,
        jest.fn(),
        INITIAL_GAME_TERMINAL_MODEL,
        controller.handState ?? undefined,
      );
      return null;
    }

    act(() => {
      renderer = create(React.createElement(Harness));
    });
    act(() => {
      hand?.handleCall();
    });

    expect(transitions).toHaveLength(1);
    expect(decodeGameFeatureState('spacepoker', transitions[0])).toMatchObject({
      gameState: { handler: SpHandler.BeginRound, myTurn: false, N: 2n },
      halfPot: 5n,
      lastRaise: 0n,
      handHistory: [
        { player: 'opponent', action: 'raise', units: 2n },
        { player: 'you', action: 'call' },
      ],
    });
    expect(makeMove).toHaveBeenCalledWith('7', null);
  });
});
