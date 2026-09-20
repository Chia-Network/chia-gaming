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
import type { WalletOperationOwner, WalletOperationPurpose } from './walletOperationStore';
import {
  walletOperation,
  type WalletOperationHandle,
  type WalletOperationService,
} from './walletOperationService';
import type {
  SubmissionDeliveryCompletion,
  SubmissionDeliveryToken,
} from './submissionDeliveryCoordinator';

export interface SubmissionExecutorPorts {
  getCradle(): ChiaGame | undefined;
  getBlockchain(): { rpc: InternalBlockchainInterface } | null;
  getRewardPuzzleHash(): string | null;
  getWalletOwner(): WalletOperationOwner | null;
  getInstallationPlayerId(): string;
  isRetired(): boolean;
  isPublishingDisabled(): boolean;
  mutate<T>(work: () => T): Promise<T>;
  release(key: string, launcher: () => Promise<void>): Promise<void>;
  requestCommit(): void;
  scheduleWalletCleanup(): void;
  reportWarning(message: string): void;
  reportLocalFailure(submission: TransactionSubmission, error: unknown): void;
}

export class SubmissionExecutor {
  constructor(
    private readonly getWalletOperations: () => WalletOperationService,
    private readonly ports: SubmissionExecutorPorts,
  ) {}

  async execute(delivery: SubmissionDeliveryToken): Promise<SubmissionDeliveryCompletion> {
    const { submission } = delivery;
    if (
      delivery.isRetired() ||
      delivery.isSuperseded() ||
      this.ports.isRetired() ||
      this.ports.isPublishingDisabled()
    ) {
      return this.completion('skipped', false, false);
    }

    const blockchain = this.ports.getBlockchain();
    if (!blockchain) {
      return this.completion('unavailable', false, true);
    }

    let reservation: WalletOperationHandle | undefined;
    let feeOfferCreated = false;
    let feeSourceJson: string | undefined;
    let finalizedDisposition: FinalizedSubmission['fee_source_disposition'] | undefined;
    let broadcastAttempted = false;
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
          reservation = walletOperation(
            this.getWalletOperations(),
            owner,
            this.feePurpose(submission),
          );
          const feeSource = await reservation.createFee({
            kind: 'fee',
            uniqueId: this.ports.getInstallationPlayerId(),
            fee: BigInt(submission.fee_request.amount),
            concurrentSpendCoinId: submission.fee_request.target,
          });
          if (feeSource.kind === 'created') {
            if (feeSource.warning) this.ports.reportWarning(feeSource.warning);
            feeOfferCreated = true;
            if (delivery.isRetired() || delivery.isSuperseded() || this.ports.isRetired()) {
              reservation.settle('cancel-required', 'fee-submission-retired');
              if (!this.ports.isRetired()) {
                await this.ports.mutate(() => {
                  this.ports.scheduleWalletCleanup();
                  this.ports.requestCommit();
                });
              }
              return this.completion('skipped', false, false);
            }
            feeSourceJson =
              feeSource.material.kind === 'offer'
                ? jsonStringify({ kind: 'offer', offer: feeSource.material.offer })
                : jsonStringify({ kind: 'bundle', bundle: feeSource.material.bundle });
          } else {
            feeSourceJson = jsonStringify({
              kind: 'failure',
              reason: feeSource.reason,
            });
          }
        }
      }

      const execution = await this.ports.mutate(() => {
        if (delivery.isRetired() || delivery.isSuperseded()) {
          if (feeOfferCreated && reservation) {
            reservation.settle('cancel-required', 'fee-submission-retired', true);
            this.ports.scheduleWalletCleanup();
          }
          this.ports.requestCommit();
          return { finalized: null, broadcast: Promise.resolve() };
        }
        const cradle = this.ports.getCradle();
        if (!cradle) throw new Error('WASM cradle became unavailable before finalization');
        const result = cradle.finalize_submission_attempt(submission.attempt_token, feeSourceJson);
        if ('status' in result && result.status === 'stale') {
          if (feeOfferCreated && reservation) {
            reservation.settle('cancel-required', 'fee-submission-superseded', true);
            this.ports.scheduleWalletCleanup();
          }
          this.ports.requestCommit();
          return { finalized: null, broadcast: Promise.resolve() };
        }
        const finalized = result as FinalizedSubmission;
        finalizedDisposition = finalized.fee_source_disposition;
        if (feeOfferCreated && reservation) {
          if (finalized.fee_source_disposition === 'attached') {
            reservation.settle('retained-for-replay', 'fee-source-attached', true);
          } else {
            reservation.settle('cancel-required', 'fee-source-unused-at-finalization', true);
            this.ports.scheduleWalletCleanup();
          }
        }
        this.ports.requestCommit();
        if (!finalized.should_broadcast) {
          return { finalized, broadcast: Promise.resolve() };
        }
        broadcastAttempted = true;
        const broadcast = this.ports.release(
          `broadcast:${submission.id}:${finalized.variant_fingerprint}`,
          async () => {
            if (delivery.isRetired() || delivery.isSuperseded()) return;
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
            await this.ports.mutate(() => {
              if (delivery.isRetired() || delivery.isSuperseded()) return;
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

      const finalized = execution.finalized;
      if (!finalized) return this.completion('skipped', false, false);
      if (!finalized.should_broadcast) {
        await this.ports.mutate(() => {
          if (!delivery.isRetired()) {
            this.ports.getCradle()?.acknowledge_submission_attempt(submission.attempt_token);
            this.ports.requestCommit();
          }
        });
        return this.completion('acknowledged', false, false);
      }

      await execution.broadcast;

      if (delivery.isRetired() || !outcome) {
        return this.completion('skipped', broadcastAttempted, false);
      }
      if (delivery.isSuperseded()) {
        return this.completion(
          outcome.status,
          broadcastAttempted,
          outcome.status === 'unavailable',
        );
      }
      if (outcome.status === 'rejected') {
        this.ports.reportWarning(`Wallet rejected transaction ${submission.id}: ${outcome.detail}`);
      }
      return this.completion(outcome.status, broadcastAttempted, outcome.status === 'unavailable');
    } catch (error) {
      if (delivery.isRetired() || this.ports.isRetired()) {
        return this.completion('skipped', broadcastAttempted, false);
      }
      if (feeOfferCreated && reservation && finalizedDisposition !== 'attached') {
        await this.ports.mutate(() => {
          reservation!.settle('cancel-required', 'fee-finalization-rejected', true);
          this.ports.scheduleWalletCleanup();
          this.ports.requestCommit();
        });
      }
      await this.ports.mutate(() => {
        this.ports.reportLocalFailure(submission, error);
      });
      return this.completion('local-failure', broadcastAttempted, true);
    }
  }

  private feePurpose(submission: TransactionSubmission): WalletOperationPurpose {
    return { kind: 'fee', operationId: submission.id };
  }

  private completion(
    outcome: SubmissionDeliveryCompletion['outcome'],
    broadcastAttempted: boolean,
    requiresFreshSync: boolean,
  ): SubmissionDeliveryCompletion {
    return {
      broadcastAttempted,
      outcome,
      requiresFreshSync,
    };
  }
}
