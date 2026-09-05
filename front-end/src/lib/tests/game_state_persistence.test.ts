import { calpokerStateCodec } from '@games/calpoker/ui/serialize';
import { initialKrunkGameState, krunkStateCodec } from '@games/krunk/ui/serialize';
import { SpHandler } from '@games/spacepoker/ui/useSpacepokerHand';
import { spacepokerStateCodec } from '@games/spacepoker/ui/serialize';
import { decodePersistedGameState } from '../gameRegistry';

describe('opaque persisted game state helpers', () => {
  it('round-trips Calpoker without validating game-owned state', () => {
    const state = {
      playerHand: [1n, 2n],
      opponentHand: [3n, 4n],
      moveNumber: 1n,
      isPlayerTurn: true,
      iStarted: true,
      cardSelections: [1n],
      error: null,
    };
    const encoded = calpokerStateCodec.encode(state);
    expect(calpokerStateCodec.decode(encoded)).toEqual(state);
    expect(calpokerStateCodec.decode({ ...encoded, state: { malformed: true } })).toEqual({
      malformed: true,
    });
  });

  it('round-trips Space Poker without validating game-owned state', () => {
    const state = {
      gameState: { handler: SpHandler.CommitA, myTurn: true, N: 4n },
      playerHoleCards: null,
      playerBoost: false,
      opponentHoleCards: null,
      opponentBoost: null,
      communityCards: [null, null, null, null, null],
      halfPot: 1n,
      lastRaise: 0n,
      iRaisedLast: false,
      handHistory: [],
      outcome: null,
      terminalState: 'none' as const,
      coinTossIOpen: null,
      unitSizeMojos: 10n,
      displayMode: 'mojos' as const,
      error: null,
    };
    const encoded = spacepokerStateCodec.encode(state);
    expect(spacepokerStateCodec.decode(encoded)).toEqual(state);
    expect(spacepokerStateCodec.decode({ ...encoded, state: ['opaque'] })).toEqual(['opaque']);
  });

  it('round-trips Krunk and exposes only generic envelope metadata', () => {
    const alice = initialKrunkGameState('alice');
    const bob = initialKrunkGameState('bob');
    const encoded = krunkStateCodec.encode({
      perPlayerStake: 100n,
      members: [alice, bob],
    });
    expect(decodePersistedGameState(encoded)).toEqual({
      persisted: encoded,
    });
  });
});
