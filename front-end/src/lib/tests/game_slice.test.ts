import {
  createSessionModel,
  sessionModelFromSave,
  snapshotFromSessionModel,
} from '../session/model';
import { initialKrunkGameState, krunkStateCodec } from '@games/krunk/ui/serialize';
import {
  gameInstanceModelFromSlice,
  gameSliceReducer,
  INITIAL_GAME_SLICE,
} from '../session/gameSlice';
import { liveSave } from './session_save_envelope.fixtures';

describe('game slice reducer', () => {
  it('atomically seeds every accepted group member and is immediately restorable', () => {
    const slice = gameSliceReducer(INITIAL_GAME_SLICE, {
      type: 'accepted-group',
      groupIds: ['11', '12'],
      members: [
        { amount: '200', startTurn: 'my-turn' },
        { amount: '200', startTurn: 'their-turn' },
      ],
      origin: 'local',
      gameType: 'krunk',
    });

    expect(slice.activeIds).toEqual(['11', '12']);
    expect(slice.currentHandOrigin).toBe('local');
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
          lastHandProposal: {
            gameType: 'krunk',
            playerAContribution: 100n,
            playerBContribution: 100n,
            senderIsPlayerA: true,
            gameTimeout: 15n,
            parameters: null,
          },
        },
      }),
    );
    const restored = sessionModelFromSave(
      liveSave({
        version: 20n,
        playerId: 'player',
        serializedGameSession: new Uint8Array([1]),
        gameSessionSchemaVersion: 3n,
        pairingToken: 'pair',
        messageNumber: 1n,
        remoteNumber: 0n,
        iStarted: true,
        myContribution: '100',
        theirContribution: '100',
        perGameAmount: '100',
        unackedMessages: [],
        ...snapshot,
        rewardPuzzleHash: '11'.repeat(32),
        handState: krunkStateCodec.encode({
          perPlayerStake: 100n,
          members: [initialKrunkGameState('alice'), initialKrunkGameState('bob')],
        }),
      }),
    );
    expect(restored.game.activeIds).toEqual(['11', '12']);
    expect(Object.keys(restored.game.instances)).toEqual(['11', '12']);
  });
});
