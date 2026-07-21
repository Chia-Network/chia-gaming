import {
  channelStateNeedsGameTabAttention,
  gameplayEventNeedsGameTabAttention,
  peerProposalIdNeedsGameTabAttention,
} from '../gameTabAttention';
import type { GameplayEvent } from '../../hooks/useGameSession';

describe('gameTabAttention', () => {
  it('marks opponent moves and proposal accepts as attention', () => {
    expect(gameplayEventNeedsGameTabAttention({
      OpponentMoved: { readable: new Uint8Array([1]), moverShare: '0' },
    })).toBe(true);
    expect(gameplayEventNeedsGameTabAttention({
      ProposalAccepted: { id: '1' },
    })).toBe(true);
  });

  it('marks settlement accepts as attention', () => {
    expect(gameplayEventNeedsGameTabAttention({
      Settled: { gameId: '1', outcome: 'accept_settlement', ourShare: '50' },
    })).toBe(true);
    expect(gameplayEventNeedsGameTabAttention({
      Settled: { gameId: '1', outcome: 'we_accepted', ourShare: '50' },
    })).toBe(true);
  });

  it('skips GameMessage and non-accept settlements', () => {
    expect(gameplayEventNeedsGameTabAttention({
      GameMessage: { readable: new Uint8Array([1]), gameId: '1' },
    })).toBe(false);
    expect(gameplayEventNeedsGameTabAttention({
      Settled: { gameId: '1', outcome: 'settled_cleanly', ourShare: '50' },
    })).toBe(false);
    expect(gameplayEventNeedsGameTabAttention({
      Settled: { gameId: '1', outcome: 'opponent_timed_out', ourShare: '50' },
    })).toBe(false);
    const moveRejected: GameplayEvent = {
      MoveRejected: { gameId: '1', tag: 'x', message: 'nope' },
    };
    expect(gameplayEventNeedsGameTabAttention(moveRejected)).toBe(false);
  });

  it('marks shutdown and on-chain channel states as attention', () => {
    expect(channelStateNeedsGameTabAttention('ShuttingDown')).toBe(true);
    expect(channelStateNeedsGameTabAttention('ShutdownTransactionPending')).toBe(true);
    expect(channelStateNeedsGameTabAttention('GoingOnChain')).toBe(true);
    expect(channelStateNeedsGameTabAttention('Unrolling')).toBe(true);
    expect(channelStateNeedsGameTabAttention('Active')).toBe(false);
    expect(channelStateNeedsGameTabAttention('ResolvedClean')).toBe(false);
  });

  it('marks new or replaced peer proposal ids as attention', () => {
    expect(peerProposalIdNeedsGameTabAttention(null, '5')).toBe(true);
    expect(peerProposalIdNeedsGameTabAttention('5', '7')).toBe(true);
    expect(peerProposalIdNeedsGameTabAttention('5', '5')).toBe(false);
    expect(peerProposalIdNeedsGameTabAttention('5', null)).toBe(false);
    expect(peerProposalIdNeedsGameTabAttention(null, null)).toBe(false);
  });
});
