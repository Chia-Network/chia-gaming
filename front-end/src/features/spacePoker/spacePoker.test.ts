import {
  isTerminalSpacepokerHandler,
  opponentTerminalAction,
  pendingTerminalActionMatchesFailure,
  clearsShowdownForTerminalAction,
  retainsRevealedTerminalPresentation,
  rollbackOptimisticTerminalHistory,
  SpHandler,
  terminalAutoSubmissionAllowed,
  terminalRecoveryAfterOpponentMove,
  voluntarySpacepokerSettlementAction,
} from './useSpacepokerHand';
import {
  gameplayEventForActionFailed,
  gameplayEventForGameActionError,
} from '../../hooks/useGameSession';

describe('Space Poker terminal UX', () => {
  it('attributes only actual opponent folds and no-reveal flags', () => {
    expect(opponentTerminalAction(
      { handler: SpHandler.MidRound, myTurn: false, N: 2n },
    )).toBe('fold');
    expect(opponentTerminalAction(
      { handler: SpHandler.End, myTurn: false, N: 1n },
    )).toBe('concede');
    expect(opponentTerminalAction(
      { handler: SpHandler.End, myTurn: true, N: 1n },
    )).toBeNull();
    expect(opponentTerminalAction(
      { handler: SpHandler.Showdown, myTurn: false, N: 0n },
    )).toBeNull();
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

  it('recognizes terminal handlers', () => {
    expect(isTerminalSpacepokerHandler(SpHandler.Folded)).toBe(true);
    expect(isTerminalSpacepokerHandler(SpHandler.Showdown)).toBe(true);
    expect(isTerminalSpacepokerHandler(SpHandler.End)).toBe(false);
  });

  it('forwards a scoped terminal action failure to gameplay', () => {
    expect(gameplayEventForGameActionError(
      '42',
      'accept-settlement',
      'cannot accept',
    )).toEqual({
      GameError: {
        gameId: '42',
        action: 'accept-settlement',
        reason: 'cannot accept',
        source: 'action',
      },
    });
  });

  it('forwards only scoped ActionFailed notifications to terminal rollback', () => {
    expect(gameplayEventForActionFailed({
      id: '42',
      action: 'make_move',
      reason: 'cannot reveal',
    })).toEqual({
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
    expect(voluntarySpacepokerSettlementAction(
      'accept_settlement',
      { handler: SpHandler.MidRound, myTurn: false, N: 2n },
    )).toEqual({ player: 'opponent', action: 'fold' });
    expect(voluntarySpacepokerSettlementAction(
      'we_accepted',
      { handler: SpHandler.End, myTurn: false, N: 1n },
    )).toEqual({ player: 'you', action: 'concede' });

    for (const outcome of [
      'settled_cleanly',
      'opponent_timed_out',
      'timed_out_waiting_for_our_move',
      'slashed_opponent',
      'opponent_slashed_us',
    ] as const) {
      expect(voluntarySpacepokerSettlementAction(
        outcome,
        { handler: SpHandler.MidRound, myTurn: false, N: 2n },
      )).toBeNull();
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
    expect(retainsRevealedTerminalPresentation(
      localReveal, 'none', 'accept_settlement',
    )).toBe(true);
    expect(retainsRevealedTerminalPresentation(
      null, 'revealed', 'we_accepted',
    )).toBe(true);
    expect(retainsRevealedTerminalPresentation(
      localReveal, 'revealed', 'opponent_timed_out',
    )).toBe(false);
    expect(retainsRevealedTerminalPresentation(
      localReveal, 'revealed', 'slashed_opponent',
    )).toBe(false);
    // A late action error cannot roll back after the acknowledgement cleared pending.
    expect(pendingTerminalActionMatchesFailure(null, 'make-move')).toBe(false);
  });

  it('keeps concede separate and clears its showdown data', () => {
    expect(voluntarySpacepokerSettlementAction(
      'accept_settlement',
      { handler: SpHandler.End, myTurn: true, N: 1n },
    )).toEqual({ player: 'you', action: 'concede' });
    expect(clearsShowdownForTerminalAction('concede')).toBe(true);
    expect(clearsShowdownForTerminalAction('fold')).toBe(false);
    expect(clearsShowdownForTerminalAction('reveal')).toBe(false);
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
