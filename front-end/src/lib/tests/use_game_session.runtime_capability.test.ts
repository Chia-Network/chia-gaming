import { Component, createElement, StrictMode, type ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Subject } from 'rxjs';
import { expectConsoleError } from '../../../scripts/testSetup';
import { useGameSession } from '../../hooks/useGameSession';
import type { SessionController } from '../../hooks/SessionController';
import type { SessionMachineRuntime } from '../session/sessionMachineRuntime';
import type { GameSessionParams, WasmEvent } from '../../types/ChiaGaming';

class TestErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {}

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

describe('useGameSession committed runtime', () => {
  function setup() {
    let runtime: SessionMachineRuntime | null = null;
    const commitSessionRuntime = jest.fn((nextRuntime: SessionMachineRuntime) => {
      if (runtime && runtime !== nextRuntime) runtime.retire();
      runtime = nextRuntime;
    });
    const events = new Subject<WasmEvent>();
    const controller = {
      cleanShutdownCalled: false,
      iStarted: false,
      wasmNotificationHistory: [],
      diagnosticLog: [],
      getCommittedSessionRuntime: () => runtime,
      commitSessionRuntime,
      getRestoreStatus: () => 'idle',
      getRestoreError: () => null,
      reportRuntimeError: jest.fn(),
      clearDerivedGamePresentation: jest.fn(),
      flushDeferredWork: jest.fn(),
      getWasmFields: () => null,
      prepareReliableCommit: jest.fn(() => ({
        generation: 0,
        outboundCount: 0,
        ackCount: 0,
        remoteNumber: 0n,
      })),
      completeReliableCommit: jest.fn(),
      getObservable: () => events,
      onRestoreStatusChange: () => () => {},
      isChannelReady: () => false,
    } as unknown as SessionController;
    const params = {
      iStarted: false,
      myContribution: 100n,
      theirContribution: 100n,
      perGameAmount: 10n,
      pairingToken: 'pairing',
    } as GameSessionParams;
    return {
      controller,
      params,
      getRuntime: () => runtime,
      events,
      commitSessionRuntime,
    };
  }

  it('keeps the committed runtime active when the hook unmounts', () => {
    const { controller, params, getRuntime } = setup();
    function Harness() {
      useGameSession(params, controller, () => {});
      return null;
    }

    let renderer: ReactTestRenderer | undefined;
    act(() => {
      renderer = create(createElement(Harness));
    });
    const runtime = getRuntime();
    expect(runtime).not.toBeNull();

    act(() => renderer?.unmount());
    act(() => {
      renderer = create(createElement(Harness));
    });
    expect(getRuntime()).toBe(runtime);
    act(() => renderer?.unmount());
  });

  it('keeps the same runtime through Strict Effects setup-cleanup-setup replay', () => {
    const { controller, params, getRuntime, commitSessionRuntime } = setup();
    function Harness() {
      useGameSession(params, controller, () => {});
      return null;
    }

    let renderer: ReactTestRenderer | undefined;
    act(() => {
      renderer = create(createElement(StrictMode, null, createElement(Harness)));
    });
    const runtime = getRuntime();
    expect(runtime).not.toBeNull();
    expect(commitSessionRuntime).toHaveBeenCalledTimes(1);

    act(() => renderer?.unmount());
    expect(getRuntime()).toBe(runtime);
  });

  it('keeps reducing controller events while unmounted and projects them on remount', () => {
    const { controller, params, events, getRuntime } = setup();
    let latestQueue: readonly unknown[] = [];
    function Harness() {
      const session = useGameSession(params, controller, () => {});
      latestQueue = session.channelQueue;
      return null;
    }

    let renderer: ReactTestRenderer | undefined;
    act(() => {
      renderer = create(createElement(Harness));
    });
    const runtime = getRuntime();
    act(() => renderer?.unmount());

    act(() => {
      events.next({ type: 'error', error: 'while absent' });
    });
    expect(runtime?.getState().model.channel.queue).toContainEqual(
      expect.objectContaining({ message: 'while absent' }),
    );

    act(() => {
      renderer = create(createElement(Harness));
    });
    expect(getRuntime()).toBe(runtime);
    expect(latestQueue).toContainEqual(expect.objectContaining({ message: 'while absent' }));
    act(() => renderer?.unmount());
  });

  it('reattaches the committed runtime after a renderer crash and remount', () => {
    expectConsoleError('renderer crashed');
    const { controller, params, getRuntime } = setup();
    function Harness() {
      useGameSession(params, controller, () => {});
      return null;
    }
    function CrashingHarness() {
      useGameSession(params, controller, () => {});
      throw new Error('renderer crashed');
    }

    let renderer: ReactTestRenderer | undefined;
    act(() => {
      renderer = create(
        createElement(TestErrorBoundary, { key: 'before' }, createElement(Harness)),
      );
    });
    const runtime = getRuntime();

    act(() => {
      renderer?.update(
        createElement(TestErrorBoundary, { key: 'before' }, createElement(CrashingHarness)),
      );
    });
    expect(getRuntime()).toBe(runtime);

    act(() => {
      renderer?.update(createElement(TestErrorBoundary, { key: 'after' }, createElement(Harness)));
    });
    expect(getRuntime()).toBe(runtime);
    act(() => renderer?.unmount());
  });
});
