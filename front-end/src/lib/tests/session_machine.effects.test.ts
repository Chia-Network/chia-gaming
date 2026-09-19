import type { SessionController } from '../../hooks/SessionController';
import { createSessionModel, INITIAL_CHANNEL_STATUS_MODEL } from '../session/model';
import { createSessionMachineState } from '../session/sessionMachine';
import { SessionMachineRuntime } from '../session/sessionMachineRuntime';
import type { ReliableCommitCoordinator } from '../../services/PeerSession';
import { runSessionMachineTransition, send } from './session_machine.harness';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe('session machine behavior sequences', () => {
  function runtimeWithCoordinator(
    persist: () => Promise<void>,
    flushDeferredWork: () => void = () => {},
  ) {
    let coordinator: ReliableCommitCoordinator | undefined;
    const controller = {
      clearDerivedGamePresentation: () => {},
      attachTransactionCoordinator: (attached: ReliableCommitCoordinator) => {
        coordinator = attached;
      },
      flushDeferredWork,
      prepareReliableCommit: () => ({
        generation: 0,
        outboundCount: 0,
        ackCount: 0,
        remoteNumber: 0n,
      }),
      completeReliableCommit: () => {},
    } as unknown as SessionController;
    const runtime = new SessionMachineRuntime(createSessionMachineState(createSessionModel()), {
      controller,
      iStarted: false,
      restoring: false,
      getRestoreStatus: () => 'idle',
      getRestoreError: () => null,
      onError: () => {},
      persist,
    });
    if (!coordinator) throw new Error('runtime did not attach its commit coordinator');
    return { runtime, coordinator };
  }

  it('deduplicates pending external effects by key without awaiting their completion', async () => {
    let resolveEffect!: () => void;
    const effectGate = new Promise<void>((resolve) => {
      resolveEffect = resolve;
    });
    const launcher = jest.fn(() => effectGate);
    const { runtime, coordinator } = runtimeWithCoordinator(async () => {});

    const first = coordinator.releaseAfterPersistence('same-key', launcher);
    const second = coordinator.releaseAfterPersistence('same-key', async () => {});
    expect(second).toBe(first);

    await runtime.persist();
    expect(launcher).toHaveBeenCalledTimes(1);
    let settled = false;
    void first.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    resolveEffect();
    await expect(first).resolves.toBeUndefined();
  });

  it('releases a captured effect once after failed persistence and rejects sync launcher throws', async () => {
    const persist = jest
      .fn<Promise<void>, []>()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValue(undefined);
    const { runtime, coordinator } = runtimeWithCoordinator(persist);
    const launcher = jest.fn((): Promise<void> => {
      throw new Error('sync launch failure');
    });
    const completion = coordinator.releaseAfterPersistence('failing-launch', launcher);

    await expect(runtime.persist()).rejects.toThrow('disk full');
    await expect(completion).rejects.toThrow('sync launch failure');
    expect(launcher).toHaveBeenCalledTimes(1);

    await runtime.persist();
    expect(launcher).toHaveBeenCalledTimes(1);
  });

  it('returns and rejects typed work after its transaction reaches a fixed point', async () => {
    let workRan = false;
    let fixedPointReached = false;
    const { coordinator } = runtimeWithCoordinator(
      async () => {},
      () => {
        if (workRan) fixedPointReached = true;
      },
    );

    const result = coordinator.enqueueResult(() => {
      workRan = true;
      return 42;
    });
    expect(workRan).toBe(true);
    await expect(result).resolves.toBe(42);
    expect(fixedPointReached).toBe(true);

    await expect(
      coordinator.enqueueResult(() => {
        throw new Error('typed work failed');
      }),
    ).rejects.toThrow('typed work failed');
  });

  it('queues typed work during persistence without coupling its result to the write', async () => {
    const write = deferred();
    const { runtime, coordinator } = runtimeWithCoordinator(() => write.promise);
    runtime.dispatch({ type: 'set-first-game-accepted', accepted: true });
    const flush = runtime.persist();
    await Promise.resolve();

    const order: string[] = [];
    const returned = coordinator.enqueueResult(() => {
      order.push('return');
      return 'done';
    });
    const thrown = coordinator.enqueueResult(() => {
      order.push('throw');
      throw new Error('queued failure');
    });
    expect(order).toEqual([]);

    write.resolve();
    await flush;
    await expect(returned).resolves.toBe('done');
    await expect(thrown).rejects.toThrow('queued failure');
    expect(order).toEqual(['return', 'throw']);
  });

  it('settles queued typed work when persistence fails', async () => {
    const write = deferred();
    const persist = jest
      .fn<Promise<void>, []>()
      .mockReturnValueOnce(write.promise)
      .mockResolvedValue(undefined);
    const { runtime, coordinator } = runtimeWithCoordinator(persist);
    runtime.dispatch({ type: 'set-first-game-accepted', accepted: true });
    const flush = runtime.persist();
    await Promise.resolve();

    const result = coordinator.enqueueResult(() => 'released');
    write.reject(new Error('disk full'));

    await expect(flush).rejects.toThrow('disk full');
    await expect(result).resolves.toBe('released');
    await runtime.persist();
  });

  it('allows a released keyed effect to reuse its key reentrantly', async () => {
    const { runtime, coordinator } = runtimeWithCoordinator(async () => {});
    let later: Promise<void> | undefined;
    const laterLauncher = jest.fn(async () => {});
    const firstLauncher = jest.fn(async () => {
      later = coordinator.releaseAfterPersistence('reentrant', laterLauncher);
    });

    const first = coordinator.releaseAfterPersistence('reentrant', firstLauncher);
    await runtime.persist();
    await expect(first).resolves.toBeUndefined();
    await expect(later).resolves.toBeUndefined();
    expect(firstLauncher).toHaveBeenCalledTimes(1);
    expect(laterLauncher).toHaveBeenCalledTimes(1);
  });

  it('queues dispatches requested during a React projection instead of re-entering it', async () => {
    jest.useFakeTimers();
    const controller = {
      clearDerivedGamePresentation: () => {},
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

    const runtime = new SessionMachineRuntime(createSessionMachineState(createSessionModel()), {
      controller,

      iStarted: false,

      restoring: false,

      getRestoreStatus: () => 'idle',

      getRestoreError: () => null,

      onError: () => {},

      persist: async () => {},
    });

    let renderDepth = 0;

    let maxRenderDepth = 0;

    let renderCount = 0;

    runtime.setRender(() => {
      renderDepth += 1;

      maxRenderDepth = Math.max(maxRenderDepth, renderDepth);

      renderCount += 1;

      if (renderCount === 1) {
        runtime.dispatch({ type: 'set-same-terms-requested', requested: true });
      }

      renderDepth -= 1;
    });

    runtime.dispatch({ type: 'set-first-game-accepted', accepted: true });
    await runtime.persist();

    expect(maxRenderDepth).toBe(1);

    expect(renderCount).toBe(2);

    expect(runtime.getState().coordination).toMatchObject({
      firstGameAccepted: true,

      sameTermsRequested: true,
    });
    jest.useRealTimers();
  });

  it('publishes machine authority before commands and React', () => {
    const state = createSessionMachineState(createSessionModel());

    const order: string[] = [];

    runSessionMachineTransition(
      {
        state,

        effects: [{ type: 'controller-accept-proposal', id: '7' }],
      },

      {
        setAuthority: () => order.push('authority'),

        getAuthority: () => state,

        controller: {
          clearDerivedGamePresentation: () => order.push('controller-clear'),
        },

        runCommand: () => order.push('command'),

        render: () => order.push('react'),
      },
    );

    expect(order).toEqual(['authority', 'command', 'react']);
  });

  it('projects channel and game status, local turn, and settlement in event order', () => {
    let state = createSessionMachineState(createSessionModel());

    state = send(state, {
      type: 'channel-status',

      status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'Active' },
    });

    state = send(state, { type: 'game', action: { type: 'channel-active' } });

    state = send(state, {
      type: 'game',

      action: {
        type: 'accepted-group',

        groupIds: ['7'],

        members: [{ amount: '20', startTurn: 'my-turn' }],

        origin: 'local',

        gameType: 'calpoker',
      },
    });

    state = send(state, {
      type: 'game',

      action: {
        type: 'status',

        id: '7',

        payload: { id: '7', status: 'on-chain-my-turn', coin_id: [1] },

        channelState: 'ResolvedUnrolled',
      },
    });

    state = send(state, {
      type: 'game',

      action: {
        type: 'local-turn',

        id: '7',

        isMyTurn: false,

        channelState: 'Unrolling',
      },
    });

    expect(state.model.game.instances['7'].presentation).toBe('on-chain-my-turn');

    state = send(state, {
      type: 'game',

      action: {
        type: 'settled',

        id: '7',

        terminal: {
          type: 'settled',

          outcome: 'settled_cleanly',

          label: 'Settled cleanly',

          myReward: '20',

          rewardCoinHex: null,
        },
      },
    });

    expect(state.model.game.activeIds).toEqual([]);

    expect(state.model.game.instances['7']).toMatchObject({
      presentation: 'ended',

      terminal: { type: 'settled', myReward: '20' },
    });
  });
});
