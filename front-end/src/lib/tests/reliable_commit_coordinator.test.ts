import type { SessionController } from '../../hooks/SessionController';
import type { ReliableCommitCoordinator } from '../../services/PeerSession';
import { attachControllerOnlyTestCommitCoordinator } from './reliable_commit_coordinator.harness';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function makeController() {
  let coordinator: ReliableCommitCoordinator | undefined;
  const controller = {
    attachTransactionCoordinator: (attached: ReliableCommitCoordinator) => {
      coordinator = attached;
    },
    flushDeferredWork: jest.fn(),
    prepareReliableCommit: jest.fn(() => ({
      generation: 0,
      outboundCount: 0,
      ackCount: 0,
      remoteNumber: 0n,
    })),
    completeReliableCommit: jest.fn(),
    prepareInboundSessionRejectPersistence: jest.fn(() => null),
    reportDurabilityError: jest.fn(),
  } as unknown as SessionController;
  return {
    controller,
    attached: () => {
      if (!coordinator) throw new Error('test coordinator was not attached');
      return coordinator;
    },
  };
}

describe('controller-only reliable commit coordinator', () => {
  it('deduplicates keys, captures at persistence start, and does not await launched work', async () => {
    const firstWrite = deferred();
    const secondWrite = deferred();
    const effectCompletion = deferred();
    const persist = jest
      .fn<Promise<void>, []>()
      .mockReturnValueOnce(firstWrite.promise)
      .mockReturnValueOnce(secondWrite.promise);
    const { controller, attached } = makeController();
    attachControllerOnlyTestCommitCoordinator(controller, { persist });
    const coordinator = attached();
    const firstLauncher = jest.fn(() => effectCompletion.promise);
    const lateLauncher = jest.fn(async () => {});

    const first = coordinator.releaseAfterPersistence('shared', firstLauncher);
    expect(coordinator.releaseAfterPersistence('shared', async () => {})).toBe(first);
    const flush = coordinator.flush();
    await Promise.resolve();
    await Promise.resolve();
    expect(persist).toHaveBeenCalledTimes(1);

    const late = coordinator.releaseAfterPersistence('late', lateLauncher);
    firstWrite.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(firstLauncher).toHaveBeenCalledTimes(1);
    expect(lateLauncher).not.toHaveBeenCalled();
    expect(persist).toHaveBeenCalledTimes(2);

    secondWrite.resolve();
    await flush;
    expect(lateLauncher).toHaveBeenCalledTimes(1);
    await expect(late).resolves.toBeUndefined();

    let firstSettled = false;
    void first.then(() => {
      firstSettled = true;
    });
    await Promise.resolve();
    expect(firstSettled).toBe(false);
    effectCompletion.resolve();
    await expect(first).resolves.toBeUndefined();
  });

  it('releases once after persistence failure and rejects a synchronous launcher throw', async () => {
    const persist = jest
      .fn<Promise<void>, []>()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValue(undefined);
    const { controller, attached } = makeController();
    attachControllerOnlyTestCommitCoordinator(controller, { persist });
    const coordinator = attached();
    const launcher = jest.fn((): Promise<void> => {
      throw new Error('sync launch failure');
    });
    const completion = coordinator.releaseAfterPersistence('effect', launcher);

    await expect(coordinator.flush()).rejects.toThrow('disk full');
    await expect(completion).rejects.toThrow('sync launch failure');
    expect(launcher).toHaveBeenCalledTimes(1);
    expect(controller.completeReliableCommit).toHaveBeenNthCalledWith(1, expect.anything(), false);

    await coordinator.flush();
    expect(launcher).toHaveBeenCalledTimes(1);
    expect(controller.completeReliableCommit).toHaveBeenNthCalledWith(2, expect.anything(), true);
  });

  it('allows a released launcher to schedule the same key for a later commit', async () => {
    const persist = jest.fn(async () => {});
    const { controller, attached } = makeController();
    attachControllerOnlyTestCommitCoordinator(controller, { persist });
    const coordinator = attached();
    let later: Promise<void> | undefined;
    const laterLauncher = jest.fn(async () => {});
    const firstLauncher = jest.fn(async () => {
      later = coordinator.releaseAfterPersistence('reentrant', laterLauncher);
    });

    const first = coordinator.releaseAfterPersistence('reentrant', firstLauncher);
    await coordinator.flush();
    await expect(first).resolves.toBeUndefined();
    await expect(later).resolves.toBeUndefined();
    expect(persist).toHaveBeenCalledTimes(2);
    expect(firstLauncher).toHaveBeenCalledTimes(1);
    expect(laterLauncher).toHaveBeenCalledTimes(1);
  });
});
