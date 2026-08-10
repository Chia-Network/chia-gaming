import { EMPTY } from 'rxjs';

import type { SessionController } from '../../hooks/SessionController';
import { createFrozenHandBridge } from '../../hooks/frozenHandBridge';
import type { UseGameSessionResult } from '../../hooks/useGameSession';
import { GAME_MOUNTS, hasGameMount } from '../gameMountRegistry';
import { createSessionModel, type SessionModel } from '../session/model';
import { projectTerminalSessionResult } from '../session/sessionResult';

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

  it('mounts finished Krunk hands without interactive protocol effects', () => {
    const model = {
      game: {
        currentHandIds: ['1', '3'],
        activeIds: ['3'],
        handState: { gameType: 'krunk', version: 2n, state: { games: {} } },
        instances: {},
      },
      betweenHand: { lastTerms: { myContribution: 100n } },
    } as unknown as SessionModel;

    const mount = GAME_MOUNTS.krunk.renderFrozen(model, {} as SessionController, {
      iStarted: true,
      iProposedHand: true,
    });

    expect(mount.props).toMatchObject({
      currentHandGameIds: ['1', '3'],
      activeGameIds: ['3'],
      interactionMode: 'terminal',
    });
  });

  it.each([
    ['calpoker', { gameType: 'calpoker' }],
    ['spacepoker', { gameType: 'spacepoker', unitSizeMojos: 10n }],
    ['krunk', { gameType: 'krunk' }],
  ] as const)(
    'keeps the %s component type and hand key while becoming terminal',
    (gameType, extra) => {
      const terms = {
        ...extra,
        myContribution: 100n,
        theirContribution: 100n,
        gameTimeout: 15n,
      };
      const model = createSessionModel({
        channel: { status: { state: 'ResolvedClean' } },
        game: {
          handKey: 7,
          currentHandIds: gameType === 'krunk' ? ['1', '2'] : ['1'],
          activeIds: [],
          lastDisplayedId: '1',
          activeGameType: gameType,
          handState: { gameType, version: 1n, state: {} },
          instances: {
            '1': {
              id: '1',
              amount: '100',
              coinHex: null,
              presentation: 'ended',
              terminal: {
                type: 'settled',
                outcome: 'opponent_timed_out',
                label: 'Opponent timed out',
                myReward: '100',
                rewardCoinHex: null,
              },
            },
          },
        },
        betweenHand: { lastTerms: terms },
      });
      const realMakeMove = jest.fn();
      const realController = { makeMove: realMakeMove } as unknown as SessionController;
      const live = {
        sessionController: realController,
        handKey: 7,
        currentHandGameIds: model.game.currentHandIds,
        activeGameIds: ['1'],
        activeGameId: '1',
        iStarted: true,
        playerNumber: 1,
        iProposedHand: true,
        gameplayEvent$: EMPTY,
        currentHandAmount: 100n,
        onHandOutcome: () => {},
        onTurnChanged: () => {},
        appendGameLog: () => {},
        lastHandTerms: terms,
        interactionMode: 'live',
        gameSpecificView: {
          gameType,
          displayGameId: '1',
          handState: model.game.handState,
          terminal: model.game.instances['1'].terminal,
          terminalsById: { '1': model.game.instances['1'].terminal },
          amountsById: { '1': '100' },
        },
      } as unknown as UseGameSessionResult;
      const bridge = createFrozenHandBridge(model.game.handState);
      const terminal = projectTerminalSessionResult(
        live,
        { model, iStarted: true, iProposedHand: true },
        bridge,
        EMPTY,
      );

      const liveMount = GAME_MOUNTS[gameType].renderLive(live, {});
      const terminalMount = GAME_MOUNTS[gameType].renderLive(terminal, {});

      expect(terminalMount.type).toBe(liveMount.type);
      expect(terminalMount.key).toBe(liveMount.key);
      expect(terminalMount.key).toBe('7');
      expect(terminalMount.props.interactionMode).toBe('terminal');
      expect(terminal.sessionController).toBe(bridge);
      terminal.sessionController.makeMove('1', null);
      expect(realMakeMove).not.toHaveBeenCalled();
    },
  );
});
