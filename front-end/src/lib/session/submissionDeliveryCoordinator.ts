import type { TransactionSubmission } from '../../types/ChiaGaming';
import type { SessionRuntimeLease } from './sessionRuntimeLease';
import { SessionRuntimeRetiredError } from './sessionMachineRuntime';

export interface SubmissionDeliveryToken {
  readonly submission: TransactionSubmission;
  isRetired(): boolean;
}

interface BridgeDelivery {
  readonly submission: TransactionSubmission;
  awaitingFreshSync: boolean;
  successor?: TransactionSubmission;
  state:
    | { readonly kind: 'idle' }
    | {
        readonly kind: 'scheduled';
        readonly lease: SessionRuntimeLease;
        readonly release: Promise<void>;
      }
    | {
        readonly kind: 'settling-failure';
        readonly completion: Promise<void>;
      };
}

class LaunchedDelivery implements SubmissionDeliveryToken {
  retired = false;
  successor?: TransactionSubmission;

  constructor(readonly submission: TransactionSubmission) {}

  isRetired(): boolean {
    return this.retired;
  }
}

class TransactionSubmitQueue {
  private tail: Promise<void> = Promise.resolve();
  private readonly active = new Map<string, LaunchedDelivery>();
  private retired = false;

  get(id: string): LaunchedDelivery | undefined {
    return this.active.get(id);
  }

  enqueue(
    operation: LaunchedDelivery,
    run: (operation: SubmissionDeliveryToken) => Promise<void>,
    completed: (operation: LaunchedDelivery, error?: unknown) => Promise<void>,
  ): void {
    if (this.retired) {
      operation.retired = true;
      return;
    }
    this.active.set(operation.submission.id, operation);
    const submission = this.tail.then(() => run(operation));
    const completedSubmission = submission.then(
      async () => {
        if (this.active.get(operation.submission.id) === operation) {
          this.active.delete(operation.submission.id);
        }
        await completed(operation);
      },
      async (error) => {
        if (this.active.get(operation.submission.id) === operation) {
          this.active.delete(operation.submission.id);
        }
        await completed(operation, error);
      },
    );
    this.tail = completedSubmission.catch(() => {});
  }

  retire(id: string): void {
    const operation = this.active.get(id);
    if (!operation) return;
    operation.retired = true;
    operation.successor = undefined;
  }

  hasPending(): boolean {
    return this.active.size > 0;
  }

  flush(): Promise<void> {
    return this.tail;
  }

  retireAll(): void {
    if (this.retired) return;
    this.retired = true;
    for (const operation of this.active.values()) operation.retired = true;
    this.active.clear();
    this.tail = Promise.resolve();
  }
}

interface SubmissionDeliveryCoordinatorDependencies {
  getLease(): SessionRuntimeLease | null;
  canLaunch(delivery: { awaitingFreshSync: boolean }): boolean;
  run(operation: SubmissionDeliveryToken): Promise<void>;
  recordFailure(submission: TransactionSubmission, error: unknown): Promise<void>;
  reportError(error: unknown): void;
  isRetired(): boolean;
}

export class SubmissionDeliveryCoordinator {
  private readonly bridge = new Map<string, BridgeDelivery>();
  private readonly queue = new TransactionSubmitQueue();
  private retired = false;

  constructor(private readonly dependencies: SubmissionDeliveryCoordinatorDependencies) {}

  submit(submission: TransactionSubmission, awaitingFreshSync: boolean): void {
    if (this.retired) return;
    const bridged = this.bridge.get(submission.id);
    if (bridged) {
      this.requireMatchingIntent(bridged.submission, submission);
      if (bridged.submission.variant_fingerprint === submission.variant_fingerprint) return;
      bridged.successor = submission;
      return;
    }
    const launched = this.queue.get(submission.id);
    if (launched) {
      this.requireMatchingIntent(launched.submission, submission);
      if (launched.submission.variant_fingerprint === submission.variant_fingerprint) return;
      launched.successor = submission;
      return;
    }
    this.bridge.set(submission.id, {
      submission,
      awaitingFreshSync,
      state: { kind: 'idle' },
    });
    this.schedule(submission.id);
  }

  scheduleAll(): void {
    for (const id of this.bridge.keys()) this.schedule(id);
  }

  releaseFreshSync(): void {
    for (const delivery of this.bridge.values()) delivery.awaitingFreshSync = false;
    this.scheduleAll();
  }

  retire(id: string): void {
    this.bridge.delete(id);
    this.queue.retire(id);
  }

  hasPrelaunch(id: string): boolean {
    return this.bridge.has(id);
  }

  hasPending(): boolean {
    return this.bridge.size > 0 || this.queue.hasPending();
  }

  async flush(): Promise<void> {
    const releases = [...this.bridge.values()]
      .map((delivery) => {
        if (delivery.state.kind === 'scheduled') return delivery.state.release;
        if (delivery.state.kind === 'settling-failure') return delivery.state.completion;
        return null;
      })
      .filter((release): release is Promise<void> => release !== null);
    await Promise.allSettled(releases);
    await this.queue.flush();
  }

  retireAll(): void {
    if (this.retired) return;
    this.retired = true;
    this.bridge.clear();
    this.queue.retireAll();
  }

  private requireMatchingIntent(
    current: TransactionSubmission,
    candidate: TransactionSubmission,
  ): void {
    if (current.intent_fingerprint !== candidate.intent_fingerprint) {
      throw new Error(
        `Submission ${candidate.id} reused a stable id with a mismatched durable intent fingerprint`,
      );
    }
  }

  private schedule(id: string): void {
    const delivery = this.bridge.get(id);
    const lease = this.dependencies.getLease();
    if (
      !delivery ||
      !lease ||
      !this.dependencies.canLaunch(delivery) ||
      delivery.state.kind === 'settling-failure' ||
      (delivery.state.kind === 'scheduled' && delivery.state.lease === lease)
    ) {
      return;
    }
    let release!: Promise<void>;
    try {
      release = lease.releaseAfterPersistence(`submission:${id}`, () => {
        const current = this.bridge.get(id);
        if (
          current !== delivery ||
          current.state.kind !== 'scheduled' ||
          current.state.lease !== lease
        ) {
          return Promise.resolve();
        }
        this.bridge.delete(id);
        const operation = new LaunchedDelivery(delivery.submission);
        operation.successor = delivery.successor;
        this.queue.enqueue(
          operation,
          (token) => this.dependencies.run(token),
          (finished, error) => this.completeLaunched(finished, error),
        );
        return Promise.resolve();
      });
    } catch (error) {
      this.handleReleaseFailure(delivery, lease, error);
      return;
    }
    delivery.state = { kind: 'scheduled', lease, release };
    void release.catch((error) => this.handleReleaseFailure(delivery, lease, error));
  }

  private handleReleaseFailure(
    delivery: BridgeDelivery,
    lease: SessionRuntimeLease,
    error: unknown,
  ): void {
    const current = this.bridge.get(delivery.submission.id);
    if (
      current !== delivery ||
      current.state.kind !== 'scheduled' ||
      current.state.lease !== lease
    ) {
      return;
    }
    if (error instanceof SessionRuntimeRetiredError) {
      delivery.state = { kind: 'idle' };
      if (this.dependencies.getLease() !== lease) this.schedule(delivery.submission.id);
      return;
    }
    const completion = this.dependencies.recordFailure(delivery.submission, error).finally(() => {
      if (this.bridge.get(delivery.submission.id) === delivery) {
        this.bridge.delete(delivery.submission.id);
      }
    });
    delivery.state = { kind: 'settling-failure', completion };
    void completion.catch((recordingError) => {
      if (!this.dependencies.isRetired()) this.dependencies.reportError(recordingError);
    });
  }

  private async completeLaunched(operation: LaunchedDelivery, error?: unknown): Promise<void> {
    const successor = operation.successor;
    if (
      error !== undefined &&
      !operation.retired &&
      !(this.dependencies.isRetired() && error instanceof SessionRuntimeRetiredError)
    ) {
      await this.dependencies.recordFailure(operation.submission, error);
    }
    if (successor && !operation.retired && !this.retired) {
      this.submit(successor, false);
    }
  }
}
