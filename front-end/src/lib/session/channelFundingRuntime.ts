import type {
  WalletOfferCompletion,
  WalletOfferProvider,
  WalletOfferRequest,
} from '../../types/ChiaGaming';
import { log } from '../../services/log';
import { jsonStringify } from '../../util/jsonSafe';
import {
  channelFundingEntryKey,
  channelFundingKey,
  channelFundingTradeKey,
  type ChannelFundingCancellationUncertainEntry,
  type ChannelFundingUncertainEntry,
  type ChannelFundingEntry,
  type ChannelFundingOwner,
  type ChannelFundingPurpose,
  type ChannelFundingRecoveryEntry,
  type ChannelFundingRecoveryRequest,
  type ChannelFundingTradeState,
} from './channelFundingStore';
import { storageRepository } from './storageRepository';
import { entryForOperation, providerRequestFromRecovery } from './channelFundingSelectors';
import { canLosePreIdResponse, isRecoverableProvider } from './providerCapabilities';
import {
  advanceProviderCancellation,
  advanceProviderCreation,
  checkpointProviderState,
  coalesceProviderFlight,
  type ProviderFlight,
} from './providerExecution';
import { providerOwnerKey, providerScopeKey } from './providerKeys';
import {
  WalletProviderRegistry,
  walletProviderRegistry,
  type WalletProviderRegistryEvent,
} from './walletProviderRegistry';
import { StorageAuthorityLostError } from './indexedDb';

interface FundingFlight extends ProviderFlight {
  completion?: WalletOfferCompletion;
}

export class ChannelFundingRuntime {
  private readonly inFlight = new Map<string, FundingFlight>();
  private readonly listeners = new Set<() => void>();
  private lifecycleUnsubscribe: (() => void) | null = null;
  private hardResetEpoch = 0;
  constructor(
    private readonly providerRegistry: WalletProviderRegistry = new WalletProviderRegistry(),
  ) {
    this.providerRegistry.subscribe((event) => this.providerEvent(event));
    this.subscribeLifecycle();
  }

  private subscribeLifecycle(): void {
    this.lifecycleUnsubscribe?.();
    this.lifecycleUnsubscribe = storageRepository.onLifecycle((_generation, event) => {
      if (event === 'claim') {
        this.resumeAll();
      } else {
        this.retireTransientWork();
        if (event === 'hard-reset') this.hardResetEpoch += 1;
      }
    });
  }

  // prettier-ignore
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  // prettier-ignore
  attachProvider = (provider: WalletOfferProvider): void => void this.providerRegistry.attach(provider);
  // prettier-ignore
  providerReady = (provider: WalletOfferProvider): void => void this.providerRegistry.ready(provider);
  // prettier-ignore
  providerReconnectReady = (provider: WalletOfferProvider): void => void this.providerRegistry.reconnectReady(provider);
  // prettier-ignore
  detachProvider = (provider: WalletOfferProvider): void => void this.providerRegistry.detach(provider);

  providerScopeKeys = (): ReadonlySet<string> => this.providerRegistry.scopeKeys();

  private entries = (): ChannelFundingEntry[] => storageRepository.channelFundingOperations();

  channelCoinConfirmed(installationPlayerId: string, peerSessionId: string): void {
    const entries = this.entries();
    const next = entries.filter(
      (entry) =>
        entry.stage !== 'awaiting-channel' ||
        entry.owner.installationPlayerId !== installationPlayerId ||
        entry.owner.peerSessionId !== peerSessionId,
    );
    if (next.length !== entries.length) this.commit(next);
  }

  channelCreationTimedOut(installationPlayerId: string, peerSessionId: string): string | null {
    const entries = this.entries();
    const unknown = entries.some(
      (entry) =>
        entry.owner.installationPlayerId === installationPlayerId &&
        entry.owner.peerSessionId === peerSessionId &&
        entry.stage === 'best-effort-uncertain',
    );
    const cancellations: string[] = [];
    let changed = false;
    const next = entries.map((entry): ChannelFundingEntry => {
      if (
        entry.owner.installationPlayerId !== installationPlayerId ||
        entry.owner.peerSessionId !== peerSessionId
      ) {
        return entry;
      }
      if (entry.stage === 'awaiting-channel') {
        const { request: _request, ...identified } = entry;
        cancellations.push(entry.providerReservationId);
        changed = true;
        return {
          ...identified,
          stage: 'cancel-required',
          reason: 'channel-creation-timed-out',
        };
      }
      if (
        (entry.stage === 'creating' || entry.stage === 'best-effort-uncertain') &&
        entry.disposition !== 'cancel-on-create'
      ) {
        changed = true;
        return { ...entry, disposition: 'cancel-on-create', reason: 'channel-creation-timed-out' };
      }
      return entry;
    });
    if (changed) this.commit(next);
    cancellations.forEach((id) => void this.scheduleCancellation(id));
    if (unknown) {
      const warning =
        'Channel creation timed out after the wallet response was lost before a reservation ID was known. A prior wallet reservation may remain, but it cannot be cancelled automatically.';
      log(`[channel-funding-runtime] ${warning} session=${peerSessionId}`);
      return warning;
    }
    return null;
  }
  async createOffer(
    owner: ChannelFundingOwner,
    purpose: ChannelFundingPurpose,
    request: WalletOfferRequest,
    recoveryRequest: ChannelFundingRecoveryRequest,
    isRetired: () => boolean = () => false,
  ): Promise<WalletOfferCompletion> {
    const generation = storageRepository.lifecycleGeneration;
    storageRepository.ensureWalletContext(owner.providerScope);
    const provider = this.providerRegistry.provider(owner.providerScope);
    if (!provider)
      return {
        kind: 'unavailable',
        reason: 'Reconnect the original wallet account to resume this operation',
      };
    const key = channelFundingKey(owner, purpose);
    const completedKey = `completed:${key}`;
    const completed = this.inFlight.get(completedKey)?.completion;
    if (completed) {
      this.inFlight.delete(completedKey);
      return completed;
    }
    const current = entryForOperation(this.entries(), owner, purpose);
    if (current?.stage === 'best-effort-uncertain') {
      const replacement = this.inFlight.get(`replace:${key}`);
      if (replacement) {
        await replacement.promise;
        const replaced = this.inFlight.get(completedKey)?.completion;
        if (replaced) {
          this.inFlight.delete(completedKey);
          return replaced;
        }
        return {
          kind: 'unavailable',
          reason: 'Wallet replacement attempt completed without material for this caller',
        };
      }
    }
    if (current && current.stage !== 'creating' && current.stage !== 'best-effort-uncertain') {
      throw new Error('Channel funding cleanup is pending for this request');
    }
    return coalesceProviderFlight(this.inFlight, `create:${key}`, () =>
      this.performCreation(
        provider,
        owner,
        purpose,
        request,
        recoveryRequest,
        isRetired,
        generation,
      ),
    );
  }

  private async performCreation(
    provider: WalletOfferProvider,
    owner: ChannelFundingOwner,
    purpose: ChannelFundingPurpose,
    request: WalletOfferRequest,
    recoveryRequest: ChannelFundingRecoveryRequest,
    isRetired: () => boolean,
    generation: number,
    replacement = false,
  ): Promise<WalletOfferCompletion> {
    const recovery = entryForOperation(this.entries(), owner, purpose);
    const hardResetEpoch = this.hardResetEpoch;
    if (!replacement && recovery?.stage === 'best-effort-uncertain') {
      return {
        kind: 'unavailable',
        reason: 'Wallet response was lost; a replacement starts on the next readiness epoch',
      };
    }
    const exactRecovery = !replacement && recovery?.stage === 'creating' ? recovery : null;
    if (exactRecovery) {
      if (jsonStringify(exactRecovery.request) !== jsonStringify(recoveryRequest)) {
        throw new Error('Persisted wallet offer request conflicts with requested recovery');
      }
    }
    let completion;
    try {
      completion = await advanceProviderCreation(
        generation,
        provider,
        { owner, purpose },
        request,
        exactRecovery?.recoveryId,
      );
    } catch (error) {
      if (error instanceof StorageAuthorityLostError) {
        return { kind: 'unavailable', reason: 'Storage authority changed before wallet creation' };
      }
      if (exactRecovery || !canLosePreIdResponse(provider)) throw error;
      if (!replacement) {
        const retired = isRetired();
        if (retired) {
          log(
            `[channel-funding-runtime] retired creation lost its pre-id response; external reservation risk operation=${channelFundingKey(owner, purpose)}`,
          );
        } else {
          // prettier-ignore
          this.recordUncertainty(owner, purpose, recoveryRequest, false, generation);
        }
      }
      return { kind: 'unavailable', reason: String(error) };
    }
    if (
      completion.kind === 'unavailable' &&
      !exactRecovery &&
      !replacement &&
      canLosePreIdResponse(provider)
    ) {
      const retired = isRetired();
      if (retired) {
        log(
          `[channel-funding-runtime] retired creation returned unavailable before reservation identification; external reservation risk operation=${channelFundingKey(owner, purpose)}`,
        );
      } else {
        // prettier-ignore
        this.recordUncertainty(owner, purpose, recoveryRequest, false, generation);
      }
      return completion as WalletOfferCompletion;
    }
    if (completion.kind === 'pending') {
      const recoveryId = completion.recoveryId;
      if (!storageRepository.isGenerationCurrent(generation)) {
        log(
          `[channel-funding-runtime] stale creation returned only recovery_id=${recoveryId}; external reservation risk operation=${channelFundingKey(owner, purpose)}`,
        );
        return { kind: 'unavailable', reason: 'Storage authority changed during wallet creation' };
      }
      const retiredBeforeReconciliation = isRetired();
      if (!retiredBeforeReconciliation) {
        if (recovery?.stage === 'best-effort-uncertain') {
          this.replace(recovery, { ...recovery, stage: 'creating', recoveryId });
        } else {
          this.replace(recovery, {
            owner,
            purpose,
            stage: 'creating',
            disposition: 'active',
            recoveryId,
            request: recoveryRequest,
            reason: 'wallet-offer-creation-pending',
            ...(recovery?.orphanRisk ? { orphanRisk: recovery.orphanRisk } : {}),
          });
        }
      }
      if (!storageRepository.isGenerationCurrent(generation)) {
        return { kind: 'unavailable', reason: 'Storage authority changed during wallet creation' };
      }
      try {
        completion = await advanceProviderCreation(
          generation,
          provider,
          { owner, purpose },
          request,
          recoveryId,
        );
      } catch (error) {
        if (error instanceof StorageAuthorityLostError) {
          return {
            kind: 'unavailable',
            reason: 'Storage authority changed before wallet recovery',
          };
        }
        throw error;
      }
      if (completion.kind === 'pending') {
        throw new Error('Provider reconciliation remained pending');
      }
      if (isRetired()) {
        if (storageRepository.isGenerationCurrent(generation)) {
          const current = entryForOperation(this.entries(), owner, purpose);
          if (current?.stage === 'creating' && current.recoveryId === recoveryId) {
            this.replace(current, null);
          }
        }
        if (completion.kind === 'created-reserved') {
          this.cancelLateReservation(
            provider,
            completion.tradeId,
            channelFundingKey(owner, purpose),
          );
        } else if (completion.kind === 'unavailable') {
          log(
            `[channel-funding-runtime] retired creation reconciliation unavailable; external reservation risk operation=${channelFundingKey(owner, purpose)} recovery_id=${recoveryId}`,
          );
        }
        return { kind: 'unavailable', reason: 'Funding consumer retired during wallet creation' };
      }
    }
    const generationCurrent = storageRepository.isGenerationCurrent(generation);
    const retired = isRetired();
    if (!generationCurrent || retired) {
      if (
        completion.kind === 'created-reserved' &&
        (generationCurrent || hardResetEpoch === this.hardResetEpoch)
      ) {
        this.cancelLateReservation(provider, completion.tradeId, channelFundingKey(owner, purpose));
      }
      return {
        kind: 'unavailable',
        reason: generationCurrent
          ? 'Funding consumer retired during wallet creation'
          : 'Storage authority changed during wallet creation',
      };
    }
    const current = entryForOperation(this.entries(), owner, purpose);
    if (completion.kind === 'created-reserved') {
      const cancel =
        (current?.stage === 'creating' || current?.stage === 'best-effort-uncertain') &&
        current.disposition === 'cancel-on-create';
      const provenance = current?.orphanRisk ? { orphanRisk: current.orphanRisk } : {};
      this.replace(
        current,
        cancel
          ? {
              owner,
              purpose,
              stage: 'cancel-required',
              providerReservationId: completion.tradeId,
              reason: 'funding-offer-created',
              ...provenance,
            }
          : {
              owner,
              purpose,
              stage: 'awaiting-channel',
              providerReservationId: completion.tradeId,
              request: recoveryRequest,
              reason: 'funding-offer-created',
              ...provenance,
            },
      );
    } else if (completion.kind !== 'unavailable' && current) {
      this.replace(current, null);
    }
    const entry =
      completion.kind === 'created-reserved' ? this.reservation(completion.tradeId) : null;
    if (entry?.orphanRisk && completion.kind === 'created-reserved') {
      const provider =
        entry.owner.providerScope.provider === 'cloud' ? 'Cloud Wallet' : 'WalletConnect';
      const warning = `${provider} lost the original create-offer response. A prior external reservation may still exist even though a later attempt succeeded.`;
      log(`[channel-funding-runtime] ${warning} operation=${channelFundingKey(owner, purpose)}`);
      completion = { ...completion, warning };
    }
    if (entry && entry.stage === 'cancel-required')
      this.scheduleCancellation(entry.providerReservationId);
    return completion;
  }

  private recordUncertainty(
    owner: ChannelFundingOwner,
    purpose: ChannelFundingPurpose,
    request: ChannelFundingRecoveryRequest,
    retired: boolean,
    generation: number,
  ): void {
    const install = () => {
      if (entryForOperation(this.entries(), owner, purpose)) return;
      this.replace(null, {
        owner,
        purpose,
        stage: 'best-effort-uncertain',
        disposition: retired ? 'cancel-on-create' : 'active',
        request,
        lastAttemptEpoch: BigInt(this.providerRegistry.readinessEpoch(owner.providerScope)),
        reason: 'wallet-response-unavailable',
        orphanRisk: 'pre-id-response-lost',
      });
    };
    if (!storageRepository.isGenerationCurrent(generation)) return;
    install();
    log(
      `[channel-funding-runtime] create response lost; external reservation risk operation=${channelFundingKey(owner, purpose)}`,
    );
  }

  retryCancelRequired(owner?: ChannelFundingOwner): void {
    this.resume(owner ? providerOwnerKey(owner) : null, null);
  }

  cancelIdentifiedReservation(providerReservationId: string): void {
    const entry = this.reservation(providerReservationId);
    if (!entry) return;
    if (entry.stage === 'awaiting-channel') {
      const { request: _request, ...identified } = entry;
      this.replace(entry, {
        ...identified,
        stage: 'cancel-required',
        reason: 'stale-funding-result',
      });
    }
    void this.scheduleCancellation(providerReservationId);
  }

  private scheduleCancellation(providerReservationId: string): Promise<void> {
    const entry = this.reservation(providerReservationId);
    if (
      !entry ||
      (entry.stage !== 'cancel-required' &&
        entry.stage !== 'cancelling' &&
        entry.stage !== 'best-effort-cancellation-uncertain')
    )
      return Promise.resolve();
    if (!this.providerRegistry.provider(entry.owner.providerScope)) return Promise.resolve();
    const generation = storageRepository.lifecycleGeneration;
    return coalesceProviderFlight(this.inFlight, `cancel:${providerReservationId}`, () =>
      this.performCancellation(entry, generation),
    );
  }

  private async performCancellation(
    entry: ChannelFundingTradeState,
    generation: number,
  ): Promise<void> {
    const provider = this.providerRegistry.provider(entry.owner.providerScope);
    if (!provider) return;
    try {
      let current = entry;
      let outcome = await advanceProviderCancellation(
        generation,
        provider,
        entry.providerReservationId,
        entry.stage === 'cancelling' ? entry.recoveryId : undefined,
      );
      if (!storageRepository.isGenerationCurrent(generation)) return;
      if (
        outcome.status === 'unavailable' &&
        provider.capability === 'recoverable-after-begin' &&
        entry.stage !== 'cancelling'
      ) {
        this.replace(entry, {
          ...entry,
          stage: 'best-effort-cancellation-uncertain',
          lastAttemptEpoch: BigInt(this.providerRegistry.readinessEpoch(entry.owner.providerScope)),
          reason: 'cancellation-response-unavailable',
        });
        return;
      }
      if (outcome.status === 'pending') {
        this.replace(entry, { ...entry, stage: 'cancelling', recoveryId: outcome.recoveryId });
        const identified = this.reservation(entry.providerReservationId);
        if (identified?.stage !== 'cancelling') return;
        current = identified;
        outcome = await advanceProviderCancellation(
          generation,
          provider,
          entry.providerReservationId,
          outcome.recoveryId,
        );
      }
      const latest = this.reservation(entry.providerReservationId);
      if (!storageRepository.isGenerationCurrent(generation) || latest?.stage !== current.stage) {
        return;
      }
      if (
        outcome.status === 'cancelled' ||
        outcome.status === 'already-terminal' ||
        outcome.status === 'rejected'
      ) {
        if (outcome.status === 'rejected') {
          log(
            `[channel-funding-runtime] cancellation definitively rejected; retiring provider_reservation_id=${entry.providerReservationId}: ${outcome.detail}`,
          );
        }
        this.replace(current, null);
      }
    } catch (error) {
      log(
        `[channel-funding-runtime] cancel threw provider_reservation_id=${entry.providerReservationId}: ${String(error)}`,
      );
    }
  }

  private resumeAll(): void {
    for (const entry of this.entries()) {
      if (
        entry.stage === 'best-effort-uncertain' ||
        entry.stage === 'best-effort-cancellation-uncertain'
      ) {
        this.inFlight.set(`restored:${channelFundingEntryKey(entry)}`, {
          promise: Promise.resolve(),
        });
      }
    }
    this.resume(null, null);
  }

  private providerEvent(event: WalletProviderRegistryEvent): void {
    if (event.kind === 'detached') {
      this.notify();
      return;
    }
    const scope = providerScopeKey(event.provider.scope);
    this.resume(null, scope);
    this.notify();
  }

  private scheduleExactRecovery(entry: ChannelFundingRecoveryEntry): void {
    const provider = this.providerRegistry.provider(entry.owner.providerScope);
    if (!provider || !isRecoverableProvider(provider)) return;
    const key = channelFundingKey(entry.owner, entry.purpose);
    void coalesceProviderFlight(this.inFlight, `recover:${key}`, async () => {
      const generation = storageRepository.lifecycleGeneration;
      const completion = await this.performCreation(
        provider,
        entry.owner,
        entry.purpose,
        providerRequestFromRecovery(entry.owner, entry.request),
        entry.request,
        () => entry.disposition === 'cancel-on-create',
        generation,
      );
      if (completion.kind === 'created-reserved')
        await this.routeCompletion(entry, completion, generation);
    });
  }

  private scheduleUncertain(
    entry: ChannelFundingUncertainEntry | ChannelFundingCancellationUncertainEntry,
  ): void {
    const entryKey = channelFundingEntryKey(entry);
    const restoredKey = `restored:${entryKey}`;
    const restored = this.inFlight.has(restoredKey);
    const epoch = BigInt(this.providerRegistry.readinessEpoch(entry.owner.providerScope));
    if (epoch === 0n || (!restored && epoch <= entry.lastAttemptEpoch)) return;
    const flightKey =
      entry.stage === 'best-effort-cancellation-uncertain'
        ? `cancel:${entry.providerReservationId}`
        : `replace:${channelFundingKey(entry.owner, entry.purpose)}`;
    if (entry.stage === 'best-effort-cancellation-uncertain') {
      void coalesceProviderFlight(
        this.inFlight,
        flightKey,
        async () => {
          const generation = storageRepository.lifecycleGeneration;
          const current = this.reservation(entry.providerReservationId);
          if (current?.stage !== 'best-effort-cancellation-uncertain') return;
          if (restored || epoch > current.lastAttemptEpoch) {
            this.replace(current, { ...current, lastAttemptEpoch: epoch });
          }
          this.inFlight.delete(restoredKey);
          await checkpointProviderState(generation);
          await this.performCancellation(
            this.reservation(entry.providerReservationId)!,
            generation,
          );
        },
        () => {
          const current = this.reservation(entry.providerReservationId);
          if (current?.stage === 'best-effort-cancellation-uncertain')
            this.scheduleUncertain(current);
        },
        epoch,
      );
      return;
    }
    void coalesceProviderFlight(
      this.inFlight,
      flightKey,
      () => this.launchUncertainCreation(entry, epoch, restored, restoredKey),
      () => {
        const current = entryForOperation(this.entries(), entry.owner, entry.purpose);
        if (current?.stage === 'best-effort-uncertain') this.scheduleUncertain(current);
      },
      epoch,
    );
  }

  private async launchUncertainCreation(
    entry: ChannelFundingUncertainEntry,
    epoch: bigint,
    restored: boolean,
    restoredKey: string,
  ): Promise<void> {
    const recovery = entryForOperation(this.entries(), entry.owner, entry.purpose);
    if (recovery?.stage !== 'best-effort-uncertain') return;
    if (restored || epoch > recovery.lastAttemptEpoch) {
      this.replace(recovery, { ...recovery, lastAttemptEpoch: epoch });
    }
    this.inFlight.delete(restoredKey);
    await checkpointProviderState(storageRepository.lifecycleGeneration);
    const provider = this.providerRegistry.provider(entry.owner.providerScope);
    if (!provider || !canLosePreIdResponse(provider)) return;
    const generation = storageRepository.lifecycleGeneration;
    const request = providerRequestFromRecovery(entry.owner, entry.request);
    const completed = await this.performCreation(
      provider,
      entry.owner,
      entry.purpose,
      request,
      entry.request,
      () => recovery.disposition === 'cancel-on-create',
      generation,
      true,
    );
    if (completed.kind !== 'created-reserved' || !storageRepository.isGenerationCurrent(generation))
      return;
    await this.routeCompletion(entry, completed, generation);
  }

  private routeCompletion(
    entry: ChannelFundingUncertainEntry | ChannelFundingRecoveryEntry,
    completed: Extract<WalletOfferCompletion, { kind: 'created-reserved' }>,
    _generation: number,
  ): void {
    const key = channelFundingKey(entry.owner, entry.purpose);
    this.inFlight.set(`completed:${key}`, { promise: Promise.resolve(), completion: completed });
    this.notify();
  }

  async flush(): Promise<void> {
    for (;;) {
      const active = [...this.inFlight.entries()]
        .filter(([key]) => !key.startsWith('completed:') && !key.startsWith('restored:'))
        .map(([, flight]) => flight.promise);
      if (!active.length) return;
      await Promise.allSettled(active);
    }
  }

  private resume(ownerKey: string | null, scopeKey: string | null): void {
    if (!storageRepository.hasAuthority()) return;
    for (const entry of this.entries()) {
      if (
        (ownerKey && providerOwnerKey(entry.owner) !== ownerKey) ||
        (scopeKey && providerScopeKey(entry.owner.providerScope) !== scopeKey)
      ) {
        continue;
      }
      if (entry.stage === 'cancel-required' || entry.stage === 'cancelling') {
        void this.scheduleCancellation(entry.providerReservationId);
      } else if (entry.stage === 'creating') {
        if (entry.disposition === 'cancel-on-create') this.scheduleExactRecovery(entry);
      } else if (
        entry.stage === 'best-effort-uncertain' ||
        entry.stage === 'best-effort-cancellation-uncertain'
      ) {
        this.scheduleUncertain(entry);
      }
    }
  }

  private commit(entries: readonly ChannelFundingEntry[]): void {
    storageRepository.replaceChannelFunding(entries);
    this.notify();
  }

  private replace(current: ChannelFundingEntry | null, next: ChannelFundingEntry | null): void {
    const currentKey = current ? channelFundingEntryKey(current) : null;
    const nextKey = next ? channelFundingEntryKey(next) : null;
    const entries = this.entries().filter((entry) => {
      const key = channelFundingEntryKey(entry);
      return key !== currentKey && key !== nextKey;
    });
    if (next) entries.push(structuredClone(next));
    this.commit(entries);
  }

  // prettier-ignore
  private reservation(providerReservationId: string): ChannelFundingTradeState | null {
    const entry = this.entries().find((candidate) => channelFundingEntryKey(candidate) === channelFundingTradeKey(providerReservationId)); return entry && entry.stage !== 'creating' && entry.stage !== 'best-effort-uncertain' ? entry : null;
  }

  private cancelLateReservation(
    provider: WalletOfferProvider,
    id: string,
    operation: string,
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
              `[channel-funding-runtime] stale reservation may remain orphaned operation=${operation} provider_reservation_id=${id}`,
            );
          }
        },
        (error) =>
          log(
            `[channel-funding-runtime] stale reservation cancellation failed operation=${operation} provider_reservation_id=${id}: ${String(error)}`,
          ),
      );
  }

  // prettier-ignore
  private notify(): void { for (const listener of this.listeners) listener(); }
  private retireTransientWork(): void {
    this.inFlight.clear();
  }

  resetForTests(): void {
    this.subscribeLifecycle();
    this.providerRegistry.clear();
    this.retireTransientWork();
    this.hardResetEpoch = 0;
    this.listeners.clear();
  }
}

export const channelFundingRuntime = new ChannelFundingRuntime(walletProviderRegistry);
