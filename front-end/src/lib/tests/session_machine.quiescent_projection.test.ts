import { Program } from 'clvm-lib';
import type { SessionController } from '../../hooks/SessionController';
import { createSessionModel, INITIAL_CHANNEL_STATUS_MODEL } from '../session/model';
import { createSessionMachineState } from '../session/sessionMachine';
import { SessionMachineRuntime } from '../session/sessionMachineRuntime';
import { storageRepository } from '../session/storageRepository';
import { baseSave } from './session_save_envelope.fixtures';

const proposal = {
  id: '7',
  handProposal: {
    gameType: 'calpoker' as const,
    senderIsPlayerA: false,
    gameTimeout: 15n,
    parameters: 10n,
  },
  lifecycle: 'peer-review' as const,
};

function controller(acceptProposal: (id: string) => void): SessionController {
  return {
    acceptProposal,
    commitSessionRuntime: jest.fn(),
    flushDeferredWork: jest.fn(),
    prepareReliableCommit: jest.fn(() => ({
      generation: 0,
      outboundCount: 0,
      ackCount: 0,
      remoteNumber: 0n,
    })),
    completeReliableCommit: jest.fn(),
  } as unknown as SessionController;
}

function initialState() {
  return createSessionMachineState(
    createSessionModel({
      channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'Active' } },
      betweenHand: {
        mode: 'review-incoming-proposal',
        pendingProposals: [proposal],
      },
    }),
  );
}

describe('SessionMachineRuntime quiescent projection', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('coalesces reentrant local-potato acceptance into one accepted render', async () => {
    const persist = jest.fn(async () => {});
    let notificationPending = false;
    const mockController = controller(() => {
      notificationPending = true;
    });
    const runtime = new SessionMachineRuntime(initialState(), {
      controller: mockController,
      iStarted: false,
      restoring: false,
      getRestoreStatus: () => 'idle',
      getRestoreError: () => null,
      onError: (error) => {
        throw error;
      },
      persist,
    });
    (mockController.flushDeferredWork as jest.Mock).mockImplementation(() => {
      if (notificationPending) {
        notificationPending = false;
        runtime.dispatch({
          type: 'wasm-notification',
          iStarted: false,
          notification: {
            ProposalAcceptedGroup: {
              id: 7n,
              members: [
                {
                  id: 101n,
                  player_a_contribution: '10',
                  player_b_contribution: '10',
                  our_turn: true,
                  readable_parameters: Program.fromBigInt(10n).serialize(),
                },
              ],
            },
          },
        });
      }
    });
    const rendered: ReturnType<typeof initialState>[] = [];
    runtime.setRender((state) => rendered.push(state));

    runtime.dispatch({ type: 'accept-review', id: '7' });
    expect(rendered).toEqual([]);
    await runtime.persist();

    expect(rendered).toHaveLength(1);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(rendered[0].model.betweenHand.pendingProposals).toEqual([]);
    expect(rendered[0].model.game.activeIds).toEqual(['101']);
  });

  it('renders accepting when acceptance remains genuinely queued', async () => {
    const runtime = new SessionMachineRuntime(initialState(), {
      controller: controller(jest.fn()),
      iStarted: false,
      restoring: false,
      getRestoreStatus: () => 'idle',
      getRestoreError: () => null,
      onError: (error) => {
        throw error;
      },
      persist: async () => {},
    });
    const rendered: ReturnType<typeof initialState>[] = [];
    runtime.setRender((state) => rendered.push(state));

    runtime.dispatch({ type: 'accept-review', id: '7' });
    await runtime.persist();

    expect(rendered).toHaveLength(1);
    expect(rendered[0].model.betweenHand.pendingProposals[0]?.lifecycle).toBe('peer-accept-queued');
    expect(rendered[0].model.game.activeIds).toEqual([]);
  });

  it('cancels a scheduled projection during teardown', () => {
    const runtime = new SessionMachineRuntime(initialState(), {
      controller: controller(jest.fn()),
      iStarted: false,
      restoring: false,
      getRestoreStatus: () => 'idle',
      getRestoreError: () => null,
      onError: (error) => {
        throw error;
      },
      persist: async () => {},
    });
    const render = jest.fn();
    runtime.setRender(render);
    runtime.dispatch({ type: 'accept-review', id: '7' });
    runtime.clearRender();
    jest.runOnlyPendingTimers();
    expect(render).not.toHaveBeenCalled();
  });

  it('orders persistence before projection and staged peer release', async () => {
    const order: string[] = [];
    const mockController = controller(jest.fn());
    (mockController.completeReliableCommit as jest.Mock).mockImplementation(() =>
      order.push('peer-send'),
    );
    const runtime = new SessionMachineRuntime(initialState(), {
      controller: mockController,
      iStarted: false,
      restoring: false,
      getRestoreStatus: () => 'idle',
      getRestoreError: () => null,
      onError: jest.fn(),
      persist: async () => {
        order.push('persist');
      },
    });
    runtime.setRender(() => order.push('render'));

    runtime.dispatch({ type: 'set-compose-timeout', timeout: 20n });
    await runtime.persist();

    expect(order).toEqual(['persist', 'render', 'peer-send']);
  });

  it('projects and releases once on failure, then retries durability without replay', async () => {
    const mockController = controller(jest.fn());
    const render = jest.fn();
    let attempt = 0;
    const persistedTimeouts: bigint[] = [];
    const runtime = new SessionMachineRuntime(initialState(), {
      controller: mockController,
      iStarted: false,
      restoring: false,
      getRestoreStatus: () => 'idle',
      getRestoreError: () => null,
      onError: jest.fn(),
      persist: async () => {
        persistedTimeouts.push(runtime.getState().model.betweenHand.compose.gameTimeout);
        if (attempt++ === 0) throw new Error('disk full');
      },
    });
    runtime.setRender(render);

    runtime.dispatch({ type: 'set-compose-timeout', timeout: 20n });
    await expect(runtime.persist()).rejects.toThrow('disk full');
    expect(render).toHaveBeenCalledTimes(1);
    expect(mockController.completeReliableCommit).toHaveBeenNthCalledWith(
      1,
      expect.any(Object),
      false,
    );

    await runtime.persist();
    expect(persistedTimeouts).toEqual([20n, 20n]);
    expect(render).toHaveBeenCalledTimes(1);
    expect(mockController.completeReliableCommit).toHaveBeenCalledTimes(2);
    expect(mockController.completeReliableCommit).toHaveBeenNthCalledWith(
      2,
      expect.any(Object),
      true,
    );
  });

  it('places work arriving during persistence in the next transaction', async () => {
    let resolveFirst!: () => void;
    const firstWrite = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const writes: bigint[] = [];
    const renders: bigint[] = [];
    const runtime = new SessionMachineRuntime(initialState(), {
      controller: controller(jest.fn()),
      iStarted: false,
      restoring: false,
      getRestoreStatus: () => 'idle',
      getRestoreError: () => null,
      onError: jest.fn(),
      persist: async (state) => {
        writes.push(state.model.betweenHand.compose.gameTimeout);
        if (writes.length === 1) await firstWrite;
      },
    });
    runtime.setRender((state) => renders.push(state.model.betweenHand.compose.gameTimeout));

    runtime.dispatch({ type: 'set-compose-timeout', timeout: 20n });
    jest.runOnlyPendingTimers();
    await Promise.resolve();
    runtime.dispatch({ type: 'set-compose-timeout', timeout: 30n });
    expect(runtime.getState().model.betweenHand.compose.gameTimeout).toBe(20n);

    resolveFirst();
    await Promise.resolve();
    await Promise.resolve();
    await runtime.persist();

    expect(writes).toEqual([20n, 30n]);
    expect(renders).toEqual([20n, 30n]);
  });

  it('keeps captured WASM and model fields exact while the next action arrives', async () => {
    let releaseFirst!: () => void;
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let wasmBytes = new Uint8Array([1, 1, 1]);
    const captured: Array<{
      bytes: Uint8Array;
      timeout: string;
    }> = [];
    const mockController = controller(jest.fn());
    (mockController as SessionController).getWalletProviderScope = jest.fn(() => ({
      provider: 'simulator',
      identity: 'projection-test',
    }));
    (mockController as SessionController).getWasmFields = jest.fn(() => ({
      serializedGameSession: wasmBytes,
      gameSessionSchemaVersion: 4n,
      pairingToken: 'pairing',
      gameSessionId: '00'.repeat(16),
      messageNumber: 1n,
      remoteNumber: 0n,
      iStarted: false,
      myContribution: '100',
      theirContribution: '100',
      perGameAmount: '10',
      rewardPuzzleHash: '11'.repeat(32),
      unackedMessages: [],
      wasmNotificationHistory: [],
      diagnosticLog: [],
      transportDisposition: 'active',
      activeGameIds: [],
      channelStatus: null,
      myAlias: undefined,
      opponentAlias: undefined,
    }));
    jest.spyOn(storageRepository, 'patchApplicationState').mockImplementation((transform) => {
      const update = transform(baseSave());
      if (update.session?.phase !== 'live') throw new Error('expected live aggregate capture');
      captured.push({
        bytes: update.session.live.serializedGameSession,
        timeout: update.session.presentation.betweenHandCompose.gameTimeout,
      });
      return update;
    });
    jest.spyOn(storageRepository, 'write').mockImplementation(async () => {
      if (captured.length === 1) await firstWrite;
    });
    const runtime = new SessionMachineRuntime(initialState(), {
      controller: mockController,
      iStarted: false,
      restoring: false,
      getRestoreStatus: () => 'idle',
      getRestoreError: () => null,
      onError: jest.fn(),
    });

    runtime.dispatch({ type: 'set-compose-timeout', timeout: 20n });
    jest.runOnlyPendingTimers();
    await Promise.resolve();
    expect(captured).toEqual([{ bytes: new Uint8Array([1, 1, 1]), timeout: 20n }]);

    wasmBytes = new Uint8Array([2, 2, 2]);
    runtime.dispatch({ type: 'set-compose-timeout', timeout: 30n });
    releaseFirst();
    await runtime.persist();

    expect(captured).toEqual([
      { bytes: new Uint8Array([1, 1, 1]), timeout: 20n },
      { bytes: new Uint8Array([2, 2, 2]), timeout: 30n },
    ]);
  });

  it('does not retry a permanent write failure without later activity or flush', async () => {
    const persist = jest.fn(async () => {
      throw new Error('disk remains unavailable');
    });
    const reportDurabilityError = jest.fn();
    const mockController = controller(jest.fn());
    reportDurabilityError.mockImplementation(() => {
      runtime.dispatch({
        type: 'enqueue-error',
        kind: 'durability-error',
        message: 'Session storage failed',
      });
    });
    (mockController as SessionController).reportDurabilityError = reportDurabilityError;
    const runtime = new SessionMachineRuntime(initialState(), {
      controller: mockController,
      iStarted: false,
      restoring: false,
      getRestoreStatus: () => 'idle',
      getRestoreError: () => null,
      onError: jest.fn(),
      persist,
    });
    const rendered: ReturnType<typeof initialState>[] = [];
    runtime.setRender((state) => rendered.push(state));

    runtime.dispatch({ type: 'set-compose-timeout', timeout: 20n });
    jest.runOnlyPendingTimers();
    await Promise.resolve();
    await Promise.resolve();
    expect(persist).toHaveBeenCalledTimes(1);
    expect(reportDurabilityError).toHaveBeenCalledTimes(1);
    expect(rendered).toHaveLength(2);
    expect(rendered[0].model.channel.queue).toEqual([]);
    expect(rendered[1].model.channel.queue).toContainEqual(
      expect.objectContaining({
        kind: 'durability-error',
        message: 'Session storage failed',
      }),
    );

    await jest.advanceTimersByTimeAsync(60_000);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(reportDurabilityError).toHaveBeenCalledTimes(1);
  });

  it('advances genuine work to a distinct failed boundary while suppressing warning-only retry', async () => {
    let rejectFirst!: (error: Error) => void;
    const firstWrite = new Promise<void>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const writes: bigint[] = [];
    const mockController = controller(jest.fn());
    const firstReliableCommit = {
      generation: 1,
      outboundCount: 0,
      ackCount: 0,
      remoteNumber: 0n,
    };
    const nextReliableCommit = {
      generation: 2,
      outboundCount: 1,
      ackCount: 1,
      remoteNumber: 1n,
    };
    (mockController.prepareReliableCommit as jest.Mock)
      .mockReturnValueOnce(firstReliableCommit)
      .mockReturnValueOnce(nextReliableCommit);
    const reportDurabilityError = jest.fn(() => {
      if (reportDurabilityError.mock.calls.length !== 1) return;
      runtime.dispatch({
        type: 'enqueue-error',
        kind: 'durability-error',
        message: 'Session storage failed',
      });
    });
    (mockController as SessionController).reportDurabilityError = reportDurabilityError;
    const runtime = new SessionMachineRuntime(initialState(), {
      controller: mockController,
      iStarted: false,
      restoring: false,
      getRestoreStatus: () => 'idle',
      getRestoreError: () => null,
      onError: jest.fn(),
      persist: async (state) => {
        writes.push(state.model.betweenHand.compose.gameTimeout);
        if (writes.length === 1) return firstWrite;
        throw new Error('disk remains unavailable');
      },
    });
    const rendered: Array<{ timeout: bigint; warningVisible: boolean }> = [];
    runtime.setRender((state) =>
      rendered.push({
        timeout: state.model.betweenHand.compose.gameTimeout,
        warningVisible: state.model.channel.queue.some(
          (notification) => notification.kind === 'durability-error',
        ),
      }),
    );

    runtime.dispatch({ type: 'set-compose-timeout', timeout: 20n });
    jest.runOnlyPendingTimers();
    await Promise.resolve();
    runtime.dispatch({ type: 'set-compose-timeout', timeout: 30n });

    rejectFirst(new Error('disk unavailable'));
    await jest.advanceTimersByTimeAsync(0);

    expect(writes).toEqual([20n, 30n]);
    expect(rendered).toEqual([
      { timeout: 20n, warningVisible: false },
      { timeout: 30n, warningVisible: true },
    ]);
    expect(mockController.completeReliableCommit).toHaveBeenCalledTimes(2);
    expect(mockController.completeReliableCommit).toHaveBeenNthCalledWith(
      1,
      firstReliableCommit,
      false,
    );
    expect(mockController.completeReliableCommit).toHaveBeenNthCalledWith(
      2,
      nextReliableCommit,
      false,
    );

    await jest.advanceTimersByTimeAsync(60_000);
    expect(writes).toEqual([20n, 30n]);
  });

  it('finishes a reentrant terminal drain before preparing persistence', async () => {
    const order: string[] = [];
    let drainPass = 0;
    const mockController = controller(jest.fn());
    (mockController.flushDeferredWork as jest.Mock).mockImplementation(() => {
      drainPass += 1;
      order.push(`drain-${drainPass}`);
      if (drainPass === 1) {
        runtime.dispatch({ type: 'set-compose-timeout', timeout: 30n });
      }
    });
    (mockController.prepareReliableCommit as jest.Mock).mockImplementation(() => {
      order.push('prepare-transport');
      return { generation: 1, outboundCount: 1, ackCount: 0, remoteNumber: 0n };
    });
    const runtime = new SessionMachineRuntime(initialState(), {
      controller: mockController,
      iStarted: false,
      restoring: false,
      getRestoreStatus: () => 'idle',
      getRestoreError: () => null,
      onError: jest.fn(),
      persist: async (state) => {
        order.push(`persist-${state.model.betweenHand.compose.gameTimeout}`);
      },
    });

    runtime.dispatch({ type: 'set-compose-timeout', timeout: 20n });
    await runtime.persist();

    expect(order).toEqual(['drain-1', 'drain-2', 'drain-3', 'prepare-transport', 'persist-30']);
  });
});
