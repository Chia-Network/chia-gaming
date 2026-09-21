import type {
  ChiaGame,
  FinalizedSubmission,
  InternalBlockchainInterface,
  TransactionSubmission,
  WalletSubmitOutcome,
} from '../../types/ChiaGaming';
import { log } from '../../services/log';
import { spend_bundle_to_clvm } from '../../util';
import { jsonStringify } from '../../util/jsonSafe';
import { SessionRuntimeRetiredError } from './sessionMachineRuntime';
import type { WalletOperationOwner, WalletOperationPurpose } from './walletOperationStore';
import type { WalletOperationRuntime } from './walletOperationRuntime';

type SubmissionOutcome = 'acknowledged' | 'unavailable' | 'rejected' | 'local-failure' | 'skipped';

interface SubmissionCompletion {
  readonly outcome: SubmissionOutcome;
  readonly requiresFreshSync: boolean;
}

type PumpEntryState =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'scheduled';
      readonly release: Promise<void>;
    }
  | { readonly kind: 'launched'; readonly attemptToken: string }
  | { readonly kind: 'settling'; readonly completion: Promise<void> };

interface PumpEntry {
  submission: TransactionSubmission;
  awaitingFreshSync: boolean;
  retired: boolean;
  state: PumpEntryState;
}

export interface SubmissionPumpPorts {
  getCradle(): ChiaGame | undefined;
  getBlockchain(): { rpc: InternalBlockchainInterface } | null;
  getRewardPuzzleHash(): string | null;
  getWalletOwner(): WalletOperationOwner | null;
  getInstallationPlayerId(): string;
  isRetired(): boolean;
  isPublishingDisabled(): boolean;
  runCommittedMutation<T>(work: () => T): Promise<T>;
  schedulePersistenceGatedEffect(key: string, launcher: () => Promise<void>): Promise<void>;
  requestCommit(): void;
  scheduleWalletCleanup(): void;
  reportWarning(message: string): void;
  reportLocalFailure(submission: TransactionSubmission, error: unknown): void;
  reportError(error: unknown): void;
  requestFreshSync(): void;
}

export class SubmissionPump {
  private readonly entries = new Map<string, PumpEntry>();
  private tail: Promise<void> = Promise.resolve();
  private providerIsReady = false;
  private retired = false;

  constructor(
    private readonly getWalletOperations: () => WalletOperationRuntime,
    private readonly ports: SubmissionPumpPorts,
  ) {}

  submit(submission: TransactionSubmission): void {
    if (this.retired) return;
    const existing = this.entries.get(submission.id);
    if (!existing) {
      this.entries.set(submission.id, {
        submission,
        awaitingFreshSync: false,
        retired: false,
        state: { kind: 'idle' },
      });
      this.schedule(submission.id);
      return;
    }
    if (existing.submission.attempt_token === submission.attempt_token) return;
    if (submission.predecessor_attempt_token !== existing.submission.attempt_token) {
      throw new Error(
        `Submission ${submission.id} successor ${submission.attempt_token} does not name active predecessor ${existing.submission.attempt_token}`,
      );
    }

    const displaced = existing.submission;
    existing.submission = submission;
    if (existing.state.kind === 'launched') {
      if (existing.state.attemptToken !== displaced.attempt_token) {
        this.queueRelinquishment(displaced);
      }
      return;
    }
    if (existing.state.kind === 'settling') {
      this.queueRelinquishment(displaced);
      return;
    }
    const completion = this.tail.then(async () => {
      await this.relinquish(displaced);
      if (this.entries.get(submission.id) !== existing || existing.retired || this.retired) return;
      existing.state = { kind: 'idle' };
      this.schedule(submission.id);
    });
    existing.state = { kind: 'settling', completion };
    this.tail = completion.catch((error) => this.reportSettlementError(error));
  }

  chainReady(): void {
    for (const entry of this.entries.values()) entry.awaitingFreshSync = false;
    this.scheduleAll();
  }

  providerReady(ready: boolean): void {
    this.providerIsReady = ready;
    if (ready) this.scheduleAll();
  }

  retire(id: string): void {
    const entry = this.entries.get(id);
    if (entry) {
      entry.retired = true;
      if (entry.state.kind !== 'launched') this.entries.delete(id);
    }
    const owner = this.ports.getWalletOwner();
    if (!owner) return;
    this.getWalletOperations().retireOperation(
      owner,
      { kind: 'fee', operationId: id },
      'fee-submission-retired',
      !this.ports.isRetired(),
    );
    if (!this.ports.isRetired()) this.ports.scheduleWalletCleanup();
  }

  retireAll(): void {
    if (this.retired) return;
    this.retired = true;
    for (const entry of this.entries.values()) entry.retired = true;
    this.entries.clear();
    this.tail = Promise.resolve();
  }

  isQuiescent(): boolean {
    return this.entries.size === 0;
  }

  async flush(): Promise<void> {
    const pending = [...this.entries.values()]
      .map((entry) => {
        if (entry.state.kind === 'scheduled') return entry.state.release;
        if (entry.state.kind === 'settling') return entry.state.completion;
        return null;
      })
      .filter((promise): promise is Promise<void> => promise !== null);
    await Promise.allSettled(pending);
    await this.tail;
  }

  private scheduleAll(): void {
    for (const id of this.entries.keys()) this.schedule(id);
  }

  private canLaunch(entry: PumpEntry): boolean {
    return (
      this.providerIsReady &&
      Boolean(this.ports.getBlockchain()) &&
      !entry.awaitingFreshSync &&
      !entry.retired
    );
  }

  private schedule(id: string): void {
    const entry = this.entries.get(id);
    if (
      !entry ||
      !this.canLaunch(entry) ||
      entry.state.kind === 'launched' ||
      entry.state.kind === 'settling' ||
      entry.state.kind === 'scheduled'
    ) {
      return;
    }

    const release = this.ports.schedulePersistenceGatedEffect(`submission:${id}`, () => {
      const current = this.entries.get(id);
      if (current !== entry || current.state.kind !== 'scheduled') {
        return Promise.resolve();
      }
      const launched = entry.submission;
      entry.state = { kind: 'launched', attemptToken: launched.attempt_token };
      const run = this.tail.then(() => this.execute(launched));
      const completed = run.then(
        (completion) => this.complete(entry, launched, completion),
        (error) => this.complete(entry, launched, undefined, error),
      );
      this.tail = completed.catch(() => {});
      return Promise.resolve();
    });
    entry.state = { kind: 'scheduled', release };
    void release.catch((error) => this.handleReleaseFailure(entry, error));
  }

  private handleReleaseFailure(entry: PumpEntry, error: unknown): void {
    const current = this.entries.get(entry.submission.id);
    if (current !== entry || entry.state.kind !== 'scheduled') return;
    if (error instanceof SessionRuntimeRetiredError && this.ports.isRetired()) return;
    const failed = entry.submission;
    const completion = this.ports
      .runCommittedMutation(() => this.ports.reportLocalFailure(failed, error))
      .finally(async () => {
        if (this.entries.get(failed.id) !== entry) return;
        if (!entry.retired) await this.relinquish(failed);
        this.finishAttempt(entry, failed, false);
      });
    entry.state = { kind: 'settling', completion };
    this.tail = completion.catch((recordingError) => this.reportSettlementError(recordingError));
  }

  private async complete(
    entry: PumpEntry,
    launched: TransactionSubmission,
    completion?: SubmissionCompletion,
    error?: unknown,
  ): Promise<void> {
    if (this.entries.get(launched.id) !== entry) return;
    if (
      error !== undefined &&
      !entry.retired &&
      entry.submission.attempt_token === launched.attempt_token &&
      !(this.ports.isRetired() && error instanceof SessionRuntimeRetiredError)
    ) {
      try {
        await this.ports.runCommittedMutation(() => this.ports.reportLocalFailure(launched, error));
      } catch (recordingError) {
        if (!this.ports.isRetired()) this.ports.reportError(recordingError);
      }
    }
    if (completion?.requiresFreshSync && !entry.retired) this.ports.requestFreshSync();

    if (entry.submission.attempt_token !== launched.attempt_token) {
      this.finishAttempt(entry, launched, completion?.requiresFreshSync === true);
      return;
    }
    if (!entry.retired) await this.relinquish(launched);
    this.finishAttempt(entry, launched, completion?.requiresFreshSync === true);
  }

  private finishAttempt(
    entry: PumpEntry,
    completed: TransactionSubmission,
    requiresFreshSync: boolean,
  ): void {
    if (this.entries.get(completed.id) !== entry) return;
    if (
      entry.submission.attempt_token !== completed.attempt_token &&
      !entry.retired &&
      !this.retired
    ) {
      entry.awaitingFreshSync =
        requiresFreshSync && entry.submission.relationship !== 'newer-fee-bearing';
      entry.state = { kind: 'idle' };
      this.schedule(completed.id);
      return;
    }
    this.entries.delete(completed.id);
  }

  private async execute(submission: TransactionSubmission): Promise<SubmissionCompletion> {
    if (this.isInactive(submission)) return this.completion('skipped', false);
    const blockchain = this.ports.getBlockchain();
    if (!blockchain || blockchain.rpc.isReadyForPlay?.() === false) {
      return this.completion('unavailable', true);
    }

    let feeOwner: WalletOperationOwner | undefined;
    let feePurpose: WalletOperationPurpose | undefined;
    let feeOfferCreated = false;
    let feeSourceJson: string | undefined;
    let finalizedDisposition: FinalizedSubmission['fee_source_disposition'] | undefined;
    let outcome: WalletSubmitOutcome | undefined;
    try {
      if (!this.ports.getRewardPuzzleHash()) {
        throw new Error('Submission execution requires a reward puzzle hash');
      }
      if (submission.fee_request) {
        const owner = this.ports.getWalletOwner();
        if (!owner) {
          feeSourceJson = jsonStringify({
            kind: 'failure',
            reason: 'wallet fee provider is unavailable',
          });
        } else {
          feeOwner = owner;
          feePurpose = this.feePurpose(submission);
          const request = {
            kind: 'fee',
            uniqueId: this.ports.getInstallationPlayerId(),
            fee: BigInt(submission.fee_request.amount),
            concurrentSpendCoinId: submission.fee_request.target,
          } as const;
          if (!/^[0-9a-f]{64}$/.test(request.concurrentSpendCoinId)) {
            throw new Error('Fee target coin id must be lowercase 64-hex');
          }
          const feeSource = await this.getWalletOperations().createOffer(
            owner,
            feePurpose,
            request,
            request,
            () => this.isInactive(submission),
          );
          if (feeSource.kind === 'created-reserved') {
            if (feeSource.warning) this.ports.reportWarning(feeSource.warning);
            feeOfferCreated = true;
            if (this.isInactive(submission)) {
              this.getWalletOperations().settleOperation(
                feeOwner,
                feePurpose,
                'cancel-required',
                'fee-submission-retired',
              );
              if (!this.ports.isRetired()) {
                await this.ports.runCommittedMutation(() => {
                  this.ports.scheduleWalletCleanup();
                  this.ports.requestCommit();
                });
              }
              return this.completion('skipped', false);
            }
            feeSourceJson =
              feeSource.material.kind === 'offer'
                ? jsonStringify({ kind: 'offer', offer: feeSource.material.offer })
                : jsonStringify({ kind: 'bundle', bundle: feeSource.material.bundle });
          } else if (feeSource.kind === 'failure' || feeSource.kind === 'unavailable') {
            feeSourceJson = jsonStringify({ kind: 'failure', reason: feeSource.reason });
          } else {
            throw new Error('Reserving fee provider returned ephemeral wallet material');
          }
        }
      }

      const execution = await this.ports.runCommittedMutation(() => {
        if (this.isInactive(submission)) {
          if (feeOfferCreated && feeOwner && feePurpose) {
            this.getWalletOperations().settleOperation(
              feeOwner,
              feePurpose,
              'cancel-required',
              'fee-submission-retired',
              true,
            );
            this.ports.scheduleWalletCleanup();
          }
          this.ports.requestCommit();
          return { finalized: null, broadcast: Promise.resolve() };
        }
        const cradle = this.ports.getCradle();
        if (!cradle) throw new Error('WASM cradle became unavailable before finalization');
        const result = cradle.finalize_submission_attempt(submission.attempt_token, feeSourceJson);
        if ('status' in result && result.status === 'stale') {
          if (feeOfferCreated && feeOwner && feePurpose) {
            this.getWalletOperations().settleOperation(
              feeOwner,
              feePurpose,
              'cancel-required',
              'fee-submission-superseded',
              true,
            );
            this.ports.scheduleWalletCleanup();
          }
          this.ports.requestCommit();
          return { finalized: null, broadcast: Promise.resolve() };
        }
        const finalized = result as FinalizedSubmission;
        finalizedDisposition = finalized.fee_source_disposition;
        if (feeOfferCreated && feeOwner && feePurpose) {
          if (finalized.fee_source_disposition === 'attached') {
            this.getWalletOperations().settleOperation(
              feeOwner,
              feePurpose,
              'retained-for-replay',
              'fee-source-attached',
              true,
            );
          } else {
            this.getWalletOperations().settleOperation(
              feeOwner,
              feePurpose,
              'cancel-required',
              'fee-source-unused-at-finalization',
              true,
            );
            this.ports.scheduleWalletCleanup();
          }
        }
        this.ports.requestCommit();
        if (!finalized.should_broadcast) {
          return { finalized, broadcast: Promise.resolve() };
        }
        const broadcast = this.ports.schedulePersistenceGatedEffect(
          `broadcast:${submission.id}:${finalized.variant_fingerprint}`,
          async () => {
            if (this.isInactive(submission)) return;
            const activeBlockchain = this.ports.getBlockchain();
            const rewardPuzzleHash = this.ports.getRewardPuzzleHash();
            if (!activeBlockchain || !rewardPuzzleHash) {
              throw new Error('Blockchain became unavailable before finalized broadcast');
            }
            const blob = spend_bundle_to_clvm(finalized.protocol_bundle);
            const appliedFee = BigInt(finalized.applied_fee);
            log(`[wasm] submitTransaction blobLen=${blob.length}`);
            if (finalized.warning) this.ports.reportWarning(finalized.warning);
            outcome = await activeBlockchain.rpc.spend(
              blob,
              finalized.bundle,
              rewardPuzzleHash,
              'submitTransaction',
              appliedFee || undefined,
            );
            await this.ports.runCommittedMutation(() => {
              if (this.isInactive(submission)) return;
              const activeCradle = this.ports.getCradle();
              if (!activeCradle) {
                throw new Error('WASM cradle became unavailable before recording wallet outcome');
              }
              if (outcome!.status === 'acknowledged') {
                activeCradle.acknowledge_submission_attempt(submission.attempt_token);
              } else if (outcome!.status === 'unavailable') {
                activeCradle.submission_attempt_unavailable(submission.attempt_token);
              } else {
                activeCradle.reject_submission_attempt(submission.attempt_token);
              }
              this.ports.requestCommit();
            });
          },
        );
        return { finalized, broadcast };
      });

      if (!execution.finalized) return this.completion('skipped', false);
      if (!execution.finalized.should_broadcast) {
        await this.ports.runCommittedMutation(() => {
          if (!this.isInactive(submission)) {
            this.ports.getCradle()?.acknowledge_submission_attempt(submission.attempt_token);
            this.ports.requestCommit();
          }
        });
        return this.completion('acknowledged', false);
      }
      await execution.broadcast;
      if (!outcome) return this.completion('skipped', false);
      if (!this.isInactive(submission) && outcome.status === 'rejected') {
        this.ports.reportWarning(`Wallet rejected transaction ${submission.id}: ${outcome.detail}`);
      }
      return this.completion(outcome.status, outcome.status === 'unavailable');
    } catch (error) {
      if (this.isInactive(submission)) return this.completion('skipped', false);
      if (feeOfferCreated && feeOwner && feePurpose && finalizedDisposition !== 'attached') {
        await this.ports.runCommittedMutation(() => {
          this.getWalletOperations().settleOperation(
            feeOwner!,
            feePurpose!,
            'cancel-required',
            'fee-finalization-rejected',
            true,
          );
          this.ports.scheduleWalletCleanup();
          this.ports.requestCommit();
        });
      }
      await this.ports.runCommittedMutation(() => this.ports.reportLocalFailure(submission, error));
      return this.completion('local-failure', true);
    }
  }

  private isInactive(submission: TransactionSubmission): boolean {
    const entry = this.entries.get(submission.id);
    return (
      !entry ||
      entry.retired ||
      entry.submission.attempt_token !== submission.attempt_token ||
      this.retired ||
      this.ports.isRetired() ||
      this.ports.isPublishingDisabled()
    );
  }

  private async relinquish(submission: TransactionSubmission): Promise<void> {
    await this.ports.runCommittedMutation(() => {
      const cradle = this.ports.getCradle();
      if (!cradle) {
        if (this.ports.isRetired()) return;
        throw new Error('WASM cradle became unavailable before attempt relinquishment');
      }
      cradle.relinquish_submission_attempt(submission.attempt_token);
      this.ports.requestCommit();
    });
    await this.ports.schedulePersistenceGatedEffect(
      `submission-relinquishment:${submission.id}:${submission.attempt_token}`,
      async () => {},
    );
  }

  private queueRelinquishment(submission: TransactionSubmission): void {
    const completion = this.tail.then(() => this.relinquish(submission));
    this.tail = completion.catch((error) => this.reportSettlementError(error));
  }

  private reportSettlementError(error: unknown): void {
    if (!this.ports.isRetired() && !(error instanceof SessionRuntimeRetiredError)) {
      this.ports.reportError(error);
    }
  }

  private feePurpose(submission: TransactionSubmission): WalletOperationPurpose {
    return { kind: 'fee', operationId: submission.id };
  }

  private completion(outcome: SubmissionOutcome, requiresFreshSync: boolean): SubmissionCompletion {
    return { outcome, requiresFreshSync };
  }
}
