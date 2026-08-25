import { restoreSpacepokerHand, type SpacepokerHandState } from '@games/spacepoker/ui/serialize';
import { SpHandler } from '@games/spacepoker/ui/useSpacepokerHand';

function handState(overrides: Partial<SpacepokerHandState>): SpacepokerHandState {
  return {
    gameId: '7',
    perPlayerStake: 100n,
    gameState: { handler: SpHandler.MidRound, myTurn: false, N: 3n },
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
    coinTossIOpen: true,
    unitSizeMojos: 10n,
    settlementOutcome: null,
    displayMode: 'units',
    ...overrides,
  };
}

function opponentAccepted(current: SpacepokerHandState): SpacepokerHandState {
  const hand = restoreSpacepokerHand(current);
  hand.receive({
    type: 'hand-ended',
    gameId: '7',
    outcome: 'accept_settlement',
  });
  return hand.getState();
}

describe('Space Poker received accept settlement', () => {
  it('keeps the winning showdown side at showdown and marks the opponent as conceding', () => {
    const settled = opponentAccepted(
      handState({
        gameState: { handler: SpHandler.End, myTurn: false, N: 1n },
        outcome: {
          result: 1n,
          playerHandCards: [],
          playerHandEval: [],
          opponentHandCards: [],
          opponentHandEval: [],
        },
      }),
    );

    expect(settled).toMatchObject({
      gameState: { handler: SpHandler.Showdown, myTurn: false, N: 0n },
      terminalState: 'conceded-by-opponent',
      handHistory: [{ player: 'opponent', action: 'concede' }],
    });
  });

  it('marks an opponent acceptance during betting as a fold', () => {
    const settled = opponentAccepted(handState({}));

    expect(settled).toMatchObject({
      gameState: { handler: SpHandler.Folded, myTurn: false, N: 3n },
      terminalState: 'folded-by-opponent',
      handHistory: [{ player: 'opponent', action: 'fold' }],
    });
  });
});
