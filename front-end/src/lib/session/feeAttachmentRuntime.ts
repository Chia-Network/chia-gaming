import type {
  WalletOfferBeginOutcome,
  WalletOfferCompletion,
  WalletOfferCancellationBeginOutcome,
  WalletOfferProvider,
  WalletOfferReconciliationOptions,
} from '../../types/ChiaGaming';
import { log } from '../../services/log';
import { StorageAuthorityLostError, StorageAuthorityRequiredError } from './indexedDb';
import {
  feeAttachmentEntryKey,
  feeAttachmentOperationKey,
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
  checkpointProviderState,
  coalesceProviderFlight,
  type ProviderFlight,
} from './providerExecution';
import { providerScopeKey } from './providerKeys';
import { storageRepository } from './storageRepository';
import { cancelRetiredWalletReservation } from './walletReservationRetirement';
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
    const reconciliation: WalletOfferReconciliationOptions = {
      mode: 'delivery',
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
    let creationEpoch = BigInt(this.providers.readinessEpoch(owner.providerScope));
    const advance = async (id?: string): Promise<WalletOfferBeginOutcome | null> => {
      await checkpointProviderState(generation);
      if (
        this.authorityRetired ||
        this.ports.isRetired() ||
        !canPersist() ||
        (id === undefined && isInactive())
      )
        return null;
      const currentProvider = this.providers.provider(owner.providerScope);
      if (!currentProvider) return null;
      provider = currentProvider;
      creationEpoch = BigInt(this.providers.readinessEpoch(owner.providerScope));
      const uncertain = findEntry();
      if (
        id === undefined &&
        replacement &&
        uncertain?.stage === 'best-effort-uncertain' &&
        uncertain.lastAttemptEpoch !== creationEpoch
      ) {
        this.replace(uncertain, { ...uncertain, lastAttemptEpoch: creationEpoch });
        await checkpointProviderState(generation);
        if (
          consumerDead() ||
          this.providers.provider(owner.providerScope) !== provider ||
          BigInt(this.providers.readinessEpoch(owner.providerScope)) !== creationEpoch
        )
          return null;
      }
      if (id === undefined) return provider.beginCreation(operation, request);
      if (!isRecoverableProvider(provider))
        throw new Error('Provider cannot reconcile persisted creation');
      return provider.reconcileCreation(operation, request, id, reconciliation);
    };
    const notInvoked = (): WalletOfferCompletion => {
      const result = {
        kind: 'unavailable',
        reason: 'Fee consumer or original provider is no longer available',
      } as const;
      if (consumerDead() && canPersist())
        this.settleDeadCreation(owner, submissionId, result, 'delivery');
      return result;
    };
    let outcome: WalletOfferBeginOutcome | null;
    try {
      outcome = await advance(recoveryId);
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
        this.creationUncertain(
          owner,
          submissionId,
          request,
          consumerDead,
          generation,
          creationEpoch,
        );
      }
      return { kind: 'unavailable', reason: String(error) };
    }
    if (outcome === null) return notInvoked();
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
        this.creationUncertain(
          owner,
          submissionId,
          request,
          consumerDead,
          generation,
          creationEpoch,
        );
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
      if (!canPersist()) {
        cancelRetiredWalletReservation(provider, {
          owner,
          submissionId,
          stage: 'creating',
          disposition: 'cancel-on-create',
          request,
          recoveryId: pendingRecoveryId,
          reason: 'fee-consumer-retired',
        });
        return { kind: 'unavailable', reason: 'Fee operation retired during wallet creation' };
      }
      const latest = findEntry();
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
      outcome = await advance(pendingRecoveryId);
      if (outcome === null) return notInvoked();
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
      this.settleDeadCreation(owner, submissionId, outcome, 'delivery');
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
      this.settleDeadCreation(owner, submissionId, outcome, 'delivery');
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
   * The one dead-consumer transition. A terminal cancellation result retires an identified offer;
   * interrupted cancellation retains its record for recovery.
   */
  private settleDeadCreation(
    owner: FeeAttachmentOwner,
    submissionId: string,
    outcome: WalletOfferBeginOutcome,
    mode: WalletOfferReconciliationOptions['mode'],
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
        const retiring = { ...latest, disposition: 'cancel-on-create' } as const;
        this.replace(latest, retiring);
        if (mode === 'delivery') this.recover(retiring);
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
    attemptEpoch: bigint,
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
        lastAttemptEpoch: attemptEpoch,
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

  private canOwnCleanup(generation: number): boolean {
    return (
      !this.detached &&
      !this.authorityRetired &&
      !this.ports.isRetired() &&
      storageRepository.isGenerationCurrent(generation)
    );
  }

  private recover(entry: Extract<FeeAttachment, { stage: 'creating' }>): void {
    if (this.detached || this.authorityRetired) return;
    const epoch = BigInt(this.providers.readinessEpoch(entry.owner.providerScope));
    if (!this.providers.provider(entry.owner.providerScope)) return;
    const generation = storageRepository.lifecycleGeneration;
    const hardResetEpoch = this.hardResetEpoch;
    const delivery = this.flights.get(`create:${entry.submissionId}`)?.promise;
    let consumedEpoch = epoch;
    const currentEntry = () => {
      const current = feeAttachmentForSubmission(
        storageRepository.feeAttachments(),
        entry.owner,
        entry.submissionId,
      );
      return current?.stage === 'creating' &&
        current.disposition === 'cancel-on-create' &&
        current.recoveryId === entry.recoveryId
        ? current
        : null;
    };
    void this.flight(
      `recover:${entry.submissionId}`,
      async () => {
        // Delivery reports its own result. Observation starts only after it settles
        // and the current owner/provider have survived the persistence barrier.
        if (delivery) await Promise.allSettled([delivery]);
        await checkpointProviderState(generation);
        const current = currentEntry();
        if (!this.canOwnCleanup(generation) || !current) return;
        const provider = this.providers.provider(current.owner.providerScope);
        if (!provider || !isRecoverableProvider(provider)) return;
        consumedEpoch = BigInt(this.providers.readinessEpoch(current.owner.providerScope));
        const outcome = await provider.reconcileCreation(
          { owner: current.owner, purpose: { kind: 'fee', operationId: current.submissionId } },
          current.request,
          current.recoveryId,
          { mode: 'observe-only' },
        );
        if (!this.canOwnCleanup(generation) || !currentEntry()) {
          if (
            outcome.kind === 'created-reserved' &&
            hardResetEpoch === this.hardResetEpoch &&
            !identifiedFeeAttachment(storageRepository.feeAttachments(), outcome.tradeId)
          ) {
            this.cancelLateReservation(provider, outcome.tradeId, current.submissionId);
          }
          return;
        }
        this.settleDeadCreation(current.owner, current.submissionId, outcome, 'observe-only');
      },
      () => {
        const current = currentEntry();
        if (
          this.canOwnCleanup(generation) &&
          current &&
          BigInt(this.providers.readinessEpoch(current.owner.providerScope)) > consumedEpoch
        )
          this.recover(current);
      },
      epoch,
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
    if (this.detached || this.authorityRetired) return Promise.resolve();
    const entry = identifiedFeeAttachment(this.entries(), id);
    if (
      !entry ||
      !isFeeAttachmentCancellation(entry) ||
      !this.providers.provider(entry.owner.providerScope)
    )
      return Promise.resolve();
    const epoch = BigInt(this.providers.readinessEpoch(entry.owner.providerScope));
    const generation = storageRepository.lifecycleGeneration;
    const operationKey = feeAttachmentOperationKey(entry.owner, entry.submissionId);
    let consumedEpoch = epoch;
    let cancellationStage = entry.stage;
    let recoveryId = entry.stage === 'cancelling' ? entry.recoveryId : undefined;
    const currentEntry = () => {
      const current = identifiedFeeAttachment(storageRepository.feeAttachments(), id);
      return current &&
        current.stage === cancellationStage &&
        feeAttachmentOperationKey(current.owner, current.submissionId) === operationKey &&
        (current.stage !== 'cancelling' || current.recoveryId === recoveryId)
        ? current
        : null;
    };
    return this.flight(
      `cancel:${id}`,
      async () => {
        const advance = async (): Promise<{
          provider: WalletOfferProvider;
          outcome: WalletOfferCancellationBeginOutcome;
        } | null> => {
          await checkpointProviderState(generation);
          const current = currentEntry();
          if (!this.canOwnCleanup(generation) || !current) return null;
          const provider = this.providers.provider(current.owner.providerScope);
          if (!provider) return null;
          const attemptEpoch = BigInt(this.providers.readinessEpoch(current.owner.providerScope));
          if (current.stage === 'best-effort-cancellation-uncertain') {
            const key = feeAttachmentEntryKey(current);
            const restored = this.restoredUncertain.has(key);
            if (!attemptEpoch || (!restored && attemptEpoch <= current.lastAttemptEpoch))
              return null;
            this.restoredUncertain.delete(key);
            this.replace(current, { ...current, lastAttemptEpoch: attemptEpoch });
            // The reservation of this actual attempt must precede wallet mutation.
            await checkpointProviderState(generation);
            if (
              !this.canOwnCleanup(generation) ||
              !currentEntry() ||
              this.providers.provider(current.owner.providerScope) !== provider ||
              BigInt(this.providers.readinessEpoch(current.owner.providerScope)) !== attemptEpoch
            )
              return null;
          }
          consumedEpoch = attemptEpoch;
          const outcome =
            current.stage === 'cancelling'
              ? isRecoverableProvider(provider)
                ? await provider.reconcileCancellation(id, current.recoveryId)
                : (() => {
                    throw new Error('Provider cannot reconcile persisted cancellation');
                  })()
              : provider.capability === 'best-effort' || provider.capability === 'terminal'
                ? await provider.cancel(id)
                : await provider.beginCancellation(id);
          return { provider, outcome };
        };
        try {
          let step = await advance();
          if (!step || !this.canOwnCleanup(generation) || !currentEntry()) return;
          let outcome = step.outcome;
          if (outcome.status === 'pending') {
            const current = currentEntry();
            if (!current) return;
            cancellationStage = 'cancelling';
            recoveryId = outcome.recoveryId;
            this.replace(current, { ...current, stage: 'cancelling', recoveryId });
            step = await advance();
            if (!step) return;
            outcome = step.outcome;
          } else if (
            outcome.status === 'unavailable' &&
            step.provider.capability === 'recoverable-after-begin' &&
            cancellationStage !== 'cancelling'
          ) {
            const current = currentEntry();
            if (!current) return;
            const uncertain = {
              ...current,
              stage: 'best-effort-cancellation-uncertain',
              lastAttemptEpoch: consumedEpoch,
              reason: 'fee-cancellation-response-unavailable',
            } as const;
            this.knownUncertain.add(feeAttachmentEntryKey(uncertain));
            this.replace(current, uncertain);
            return;
          }
          const current = currentEntry();
          if (!this.canOwnCleanup(generation) || !current) return;
          if (
            outcome.status === 'cancelled' ||
            outcome.status === 'already-terminal' ||
            outcome.status === 'rejected'
          ) {
            if (outcome.status === 'rejected')
              this.ports.reportWarning(`Wallet rejected fee cancellation ${id}: ${outcome.detail}`);
            this.replace(current, null);
          }
        } catch (error) {
          if (!(error instanceof StorageAuthorityLostError))
            log(`[fee-attachment] cancel failed: ${String(error)}`);
        }
      },
      () => {
        if (
          this.canOwnCleanup(generation) &&
          BigInt(this.providers.readinessEpoch(entry.owner.providerScope)) > consumedEpoch
        )
          void this.scheduleCancellation(id);
      },
      epoch,
    );
  }

  private providerEvent(event: WalletProviderRegistryEvent): void {
    if (this.detached || this.authorityRetired || event.kind === 'detached') return;
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

  private flight<T>(
    key: string,
    launch: () => Promise<T>,
    resume?: () => void,
    epoch?: bigint,
  ): Promise<T> {
    const promise = coalesceProviderFlight(this.flights, key, launch, resume, epoch);
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
