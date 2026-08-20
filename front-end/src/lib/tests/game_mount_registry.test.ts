import React from 'react';
import { EMPTY } from 'rxjs';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import type { SessionController } from '../../hooks/SessionController';
import type { UseGameSessionResult } from '../../hooks/useGameSession';
import { frozenGameViewFromModel, requireLiveGameHandSource } from '../gameMountRegistry';
import { isCatalogGameType, packageFor } from '../gameRegistry';
import { resetProtocolIds, setProtocolIds } from '../gameIdentities';
import { TEST_PROTOCOL_IDS } from './protocolIdentities';
import {
  gameHandState,
  liveGameHandOrigin,
  terminalGameHandSource,
  type GameHandSource,
} from '@games/host';
import { useInitialGameHandState } from '@games/host/ui';
import { createSessionModel, type SessionModel } from '../session/model';
import { projectTerminalSessionResult } from '../session/sessionResult';
import { createSessionMachineState } from '../session/sessionMachine';
import { SessionMachineRuntime } from '../session/sessionMachineRuntime';
import type { PersistedGameState } from '../session/gameStateCodec';

describe('game mount registry', () => {
  it('recognizes registered keys and rejects unknown mounts', () => {
    expect(isCatalogGameType('calpoker')).toBe(true);
    expect(isCatalogGameType('spacepoker')).toBe(true);
    expect(isCatalogGameType('krunk')).toBe(true);
    expect(isCatalogGameType('debug')).toBe(false);
    expect(isCatalogGameType('')).toBe(false);
  });

  it('renders Space Poker after protocol identities are ready without renaming terms', () => {
    setProtocolIds(TEST_PROTOCOL_IDS);
    try {
      expect(packageFor('spacepoker').gameType).toBe('spacepoker');
      expect(() =>
        packageFor('spacepoker').renderLive(
          {
            lastHandTerms: {
              gameType: 'spacepoker',
              myContribution: 100n,
              theirContribution: 100n,
              gameTimeout: 15n,
              unitSizeMojos: 10n,
            },
            handSource: { interactionMode: 'live', controller: {} },
            handKey: 1,
            activeGameId: '1',
            gameplayEvent$: EMPTY,
            iStarted: true,
            onTurnChanged: () => {},
            appendGameLog: () => {},
            gameSpecificView: { displayGameId: '1', terminal: { type: 'none' } },
          } as unknown as UseGameSessionResult,
          {},
        ),
      ).not.toThrow();
    } finally {
      resetProtocolIds();
    }
  });

  it('gives each Krunk hand a fresh React lifecycle', () => {
    const session = {
      handSource: { interactionMode: 'live', controller: {} },
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

    const first = packageFor('krunk').renderLive({ ...session, handKey: 1 }, {});
    const second = packageFor('krunk').renderLive({ ...session, handKey: 2 }, {});

    expect(first.key).toBe('1');
    expect(second.key).toBe('2');
  });

  it('scopes restored origin to the captured hand key', () => {
    expect(liveGameHandOrigin(null, 1)).toBe('fresh');
    expect(liveGameHandOrigin(4, 4)).toBe('restored');
    expect(liveGameHandOrigin(4, 5)).toBe('fresh');
  });

  it('captures controller hand state once for the lifetime of a mount', () => {
    const first = { gameType: 'calpoker', version: 1n, state: { moveNumber: 0n } } as const;
    const second = { gameType: 'calpoker', version: 1n, state: { moveNumber: 1n } } as const;
    let current: PersistedGameState = first;
    let reads = 0;
    const controller = {
      get handState() {
        reads += 1;
        return current;
      },
    } as unknown as SessionController;
    const source: GameHandSource = { interactionMode: 'live', controller };
    let observed: Readonly<PersistedGameState> | null = null;
    let renderer: ReactTestRenderer | null = null;
    function Harness({ tick }: { tick: number }) {
      void tick;
      observed = useInitialGameHandState(source);
      return null;
    }

    act(() => {
      renderer = create(React.createElement(Harness, { tick: 0 }));
    });
    current = second;
    act(() => {
      renderer!.update(React.createElement(Harness, { tick: 1 }));
    });

    expect(reads).toBe(1);
    expect(observed).toBe(first);
    act(() => renderer?.unmount());
  });

  it.each([
    [
      'calpoker',
      ['1'],
      { gameType: 'calpoker', myContribution: 10n, theirContribution: 10n, gameTimeout: 15n },
    ],
    [
      'spacepoker',
      ['1'],
      {
        gameType: 'spacepoker',
        myContribution: 100n,
        theirContribution: 100n,
        gameTimeout: 15n,
        unitSizeMojos: 10n,
      },
    ],
    [
      'krunk',
      ['1', '2'],
      { gameType: 'krunk', myContribution: 100n, theirContribution: 100n, gameTimeout: 15n },
    ],
  ] as const)(
    'projects machine-owned %s state into live mounts and reset',
    (gameType, ids, terms) => {
      const formerControllerState: PersistedGameState = {
        gameType: 'calpoker',
        version: 1n,
        state: { moveNumber: 99n },
      };
      let readHandState = () => formerControllerState;
      const controller = {
        get handState() {
          return readHandState();
        },
        projectHandState(read: () => PersistedGameState | null) {
          readHandState = read;
          return () => {};
        },
        clearDerivedGamePresentation: () => {},
      } as unknown as SessionController;
      const runtime = new SessionMachineRuntime(
        createSessionMachineState(
          createSessionModel({
            betweenHand: {
              proposalGroups: [
                {
                  primaryId: ids[0],
                  memberIds: [...ids],
                  terms,
                  origin: 'local',
                  disposition: 'outgoing',
                },
              ],
            },
          }),
        ),
        {
          controller,
          iStarted: true,
          restoring: false,
          getRestoreStatus: () => 'idle',
          getRestoreError: () => null,
          emitGameplay: () => {},
          onError: (error) => {
            throw error;
          },
          persist: async () => {},
        },
      );
      runtime.dispatch({
        type: 'notification-accepted-group',
        id: ids[0],
        amount: String(terms.myContribution),
        iStarted: true,
        isMyTurn: false,
      });
      const model = runtime.getState().model;
      const terminal = model.game.instances[ids[0]].terminal;
      const mount = packageFor(gameType).renderLive(
        {
          handSource: { interactionMode: 'live', controller },
          handKey: model.game.handKey,
          activeGameId: ids[0],
          currentHandGameIds: [...ids],
          activeGameIds: [...ids],
          iStarted: true,
          playerNumber: 1,
          iProposedHand: true,
          gameplayEvent$: EMPTY,
          currentHandAmount: terms.myContribution,
          onHandOutcome: () => {},
          onTurnChanged: () => {},
          appendGameLog: () => {},
          lastHandTerms: terms,
          gameSpecificView: {
            gameType,
            displayGameId: ids[0],
            handState: model.game.handState,
            terminal,
            terminalsById: Object.fromEntries(
              ids.map((id) => [id, model.game.instances[id].terminal]),
            ),
            amountsById: Object.fromEntries(ids.map((id) => [id, model.game.instances[id].amount])),
          },
        } as unknown as UseGameSessionResult,
        {},
      );

      expect(mount.props.handSource.controller.handState).toBe(model.game.handState);
      expect(mount.props.handSource.controller.handState).not.toBe(formerControllerState);

      runtime.dispatch({ type: 'notification-abandoned' });
      expect(controller.handState).toBeNull();
      runtime.dispose();
    },
  );

  it('exposes terminal hand state as a readonly source without a controller', () => {
    const initial = {
      gameType: 'calpoker',
      version: 1n,
      state: { playerHand: [1n] },
    } as const;
    const source: GameHandSource = terminalGameHandSource(initial);

    if (source.interactionMode !== 'terminal') throw new Error('expected terminal source');
    function assertReadonly(terminal: Extract<GameHandSource, { interactionMode: 'terminal' }>) {
      // @ts-expect-error terminal hand state is a readonly contract
      terminal.handState = null;
    }
    void assertReadonly;
    expect(source.handState).toBe(initial);
    expect(Object.keys(source)).not.toContain('handState');
    expect(Object.isFrozen(source)).toBe(true);
    expect(source).not.toHaveProperty('controller');
    expect(() => requireLiveGameHandSource(source)).toThrow(
      'Protocol commands require a live game hand source',
    );
  });

  it('mounts finished Krunk hands without interactive protocol effects', () => {
    const model = {
      game: {
        currentHandIds: ['1', '3'],
        currentHandOrigin: 'local',
        activeIds: ['3'],
        handState: { gameType: 'krunk', version: 2n, state: { games: {} } },
        instances: {},
      },
      betweenHand: { lastTerms: { myContribution: 100n } },
    } as unknown as SessionModel;

    const mount = packageFor('krunk').renderFrozen(frozenGameViewFromModel(model), {
      iStarted: true,
    });

    expect(mount.props).toMatchObject({
      currentHandGameIds: ['1', '3'],
      activeGameIds: ['3'],
      handSource: {
        interactionMode: 'terminal',
        handState: model.game.handState,
      },
    });
    expect(mount.props).not.toHaveProperty('gameObject');
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
          currentHandOrigin: 'local',
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
        handSource: { interactionMode: 'live', controller: realController },
        handKey: 7,
        handOrigin: 'restored',
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
        gameSpecificView: {
          gameType,
          displayGameId: '1',
          handState: model.game.handState,
          terminal: model.game.instances['1'].terminal,
          terminalsById: { '1': model.game.instances['1'].terminal },
          amountsById: { '1': '100' },
        },
      } as unknown as UseGameSessionResult;
      const terminal = projectTerminalSessionResult(live, { model, iStarted: true }, EMPTY);

      const liveMount = packageFor(gameType).renderLive(live, {});
      const terminalMount = packageFor(gameType).renderLive(terminal, {});

      expect(terminalMount.type).toBe(liveMount.type);
      expect(terminalMount.key).toBe(liveMount.key);
      expect(terminalMount.key).toBe('7');
      expect(terminalMount.props.handSource.interactionMode).toBe('terminal');
      expect(liveMount.props.initialPersistedState).toBeUndefined();
      expect(terminalMount.props.initialPersistedState).toBeUndefined();
      if (gameType === 'calpoker') {
        expect(liveMount.props.handOrigin).toBe('restored');
        expect(terminalMount.props.handOrigin).toBe('terminal');
      }
      expect(terminal.handSource.interactionMode).toBe('terminal');
      expect(gameHandState(terminal.handSource)).toBe(model.game.handState);
      expect(() => requireLiveGameHandSource(terminal.handSource).makeMove('1', null)).toThrow(
        'Protocol commands require a live game hand source',
      );
      expect(realMakeMove).not.toHaveBeenCalled();
    },
  );
});
