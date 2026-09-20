import type { TransactionSubmission } from '../../types/ChiaGaming';
import type { SessionRuntimeLease } from './sessionRuntimeLease';
import { SessionRuntimeRetiredError } from './sessionMachineRuntime';

export interface SubmissionDeliveryToken {
  readonly submission: TransactionSubmission;
  isRetired(): boolean;
  isSuperseded(): boolean;
}

export type SubmissionDeliveryOutcome =
  | 'acknowledged'
  | 'unavailable'
  | 'rejected'
  | 'local-failure'
  | 'skipped';

export interface SubmissionDeliveryCompletion {
  readonly broadcastAttempted: boolean;
  readonly outcome: SubmissionDeliveryOutcome;
  readonly requiresFreshSync: boolean;
}

export type SubmissionSuccessorRelationship = 'exact' | 'newer-fee-bearing' | 'other';

interface DeliveryEntry {
  submission: TransactionSubmission;
  awaitingFreshSync: boolean;
  successor?: TransactionSubmission;
  retired: boolean;
  state:
    | { readonly kind: 'idle' }
    | {
        readonly kind: 'scheduled';
        readonly lease: SessionRuntimeLease;
        readonly release: Promise<void>;
      }
    | {
        readonly kind: 'launched';
      }
    | {
        readonly kind: 'settling-failure';
        readonly completion: Promise<void>;
      }
    | {
        readonly kind: 'settling-relinquishment';
        readonly completion: Promise<void>;
      };
}

class LaunchedDeliveryToken implements SubmissionDeliveryToken {
  constructor(
    readonly submission: TransactionSubmission,
    private readonly entry: DeliveryEntry,
  ) {}

  isRetired(): boolean {
    return this.entry.retired;
  }

  isSuperseded(): boolean {
    return this.entry.successor !== undefined;
  }
}

interface SubmissionDeliveryCoordinatorDependencies {
  getLease(): SessionRuntimeLease | null;
  canLaunch(delivery: { awaitingFreshSync: boolean }): boolean;
  run(operation: SubmissionDeliveryToken): Promise<SubmissionDeliveryCompletion>;
  classifySuccessor(
    successor: TransactionSubmission,
    completed: TransactionSubmission,
  ): SubmissionSuccessorRelationship;
  relinquishAttempt(completed: TransactionSubmission): Promise<void>;
  requireFreshSync(): void;
  recordFailure(submission: TransactionSubmission, error: unknown): Promise<void>;
  reportError(error: unknown): void;
  isRetired(): boolean;
}

export class SubmissionDeliveryCoordinator {
  private readonly deliveries = new Map<string, DeliveryEntry>();
  private tail: Promise<void> = Promise.resolve();
  private retired = false;

  constructor(private readonly dependencies: SubmissionDeliveryCoordinatorDependencies) {}

  submit(submission: TransactionSubmission, awaitingFreshSync: boolean): void {
    if (this.retired) return;
    const existing = this.deliveries.get(submission.id);
    if (existing) {
      this.requireMatchingIntent(existing.submission, submission);
      if (
        existing.submission.attempt_token === submission.attempt_token ||
        existing.successor?.attempt_token === submission.attempt_token
      ) {
        return;
      }
      if (existing.state.kind === 'launched') {
        if (existing.successor) this.queueRelinquishment(existing.successor);
        existing.successor = submission;
      } else if (
        existing.state.kind === 'settling-failure' ||
        existing.state.kind === 'settling-relinquishment'
      ) {
        if (existing.successor) this.queueRelinquishment(existing.successor);
        existing.successor = submission;
      } else {
        existing.successor = submission;
        const completion = this.tail.then(() =>
          this.settlePrelaunchRelinquishment(existing, awaitingFreshSync),
        );
        existing.state = { kind: 'settling-relinquishment', completion };
        this.tail = completion.catch((error) => this.reportSettlementError(error));
      }
      return;
    }
    this.deliveries.set(submission.id, {
      submission,
      awaitingFreshSync,
      retired: false,
      state: { kind: 'idle' },
    });
    this.schedule(submission.id);
  }

  scheduleAll(): void {
    for (const id of this.deliveries.keys()) this.schedule(id);
  }

  releaseFreshSync(): void {
    for (const delivery of this.deliveries.values()) delivery.awaitingFreshSync = false;
    this.scheduleAll();
  }

  retire(id: string): void {
    const delivery = this.deliveries.get(id);
    if (!delivery) return;
    delivery.retired = true;
    delivery.successor = undefined;
    if (delivery.state.kind !== 'launched') this.deliveries.delete(id);
  }

  hasPrelaunch(id: string): boolean {
    const delivery = this.deliveries.get(id);
    return delivery !== undefined && delivery.state.kind !== 'launched';
  }

  hasPending(): boolean {
    return this.deliveries.size > 0;
  }

  async flush(): Promise<void> {
    const releases = [...this.deliveries.values()]
      .map((delivery) => {
        if (delivery.state.kind === 'scheduled') return delivery.state.release;
        if (delivery.state.kind === 'settling-failure') return delivery.state.completion;
        if (delivery.state.kind === 'settling-relinquishment') return delivery.state.completion;
        return null;
      })
      .filter((release): release is Promise<void> => release !== null);
    await Promise.allSettled(releases);
    await this.tail;
  }

  retireAll(): void {
    if (this.retired) return;
    this.retired = true;
    for (const delivery of this.deliveries.values()) delivery.retired = true;
    this.deliveries.clear();
    this.tail = Promise.resolve();
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
    const delivery = this.deliveries.get(id);
    const lease = this.dependencies.getLease();
    if (
      !delivery ||
      !lease ||
      !this.dependencies.canLaunch(delivery) ||
      delivery.retired ||
      delivery.state.kind === 'launched' ||
      delivery.state.kind === 'settling-failure' ||
      delivery.state.kind === 'settling-relinquishment' ||
      (delivery.state.kind === 'scheduled' && delivery.state.lease === lease)
    ) {
      return;
    }
    let release!: Promise<void>;
    try {
      release = lease.releaseAfterPersistence(`submission:${id}`, () => {
        const current = this.deliveries.get(id);
        if (
          current !== delivery ||
          current.state.kind !== 'scheduled' ||
          current.state.lease !== lease
        ) {
          return Promise.resolve();
        }
        delivery.state = { kind: 'launched' };
        const token = new LaunchedDeliveryToken(delivery.submission, delivery);
        const run = this.tail.then(() => this.dependencies.run(token));
        const completed = run.then(
          (completion) => this.completeLaunched(delivery, token, completion),
          (error) => this.completeLaunched(delivery, token, undefined, error),
        );
        this.tail = completed.catch(() => {});
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
    delivery: DeliveryEntry,
    lease: SessionRuntimeLease,
    error: unknown,
  ): void {
    const current = this.deliveries.get(delivery.submission.id);
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
    const completion = this.settlePrelaunchFailure(delivery, error);
    delivery.state = { kind: 'settling-failure', completion };
    void completion.catch((recordingError) => this.reportSettlementError(recordingError));
  }

  private async settlePrelaunchFailure(delivery: DeliveryEntry, error: unknown): Promise<void> {
    try {
      await this.dependencies.recordFailure(delivery.submission, error);
    } finally {
      if (this.deliveries.get(delivery.submission.id) === delivery) {
        if (!delivery.retired) await this.dependencies.relinquishAttempt(delivery.submission);
        const successor = delivery.successor;
        if (successor && !delivery.retired && !this.retired) {
          delivery.submission = successor;
          delivery.successor = undefined;
          delivery.state = { kind: 'idle' };
          this.schedule(successor.id);
        } else {
          this.deliveries.delete(delivery.submission.id);
        }
      }
    }
  }

  private async settlePrelaunchRelinquishment(
    delivery: DeliveryEntry,
    awaitingFreshSync: boolean,
  ): Promise<void> {
    await this.dependencies.relinquishAttempt(delivery.submission);
    if (
      this.deliveries.get(delivery.submission.id) !== delivery ||
      delivery.retired ||
      this.retired
    ) {
      return;
    }
    const successor = delivery.successor;
    if (!successor) {
      throw new Error(`Submission ${delivery.submission.id} lost its prelaunch successor`);
    }
    delivery.submission = successor;
    delivery.successor = undefined;
    delivery.awaitingFreshSync = awaitingFreshSync;
    delivery.state = { kind: 'idle' };
    this.schedule(successor.id);
  }

  private async completeLaunched(
    delivery: DeliveryEntry,
    operation: LaunchedDeliveryToken,
    completion?: SubmissionDeliveryCompletion,
    error?: unknown,
  ): Promise<void> {
    if (this.deliveries.get(operation.submission.id) !== delivery) return;
    if (
      error !== undefined &&
      !operation.isRetired() &&
      !operation.isSuperseded() &&
      !(this.dependencies.isRetired() && error instanceof SessionRuntimeRetiredError)
    ) {
      try {
        await this.dependencies.recordFailure(operation.submission, error);
      } catch (recordingError) {
        if (!this.dependencies.isRetired()) this.dependencies.reportError(recordingError);
      }
    }
    if (completion?.requiresFreshSync && !operation.isRetired()) {
      this.dependencies.requireFreshSync();
    }
    const successor = delivery.successor;
    if (successor && !operation.isRetired() && !this.retired) {
      const relationship = this.dependencies.classifySuccessor(successor, operation.submission);
      const awaitingFreshSync =
        completion?.requiresFreshSync === true && relationship !== 'newer-fee-bearing';
      delivery.submission = successor;
      delivery.successor = undefined;
      delivery.awaitingFreshSync = awaitingFreshSync;
      delivery.state = { kind: 'idle' };
      this.schedule(successor.id);
    } else {
      if (!operation.isRetired()) {
        await this.dependencies.relinquishAttempt(operation.submission);
      }
      this.deliveries.delete(operation.submission.id);
    }
  }

  private queueRelinquishment(submission: TransactionSubmission): void {
    const relinquishment = this.tail.then(() => this.dependencies.relinquishAttempt(submission));
    this.tail = relinquishment.catch((error) => this.reportSettlementError(error));
  }

  private reportSettlementError(error: unknown): void {
    if (!this.dependencies.isRetired() && !(error instanceof SessionRuntimeRetiredError)) {
      this.dependencies.reportError(error);
    }
  }
}
