import { createElement, StrictMode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Subject } from 'rxjs';
import { useGameSession } from '../../hooks/useGameSession';
import type { SessionController } from '../../hooks/SessionController';
import type { SessionRuntimeLease } from '../session/sessionRuntimeLease';
import type { GameSessionParams, WasmEvent } from '../../types/ChiaGaming';

describe('useGameSession runtime lease', () => {
  function setup() {
    let lease: SessionRuntimeLease | undefined;
    const attachTransactionCoordinator = jest.fn((next: SessionRuntimeLease) => {
      if (lease && lease !== next) lease.retire();
      lease = next;
    });
    const detachTransactionCoordinator = jest.fn();
    const events = new Subject<WasmEvent>();
    const controller = {
      cleanShutdownCalled: false,
      iStarted: false,
      wasmNotificationHistory: [],
      diagnosticLog: [],
      attachTransactionCoordinator,
      detachTransactionCoordinator,
      getRestoreStatus: () => 'idle',
      getRestoreError: () => null,
      reportRuntimeError: jest.fn(),
      clearDerivedGamePresentation: jest.fn(),
      flushDeferredWork: jest.fn(),
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
      getLease: () => lease,
      attachTransactionCoordinator,
      detachTransactionCoordinator,
    };
  }

  it('keeps the committed runtime active when the hook unmounts', () => {
    const { controller, params, getLease, detachTransactionCoordinator } = setup();
    function Harness() {
      useGameSession(params, controller, () => {});
      return null;
    }

    let renderer: ReactTestRenderer | undefined;
    act(() => {
      renderer = create(createElement(Harness));
    });
    expect(getLease()).toBeDefined();

    act(() => renderer?.unmount());
    expect(detachTransactionCoordinator).not.toHaveBeenCalled();
  });

  it('keeps the same lease through Strict Effects setup-cleanup-setup replay', () => {
    const { controller, params, getLease, attachTransactionCoordinator } = setup();
    function Harness() {
      useGameSession(params, controller, () => {});
      return null;
    }

    let renderer: ReactTestRenderer | undefined;
    act(() => {
      renderer = create(createElement(StrictMode, null, createElement(Harness)));
    });
    const lease = getLease();
    expect(lease).toBeDefined();
    expect(attachTransactionCoordinator).toHaveBeenCalledTimes(1);

    act(() => renderer?.unmount());
    expect(getLease()).toBe(lease);
  });
});
