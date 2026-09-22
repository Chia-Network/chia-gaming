import { type DurableApplicationState } from '../session/saveEnvelope';
import {
  createSessionModel,
  decodeDurableApplicationState,
  INITIAL_GAME_TERMINAL_MODEL,
  snapshotFromSessionModel,
} from '../session/model';
import { liveSave } from './session_save_envelope.fixtures';

function liveEnvelope(fields: Partial<DurableApplicationState>): DurableApplicationState {
  return liveSave(fields as unknown as Record<string, unknown>);
}

const CAL_TERMS = {
  gameType: 'calpoker' as const,
  senderIsPlayerA: false,
  gameTimeout: 15n,
  parameters: 100n,
};
describe('session persistence boundaries', () => {
  it('rejects the removed aggregate version without migration', () => {
    expect(() =>
      decodeDurableApplicationState({
        ...liveSave(),
        version: 1n,
      } as unknown as DurableApplicationState),
    ).toThrow('Garbled application state: unsupported version 1');
  });

  it('does not serialize notification residue and restores runtime defaults', () => {
    const model = createSessionModel({
      channel: {
        dismissedChannelStatus: 'Active',
        queue: [
          {
            id: 1n,
            kind: 'durability-error',
            title: 'Session Storage Error',
            message: 'disk unavailable',
          },
          { id: 2n, kind: 'infra-error', title: 'Error', message: 'keep me' },
        ],
      },
      game: {
        queue: [{ id: 3n, kind: 'proposal-rejected', title: 'Game', message: 'dismiss me' }],
      },
    });

    const snapshot = snapshotFromSessionModel(model);
    expect(snapshot).not.toHaveProperty('channelNotifQueue');
    expect(snapshot).not.toHaveProperty('gameNotifQueue');
    expect(snapshot).not.toHaveProperty('dismissedChannelStatus');

    const restored = decodeDurableApplicationState(liveSave(snapshot)).model;
    expect(restored.channel.queue).toEqual([]);
    expect(restored.game.queue).toEqual([]);
    expect(restored.channel.dismissedChannelStatus).toBeNull();
  });

  it('rejects an invalid saved display id instead of selecting unrelated state', () => {
    const snapshot = snapshotFromSessionModel(
      createSessionModel({
        game: {
          activeIds: ['9', '7'],
          currentHandIds: ['9', '7'],
          currentHandOrigin: 'local',
          instances: {
            '9': {
              id: '9',
              amount: '20',
              coinHex: null,
              presentation: 'off-chain-their-turn',
              terminal: INITIAL_GAME_TERMINAL_MODEL,
            },
            '7': {
              id: '7',
              amount: '20',
              coinHex: null,
              presentation: 'off-chain-my-turn',
              terminal: INITIAL_GAME_TERMINAL_MODEL,
            },
          },
          lastDisplayedId: '7',
        },
        betweenHand: { lastHandProposal: CAL_TERMS },
      }),
    );
    expect(() =>
      decodeDurableApplicationState(
        liveEnvelope({
          activeGameIds: snapshot.activeGameIds,
          currentHandGameIds: snapshot.currentHandGameIds,
          currentHandOrigin: snapshot.currentHandOrigin,
          lastDisplayedGameId: 'missing',
          gameInstances: snapshot.gameInstances,
          activeGameType: snapshot.activeGameType,
        }),
      ),
    ).toThrow('game missing is missing its keyed instance');
  });
});
