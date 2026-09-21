import { SessionController } from '../../hooks/SessionController';
import { createSessionModel, INITIAL_CHANNEL_STATUS_MODEL } from '../session/model';
import { createSessionMachineState } from '../session/sessionMachine';
import { SessionMachineRuntime } from '../session/sessionMachineRuntime';
import { SessionRuntimeRetiredError } from '../session/sessionMachineRuntime';
import { StorageAuthorityLostError } from '../session/indexedDb';
import { runSessionMachineTransition, send } from './session_machine.harness';
import { Subject } from 'rxjs';

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
    persist: (state: ReturnType<typeof createSessionMachineState>) => Promise<void>,
    flushDeferredWork: () => void = () => {},
  ) {
    let coordinator: SessionMachineRuntime | undefined;
    const controller = {
      clearDerivedGamePresentation: () => {},
      commitSessionRuntime: (runtime: SessionMachineRuntime) => {
        coordinator?.retire();
        coordinator = runtime;
      },
      getObservable: () => new Subject(),
      onRestoreStatusChange: () => () => {},
      flushDeferredWork,
      prepareReliableCommit: () => ({
        generation: 0,
        outboundCount: 0,
        ackCount: 0,
        remoteNumber: 0n,
      }),
      completeReliableCommit: () => {},
      reportDurabilityError: jest.fn(),
      clearDurabilityError: jest.fn(),
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
    runtime.activate();
    if (!coordinator) throw new Error('runtime did not commit');
    return { runtime, coordinator, controller };
  }

  it('does not attach an abandoned render candidate or revoke controller authority', async () => {
    const controller = new SessionController(null, 'session-id', 0n, 0n, {
      sendMessage: () => true,
      sendAck: () => true,
    });
    const current = new SessionMachineRuntime(createSessionMachineState(createSessionModel()), {
      controller,
      iStarted: false,
      restoring: false,
      getRestoreStatus: () => 'idle',
      getRestoreError: () => null,
      onError: jest.fn(),
      persist: async () => {},
    });
    const retire = jest.spyOn(current, 'retire');
    const flush = jest.spyOn(current, 'flush');
    current.activate();

    new SessionMachineRuntime(createSessionMachineState(createSessionModel()), {
      controller,
      iStarted: false,
      restoring: false,
      getRestoreStatus: () => 'idle',
      getRestoreError: () => null,
      onError: jest.fn(),
      persist: async () => {},
    });

    expect(retire).not.toHaveBeenCalled();
    await controller.flushPendingSave();
    expect(flush).toHaveBeenCalledTimes(1);
    controller.cleanup();
    expect(retire).toHaveBeenCalledTimes(1);
  });

  it('makes committed replacement the sole authority and retires the old runtime', () => {
    const controller = new SessionController(null, 'session-id', 0n, 0n, {
      sendMessage: () => true,
      sendAck: () => true,
    });
    const makeRuntime = () =>
      new SessionMachineRuntime(createSessionMachineState(createSessionModel()), {
        controller,
        iStarted: false,
        restoring: false,
        getRestoreStatus: () => 'idle',
        getRestoreError: () => null,
        onError: jest.fn(),
        persist: async () => {},
      });
    const first = makeRuntime();
    const replacement = makeRuntime();
    first.activate();
    expect(controller.getCommittedSessionRuntime()).toBe(first);

    replacement.activate();
    expect(controller.getCommittedSessionRuntime()).toBe(replacement);
    const retiredState = first.getState();
    first.dispatch({ type: 'set-first-game-accepted', accepted: true });
    expect(first.getState()).toBe(retiredState);

    controller.cleanup();
    const replacementState = replacement.getState();
    replacement.dispatch({ type: 'set-first-game-accepted', accepted: true });
    expect(replacement.getState()).toBe(replacementState);
  });

  it('synchronously revokes a replaced runtime owner', async () => {
    const controller = new SessionController(null, 'session-id', 0n, 0n, {
      sendMessage: () => true,
      sendAck: () => true,
    });
    const makeRuntime = () =>
      new SessionMachineRuntime(createSessionMachineState(createSessionModel()), {
        controller,
        iStarted: false,
        restoring: false,
        getRestoreStatus: () => 'idle',
        getRestoreError: () => null,
        onError: jest.fn(),
        persist: async () => {},
      });
    const first = makeRuntime();
    const second = makeRuntime();
    const firstRetire = jest.spyOn(first, 'retire');
    const secondFlush = jest.spyOn(second, 'flush');
    const secondRetire = jest.spyOn(second, 'retire');
    first.activate();
    second.activate();
    expect(firstRetire).toHaveBeenCalledTimes(1);

    await controller.flushPendingSave();
    expect(secondFlush).toHaveBeenCalledTimes(1);

    controller.cleanup();
    expect(secondRetire).toHaveBeenCalledTimes(1);
  });

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

  it('captures concurrent effect keys behind one persistence gate', async () => {
    const persist = jest.fn(async () => {});
    const firstLauncher = jest.fn(async () => {});
    const secondLauncher = jest.fn(async () => {});
    const { runtime, coordinator } = runtimeWithCoordinator(persist);

    const first = coordinator.releaseAfterPersistence('first-key', firstLauncher);
    const second = coordinator.releaseAfterPersistence('second-key', secondLauncher);
    await runtime.persist();
    await Promise.all([first, second]);

    expect(persist).toHaveBeenCalledTimes(1);
    expect(firstLauncher).toHaveBeenCalledTimes(1);
    expect(secondLauncher).toHaveBeenCalledTimes(1);
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

  it('retires on storage authority loss without releasing effects', async () => {
    const persist = jest.fn(async () => {
      throw new StorageAuthorityLostError();
    });
    const { runtime, coordinator, controller } = runtimeWithCoordinator(persist);
    const launcher = jest.fn(async () => {});
    const effect = coordinator.releaseAfterPersistence('authority-lost', launcher);

    await expect(runtime.persist()).rejects.toBeInstanceOf(StorageAuthorityLostError);
    await expect(effect).rejects.toBeInstanceOf(SessionRuntimeRetiredError);
    expect(launcher).not.toHaveBeenCalled();
    expect(controller.reportDurabilityError).not.toHaveBeenCalled();
    expect(controller.clearDurabilityError).not.toHaveBeenCalled();
  });

  it('clears degraded durability after a full retry without replaying released effects', async () => {
    const persisted: Array<ReturnType<typeof createSessionMachineState>> = [];
    const persist = jest.fn(async (state: ReturnType<typeof createSessionMachineState>) => {
      persisted.push(state);
      if (persisted.length === 1) throw new Error('disk full');
    });
    const { runtime, coordinator, controller } = runtimeWithCoordinator(persist);
    (controller.reportDurabilityError as jest.Mock).mockImplementation(() => {
      runtime.dispatch({
        type: 'enqueue-error',
        kind: 'durability-error',
        message: 'Session storage failed',
      });
    });
    const launcher = jest.fn(async () => {});

    const completion = coordinator.releaseAfterPersistence('cleanup', launcher);
    await expect(runtime.persist()).rejects.toThrow('disk full');
    await expect(completion).resolves.toBeUndefined();
    expect(launcher).toHaveBeenCalledTimes(1);
    expect(runtime.getState().model.channel.queue).toContainEqual(
      expect.objectContaining({ kind: 'durability-error' }),
    );

    await runtime.persist();

    expect(persisted).toHaveLength(2);
    expect(
      persisted[1].model.channel.queue.some(
        (notification) => notification.kind === 'durability-error',
      ),
    ).toBe(false);
    expect(controller.clearDurabilityError).toHaveBeenCalledTimes(1);
    expect(launcher).toHaveBeenCalledTimes(1);

    await runtime.persist();
    expect(persisted).toHaveLength(2);
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

  it.each([
    ['success', undefined],
    ['failure', new Error('disk full')],
  ] as const)(
    'retires a stale runtime during a slow persistence %s without releasing its boundary',
    async (_label, writeError) => {
      const write = deferred();
      const { runtime, coordinator, controller } = runtimeWithCoordinator(() => write.promise);
      const render = jest.fn();
      const complete = jest.fn();
      const reportDurabilityError = jest.fn();
      (controller as SessionController).completeReliableCommit = complete;
      (controller as SessionController).reportDurabilityError = reportDurabilityError;
      runtime.setRender(render);
      runtime.dispatch({ type: 'set-first-game-accepted', accepted: true });
      const flush = runtime.persist();
      await Promise.resolve();

      const result = coordinator.enqueueResult(() => 'stale');
      const launcher = jest.fn(async () => {});
      const effect = coordinator.releaseAfterPersistence('stale-effect', launcher);
      const replacement = new SessionMachineRuntime(
        createSessionMachineState(createSessionModel()),
        {
          controller,
          iStarted: false,
          restoring: false,
          getRestoreStatus: () => 'idle',
          getRestoreError: () => null,
          onError: jest.fn(),
          persist: async () => {},
        },
      );
      replacement.activate();
      if (writeError) write.reject(writeError);
      else write.resolve();

      if (writeError) await expect(flush).rejects.toThrow('disk full');
      else await expect(flush).resolves.toBeUndefined();
      await expect(result).rejects.toBeInstanceOf(SessionRuntimeRetiredError);
      await expect(effect).rejects.toBeInstanceOf(SessionRuntimeRetiredError);
      expect(render).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
      expect(reportDurabilityError).not.toHaveBeenCalled();
      expect(launcher).not.toHaveBeenCalled();
      replacement.retire();
    },
  );

  it('rejects queued typed work, discards fire-and-forget work, and cancels keyed effects', async () => {
    const write = deferred();
    const { runtime, coordinator } = runtimeWithCoordinator(() => write.promise);
    runtime.dispatch({ type: 'set-first-game-accepted', accepted: true });
    const flush = runtime.persist();
    await Promise.resolve();

    const discarded = jest.fn();
    coordinator.enqueue(discarded);
    const result = coordinator.enqueueResult(() => 42);
    const launcher = jest.fn(async () => {});
    const effect = coordinator.releaseAfterPersistence('cancel-me', launcher);
    runtime.retire();

    await expect(result).rejects.toMatchObject({
      name: 'SessionRuntimeRetiredError',
      code: 'SESSION_RUNTIME_RETIRED',
    });
    await expect(effect).rejects.toBeInstanceOf(SessionRuntimeRetiredError);
    write.resolve();
    await flush;
    expect(discarded).not.toHaveBeenCalled();
    expect(launcher).not.toHaveBeenCalled();
  });

  it('queues dispatches requested during a React projection instead of re-entering it', async () => {
    jest.useFakeTimers();
    const controller = {
      clearDerivedGamePresentation: () => {},
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
        runtime.dispatch({ type: 'set-new-hand-requested', requested: true });
      }

      renderDepth -= 1;
    });

    runtime.dispatch({ type: 'set-first-game-accepted', accepted: true });
    await runtime.persist();

    expect(maxRenderDepth).toBe(1);

    expect(renderCount).toBe(2);

    expect(runtime.getState().coordination.firstGameAccepted).toBe(true);
    expect(runtime.getState().model.betweenHand.newHandRequested).toBe(true);
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
