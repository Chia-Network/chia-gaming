import { Program } from 'clvm-lib';
import type { SessionController } from '../../hooks/SessionController';
import { createSessionModel, INITIAL_CHANNEL_STATUS_MODEL } from '../session/model';
import { createSessionMachineState } from '../session/sessionMachine';
import { SessionMachineRuntime } from '../session/sessionMachineRuntime';

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
    clearDerivedGamePresentation: jest.fn(),
    attachTransactionCoordinator: jest.fn(),
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
  afterEach(() => jest.useRealTimers());

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

  it('projects and releases nothing on failure, then retries the exact state', async () => {
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
    expect(render).not.toHaveBeenCalled();
    expect(mockController.completeReliableCommit).not.toHaveBeenCalled();

    await runtime.persist();
    expect(persistedTimeouts).toEqual([20n, 20n]);
    expect(render).toHaveBeenCalledTimes(1);
    expect(mockController.completeReliableCommit).toHaveBeenCalledTimes(1);
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
      persist: async () => {
        writes.push(runtime.getState().model.betweenHand.compose.gameTimeout);
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
});
