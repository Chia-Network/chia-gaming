import {
  acceptedSettlementFromOpponent,
  SpHandler,
} from '../../hooks/useSpacepokerHand';

describe('Space Poker received accept settlement', () => {
  it('keeps the winning showdown side at showdown and marks the opponent as conceding', () => {
    expect(acceptedSettlementFromOpponent(SpHandler.End)).toEqual({
      action: 'concede',
      terminalState: 'conceded-by-opponent',
      nextHandler: SpHandler.Showdown,
    });
  });

  it('marks an opponent acceptance during betting as a fold', () => {
    expect(acceptedSettlementFromOpponent(SpHandler.MidRound)).toEqual({
      action: 'fold',
      terminalState: 'folded-by-opponent',
      nextHandler: SpHandler.Folded,
    });
  });
});
