import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Subject } from 'rxjs';
import { useGameSession } from '../../hooks/useGameSession';
import type { SessionController } from '../../hooks/SessionController';
import type { ReliableCommitCoordinator } from '../../services/PeerSession';
import type { GameSessionParams, WasmEvent } from '../../types/ChiaGaming';

describe('useGameSession runtime lease', () => {
  it('retires its runtime when the hook unmounts', () => {
    let coordinator: ReliableCommitCoordinator | undefined;
    const detachTransactionCoordinator = jest.fn();
    const events = new Subject<WasmEvent>();
    const controller = {
      cleanShutdownCalled: false,
      iStarted: false,
      wasmNotificationHistory: [],
      diagnosticLog: [],
      attachTransactionCoordinator: (next: ReliableCommitCoordinator) => {
        coordinator = next;
      },
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
    function Harness() {
      useGameSession(params, controller, () => {});
      return null;
    }

    let renderer: ReactTestRenderer | undefined;
    act(() => {
      renderer = create(createElement(Harness));
    });
    expect(coordinator).toBeDefined();

    act(() => renderer?.unmount());
    expect(detachTransactionCoordinator).toHaveBeenCalledWith(coordinator);
  });
});
