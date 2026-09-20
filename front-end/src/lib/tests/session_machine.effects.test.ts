import { SessionController } from '../../hooks/SessionController';
import { createSessionModel, INITIAL_CHANNEL_STATUS_MODEL } from '../session/model';
import { createSessionMachineState } from '../session/sessionMachine';
import { SessionMachineRuntime } from '../session/sessionMachineRuntime';
import { SessionRuntimeRetiredError } from '../session/sessionMachineRuntime';
import type { SessionRuntimeLease } from '../session/sessionRuntimeLease';
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
    let coordinator: SessionRuntimeLease | undefined;
    let attachedCoordinator: SessionRuntimeLease | undefined;
    const controller = {
      clearDerivedGamePresentation: () => {},
      attachTransactionCoordinator: (next: SessionRuntimeLease) => {
        coordinator = next;
        if (attachedCoordinator && attachedCoordinator !== next) {
          attachedCoordinator.retire();
        }
        attachedCoordinator = next;
      },
      detachTransactionCoordinator: (detached: SessionRuntimeLease) => {
        if (attachedCoordinator === detached) attachedCoordinator = undefined;
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
    runtime.activate();
    if (!coordinator) throw new Error('runtime did not attach its commit coordinator');
    return { runtime, coordinator, controller };
  }

  it('constructs without attaching or revoking controller authority', async () => {
    const controller = new SessionController(null, 'session-id', 0n, 0n, {
      sendMessage: () => true,
      sendAck: () => true,
    });
    const current = {
      retire: jest.fn(() => controller.detachTransactionCoordinator(current)),
      requestCommit: jest.fn(),
      flush: jest.fn(async () => {}),
      enqueue: jest.fn(),
      enqueueResult: jest.fn(),
      releaseAfterPersistence: jest.fn(),
      snapshotModel: jest.fn(() => createSessionModel()),
    } as unknown as SessionRuntimeLease;
    controller.attachTransactionCoordinator(current);

    new SessionMachineRuntime(createSessionMachineState(createSessionModel()), {
      controller,
      iStarted: false,
      restoring: false,
      getRestoreStatus: () => 'idle',
      getRestoreError: () => null,
      onError: jest.fn(),
      persist: async () => {},
    });

    expect(current.retire).not.toHaveBeenCalled();
    await controller.flushPendingSave();
    expect(current.flush).toHaveBeenCalledTimes(1);
    controller.cleanup();
    expect(current.retire).toHaveBeenCalledTimes(1);
  });

  it('synchronously revokes a replaced controller owner and ignores stale release', async () => {
    const controller = new SessionController(null, 'session-id', 0n, 0n, {
      sendMessage: () => true,
      sendAck: () => true,
    });
    const first = {
      retire: jest.fn(() => controller.detachTransactionCoordinator(first)),
      requestCommit: jest.fn(),
      flush: jest.fn(async () => {}),
      enqueue: jest.fn(),
      enqueueResult: jest.fn(),
      releaseAfterPersistence: jest.fn(),
      snapshotModel: jest.fn(() => createSessionModel()),
    } as unknown as SessionRuntimeLease;
    const second = {
      retire: jest.fn(() => controller.detachTransactionCoordinator(second)),
      requestCommit: jest.fn(),
      flush: jest.fn(async () => {}),
      enqueue: jest.fn(),
      enqueueResult: jest.fn(),
      releaseAfterPersistence: jest.fn(),
      snapshotModel: jest.fn(() => createSessionModel()),
    } as unknown as SessionRuntimeLease;

    controller.attachTransactionCoordinator(first);
    controller.attachTransactionCoordinator(second);
    expect(first.retire).toHaveBeenCalledTimes(1);

    controller.detachTransactionCoordinator(first);
    await controller.flushPendingSave();
    expect(second.flush).toHaveBeenCalledTimes(1);

    controller.cleanup();
    expect(second.retire).toHaveBeenCalledTimes(1);
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
