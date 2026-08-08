import {
  createSessionModel,
  sessionModelFromSave,
  snapshotFromSessionModel,
} from '../session/model';
import {
  gameInstanceModelFromSlice,
  gameSliceReducer,
  INITIAL_GAME_SLICE,
} from '../session/gameSlice';

describe('game slice reducer', () => {
  it('atomically seeds every accepted group member and is immediately restorable', () => {
    const slice = gameSliceReducer(INITIAL_GAME_SLICE, {
      type: 'accepted-group',
      groupIds: ['11', '12'],
      acceptedId: '11',
      amount: '200',
      startTurn: 'my-turn',
      gameType: 'krunk',
    });

    expect(slice.activeIds).toEqual(['11', '12']);
    expect(Object.keys(slice.instances)).toEqual(['11', '12']);
    expect(slice.instances['11'].presentation).toBe('off-chain-my-turn');

    const snapshot = snapshotFromSessionModel(
      createSessionModel({
        game: {
          ...slice,
          instances: Object.fromEntries(
            Object.entries(slice.instances).map(([id, instance]) => [
              id,
              gameInstanceModelFromSlice(instance),
            ]),
          ),
          handState: null,
          queue: [],
        },
        betweenHand: {
          lastTerms: {
            gameType: 'krunk',
            myContribution: 100n,
            theirContribution: 100n,
            gameTimeout: 15n,
          },
        },
      }),
    );
    const restored = sessionModelFromSave({
      version: 11n,
      playerId: 'player',
      ...snapshot,
      rewardPuzzleHash: null,
    });
    expect(restored.game.activeIds).toEqual(['11', '12']);
    expect(Object.keys(restored.game.instances)).toEqual(['11', '12']);
  });
});
