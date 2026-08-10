import { EMPTY } from 'rxjs';

import type { UseGameSessionResult } from '../../hooks/useGameSession';
import { GAME_MOUNTS, hasGameMount } from '../gameMountRegistry';

describe('game mount registry', () => {
  it('recognizes registered keys and rejects unknown mounts', () => {
    expect(hasGameMount('calpoker')).toBe(true);
    expect(hasGameMount('spacepoker')).toBe(true);
    expect(hasGameMount('krunk')).toBe(true);
    expect(hasGameMount('debug')).toBe(false);
    expect(hasGameMount('')).toBe(false);
  });

  it('gives each Krunk hand a fresh React lifecycle', () => {
    const session = {
      sessionController: {},
      currentHandGameIds: ['1', '3'],
      activeGameIds: ['1', '3'],
      iProposedHand: true,
      gameplayEvent$: EMPTY,
      currentHandAmount: 100n,
      onTurnChanged: () => {},
      appendGameLog: () => {},
      gameSpecificView: {
        handState: null,
        terminalsById: {},
        amountsById: { '1': '100', '3': '100' },
      },
    } as unknown as UseGameSessionResult;

    const first = GAME_MOUNTS.krunk.renderLive({ ...session, handKey: 1 }, {});
    const second = GAME_MOUNTS.krunk.renderLive({ ...session, handKey: 2 }, {});

    expect(first.key).toBe('1');
    expect(second.key).toBe('2');
  });
});
