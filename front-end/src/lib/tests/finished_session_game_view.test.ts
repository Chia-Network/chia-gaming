import { createSessionModel } from '../session/model';
import {
  selectFinishedSessionDisplay,
  sessionModelForReactProps,
} from '../session/finishedSessionDisplay';

describe('finished session shell display', () => {
  it('falls back when a Calpoker hand lacks a validated display snapshot', () => {
    const model = createSessionModel({
      game: {
        activeGameType: 'calpoker',
        currentHandIds: ['finished'],
        lastDisplayedId: 'finished',
        instances: {
          finished: {
            id: 'finished',
            amount: '200',
            coin: { coinHex: null, turnState: 'ended' },
            handStatus: 'ended',
            terminal: {
              type: 'settled',
              outcome: 'opponent_timed_out',
              label: 'Opponent timed out',
              myReward: '200',
              rewardCoinHex: null,
            },
          },
        },
        handState: {
          gameType: 'calpoker',
          version: 1n,
          state: { cards: [1n, 2n] },
        },
      },
    });

    expect(selectFinishedSessionDisplay(model)).toEqual({
      canRemountHand: false,
      terminalLabel: 'Opponent timed out',
    });
  });

  it('keeps Krunk finished-hand remounts unsupported', () => {
    const model = createSessionModel({
      game: {
        activeGameType: 'krunk',
        handState: {
          gameType: 'krunk',
          version: 1n,
          state: { guesses: [] },
        },
      },
    });

    expect(selectFinishedSessionDisplay(model).canRemountHand).toBe(false);
  });

  it('does not expose bigint hand payloads to React prop enumeration', () => {
    const model = createSessionModel({
      game: {
        handState: { gameType: 'krunk', version: 1n, state: { clues: [2n] } },
      },
    });

    const propSafe = sessionModelForReactProps(model);
    expect(Object.keys(propSafe.game)).not.toContain('handState');
    expect(propSafe.game.handState).toBe(model.game.handState);
  });
});
