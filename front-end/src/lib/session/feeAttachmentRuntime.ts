import type {
  WalletOfferBeginOutcome,
  WalletOfferCompletion,
  WalletOfferProvider,
} from '../../types/ChiaGaming';
import { log } from '../../services/log';
import { StorageAuthorityLostError } from './indexedDb';
import {
  feeAttachmentEntryKey,
  feeAttachmentForSubmission,
  identifiedFeeAttachment,
  type FeeAttachment,
  type FeeAttachmentOwner,
  type FeeAttachmentRequest,
  type FeeAttachmentUncertain,
} from './feeAttachmentStore';
import { canLosePreIdResponse, isRecoverableProvider } from './providerCapabilities';
import {
  advanceProviderCancellation,
  advanceProviderCreation,
  checkpointProviderState,
  coalesceProviderFlight,
  type ProviderFlight,
} from './providerExecution';
import { providerOwnerKey, providerScopeKey } from './providerKeys';
import { storageRepository } from './storageRepository';
import {
  walletProviderRegistry,
  type WalletProviderRegistry,
  type WalletProviderRegistryEvent,
} from './walletProviderRegistry';

export interface FeeAttachmentRuntimePorts {
  isRetired(): boolean;
  getOwner(): FeeAttachmentOwner | null;
  requestCommit(): void;
  reportWarning(message: string): void;
}

const processKnownUncertainty = new WeakMap<WalletProviderRegistry, Set<string>>();

export class FeeAttachmentRuntime {
  private readonly flights = new Map<string, ProviderFlight>();
  private readonly completed = new Map<
    string,
    Extract<WalletOfferCompletion, { kind: 'created-reserved' }>
  >();
  private readonly restoredUncertain = new Set<string>();
  private readonly knownUncertain: Set<string>;
  private readonly unsubscribe: (() => void)[];
  private detached = false;
  private authorityRetired = false;
  private hardResetEpoch = 0;

  constructor(
    private readonly ports: FeeAttachmentRuntimePorts,
    private readonly providers: WalletProviderRegistry = walletProviderRegistry,
  ) {
    this.knownUncertain = processKnownUncertainty.get(providers) ?? new Set<string>();
    processKnownUncertainty.set(providers, this.knownUncertain);
    this.unsubscribe = [
      providers.subscribe((event) => this.providerEvent(event)),
      storageRepository.onLifecycle((_generation, event) => {
        if (event === 'claim') {
          if (this.authorityRetired) return;
          this.markRestoredUncertain();
          this.resume();
        } else {
          this.authorityRetired = true;
          this.detached = true;
          this.completed.clear();
          this.restoredUncertain.clear();
          this.knownUncertain.clear();
          if (event === 'hard-reset') {
            this.hardResetEpoch += 1;
          }
          this.maybeDispose();
        }
      }),
    ];
    this.markRestoredUncertain();
    this.resume();
  }

  private entries(): FeeAttachment[] {
    const owner = this.ports.getOwner();
    const key = owner ? providerOwnerKey(owner) : null;
    return key
      ? storageRepository.feeAttachments().filter((entry) => providerOwnerKey(entry.owner) === key)
      : [];
  }

  detach(): void {
    this.detached = true;
    this.maybeDispose();
  }

  async reserve(
    owner: FeeAttachmentOwner,
    submissionId: string,
    request: FeeAttachmentRequest,
    isInactive: () => boolean,
  ): Promise<WalletOfferCompletion> {
    if (this.authorityRetired) {
      return { kind: 'unavailable', reason: 'Fee runtime lost storage authority' };
    }
    const consumerDead = () => this.authorityRetired || this.ports.isRetired() || isInactive();
    const completed = this.completed.get(submissionId);
    if (completed) {
      this.completed.delete(submissionId);
      if (consumerDead()) {
        return { kind: 'unavailable', reason: 'Fee consumer retired during wallet creation' };
      }
      return completed;
    }
    storageRepository.ensureWalletContext(owner.providerScope);
    const provider = this.providers.provider(owner.providerScope);
    if (!provider) {
      return { kind: 'unavailable', reason: 'Reconnect the original wallet account to attach fee' };
    }
    const current = feeAttachmentForSubmission(this.entries(), owner, submissionId);
    if (current?.stage === 'best-effort-uncertain') {
      await this.flights.get(`replace:${submissionId}`)?.promise;
      const replacement = this.completed.get(submissionId);
      if (replacement) {
        this.completed.delete(submissionId);
        if (consumerDead()) {
          return { kind: 'unavailable', reason: 'Fee consumer retired during wallet creation' };
        }
        return replacement;
      }
      return { kind: 'unavailable', reason: 'Fee replacement waits for wallet readiness' };
    }
    if (current && current.stage !== 'creating') {
      throw new Error('Fee attachment already owns a provider reservation');
    }
    return this.flight(`create:${submissionId}`, () =>
      this.create(provider, owner, submissionId, request, isInactive, false),
    );
  }

  retain(owner: FeeAttachmentOwner, submissionId: string): void {
    if (this.authorityRetired) return;
    const current = feeAttachmentForSubmission(this.entries(), owner, submissionId);
    if (!current || (current.stage !== 'reserved' && current.stage !== 'retained-for-replay')) {
      throw new Error('Fee replay retention requires a reserved attachment');
    }
    this.replace(current, { ...current, stage: 'retained-for-replay' });
  }

  cancel(owner: FeeAttachmentOwner, submissionId: string, _reason: string): void {
    if (this.authorityRetired) return;
    const current = feeAttachmentForSubmission(this.entries(), owner, submissionId);
    if (!current) return;
    if (current.stage === 'creating' || current.stage === 'best-effort-uncertain') {
      this.replace(current, { ...current, disposition: 'cancel-on-create' });
      return;
    }
    const next =
      current.stage === 'reserved' || current.stage === 'retained-for-replay'
        ? ({ ...current, stage: 'cancel-required' } as const)
        : current;
    if (next !== current) this.replace(current, next);
    void this.scheduleCancellation(current.providerReservationId);
  }

  retire(owner: FeeAttachmentOwner, submissionId: string): void {
    this.cancel(owner, submissionId, 'fee-submission-retired');
  }

  async awaitIdle(): Promise<void> {
    while (this.flights.size) {
      await Promise.allSettled([...this.flights.values()].map((flight) => flight.promise));
    }
  }

  private async create(
    provider: WalletOfferProvider,
    owner: FeeAttachmentOwner,
    submissionId: string,
    request: FeeAttachmentRequest,
    isInactive: () => boolean,
    replacement: boolean,
  ): Promise<WalletOfferCompletion> {
    const generation = storageRepository.lifecycleGeneration;
    const hardResetEpoch = this.hardResetEpoch;
    const consumerDead = () => this.authorityRetired || this.ports.isRetired() || isInactive();
    const current = feeAttachmentForSubmission(this.entries(), owner, submissionId);
    const recoveryId =
      !replacement && current?.stage === 'creating' ? current.recoveryId : undefined;
    const operation = { owner, purpose: { kind: 'fee' as const, operationId: submissionId } };
    let outcome: WalletOfferBeginOutcome;
    try {
      outcome = await advanceProviderCreation(generation, provider, operation, request, recoveryId);
    } catch (error) {
      if (error instanceof StorageAuthorityLostError) {
        return { kind: 'unavailable', reason: 'Storage authority changed before fee creation' };
      }
      if (recoveryId || !canLosePreIdResponse(provider)) throw error;
      if (consumerDead()) {
        log(
          `[fee-attachment] dead fee consumer lost its pre-id response; reservation may remain orphaned submission_id=${submissionId}`,
        );
      } else {
        this.creationUncertain(owner, submissionId, request, consumerDead, generation);
      }
      return { kind: 'unavailable', reason: String(error) };
    }
    if (
      outcome.kind === 'unavailable' &&
      !recoveryId &&
      !replacement &&
      canLosePreIdResponse(provider)
    ) {
      if (consumerDead()) {
        log(
          `[fee-attachment] dead fee consumer returned unavailable before reservation identification; reservation may remain orphaned submission_id=${submissionId}`,
        );
      } else {
        this.creationUncertain(owner, submissionId, request, consumerDead, generation);
      }
      return outcome;
    }
    if (outcome.kind === 'pending') {
      const pendingRecoveryId = outcome.recoveryId;
      const pending = () => {
        if (consumerDead()) return;
        const latest = feeAttachmentForSubmission(this.entries(), owner, submissionId);
        this.replace(latest, {
          owner,
          submissionId,
          stage: 'creating',
          disposition:
            (latest?.stage === 'creating' || latest?.stage === 'best-effort-uncertain') &&
            latest.disposition === 'cancel-on-create'
              ? 'cancel-on-create'
              : 'active',
          request,
          recoveryId: pendingRecoveryId,
          reason: 'fee-creation-pending',
          ...(latest?.orphanRisk ? { orphanRisk: latest.orphanRisk } : {}),
        });
      };
      if (!storageRepository.isGenerationCurrent(generation)) {
        log(
          `[fee-attachment] stale creation returned only recovery_id=${pendingRecoveryId}; reservation may remain orphaned submission_id=${submissionId}`,
        );
        return { kind: 'unavailable', reason: 'Storage authority changed during fee creation' };
      }
      const pendingConsumerDead = consumerDead();
      if (!pendingConsumerDead) pending();
      outcome = await advanceProviderCreation(
        generation,
        provider,
        operation,
        request,
        pendingRecoveryId,
      );
      if (outcome.kind === 'pending') throw new Error('Fee reconciliation remained pending');
      if (consumerDead()) {
        const latest = feeAttachmentForSubmission(this.entries(), owner, submissionId);
        if (storageRepository.isGenerationCurrent(generation) && latest) {
          this.replace(latest, null);
        }
        if (outcome.kind === 'created-reserved') {
          this.cancelLateReservation(provider, outcome.tradeId, submissionId);
        } else if (outcome.kind === 'unavailable') {
          log(
            `[fee-attachment] dead consumer creation reconciliation unavailable; reservation may remain orphaned submission_id=${submissionId} recovery_id=${pendingRecoveryId}`,
          );
        }
        return { kind: 'unavailable', reason: 'Fee consumer retired during wallet creation' };
      }
    }
    const generationCurrent = storageRepository.isGenerationCurrent(generation);
    const dead = consumerDead();
    if (!generationCurrent || dead) {
      if (generationCurrent && dead) {
        const latest = feeAttachmentForSubmission(this.entries(), owner, submissionId);
        if (latest) this.replace(latest, null);
      }
      if (
        outcome.kind === 'created-reserved' &&
        (generationCurrent || hardResetEpoch === this.hardResetEpoch)
      ) {
        this.cancelLateReservation(provider, outcome.tradeId, submissionId);
      }
      return {
        kind: 'unavailable',
        reason: generationCurrent
          ? 'Fee consumer retired during wallet creation'
          : 'Storage authority changed during fee creation',
      };
    }
    if (outcome.kind === 'failure') {
      const latest = feeAttachmentForSubmission(this.entries(), owner, submissionId);
      if (latest) this.replace(latest, null);
      return outcome;
    }
    if (outcome.kind === 'unavailable') return outcome;
    if (outcome.kind === 'created-ephemeral')
      throw new Error('Fee provider returned unreserved material');
    const latest = feeAttachmentForSubmission(this.entries(), owner, submissionId);
    const cancel =
      (latest?.stage === 'creating' || latest?.stage === 'best-effort-uncertain') &&
      latest.disposition === 'cancel-on-create';
    this.replace(latest, {
      owner,
      submissionId,
      stage: cancel ? 'cancel-required' : 'reserved',
      providerReservationId: outcome.tradeId,
      reason: 'fee-offer-created',
      ...(latest?.orphanRisk ? { orphanRisk: latest.orphanRisk } : {}),
    });
    if (cancel) void this.scheduleCancellation(outcome.tradeId);
    await checkpointProviderState(generation);
    if (consumerDead()) {
      const installed = feeAttachmentForSubmission(this.entries(), owner, submissionId);
      const cancellationStarted =
        installed?.stage === 'cancel-required' ||
        installed?.stage === 'cancelling' ||
        installed?.stage === 'best-effort-cancellation-uncertain';
      if (!cancellationStarted) {
        if (installed) this.replace(installed, null);
        this.cancelLateReservation(provider, outcome.tradeId, submissionId);
      }
      return { kind: 'unavailable', reason: 'Fee consumer retired during wallet creation' };
    }
    if (latest?.orphanRisk) {
      const warning =
        'Wallet lost an earlier fee create response; a reservation may remain orphaned.';
      this.ports.reportWarning(warning);
      return { ...outcome, warning };
    }
    return outcome;
  }

  private creationUncertain(
    owner: FeeAttachmentOwner,
    submissionId: string,
    request: FeeAttachmentRequest,
    consumerDead: () => boolean,
    generation: number,
  ): void {
    const apply = () => {
      if (consumerDead()) return;
      if (feeAttachmentForSubmission(this.entries(), owner, submissionId)) return;
      const uncertain: FeeAttachmentUncertain = {
        owner,
        submissionId,
        stage: 'best-effort-uncertain',
        disposition: 'active',
        request,
        lastAttemptEpoch: BigInt(this.providers.readinessEpoch(owner.providerScope)),
        reason: 'fee-create-response-unavailable',
        orphanRisk: 'pre-id-response-lost',
      };
      this.knownUncertain.add(feeAttachmentEntryKey(uncertain));
      this.replace(null, uncertain);
    };
    if (storageRepository.isGenerationCurrent(generation)) apply();
  }

  private resume(): void {
    if (this.authorityRetired) return;
    for (const entry of this.entries()) {
      if (entry.stage === 'creating') this.recover(entry);
      else if (entry.stage === 'best-effort-uncertain') this.replaceUncertain(entry);
      else if (
        entry.stage === 'cancel-required' ||
        entry.stage === 'cancelling' ||
        entry.stage === 'best-effort-cancellation-uncertain'
      ) {
        void this.scheduleCancellation(entry.providerReservationId);
      }
    }
  }

  private recover(entry: Extract<FeeAttachment, { stage: 'creating' }>): void {
    if (this.authorityRetired) return;
    const provider = this.providers.provider(entry.owner.providerScope);
    if (!provider || !isRecoverableProvider(provider)) return;
    void this.flight(`recover:${entry.submissionId}`, async () => {
      const consumerDead = () =>
        this.authorityRetired ||
        this.ports.isRetired() ||
        this.recoveredConsumerDead(entry.owner, entry.submissionId);
      const outcome = await this.create(
        provider,
        entry.owner,
        entry.submissionId,
        entry.request,
        consumerDead,
        false,
      );
      if (outcome.kind === 'created-reserved' && !consumerDead()) {
        this.completed.set(entry.submissionId, outcome);
      }
    });
  }

  private replaceUncertain(entry: FeeAttachmentUncertain): void {
    if (this.authorityRetired) return;
    const provider = this.providers.provider(entry.owner.providerScope);
    const epoch = BigInt(this.providers.readinessEpoch(entry.owner.providerScope));
    const key = feeAttachmentEntryKey(entry);
    const restored = this.restoredUncertain.has(key);
    if (!provider || !canLosePreIdResponse(provider) || epoch === 0n) return;
    if (!restored && epoch <= entry.lastAttemptEpoch) return;
    this.restoredUncertain.delete(key);
    this.replace(entry, { ...entry, lastAttemptEpoch: epoch });
    void this.flight(`replace:${entry.submissionId}`, async () => {
      const consumerDead = () =>
        this.authorityRetired ||
        this.ports.isRetired() ||
        this.recoveredConsumerDead(entry.owner, entry.submissionId);
      const outcome = await this.create(
        provider,
        entry.owner,
        entry.submissionId,
        entry.request,
        consumerDead,
        true,
      );
      if (outcome.kind === 'created-reserved' && !consumerDead()) {
        this.completed.set(entry.submissionId, outcome);
      }
    });
  }

  private scheduleCancellation(id: string): Promise<void> {
    if (this.authorityRetired) return Promise.resolve();
    const entry = identifiedFeeAttachment(this.entries(), id);
    const provider = entry && this.providers.provider(entry.owner.providerScope);
    if (
      !entry ||
      !provider ||
      !['cancel-required', 'cancelling', 'best-effort-cancellation-uncertain'].includes(entry.stage)
    ) {
      return Promise.resolve();
    }
    if (entry.stage === 'best-effort-cancellation-uncertain') {
      const epoch = BigInt(this.providers.readinessEpoch(entry.owner.providerScope));
      const key = feeAttachmentEntryKey(entry);
      const restored = this.restoredUncertain.has(key);
      if (!epoch || (!restored && epoch <= entry.lastAttemptEpoch)) return Promise.resolve();
      this.restoredUncertain.delete(key);
      this.replace(entry, { ...entry, lastAttemptEpoch: epoch });
    }
    return this.flight(`cancel:${id}`, async () => {
      const generation = storageRepository.lifecycleGeneration;
      let outcome;
      try {
        outcome = await advanceProviderCancellation(
          generation,
          provider,
          id,
          entry.stage === 'cancelling' ? entry.recoveryId : undefined,
        );
        if (outcome.status === 'pending') {
          const current = identifiedFeeAttachment(this.entries(), id);
          if (!current) return;
          this.replace(current, {
            ...current,
            stage: 'cancelling',
            recoveryId: outcome.recoveryId,
          });
          outcome = await advanceProviderCancellation(generation, provider, id, outcome.recoveryId);
        } else if (
          outcome.status === 'unavailable' &&
          provider.capability === 'recoverable-after-begin' &&
          entry.stage !== 'cancelling'
        ) {
          const uncertain = {
            ...entry,
            stage: 'best-effort-cancellation-uncertain',
            lastAttemptEpoch: BigInt(this.providers.readinessEpoch(entry.owner.providerScope)),
            reason: 'fee-cancellation-response-unavailable',
          } as const;
          this.knownUncertain.add(feeAttachmentEntryKey(uncertain));
          this.replace(entry, uncertain);
          return;
        }
      } catch (error) {
        if (!(error instanceof StorageAuthorityLostError))
          log(`[fee-attachment] cancel failed: ${String(error)}`);
        return;
      }
      if (
        storageRepository.isGenerationCurrent(generation) &&
        (outcome.status === 'cancelled' ||
          outcome.status === 'already-terminal' ||
          outcome.status === 'rejected')
      ) {
        if (outcome.status === 'rejected') {
          this.ports.reportWarning(`Wallet rejected fee cancellation ${id}: ${outcome.detail}`);
        }
        const current = identifiedFeeAttachment(this.entries(), id);
        if (current) this.replace(current, null);
      }
    });
  }

  private providerEvent(event: WalletProviderRegistryEvent): void {
    if (this.authorityRetired || event.kind === 'detached') return;
    const scope = providerScopeKey(event.provider.scope);
    for (const entry of this.entries()) {
      if (providerScopeKey(entry.owner.providerScope) !== scope) continue;
      if (entry.stage === 'creating') this.recover(entry);
      else if (entry.stage === 'best-effort-uncertain') this.replaceUncertain(entry);
      else if (
        entry.stage === 'cancel-required' ||
        entry.stage === 'cancelling' ||
        entry.stage === 'best-effort-cancellation-uncertain'
      ) {
        void this.scheduleCancellation(entry.providerReservationId);
      }
    }
  }

  private replace(current: FeeAttachment | null, next: FeeAttachment | null): void {
    if (this.authorityRetired || !storageRepository.hasAuthority()) return;
    const currentKey = current ? feeAttachmentEntryKey(current) : null;
    const nextKey = next ? feeAttachmentEntryKey(next) : null;
    if (
      currentKey &&
      (current?.stage === 'best-effort-uncertain' ||
        current?.stage === 'best-effort-cancellation-uncertain') &&
      next?.stage !== 'best-effort-uncertain' &&
      next?.stage !== 'best-effort-cancellation-uncertain'
    ) {
      this.knownUncertain.delete(currentKey);
    }
    const entries = storageRepository.feeAttachments().filter((entry) => {
      const key = feeAttachmentEntryKey(entry);
      return key !== currentKey && key !== nextKey;
    });
    if (next) entries.push(structuredClone(next));
    storageRepository.replaceFeeAttachments(entries);
    this.ports.requestCommit();
  }

  private flight<T>(key: string, launch: () => Promise<T>): Promise<T> {
    const promise = coalesceProviderFlight(this.flights, key, launch);
    void promise.then(
      () => this.maybeDispose(),
      () => this.maybeDispose(),
    );
    return promise;
  }

  private cancelLateReservation(
    provider: WalletOfferProvider,
    id: string,
    submissionId: string,
  ): void {
    void Promise.resolve()
      .then(() =>
        provider.capability === 'best-effort' || provider.capability === 'terminal'
          ? provider.cancel(id)
          : provider.beginCancellation(id),
      )
      .then(
        (outcome) => {
          if (outcome.status !== 'cancelled' && outcome.status !== 'already-terminal') {
            log(
              `[fee-attachment] stale reservation may remain orphaned submission_id=${submissionId} provider_reservation_id=${id}`,
            );
          }
        },
        (error) =>
          log(
            `[fee-attachment] stale reservation cancellation failed submission_id=${submissionId} provider_reservation_id=${id}: ${String(error)}`,
          ),
      );
  }

  private recoveredConsumerDead(owner: FeeAttachmentOwner, submissionId: string): boolean {
    const current = feeAttachmentForSubmission(this.entries(), owner, submissionId);
    return (
      !current ||
      current.stage === 'cancel-required' ||
      current.stage === 'cancelling' ||
      current.stage === 'best-effort-cancellation-uncertain' ||
      ((current.stage === 'creating' || current.stage === 'best-effort-uncertain') &&
        current.disposition === 'cancel-on-create')
    );
  }

  private markRestoredUncertain(): void {
    for (const entry of this.entries()) {
      if (
        entry.stage === 'best-effort-uncertain' ||
        entry.stage === 'best-effort-cancellation-uncertain'
      ) {
        const key = feeAttachmentEntryKey(entry);
        if (!this.knownUncertain.has(key)) {
          this.knownUncertain.add(key);
          this.restoredUncertain.add(key);
        }
      }
    }
  }

  private maybeDispose(): void {
    if (!this.detached || this.flights.size) return;
    this.unsubscribe.splice(0).forEach((unsubscribe) => unsubscribe());
    this.completed.clear();
    this.restoredUncertain.clear();
  }
}
