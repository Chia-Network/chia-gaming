import { BlockchainPoller } from '../../hooks/BlockchainPoller';
import { SessionController } from '../../hooks/SessionController';
import type { InternalBlockchainInterface } from '../../types/ChiaGaming';
import type { SessionRuntimeLease } from '../session/sessionRuntimeLease';
import { SessionRuntimeRetiredError } from '../session/sessionMachineRuntime';
import { createSessionModel } from '../session/model';
import { expectConsoleError } from '../../../scripts/testSetup';
import {
  makeMockCradle,
  makePeerConn,
  mockRpc,
  mockWasmConnection,
  processWasmResult,
  wasmResult,
} from './message_protocol.harness';

interface PendingRelease {
  readonly launcher: () => Promise<void>;
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

class ControlledLease implements SessionRuntimeLease {
  private readonly pending = new Map<string, PendingRelease>();
  private readonly heldMutations: Array<(error: unknown) => void> = [];
  private nextMutationError: unknown;

  constructor(private holdMutations = false) {}

  retire(): void {
    for (const release of this.pending.values()) {
      release.reject(new SessionRuntimeRetiredError());
    }
    this.pending.clear();
    for (const reject of this.heldMutations.splice(0)) {
      reject(new SessionRuntimeRetiredError());
    }
  }

  requestCommit(): void {}
  flush(): Promise<void> {
    return Promise.resolve();
  }
  enqueue(work: () => void): void {
    work();
  }
  enqueueResult<T>(work: () => T): Promise<T> {
    if (this.nextMutationError !== undefined) {
      const error = this.nextMutationError;
      this.nextMutationError = undefined;
      return Promise.reject(error);
    }
    if (this.holdMutations) {
      return new Promise<T>((_resolve, reject) => this.heldMutations.push(reject));
    }
    try {
      return Promise.resolve(work());
    } catch (error) {
      return Promise.reject(error);
    }
  }
  releaseAfterPersistence(key: string, launcher: () => Promise<void>): Promise<void> {
    const existing = this.pending.get(key);
    if (existing) return existing.promise;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((settle, fail) => {
      resolve = settle;
      reject = fail;
    });
    void promise.catch(() => {});
    this.pending.set(key, { launcher, promise, resolve, reject });
    return promise;
  }
  snapshotModel() {
    return createSessionModel();
  }
  has(key: string): boolean {
    return this.pending.has(key);
  }
  failNextMutation(error: unknown): void {
    this.nextMutationError = error;
  }
  async launch(key: string): Promise<void> {
    const release = this.pending.get(key);
    if (!release) throw new Error(`No pending release for ${key}`);
    this.pending.delete(key);
    try {
      await release.launcher();
      release.resolve();
    } catch (error) {
      release.reject(error);
    }
  }
}

const coin = 'ab'.repeat(72);
const effectKey = `coin-solution:${coin}`;

function setup(getPuzzleAndSolution: jest.Mock, pendingRequests: string[] = []) {
  let readinessListener: ((ready: boolean) => void) | null = null;
  const blockchain = new BlockchainPoller(
    {
      ...mockRpc,
      getPuzzleAndSolution,
      onConnectionChange: () => () => {},
      onPlayReadinessChange: (listener) => {
        readinessListener = listener;
        return () => {
          readinessListener = null;
        };
      },
      isReadyForPlay: () => true,
    } as InternalBlockchainInterface,
    60_000,
  );
  const controller = new SessionController(
    blockchain,
    'coin-solution-delivery',
    100n,
    100n,
    makePeerConn([], []),
  );
  const cradle = makeMockCradle();
  (cradle.snapshot_pending_coin_solution_requests as jest.Mock).mockReturnValue(pendingRequests);
  controller.loadWasm(mockWasmConnection);
  controller.setGameSession(cradle);
  controller.attachBlockchain(blockchain);
  const request = () => {
    processWasmResult(controller, { events: [{ CoinSolutionRequest: coin }] });
    controller.flushDeferredWork();
  };
  return {
    blockchain,
    controller,
    cradle,
    request,
    signalReady: () => readinessListener?.(true),
  };
}

describe('coin puzzle/solution delivery', () => {
  it('seeds delivery from the live Rust pending-request snapshot', async () => {
    const getPuzzleAndSolution = jest.fn().mockResolvedValue(['aa', 'bb']);
    const { controller, cradle } = setup(getPuzzleAndSolution, [coin]);
    const lease = new ControlledLease();
    try {
      controller.attachTransactionCoordinator(lease);
      expect(lease.has(effectKey)).toBe(true);
      await lease.launch(effectKey);
      expect(cradle.report_puzzle_and_solution).toHaveBeenCalledWith(coin, 'aa', 'bb');
    } finally {
      controller.cleanup();
    }
  });

  it('deduplicates duplicate events and launches only after persistence release', async () => {
    const getPuzzleAndSolution = jest.fn().mockResolvedValue(['aa', 'bb']);
    const { controller, cradle, request } = setup(getPuzzleAndSolution);
    const lease = new ControlledLease();
    try {
      controller.attachTransactionCoordinator(lease);
      request();
      request();

      expect(lease.has(effectKey)).toBe(true);
      expect(getPuzzleAndSolution).not.toHaveBeenCalled();
      await lease.launch(effectKey);

      expect(getPuzzleAndSolution).toHaveBeenCalledTimes(1);
      expect(cradle.report_puzzle_and_solution).toHaveBeenCalledTimes(1);
      expect(cradle.report_puzzle_and_solution).toHaveBeenCalledWith(coin, 'aa', 'bb');
    } finally {
      controller.cleanup();
    }
  });

  it('retains a provider failure until reconnect readiness', async () => {
    const getPuzzleAndSolution = jest
      .fn()
      .mockRejectedValueOnce(new Error('provider unavailable'))
      .mockResolvedValueOnce(['aa', 'bb']);
    const { controller, cradle, request, signalReady } = setup(getPuzzleAndSolution);
    const lease = new ControlledLease();
    try {
      controller.attachTransactionCoordinator(lease);
      request();
      expectConsoleError(/provider unavailable/);
      await lease.launch(effectKey);
      expect(cradle.report_puzzle_and_solution).not.toHaveBeenCalled();
      expect(getPuzzleAndSolution).toHaveBeenCalledTimes(1);

      signalReady();
      expect(lease.has(effectKey)).toBe(true);
      await lease.launch(effectKey);
      expect(getPuzzleAndSolution).toHaveBeenCalledTimes(2);
      expect(cradle.report_puzzle_and_solution).toHaveBeenCalledWith(coin, 'aa', 'bb');
    } finally {
      controller.cleanup();
    }
  });

  it('hands an unlaunched request to a replacement lease', async () => {
    const getPuzzleAndSolution = jest.fn().mockResolvedValue(['aa', 'bb']);
    const { controller, cradle, request } = setup(getPuzzleAndSolution);
    const first = new ControlledLease();
    const replacement = new ControlledLease();
    try {
      controller.attachTransactionCoordinator(first);
      request();
      controller.attachTransactionCoordinator(replacement);
      await Promise.resolve();

      expect(replacement.has(effectKey)).toBe(true);
      await replacement.launch(effectKey);
      expect(getPuzzleAndSolution).toHaveBeenCalledTimes(1);
      expect(cradle.report_puzzle_and_solution).toHaveBeenCalledTimes(1);
    } finally {
      controller.cleanup();
    }
  });

  it('replays completion mutation on a replacement lease after RPC completion', async () => {
    let resolveLookup!: (value: string[]) => void;
    const lookup = new Promise<string[]>((resolve) => {
      resolveLookup = resolve;
    });
    const getPuzzleAndSolution = jest.fn(() => lookup);
    const { controller, cradle, request } = setup(getPuzzleAndSolution);
    const first = new ControlledLease(true);
    const replacement = new ControlledLease();
    try {
      controller.attachTransactionCoordinator(first);
      request();
      const launch = first.launch(effectKey);
      resolveLookup(['aa', 'bb']);
      await Promise.resolve();

      controller.attachTransactionCoordinator(replacement);
      await launch;
      expect(cradle.report_puzzle_and_solution).toHaveBeenCalledTimes(1);
      expect(cradle.report_puzzle_and_solution).toHaveBeenCalledWith(coin, 'aa', 'bb');
    } finally {
      controller.cleanup();
    }
  });

  it('keeps malformed puzzle/solution from a successful wallet response terminal', async () => {
    const getPuzzleAndSolution = jest.fn().mockResolvedValue(['02', '80']);
    const { controller, cradle, request, signalReady } = setup(getPuzzleAndSolution);
    const lease = new ControlledLease();
    try {
      controller.attachTransactionCoordinator(lease);
      (cradle.report_puzzle_and_solution as jest.Mock).mockReturnValue(
        wasmResult({
          actionSucceeded: false,
          events: [
            {
              Notification: {
                ActionFailed: { reason: 'trusted wallet returned malformed puzzle/solution' },
              },
            },
          ],
        }),
      );
      request();
      expectConsoleError(/puzzle\/solution callback failed/);
      await lease.launch(effectKey);
      expect(cradle.report_puzzle_and_solution).toHaveBeenCalledWith(coin, '02', '80');
      (cradle.snapshot_pending_coin_solution_requests as jest.Mock).mockReturnValue([coin]);
      signalReady();
      controller.reportNewBlock(2n);
      expect(lease.has(effectKey)).toBe(false);
      expect(getPuzzleAndSolution).toHaveBeenCalledTimes(1);
      expect(cradle.report_puzzle_and_solution).toHaveBeenCalledTimes(1);
      await controller.flushPendingWork();
    } finally {
      controller.cleanup();
    }
  });

  it('retries a transient completion mutation failure on readiness', async () => {
    const getPuzzleAndSolution = jest.fn().mockResolvedValue(['aa', 'bb']);
    const { controller, cradle, request, signalReady } = setup(getPuzzleAndSolution);
    const lease = new ControlledLease();
    try {
      controller.attachTransactionCoordinator(lease);
      lease.failNextMutation(new Error('transient mutation failure'));
      request();
      expectConsoleError(/transient mutation failure/);
      await lease.launch(effectKey);

      expect(getPuzzleAndSolution).toHaveBeenCalledTimes(1);
      expect(cradle.report_puzzle_and_solution).not.toHaveBeenCalled();
      expect(lease.has(effectKey)).toBe(false);

      signalReady();
      expect(lease.has(effectKey)).toBe(true);
      await lease.launch(effectKey);
      expect(getPuzzleAndSolution).toHaveBeenCalledTimes(2);
      expect(cradle.report_puzzle_and_solution).toHaveBeenCalledTimes(1);
      expect(cradle.report_puzzle_and_solution).toHaveBeenCalledWith(coin, 'aa', 'bb');
    } finally {
      controller.cleanup();
    }
  });

  it('detaches a late provider result during clean teardown', async () => {
    let resolveLookup!: (value: string[]) => void;
    const getPuzzleAndSolution = jest.fn(
      () =>
        new Promise<string[]>((resolve) => {
          resolveLookup = resolve;
        }),
    );
    const { controller, cradle, request } = setup(getPuzzleAndSolution);
    const lease = new ControlledLease();
    controller.attachTransactionCoordinator(lease);
    request();
    const launch = lease.launch(effectKey);
    for (let i = 0; i < 10 && getPuzzleAndSolution.mock.calls.length === 0; i += 1) {
      await Promise.resolve();
    }
    controller.cleanup();
    resolveLookup(['aa', 'bb']);
    await launch;
    expect(cradle.report_puzzle_and_solution).not.toHaveBeenCalled();
  });
});
