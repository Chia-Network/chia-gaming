import type { LiveGamePort } from '@games/host';
import { Program } from 'clvm-lib';
import { createElement, StrictMode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import {
  projectTerminalSessionResult,
  useTerminalSessionPresentation,
  type UseGameSessionResult,
} from '../../hooks/sessionView';
import { useGameSession } from '../../hooks/useGameSession';
import type { PeerConnectionResult } from '../../types/ChiaGaming';
import { createRegisteredGameHand } from '../gameRegistry';
import { createSessionModel, INITIAL_CHANNEL_STATUS_MODEL } from '../session/model';
import { createSessionController } from '../session/sessionHost';
import { useTestSessionPresentation } from './session_frontend.harness';

const peerConnection: PeerConnectionResult = {
  sendMessage: () => true,
  sendAck: () => true,
  sendKeepalive: () => true,
};

describe('GameSession render boundary', () => {
  let renderer: ReactTestRenderer | null = null;
  let controller: import('../session/SessionController').SessionController | undefined;
  const originalActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    if (renderer) {
      act(() => renderer?.unmount());
      renderer = null;
    }
    controller?.cleanup();
    controller = undefined;
  });

  afterAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      originalActEnvironment;
  });

  it('keeps session construction outside StrictMode view attachment', () => {
    const params = {
      iStarted: true,
      myContribution: 1000n,
      theirContribution: 1000n,
      perGameAmount: 100n,
    };
    controller = createSessionController(null, peerConnection, 'test', 1000n, 1000n, true);
    const frontend = controller.frontend;
    function View() {
      useGameSession(params, frontend, () => {}, undefined, useTestSessionPresentation(frontend));
      return null;
    }
    act(() => {
      renderer = create(createElement(StrictMode, null, createElement(View)));
    });
    expect(controller!.initializeExecution(false)).toBe(frontend);
    expect(controller!.getPeerProtocol().snapshot().remoteNumber).toBe(0n);
  });

  it('dismisses terminal errors locally while protocol controls stay frozen', () => {
    const model = createSessionModel({
      channel: {
        status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'ResolvedUnrolled' },
      },
      game: {
        queue: [
          {
            id: 1n,
            kind: 'durability-error',
            title: 'Session storage failed',
            message: 'Garbled save: invalid handState.',
          },
        ],
      },
    });
    const source = { model, iStarted: true };
    const liveNerf = jest.fn();
    const liveDismissGame = jest.fn();
    const live = {
      handSource: {
        frozen: false,
        handState: model.game.handState,
        port: { nerf: liveNerf } as unknown as LiveGamePort,
      },
      dismissGame: liveDismissGame,
    } as unknown as UseGameSessionResult;
    let observed: UseGameSessionResult | null = null;

    function TerminalHarness() {
      const terminal = useTerminalSessionPresentation(source);
      const projected = projectTerminalSessionResult(live, terminal.presentation!, terminal);
      observed = projected;
      return createElement(
        'button',
        { onClick: projected.dismissGame },
        String(projected.gameQueue.length),
      );
    }

    act(() => {
      renderer = create(createElement(TerminalHarness));
    });
    expect(observed!.gameQueue).toHaveLength(1);
    act(() => renderer!.root.findByType('button').props.onClick());
    expect(observed!.gameQueue).toHaveLength(0);

    expect(observed!.handSource.frozen).toBe(true);
    expect(observed!.handSource).not.toHaveProperty('port');
    expect(liveNerf).not.toHaveBeenCalled();
    expect(liveDismissGame).not.toHaveBeenCalled();
  });

  it('projects the finalized model hand instead of a surviving live hand', () => {
    const finalizedHand = createRegisteredGameHand('calpoker', {
      members: [
        {
          playerAContribution: 100n,
          playerBContribution: 100n,
          ourTurn: false,
          readableParameters: Program.fromBigInt(100n),
        },
      ],
    });
    const survivingLiveHand = createRegisteredGameHand('calpoker', {
      members: [
        {
          playerAContribution: 100n,
          playerBContribution: 100n,
          ourTurn: true,
          readableParameters: Program.fromBigInt(100n),
        },
      ],
    });
    const model = createSessionModel({
      channel: {
        status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'ResolvedUnrolled' },
      },
      game: {
        activeGameType: 'calpoker',
        currentHandIds: ['7'],
        currentHandOrigin: 'local',
        handState: { gameType: 'calpoker', state: finalizedHand.getState() },
      },
    });
    const live = {
      handSource: {
        frozen: false,
        hand: survivingLiveHand,
        port: {} as LiveGamePort,
      },
    } as unknown as UseGameSessionResult;

    expect(survivingLiveHand.getState()).not.toEqual(finalizedHand.getState());

    const projected = projectTerminalSessionResult(live, { model, iStarted: true });

    expect(projected.handSource.frozen).toBe(true);
    expect(projected.handSource).not.toHaveProperty('port');
    expect(projected.handSource.hand).not.toBe(survivingLiveHand);
    expect(projected.handSource.hand?.getState()).toEqual(model.game.handState?.state);
  });
});
