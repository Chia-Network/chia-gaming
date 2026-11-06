import type {
  WalletOfferBeginOutcome,
  WalletOfferCompletion,
  WalletOfferProvider,
} from '../../types/ChiaGaming';
import { log } from '../../services/log';
import { StorageAuthorityLostError, StorageAuthorityRequiredError } from './indexedDb';
import {
  feeAttachmentEntryKey,
  feeAttachmentForSubmission,
  identifiedFeeAttachment,
  isFeeAttachmentCancellation,
  isRetiringFeeAttachment,
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
import { providerScopeKey } from './providerKeys';
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
  private readonly restoredUncertain = new Set<string>();
  private readonly knownUncertain: Set<string>;
  private readonly unsubscribe: (() => void)[];
  private readonly approvalListeners = new Set<() => void>();
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
          this.restoredUncertain.clear();
          this.knownUncertain.clear();
          if (event === 'hard-reset') {
            this.hardResetEpoch += 1;
          }
          this.notifySubmissionChange();
          this.maybeDispose();
        }
      }),
    ];
    this.markRestoredUncertain();
    this.resume();
  }

  private entries(): FeeAttachment[] {
    const owner = this.ports.getOwner();
    return owner
      ? storageRepository
          .feeAttachments()
          .filter(
            (entry) =>
              entry.owner.installationPlayerId === owner.installationPlayerId &&
              entry.owner.peerSessionId === owner.peerSessionId,
          )
      : [];
  }

  detach(): void {
    this.detached = true;
    this.notifySubmissionChange();
    this.maybeDispose();
  }

  notifySubmissionChange(): void {
    for (const listener of this.approvalListeners) listener();
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
    if (this.detached) return { kind: 'unavailable', reason: 'Fee runtime retired' };
    const consumerDead = () =>
      this.detached || this.authorityRetired || this.ports.isRetired() || isInactive();
    storageRepository.ensureWalletContext(owner.providerScope);
    const provider = this.providers.provider(owner.providerScope);
    if (!provider) {
      return { kind: 'unavailable', reason: 'Reconnect the original wallet account to attach fee' };
    }
    const current = feeAttachmentForSubmission(this.entries(), owner, submissionId);
    if (current?.stage === 'best-effort-uncertain') {
      if (current.disposition === 'cancel-on-create') {
        return { kind: 'unavailable', reason: 'An earlier fee offer is still being retired' };
      }
      return (
        (await this.replaceUncertain(current, consumerDead)) ?? {
          kind: 'unavailable',
          reason: 'Fee replacement waits for wallet readiness',
        }
      );
    }
    if (current && isRetiringFeeAttachment(current)) {
      return { kind: 'unavailable', reason: 'An earlier fee offer is still being retired' };
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
    this.notifySubmissionChange();
    const current = feeAttachmentForSubmission(this.entries(), owner, submissionId);
    if (!current) return;
    if (current.stage === 'creating' || current.stage === 'best-effort-uncertain') {
      const retiring = { ...current, disposition: 'cancel-on-create' } as const;
      this.replace(current, retiring);
      if (retiring.stage === 'creating') this.recover(retiring);
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
    const findEntry = () =>
      feeAttachmentForSubmission(storageRepository.feeAttachments(), owner, submissionId);
    const current = findEntry();
    let entryEstablished = current !== null;
    const startedLive = storageRepository.loadState().session?.phase === 'live';
    const canPersist = () =>
      !this.detached &&
      (!startedLive || storageRepository.loadState().session?.phase === 'live') &&
      (!entryEstablished || findEntry() !== null);
    const consumerDead = () =>
      this.authorityRetired || this.ports.isRetired() || isInactive() || !canPersist();
    const discardRetiredCreation = (result: WalletOfferBeginOutcome) => {
      if (result.kind === 'created-reserved' && findEntry()?.stage !== 'retained-for-replay') {
        this.cancelLateReservation(provider, result.tradeId, submissionId);
      }
    };
    const recoveryId =
      !replacement && current?.stage === 'creating' ? current.recoveryId : undefined;
    const operation = { owner, purpose: { kind: 'fee' as const, operationId: submissionId } };
    const reconciliation = {
      allowApproval: () => {
        const latest = feeAttachmentForSubmission(this.entries(), owner, submissionId);
        return !consumerDead() && !!latest && !isRetiringFeeAttachment(latest);
      },
      onApprovalChange: (listener: () => void) => {
        this.approvalListeners.add(listener);
        const unsubscribe = storageRepository.onWalletOperationsChange(listener);
        return () => {
          unsubscribe();
          this.approvalListeners.delete(listener);
        };
      },
    };
    let outcome: WalletOfferBeginOutcome;
    try {
      outcome = await advanceProviderCreation(
        generation,
        provider,
        operation,
        request,
        recoveryId,
        reconciliation,
      );
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
      if (!storageRepository.isGenerationCurrent(generation)) {
        log(
          `[fee-attachment] stale creation returned only recovery_id=${pendingRecoveryId}; reservation may remain orphaned submission_id=${submissionId}`,
        );
        return { kind: 'unavailable', reason: 'Storage authority changed during fee creation' };
      }
      const latest = findEntry();
      // Explicit retirement removes the operation; an old flight cannot recreate it.
      if (canPersist()) {
        this.replace(latest, {
          owner,
          submissionId,
          stage: 'creating',
          disposition:
            consumerDead() || (latest && isRetiringFeeAttachment(latest))
              ? 'cancel-on-create'
              : 'active',
          request,
          recoveryId: pendingRecoveryId,
          reason: 'fee-creation-pending',
          ...(latest?.orphanRisk ? { orphanRisk: latest.orphanRisk } : {}),
        });
        entryEstablished = true;
      }
      outcome = await advanceProviderCreation(
        generation,
        provider,
        operation,
        request,
        pendingRecoveryId,
        reconciliation,
      );
      if (outcome.kind === 'pending') throw new Error('Fee reconciliation remained pending');
    }
    if (!storageRepository.isGenerationCurrent(generation)) {
      if (outcome.kind === 'created-reserved' && hardResetEpoch === this.hardResetEpoch) {
        this.cancelLateReservation(provider, outcome.tradeId, submissionId);
      }
      return { kind: 'unavailable', reason: 'Storage authority changed during fee creation' };
    }
    if (!canPersist()) {
      discardRetiredCreation(outcome);
      return { kind: 'unavailable', reason: 'Fee operation retired during wallet creation' };
    }
    const latest = findEntry();
    if (consumerDead() || (latest && isRetiringFeeAttachment(latest))) {
      this.settleDeadCreation(owner, submissionId, outcome);
      return { kind: 'unavailable', reason: 'Fee consumer retired during wallet creation' };
    }
    if (outcome.kind === 'failure') {
      if (latest) this.replace(latest, null);
      return outcome;
    }
    if (outcome.kind === 'unavailable') return outcome;
    if (outcome.kind === 'created-ephemeral')
      throw new Error('Fee provider returned unreserved material');
    this.replace(latest, {
      owner,
      submissionId,
      stage: 'reserved',
      providerReservationId: outcome.tradeId,
      reason: 'fee-offer-created',
      ...(latest?.orphanRisk ? { orphanRisk: latest.orphanRisk } : {}),
    });
    entryEstablished = true;
    try {
      await checkpointProviderState(generation);
    } catch (error) {
      if (
        error instanceof StorageAuthorityLostError ||
        error instanceof StorageAuthorityRequiredError
      ) {
        if (hardResetEpoch === this.hardResetEpoch) {
          this.cancelLateReservation(provider, outcome.tradeId, submissionId);
        }
        return { kind: 'unavailable', reason: 'Storage authority changed during fee creation' };
      }
      throw error;
    }
    if (!canPersist()) {
      discardRetiredCreation(outcome);
      return { kind: 'unavailable', reason: 'Fee operation retired during wallet creation' };
    }
    if (consumerDead()) {
      this.settleDeadCreation(owner, submissionId, outcome);
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

  /**
   * The one dead-consumer transition. Only a completed cancellation removes an identified offer,
   * so a refused or interrupted cancel still has its record to retry from.
   */
  private settleDeadCreation(
    owner: FeeAttachmentOwner,
    submissionId: string,
    outcome: WalletOfferBeginOutcome,
  ): void {
    const latest = feeAttachmentForSubmission(
      storageRepository.feeAttachments(),
      owner,
      submissionId,
    );
    const unidentified = latest?.stage === 'creating' || latest?.stage === 'best-effort-uncertain';
    const tradeId =
      outcome.kind === 'created-reserved'
        ? outcome.tradeId
        : latest && !unidentified
          ? latest.providerReservationId
          : null;
    if (tradeId === null) {
      if (latest?.stage === 'creating' && outcome.kind !== 'failure') {
        this.replace(latest, { ...latest, disposition: 'cancel-on-create' });
      } else if (latest) {
        this.replace(latest, null);
      }
      return;
    }
    // Replay owns an attached offer: this flight's consumer dying says nothing about it.
    if (latest?.stage === 'retained-for-replay') return;
    if (!latest || !isFeeAttachmentCancellation(latest)) {
      this.replace(latest, {
        owner,
        submissionId,
        stage: 'cancel-required',
        providerReservationId: tradeId,
        reason: 'fee-offer-created',
        ...(latest?.orphanRisk ? { orphanRisk: latest.orphanRisk } : {}),
      });
    }
    void this.scheduleCancellation(tradeId);
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
    // Only Rust-issued submission demand may acquire an active fee. Background work retires offers.
    for (const entry of this.entries()) {
      if (entry.stage === 'creating' && entry.disposition === 'cancel-on-create') {
        this.recover(entry);
      } else if (
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
    void this.flight(`create:${entry.submissionId}`, () =>
      this.create(
        provider,
        entry.owner,
        entry.submissionId,
        entry.request,
        () => this.recoveredConsumerDead(entry.owner, entry.submissionId),
        false,
      ),
    );
  }

  private replaceUncertain(
    entry: FeeAttachmentUncertain,
    isInactive: () => boolean,
  ): Promise<WalletOfferCompletion> | null {
    if (this.authorityRetired) return null;
    const provider = this.providers.provider(entry.owner.providerScope);
    const epoch = BigInt(this.providers.readinessEpoch(entry.owner.providerScope));
    const key = feeAttachmentEntryKey(entry);
    const restored = this.restoredUncertain.has(key);
    if (!provider || !canLosePreIdResponse(provider) || epoch === 0n) return null;
    if (!restored && epoch <= entry.lastAttemptEpoch) return null;
    this.restoredUncertain.delete(key);
    this.replace(entry, { ...entry, lastAttemptEpoch: epoch });
    return this.flight(`create:${entry.submissionId}`, () =>
      this.create(
        provider,
        entry.owner,
        entry.submissionId,
        entry.request,
        () => isInactive() || this.recoveredConsumerDead(entry.owner, entry.submissionId),
        true,
      ),
    );
  }

  private scheduleCancellation(id: string): Promise<void> {
    if (this.authorityRetired) return Promise.resolve();
    const entry = identifiedFeeAttachment(this.entries(), id);
    const provider = entry && this.providers.provider(entry.owner.providerScope);
    if (!entry || !provider || !isFeeAttachmentCancellation(entry)) {
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
      let cancellationStage: FeeAttachment['stage'] = entry.stage;
      try {
        outcome = await advanceProviderCancellation(
          generation,
          provider,
          id,
          entry.stage === 'cancelling' ? entry.recoveryId : undefined,
        );
        if (
          !storageRepository.isGenerationCurrent(generation) ||
          identifiedFeeAttachment(this.entries(), id)?.stage !== cancellationStage
        )
          return;
        if (outcome.status === 'pending') {
          const current = identifiedFeeAttachment(this.entries(), id);
          if (!current) return;
          cancellationStage = 'cancelling';
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
        identifiedFeeAttachment(this.entries(), id)?.stage === cancellationStage &&
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
      if (entry.stage === 'creating' && entry.disposition === 'cancel-on-create') {
        this.recover(entry);
      } else if (
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
      .then((outcome) =>
        outcome.status === 'pending' && isRecoverableProvider(provider)
          ? provider.reconcileCancellation(id, outcome.recoveryId)
          : outcome,
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
    return !current || isRetiringFeeAttachment(current);
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
    this.restoredUncertain.clear();
  }
}
