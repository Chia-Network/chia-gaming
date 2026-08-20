import { calpokerStateCodec } from '@games/calpoker/ui/stateCodec';
import {
  initialKrunkGameState,
  krunkGameStateFromPersisted,
  krunkStateCodec,
  KrunkHandler,
  persistedKrunkGameState,
} from '@games/krunk/ui/stateCodec';
import { SpHandler } from '@games/spacepoker/ui/useSpacepokerHand';
import { spacepokerStateCodec } from '@games/spacepoker/ui/stateCodec';
import { canRemountFinishedGameState, decodePersistedGameState } from '../gameRegistry';

describe('game-owned state codecs', () => {
  it('round-trips Calpoker and rejects malformed cards', () => {
    const state = {
      playerHand: [1n, 2n],
      opponentHand: [3n, 4n],
      moveNumber: 1n,
      isPlayerTurn: true,
      cardSelections: [1n],
    };
    const encoded = calpokerStateCodec.encode(state);
    expect(calpokerStateCodec.decode(encoded)).toEqual(state);
    expect(
      calpokerStateCodec.decode({
        ...encoded,
        state: { ...state, playerHand: [1] },
      }),
    ).toBeNull();
    expect(
      calpokerStateCodec.decode({
        ...encoded,
        state: { ...state, moveNumber: 4n },
      }),
    ).toBeNull();
    expect(
      calpokerStateCodec.decode({
        ...encoded,
        state: { ...state, cardSelections: [51n] },
      }),
    ).toBeNull();
  });

  it('round-trips Space Poker and rejects malformed history', () => {
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
      terminalRecovery: null,
      pendingTerminalAction: null,
      coinTossIOpen: null,
      unitSizeMojos: 10n,
      displayMode: 'mojos' as const,
    };
    const encoded = spacepokerStateCodec.encode(state);
    expect(spacepokerStateCodec.decode(encoded)).toEqual(state);
    const pendingFold = {
      ...state,
      gameState: { handler: SpHandler.Folded, myTurn: false, N: 3n },
      handHistory: [{ player: 'you' as const, action: 'fold' as const }],
      terminalState: 'folded-by-you' as const,
      pendingTerminalAction: {
        action: 'fold' as const,
        submission: 'accept-settlement' as const,
        previousTerminalState: 'none' as const,
        previousGameState: { handler: SpHandler.MidRound, myTurn: true, N: 3n },
      },
    };
    expect(spacepokerStateCodec.decode(spacepokerStateCodec.encode(pendingFold))).toEqual(
      pendingFold,
    );
    expect(
      spacepokerStateCodec.decode({
        ...encoded,
        state: { ...state, handHistory: [{ player: 'you', action: 'invalid' }] },
      }),
    ).toBeNull();
    expect(
      spacepokerStateCodec.decode({
        ...encoded,
        state: { ...state, gameState: { handler: SpHandler.End, myTurn: true, N: 4n } },
      }),
    ).toBeNull();
    expect(
      spacepokerStateCodec.decode({
        ...encoded,
        state: { ...state, halfPot: -1n },
      }),
    ).toBeNull();
    expect(
      spacepokerStateCodec.decode({
        ...encoded,
        state: { ...state, terminalState: 'revealed' },
      }),
    ).toBeNull();
  });

  it('round-trips Krunk live initialization and remains non-remountable', () => {
    const alice = initialKrunkGameState('alice');
    const bob = initialKrunkGameState('bob');
    expect(alice.handler).toBe(KrunkHandler.WaitingCommit);
    const alicePersisted = persistedKrunkGameState(null, 'alice-game', alice);
    const encoded = persistedKrunkGameState(alicePersisted, 'bob-game', bob);
    expect(decodePersistedGameState(encoded)).toEqual({
      persisted: encoded,
      gameIds: ['alice-game', 'bob-game'],
      canRemountFinished: true,
    });
    expect(krunkGameStateFromPersisted(encoded, 'alice-game', 'alice')).toEqual(alice);
    expect(krunkGameStateFromPersisted(encoded, 'bob-game', 'bob')).toEqual(bob);
    expect(canRemountFinishedGameState(encoded)).toBe(true);
    expect(
      krunkStateCodec.decode({
        ...encoded,
        state: {
          games: {
            ...encoded.state.games,
            'alice-game': {
              ...alice,
              guesses: [{ word: 'TOO', clue: [0, 0, 0, 0, 0] }],
            },
          },
        },
      }),
    ).toBeNull();
    expect(
      krunkStateCodec.decode({
        ...encoded,
        state: {
          games: {
            'alice-game': { ...alice, handler: KrunkHandler.BobGuess },
          },
        },
      }),
    ).toBeNull();
    expect(
      krunkStateCodec.decode({
        ...encoded,
        state: {
          games: {
            'bob-game': {
              ...bob,
              guesses: [
                { word: 'CRANE', clue: [-1, -1, -1, -1, -1] },
                { word: 'SLATE', clue: [0, 0, 0, 0, 0] },
              ],
            },
          },
        },
      }),
    ).toBeNull();
  });
});
