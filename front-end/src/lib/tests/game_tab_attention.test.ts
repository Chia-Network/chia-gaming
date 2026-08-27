import {
  acceptedHandNeedsGameTabAttention,
  channelStateNeedsGameTabAttention,
  gameModelNeedsGameTabAttention,
  peerProposalIdNeedsGameTabAttention,
} from '../gameTabAttention';
import { EMPTY_GAME_TERMINAL_MODEL } from '@games/host';
import { createSessionModel } from '../session/model';

function gameWith(
  presentation: 'off-chain-my-turn' | 'off-chain-their-turn',
  handState: object,
  outcome: 'accept_settlement' | 'we_accepted' | 'settled_cleanly' | null = null,
) {
  const game = createSessionModel().game;
  return {
    ...game,
    handState: handState as never,
    instances: {
      '1': {
        id: '1',
        amount: '50',
        coinHex: null,
        presentation,
        terminal: { ...EMPTY_GAME_TERMINAL_MODEL, outcome },
      },
    },
  };
}

describe('gameTabAttention', () => {
  it('marks becoming our turn as attention without requiring a hand-state change', () => {
    const handState = {};
    expect(
      gameModelNeedsGameTabAttention(
        gameWith('off-chain-their-turn', handState),
        gameWith('off-chain-my-turn', handState),
      ),
    ).toBe(true);
  });

  it('marks a newly accepted hand without exposing it as a gameplay event', () => {
    expect(acceptedHandNeedsGameTabAttention(3, 4, ['7'])).toBe(true);
    expect(acceptedHandNeedsGameTabAttention(4, 4, ['7'])).toBe(false);
    expect(acceptedHandNeedsGameTabAttention(3, 4, [])).toBe(false);
  });

  it('marks settlement accepts as attention', () => {
    expect(
      gameModelNeedsGameTabAttention(
        gameWith('off-chain-their-turn', {}),
        gameWith('off-chain-their-turn', {}, 'accept_settlement'),
      ),
    ).toBe(true);
    expect(
      gameModelNeedsGameTabAttention(
        gameWith('off-chain-their-turn', {}),
        gameWith('off-chain-their-turn', {}, 'we_accepted'),
      ),
    ).toBe(true);
  });

  it('skips messages, rejections, and non-accept settlements', () => {
    expect(
      gameModelNeedsGameTabAttention(
        gameWith('off-chain-their-turn', {}),
        gameWith('off-chain-their-turn', {}),
      ),
    ).toBe(false);
    expect(
      gameModelNeedsGameTabAttention(
        gameWith('off-chain-their-turn', {}),
        gameWith('off-chain-their-turn', {}, 'settled_cleanly'),
      ),
    ).toBe(false);
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
