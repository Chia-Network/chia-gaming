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
        handState: {
          gameType: 'calpoker',
          version: 1n,
          state: { cards: [1n, 2n] },
        },
        terminal: {
          type: 'settled',
          outcome: 'opponent_timed_out',
          label: 'Opponent timed out',
          myReward: '200',
          rewardCoinHex: null,
        },
      },
    });

    expect(selectFinishedSessionDisplay(model)).toEqual({
      canRemountHand: false,
      terminalLabel: 'Opponent timed out',
    });
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
