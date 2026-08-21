import {
  gameplayEventForActionFailed,
  gameplayEventForEndedStatus,
  gameplayEventForGameActionError,
  gameplayEventForMoveRejected,
  gameplayEventForSettlement,
  gameplayEventsForGameStatus,
} from '../wasm/gameplayEvents';

describe('WASM gameplay event projection', () => {
  it('maps a typed MoveRejected payload to a game-scoped host event', () => {
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

  it('maps a scoped game-action-error onto GameError', () => {
    expect(gameplayEventForGameActionError('42', 'accept-settlement', 'cannot accept')).toEqual({
      GameError: {
        gameId: '42',
        action: 'accept-settlement',
        reason: 'cannot accept',
        source: 'action',
      },
    });
  });

  it('forwards only scoped ActionFailed notifications', () => {
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

  it('projects GameStatus readable with mover_share as OpponentMoved', () => {
    expect(
      gameplayEventsForGameStatus(
        {
          id: '3',
          status: 'my-turn',
          coin_id: null,
          other_params: {
            readable: [0x80],
            mover_share: '0',
          },
        },
        ['1', '3'],
      ),
    ).toEqual([
      {
        OpponentMoved: {
          readable: Uint8Array.from([0x80]),
          gameId: '3',
          moverShare: '0',
        },
      },
    ]);
  });

  it('projects GameStatus readable without mover_share as GameMessage', () => {
    expect(
      gameplayEventsForGameStatus(
        {
          id: '7',
          status: 'their-turn',
          other_params: { readable: [1, 2, 3] },
        },
        ['7'],
      ),
    ).toEqual([{ GameMessage: { readable: Uint8Array.from([1, 2, 3]), gameId: '7' } }]);
  });

  it('emits Settled for validated settlement terminals and GameError otherwise', () => {
    expect(
      gameplayEventForSettlement('7', {
        type: 'settled',
        outcome: 'settled_cleanly',
        label: 'Settled cleanly',
        myReward: '20',
        rewardCoinHex: null,
      }),
    ).toEqual({
      Settled: { gameId: '7', outcome: 'settled_cleanly', ourShare: '20' },
    });
    expect(
      gameplayEventForSettlement('7', {
        type: 'game-error',
        outcome: null,
        label: 'Settlement missing our_share',
        myReward: null,
        rewardCoinHex: null,
      }),
    ).toEqual({
      GameError: {
        gameId: '7',
        reason: 'Settlement missing our_share',
        source: 'terminal',
      },
    });
  });

  it('emits terminal GameError only for ended-cancelled and game-error status', () => {
    expect(
      gameplayEventForEndedStatus('7', {
        type: 'ended-cancelled',
        outcome: null,
        label: 'Cancelled',
        myReward: null,
        rewardCoinHex: null,
      }),
    ).toEqual({
      GameError: { gameId: '7', reason: 'Cancelled', source: 'terminal' },
    });
    expect(
      gameplayEventForEndedStatus('7', {
        type: 'none',
        outcome: null,
        label: null,
        myReward: null,
        rewardCoinHex: null,
      }),
    ).toBeNull();
  });
});
