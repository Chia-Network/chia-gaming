import { createElement, StrictMode, useCallback, useState } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { expectConsoleError } from '../../../scripts/testSetup';
import { destroySessionController } from '../../hooks/blobSingleton';
import { useSessionControllerAfterCommit } from '../../hooks/useGameSession';
import type { SessionController } from '../../hooks/SessionController';
import type { PeerConnectionResult } from '../../types/ChiaGaming';
import { requireLiveGameHandSource, type LiveGamePort } from '@games/host';
import { createSessionModel, INITIAL_CHANNEL_STATUS_MODEL } from '../session/model';
import {
  projectTerminalSessionResult,
  useTerminalSessionPresentation,
  type UseGameSessionResult,
} from '../session/sessionResult';

const peerConnection: PeerConnectionResult = {
  sendMessage: () => true,
  sendAck: () => true,
  sendKeepalive: () => true,
  hostLog: () => {},
  close: () => {},
};

describe('GameSession render boundary', () => {
  let renderer: ReactTestRenderer | null = null;
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
    destroySessionController();
  });

  afterAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      originalActEnvironment;
  });

  it('does not publish buffered controller setup into Shell during render', () => {
    expectConsoleError('Cannot start a new session without a blockchain connection');
    const reactErrors: string[] = [];
    let registrations = 0;
    let observedController: SessionController | null = null;
    const originalError = console.error;
    const errorSpy = jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      reactErrors.push(args.map(String).join(' '));
      originalError(...args);
    });

    function GameSessionHarness({ publishToShell }: { publishToShell: () => void }) {
      const registerMessageHandler = useCallback(
        (handler: (msgno: number, msg: Uint8Array) => void) => {
          registrations += 1;
          handler(1, Uint8Array.from([1]));
          publishToShell();
        },
        [publishToShell],
      );
      observedController = useSessionControllerAfterCommit(
        {
          iStarted: true,
          myContribution: 1_000n,
          theirContribution: 1_000n,
          perGameAmount: 100n,
        },
        peerConnection,
        registerMessageHandler,
      );
      return null;
    }

    function ShellHarness() {
      const [, setPublished] = useState(0);
      const publishToShell = useCallback(() => setPublished((value) => value + 1), []);
      return createElement(GameSessionHarness, { publishToShell });
    }

    try {
      act(() => {
        renderer = create(createElement(StrictMode, null, createElement(ShellHarness)));
      });
    } finally {
      errorSpy.mockRestore();
    }

    expect(reactErrors.filter((message) => message.includes('Cannot update a component'))).toEqual(
      [],
    );
    expect(registrations).toBe(1);
    expect(observedController).not.toBeNull();
    expect(observedController!.storedMessages).toEqual([{ msgno: 1n, msg: Uint8Array.from([1]) }]);
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
        interactionMode: 'live',
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

    expect(() => requireLiveGameHandSource(observed!.handSource).nerf()).toThrow(
      'Protocol commands require a live game hand source',
    );
    expect(liveNerf).not.toHaveBeenCalled();
    expect(liveDismissGame).not.toHaveBeenCalled();
  });
});
