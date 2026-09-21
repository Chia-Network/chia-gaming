import type {
  NeedCoinSpendRequest,
  WalletOfferBeginOutcome,
  WalletOfferCancellationOutcome,
  WalletOfferCompletion,
  WalletOfferProvider,
  WalletOfferRequest,
  WalletProviderScope,
} from '../../types/ChiaGaming';
import { diagStack, log } from '../../services/log';
import {
  canonicalizeFundingRequest,
  fundingRequestKey,
  type CanonicalFundingRequest,
} from './fundingRequest';
import { jsonStringify } from '../../util/jsonSafe';
import { decodeWalletOperationEntries, decodeWalletOperationRecord } from './walletOperationCodec';
import {
  reduceWalletOperation,
  walletOperationEntryKey,
  walletOperationKey,
  walletOperationOwnerKey,
  walletProviderScopeKey,
  walletOperationRecoveryKey,
  walletOperationTradeKey,
  type WalletBestEffortCancellationUncertainEntry,
  type WalletBestEffortUncertainEntry,
  type WalletOperationCommand,
  type WalletOperationEntry,
  type WalletOperationEntryKey,
  type FundingMaterialSink,
  type WalletOperationCheckpoint,
  type WalletOperationFlight,
  type WalletOperationLifecycle,
  type WalletOperationOwner,
  type WalletOperationPurpose,
  type WalletOperationRecoveryEntry,
  type WalletOperationRecoveryRequest,
  type WalletOperationTradeState,
  type WalletOperationTransition,
} from './walletOperationStore';
import {
  entriesForOwner,
  entryForOperation,
  canLosePreIdResponse,
  flightBelongsToOwner,
  isRecoverableProvider,
  providerRequestFromRecovery,
  restoredFundingForSink,
  walletSessionKey as sessionKey,
} from './walletOperationSelectors';
import {
  WalletProviderRegistry,
  walletProviderRegistry,
  type WalletProviderRegistryEvent,
} from './walletProviderRegistry';
import { StorageAuthorityLostError } from './indexedDb';

type PersistOperations = (entries: WalletOperationEntry[]) => Promise<void>;

interface AttachedFundingSession {
  sink: FundingMaterialSink;
  owner: WalletOperationOwner | null;
  purpose: Extract<WalletOperationPurpose, { kind: 'funding' }> | null;
  request: CanonicalFundingRequest | null;
}

// prettier-ignore
const standaloneLifecycle: WalletOperationLifecycle = { generation: () => 0, isCurrent: () => true };

export class WalletOperationRuntime {
  private entries = new Map<WalletOperationEntryKey, WalletOperationEntry>();
  private readonly inFlight = new Map<string, WalletOperationFlight>();
  private readonly attachedFundingSessions = new Map<string, AttachedFundingSession>();
  private readonly listeners = new Set<() => void>();
  private persist: PersistOperations | null = null;
  private lifecycle: WalletOperationLifecycle = standaloneLifecycle;
  private initialized = false;
  private dirty = false;
  private revision = 0;
  private coordinatedRevision: number | null = null;
  private lastPersistence: Promise<void> = Promise.resolve();
  private authorityLost: StorageAuthorityLostError | null = null;
  private hydratedGeneration: number | null = null;
  private sessionScope: WalletProviderScope | null = null;
  private hydrationState: 'pending' | 'ready' | 'failed' = 'ready';
  private hydrationPromise = Promise.resolve();
  private hydrationResolve: () => void = () => {};
  private hydrationReject: (error: unknown) => void = () => {};

  // prettier-ignore
  constructor(private readonly providerRegistry: WalletProviderRegistry = new WalletProviderRegistry()) {
    this.resetHydration(true); this.providerRegistry.subscribe((event) => this.providerEvent(event));
  }

  // prettier-ignore
  configureLifecycle = (lifecycle: WalletOperationLifecycle): void => { this.lifecycle = lifecycle; };
  // prettier-ignore
  configurePersistence(persist: PersistOperations): void { this.persist = persist; this.authorityLost = null; }

  awaitHydrated = (): Promise<void> => this.hydrationPromise;
  // prettier-ignore
  beginHydration(): void { if (this.hydrationState === 'ready' && !this.initialized) this.resetHydration(false); }
  // prettier-ignore
  runAfterHydration<T>(run: () => Promise<T> | T): Promise<T> | T { return this.hydrationState === 'ready' ? run() : this.hydrationPromise.then(run); }

  // prettier-ignore
  failHydration(error: unknown): void { if (this.hydrationState !== 'pending') return; this.hydrationState = 'failed'; this.hydrationReject(error); }

  // prettier-ignore
  hydrateFromDisk(record: unknown | null, replace = false): void {
    try {
      const entries = record === null ? [] : decodeWalletOperationRecord(record).entries;
      this.installHydrated(entries, replace);
      const pending = this.hydrationState === 'pending'; if (pending) this.hydrationState = 'ready';
      if (pending) this.hydrationResolve();
      void Promise.resolve().then(() => this.resumeAll());
    } catch (error) {
      this.failHydration(error); throw error;
    }
  }

  // prettier-ignore
  hydrateClaimedSnapshot(record: unknown | null, sessionScope: WalletProviderScope | null): void {
    for (const attached of this.attachedFundingSessions.values()) {
      attached.owner = null; attached.purpose = null; attached.request = null;
    }
    this.initialized = false; this.dirty = false; this.coordinatedRevision = null;
    this.lastPersistence = Promise.resolve(); this.authorityLost = null; this.sessionScope = sessionScope ? structuredClone(sessionScope) : null;
    if (this.hydrationState !== 'pending') this.resetHydration(false);
    this.hydrateFromDisk(record, true);
  }

  // prettier-ignore
  restore = (entries: unknown): void => { this.installHydrated(decodeWalletOperationEntries(entries, 'walletOperationRuntime')); this.resumeAll(); };

  private installHydrated(diskEntries: WalletOperationEntry[], replace = false): void {
    this.dispatch({ kind: 'hydrate', entries: diskEntries, replace });
    for (const entry of this.entries.values()) {
      if (
        entry.stage === 'best-effort-uncertain' ||
        entry.stage === 'best-effort-cancellation-uncertain'
      ) {
        this.inFlight.set(`restored:${walletOperationEntryKey(entry)}`, {
          promise: Promise.resolve(),
        });
      }
    }
    this.initialized = true;
    this.hydratedGeneration = this.lifecycle.generation();
  }

  // prettier-ignore
  snapshot = (): WalletOperationEntry[] => [...this.entries.values()].map((entry) => structuredClone(entry));

  // prettier-ignore
  checkpoint = (): WalletOperationCheckpoint => ({ entries: this.snapshot(), revision: this.revision });

  isDirty = (): boolean => this.dirty;

  // prettier-ignore
  persistIfDirty(): Promise<void> { if (this.dirty && this.coordinatedRevision === null) this.persistSnapshot(); return this.lastPersistence; }

  // prettier-ignore
  flushPersistence = (): Promise<void> => this.authorityLost ? Promise.reject(this.authorityLost) : this.lastPersistence;

  // prettier-ignore
  combinedCheckpointPersisted(checkpoint: WalletOperationCheckpoint): void {
    if (this.coordinatedRevision !== null && this.coordinatedRevision <= checkpoint.revision) this.coordinatedRevision = null;
    if (this.revision === checkpoint.revision) this.dirty = false; else this.persistIfDirty();
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

  // prettier-ignore
  entriesFor = (owner: WalletOperationOwner): WalletOperationEntry[] => entriesForOwner(this.snapshot(), owner);

  // prettier-ignore
  registerReserved(tradeId: string, owner: WalletOperationOwner, purpose: WalletOperationPurpose, reason = 'wallet-offer-created'): WalletOperationEntry {
    this.dispatch({ kind: 'reserve', key: walletOperationTradeKey(tradeId), owner, purpose, tradeId, reason });
    return structuredClone(this.trade(tradeId)!);
  }
  // prettier-ignore
  settleTrade(tradeId: string, disposition: 'consumed' | 'cancel-required' | 'retained-for-replay', reason: string, coordinated = false): void {
    this.dispatch({ kind: 'settle-obligation', target: { kind: 'trade', tradeId }, disposition, reason, coordinated }, coordinated);
  }
  // prettier-ignore
  settleOperation(owner: WalletOperationOwner, purpose: WalletOperationPurpose, disposition: 'consumed' | 'cancel-required' | 'retained-for-replay', reason: string, coordinated = false): void {
    this.dispatch({ kind: 'settle-obligation', target: { kind: 'operation', owner, purpose }, disposition, reason, coordinated }, coordinated);
  }
  // prettier-ignore
  retireOperation(owner: WalletOperationOwner, purpose: WalletOperationPurpose, reason: string, coordinated = false): void {
    this.dispatch({ kind: 'obligate-cleanup', target: { kind: 'operation', owner, purpose }, reason, coordinated, preserveReplay: false }, coordinated);
  }
  // prettier-ignore
  retireSession(installationPlayerId: string, peerSessionId: string, reason: string, coordinated = false): void {
    this.dispatch({ kind: 'obligate-cleanup', target: { kind: 'session', installationPlayerId, peerSessionId }, reason, coordinated, preserveReplay: true }, coordinated);
  }

  async createOffer(
    owner: WalletOperationOwner,
    purpose: WalletOperationPurpose,
    request: WalletOfferRequest,
    recoveryRequest: WalletOperationRecoveryRequest = request.kind === 'fee'
      ? request
      : (() => {
          throw new Error('Funding creation requires its canonical durable request');
        })(),
    isRetired: () => boolean = () => false,
  ): Promise<WalletOfferCompletion> {
    const generation = this.lifecycle.generation();
    await this.awaitHydrated();
    const provider = this.providerRegistry.provider(owner.providerScope);
    if (!provider)
      return {
        kind: 'unavailable',
        reason: 'Reconnect the original wallet account to resume this operation',
      };
    const key = walletOperationKey(owner, purpose);
    const completedKey = `completed:${key}`;
    const completed = this.inFlight.get(completedKey)?.completion;
    if (completed) {
      this.inFlight.delete(completedKey);
      return completed;
    }
    const current = entryForOperation(this.entries.values(), owner, purpose);
    if (current && current.stage !== 'creating' && current.stage !== 'best-effort-uncertain') {
      throw new Error('Wallet operation cleanup is pending for this operation');
    }
    return this.coalesce(`create:${key}`, () =>
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
    owner: WalletOperationOwner,
    purpose: WalletOperationPurpose,
    request: WalletOfferRequest,
    recoveryRequest: WalletOperationRecoveryRequest,
    isRetired: () => boolean,
    generation: number,
    replacement = false,
  ): Promise<WalletOfferCompletion> {
    const uncertaintyReason =
      provider.capability === 'best-effort'
        ? 'walletconnect-response-unavailable'
        : 'cloud-response-unavailable';
    const recovery = entryForOperation(this.entries.values(), owner, purpose);
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
      if (!isRecoverableProvider(provider)) {
        throw new Error('Wallet provider cannot reconcile persisted creation');
      }
    }
    let completion: WalletOfferBeginOutcome;
    try {
      if (exactRecovery) {
        completion = await this.providerMutation<WalletOfferBeginOutcome>(generation, () =>
          (
            provider as Extract<
              WalletOfferProvider,
              { capability: 'recoverable' | 'recoverable-after-begin' }
            >
          ).reconcileCreation({ owner, purpose }, request, exactRecovery.recoveryId),
        );
      } else {
        completion = await this.providerMutation<WalletOfferBeginOutcome>(generation, () =>
          provider.beginCreation({ owner, purpose }, request),
        );
      }
    } catch (error) {
      if (error instanceof StorageAuthorityLostError) {
        return { kind: 'unavailable', reason: 'Storage authority changed before wallet creation' };
      }
      if (exactRecovery || !canLosePreIdResponse(provider)) throw error;
      if (!replacement) {
        const retired = isRetired();
        // prettier-ignore
        this.recordUncertainty(owner, purpose, recoveryRequest, retired, uncertaintyReason, generation);
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
      // prettier-ignore
      this.recordUncertainty(owner, purpose, recoveryRequest, retired, uncertaintyReason, generation);
      return completion as WalletOfferCompletion;
    }
    if (completion.kind === 'pending') {
      const recoveryId = completion.recoveryId;
      if (!isRecoverableProvider(provider)) {
        throw new Error('Non-recoverable provider returned a recovery id');
      }
      if (!this.lifecycle.isCurrent(generation)) {
        this.transferToCurrent(owner, () => {
          const current = entryForOperation(this.entries.values(), owner, purpose);
          if (current?.stage === 'creating') return;
          const retired = isRetired();
          if (current?.stage === 'best-effort-uncertain') {
            this.transition(current, {
              kind: 'creation-recovery-identified',
              recoveryId,
              reason: 'wallet-offer-creation-recovery-identified-after-authority-change',
            });
          } else if (!current) {
            this.dispatch({
              kind: 'creation-pending',
              key: walletOperationRecoveryKey(owner, purpose),
              owner,
              purpose,
              recoveryId,
              request: recoveryRequest,
              reason: 'wallet-offer-creation-recovery-identified-after-authority-change',
              retired,
            });
          }
        });
        return { kind: 'unavailable', reason: 'Storage authority changed during wallet creation' };
      }
      const key = recovery
        ? walletOperationEntryKey(recovery)
        : walletOperationRecoveryKey(owner, purpose);
      this.dispatch(
        recovery?.stage === 'best-effort-uncertain'
          ? {
              kind: 'creation-recovery-identified',
              key,
              owner,
              purpose,
              recoveryId,
              reason: 'wallet-offer-creation-recovery-identified',
            }
          : {
              kind: 'creation-pending',
              key,
              owner,
              purpose,
              recoveryId,
              request: recoveryRequest,
              reason: 'wallet-offer-creation-pending',
              retired: isRetired(),
            },
      );
      await this.flushPersistence();
      if (!this.lifecycle.isCurrent(generation)) {
        return { kind: 'unavailable', reason: 'Storage authority changed during wallet creation' };
      }
      try {
        completion = await this.providerMutation(generation, () =>
          provider.reconcileCreation({ owner, purpose }, request, recoveryId),
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
    }
    if (!this.lifecycle.isCurrent(generation)) {
      if (completion.kind === 'created-reserved') {
        const reservedCompletion = completion;
        this.transferToCurrent(owner, () => {
          this.dispatch({
            kind: 'install',
            entry: {
              owner,
              purpose,
              stage: 'cancel-required',
              tradeId: reservedCompletion.tradeId,
              reason: 'stale-create-result',
              ...(recovery?.orphanRisk ? { orphanRisk: recovery.orphanRisk } : {}),
            },
          });
        });
      }
      return { kind: 'unavailable', reason: 'Storage authority changed during wallet creation' };
    }
    this.dispatch({
      kind: 'creation-result',
      owner,
      purpose,
      completion,
      reason: `${purpose.kind}-offer-created`,
    });
    const entry = completion.kind === 'created-reserved' ? this.trade(completion.tradeId) : null;
    if (entry?.orphanRisk && completion.kind === 'created-reserved') {
      const provider =
        entry.owner.providerScope.provider === 'cloud' ? 'Cloud Wallet' : 'WalletConnect';
      const warning = `${provider} lost the original create-offer response. A prior external reservation may still exist even though a later attempt succeeded.`;
      log(`[wallet-operation-runtime] ${warning} operation=${walletOperationKey(owner, purpose)}`);
      completion = { ...completion, warning };
    }
    if (entry && entry.stage === 'cancel-required') this.scheduleCancellation(entry.tradeId);
    return completion;
  }

  // prettier-ignore
  private recordUncertainty(owner: WalletOperationOwner, purpose: WalletOperationPurpose, request: WalletOperationRecoveryRequest, retired: boolean, reason: string, generation: number): void {
    if (!this.lifecycle.isCurrent(generation)) {
      this.transferToCurrent(owner, () => {
        if (entryForOperation(this.entries.values(), owner, purpose)) return;
        this.dispatch({
          kind: 'creation-uncertain',
          key: walletOperationRecoveryKey(owner, purpose),
          owner,
          purpose,
          request,
          generation: 0n,
          readinessEpoch: BigInt(this.providerRegistry.readinessEpoch(owner.providerScope)),
          retired,
          reason,
          orphanRisk: 'pre-id-response-lost',
        });
      });
      return;
    }
    if (entryForOperation(this.entries.values(), owner, purpose)) return;
    // prettier-ignore
    this.dispatch({ kind: 'creation-uncertain', key: walletOperationRecoveryKey(owner, purpose), owner, purpose, request, generation: 0n, readinessEpoch: BigInt(this.providerRegistry.readinessEpoch(owner.providerScope)), retired, reason, orphanRisk: 'pre-id-response-lost' });
    log(`[wallet-operation-runtime] create response lost; external reservation risk operation=${walletOperationKey(owner, purpose)}`);
  }

  attachFundingSink(
    installationPlayerId: string,
    peerSessionId: string,
    sink: FundingMaterialSink,
  ): () => void {
    const key = sessionKey(installationPlayerId, peerSessionId);
    const attached = { sink, owner: null, purpose: null, request: null };
    this.attachedFundingSessions.set(key, attached);
    this.restoreAttachedFunding(key);
    return () => {
      if (this.attachedFundingSessions.get(key) === attached) {
        this.attachedFundingSessions.delete(key);
      }
    };
  }

  queueFunding(
    installationPlayerId: string,
    peerSessionId: string,
    request: NeedCoinSpendRequest,
  ): void {
    const sinkKey = sessionKey(installationPlayerId, peerSessionId);
    const attached = this.attachedFundingSessions.get(sinkKey);
    if (!attached) throw new Error('Funding material sink is unavailable');
    const canonical = canonicalizeFundingRequest(request, 'WASM NeedCoinSpend request');
    const purpose = { kind: 'funding' as const, operationId: fundingRequestKey(canonical) };
    if (attached.purpose && attached.purpose.operationId !== purpose.operationId) {
      const message = `Internal protocol-state violation: received concurrent funding request ${purpose.operationId} while ${attached.purpose.operationId} is active`;
      attached.owner = null;
      attached.purpose = null;
      attached.request = null;
      attached.sink.walletFailed(message);
      throw new Error(message);
    }
    if (!attached.purpose) {
      attached.owner = attached.sink.getOwner();
      attached.purpose = purpose;
      attached.request = canonical;
    }
    this.scheduleFunding(sinkKey);
  }

  activateFundingSession(installationPlayerId: string, peerSessionId: string): void {
    const key = sessionKey(installationPlayerId, peerSessionId);
    this.restoreAttachedFunding(key);
    this.scheduleFunding(key);
  }

  private restoreAttachedFunding(sinkKey: string): void {
    const attached = this.attachedFundingSessions.get(sinkKey);
    if (!attached || !attached.sink.isReady() || this.hydrationState !== 'ready') return;
    const entry = restoredFundingForSink(this.snapshot(), sinkKey);
    if (!entry) return;
    attached.owner = entry.owner;
    attached.purpose = entry.purpose;
    attached.request = entry.request.canonical;
    this.scheduleFunding(sinkKey);
  }

  private scheduleFunding(sinkKey: string): void {
    const attached = this.attachedFundingSessions.get(sinkKey);
    if (
      !attached ||
      !attached.purpose ||
      !attached.request ||
      !attached.sink.isReady() ||
      attached.sink.isRetired()
    )
      return;
    attached.owner ??= attached.sink.getOwner();
    if (!attached.owner) return;
    const owner = attached.owner;
    const purpose = attached.purpose;
    const request = attached.request;
    const operation = entryForOperation(this.entries.values(), owner, purpose);
    if (operation && operation.stage !== 'creating') return;
    const generation = this.lifecycle.generation();
    const effect = attached.sink.releaseAfterPersistence(
      `funding:${purpose.operationId}`,
      async () => {
        if (!this.lifecycle.isCurrent(generation)) return;
        const recoveryRequest = { kind: 'funding' as const, canonical: request };
        const outcome = await this.createOffer(
          owner,
          purpose,
          providerRequestFromRecovery(owner, recoveryRequest),
          recoveryRequest,
          () => attached.sink.isRetired(),
        );
        await this.handleFundingOutcome(attached, outcome, generation);
      },
    );
    attached.sink.track(effect);
  }

  private async handleFundingOutcome(
    attached: AttachedFundingSession,
    outcome: WalletOfferCompletion,
    generation: number,
  ): Promise<void> {
    const { owner, purpose, sink } = attached;
    if (!owner || !purpose) return;
    if (outcome.kind === 'unavailable') {
      sink.requestCheckpoint();
      return;
    }
    if (outcome.kind === 'failure') {
      attached.owner = null;
      attached.purpose = null;
      attached.request = null;
      await sink.mutate(() => {
        sink.reportWarning(outcome.reason);
        sink.walletFailed(outcome.reason);
        sink.requestCheckpoint();
      });
      return;
    }
    if (!this.lifecycle.isCurrent(generation) || sink.isRetired()) {
      this.settleOperation(owner, purpose, 'cancel-required', 'funding-material-stale');
      sink.scheduleCleanup();
      sink.requestCheckpoint();
      return;
    }
    await sink.mutate(() => {
      try {
        if (outcome.warning) sink.reportWarning(outcome.warning);
        sink.materialDelivered(outcome.material);
        this.settleOperation(owner, purpose, 'consumed', 'funding-material-consumed', true);
        attached.owner = null;
        attached.purpose = null;
        attached.request = null;
        sink.requestCheckpoint();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        diagStack('handleNeedCoinSpend error', error);
        this.settleOperation(owner, purpose, 'cancel-required', 'funding-material-rejected', true);
        attached.owner = null;
        attached.purpose = null;
        attached.request = null;
        sink.reportWarning(message);
        sink.walletFailed(message);
        sink.scheduleCleanup();
        sink.requestCheckpoint();
      }
    });
  }

  retryCancelRequired(owner?: WalletOperationOwner): void {
    this.dispatch({ kind: 'resume', ...(owner ? { owner } : {}) });
  }

  launchCancellation(tradeId: string): Promise<void> {
    this.inFlight.delete(`coordinated:${tradeId}`);
    return this.scheduleCancellation(tradeId);
  }

  private scheduleCancellation(tradeId: string): Promise<void> {
    const entry = this.trade(tradeId);
    if (
      !entry ||
      (entry.stage !== 'cancel-required' &&
        entry.stage !== 'cancelling' &&
        entry.stage !== 'best-effort-cancellation-uncertain')
    )
      return Promise.resolve();
    if (!this.providerRegistry.provider(entry.owner.providerScope)) return Promise.resolve();
    const generation = this.lifecycle.generation();
    return this.coalesce(`cancel:${tradeId}`, () => this.performCancellation(entry, generation));
  }

  // prettier-ignore
  private async performCancellation(entry: WalletOperationTradeState, generation: number): Promise<void> {
    const provider = this.providerRegistry.provider(entry.owner.providerScope);
    if (!provider) return;
    try {
      let current = entry;
      let outcome: WalletOfferCancellationOutcome;
      if (entry.stage === 'cancelling') {
        if (!isRecoverableProvider(provider)) {
          throw new Error('Non-recoverable provider cannot own cancellation recovery');
        }
        outcome = await this.providerMutation(generation, () =>
          provider.reconcileCancellation(entry.tradeId, entry.recoveryId),
        );
      } else if (provider.capability === 'best-effort' || provider.capability === 'terminal') {
        outcome = await this.providerMutation(generation, () => provider.cancel(entry.tradeId));
      } else {
        let begun;
        try {
          // prettier-ignore
          begun = await this.providerMutation(generation, () => provider.beginCancellation(entry.tradeId));
        } catch (error) {
          if (error instanceof StorageAuthorityLostError) return;
          begun = { status: 'unavailable' as const, detail: String(error) };
        }
        if (!this.lifecycle.isCurrent(generation)) {
          if (begun.status === 'pending') {
            this.transferToCurrent(entry.owner, () => {
              const current = this.trade(entry.tradeId);
              if (current?.stage === 'cancel-required') {
                this.transition(current, {
                  kind: 'cancellation-pending',
                  recoveryId: begun.recoveryId,
                });
              }
            });
          // prettier-ignore
          } else if (begun.status === 'unavailable' && provider.capability === 'recoverable-after-begin' && entry.stage === 'cancel-required') {
            this.transferToCurrent(entry.owner, () => {
              const current = this.trade(entry.tradeId);
              if (current?.stage === 'cancel-required') {
                this.transition(current, {
                  kind: 'cancellation-uncertain',
                  readinessEpoch: BigInt(
                    this.providerRegistry.readinessEpoch(entry.owner.providerScope),
                  ),
                  reason: 'cloud-cancellation-response-lost-orphan-risk',
                });
              }
            });
          }
          return;
        }
        // prettier-ignore
        if (begun.status === 'unavailable' && provider.capability === 'recoverable-after-begin' && entry.stage === 'cancel-required') {
          this.transition(entry, {
            kind: 'cancellation-uncertain',
            readinessEpoch: BigInt(this.providerRegistry.readinessEpoch(entry.owner.providerScope)),
            reason: 'cloud-cancellation-response-lost-orphan-risk',
          });
          return;
        }
        if (begun.status === 'pending') {
          this.transition(entry, {
            kind:
              entry.stage === 'best-effort-cancellation-uncertain'
                ? 'cancellation-recovery-identified'
                : 'cancellation-pending',
            recoveryId: begun.recoveryId,
          });
          await this.flushPersistence();
          const identified = this.trade(entry.tradeId);
          if (identified?.stage !== 'cancelling') return;
          current = identified;
          outcome = await this.providerMutation(generation, () =>
            provider.reconcileCancellation(entry.tradeId, begun.recoveryId),
          );
        } else outcome = begun;
      }
      if (!this.lifecycle.isCurrent(generation) || this.trade(entry.tradeId) !== current) return;
      if (outcome.status === 'cancelled' || outcome.status === 'already-terminal') {
        this.transition(current, { kind: 'cancellation-completed' });
      } else if (
        outcome.status === 'rejected' &&
        (current.stage === 'cancelling' || current.stage === 'best-effort-cancellation-uncertain')
      ) {
        this.transition(current, { kind: 'cancellation-failed', reason: outcome.detail });
      }
    } catch (error) {
      log(`[wallet-operation-runtime] cancel threw trade_id=${entry.tradeId}: ${String(error)}`);
    }
  }

  // prettier-ignore
  private resumeAll(): void { if (this.hydrationState === 'failed') return; this.dispatch({ kind: 'resume' }); for (const key of this.attachedFundingSessions.keys()) this.restoreAttachedFunding(key); }

  private providerEvent(event: WalletProviderRegistryEvent): void {
    if (event.kind === 'detached') {
      this.notify();
      return;
    }
    const scope = walletProviderScopeKey(event.provider.scope);
    this.dispatch({ kind: 'resume', scope: event.provider.scope });
    for (const [key, attached] of this.attachedFundingSessions) {
      if (!attached.owner || walletProviderScopeKey(attached.owner.providerScope) === scope) {
        this.scheduleFunding(key);
      }
    }
    this.notify();
  }

  private scheduleExactRecovery(entry: WalletOperationRecoveryEntry): void {
    const provider = this.providerRegistry.provider(entry.owner.providerScope);
    if (!provider || !isRecoverableProvider(provider)) return;
    const key = walletOperationKey(entry.owner, entry.purpose);
    void this.coalesce(`recover:${key}`, async () => {
      const generation = this.lifecycle.generation();
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
    entry: WalletBestEffortUncertainEntry | WalletBestEffortCancellationUncertainEntry,
  ): void {
    const entryKey = walletOperationEntryKey(entry);
    const restoredKey = `restored:${entryKey}`;
    const restored = this.inFlight.has(restoredKey);
    const epoch = BigInt(this.providerRegistry.readinessEpoch(entry.owner.providerScope));
    if (epoch === 0n || (!restored && epoch <= entry.lastAttemptEpoch)) return;
    const flightKey =
      entry.stage === 'best-effort-cancellation-uncertain'
        ? `cancel:${entry.tradeId}`
        : `replace:${walletOperationKey(entry.owner, entry.purpose)}`;
    if (entry.stage === 'best-effort-cancellation-uncertain') {
      void this.coalesce(
        flightKey,
        async () => {
          const generation = this.lifecycle.generation();
          const current = this.trade(entry.tradeId);
          if (current?.stage !== 'best-effort-cancellation-uncertain') return;
          this.transition(current, {
            kind: 'uncertain-cancellation-attempt-launched',
            readinessEpoch: epoch,
            reason: current.reason,
            newRegistryGeneration: restored,
          });
          this.inFlight.delete(restoredKey);
          await this.flushPersistence();
          await this.performCancellation(this.trade(entry.tradeId)!, generation);
        },
        () => {
          const current = this.trade(entry.tradeId);
          if (current?.stage === 'best-effort-cancellation-uncertain')
            this.scheduleUncertain(current);
        },
        epoch,
      );
      return;
    }
    void this.coalesce(
      flightKey,
      () => this.launchUncertainCreation(entry, epoch, restored, restoredKey),
      () => {
        const current = entryForOperation(this.entries.values(), entry.owner, entry.purpose);
        if (current?.stage === 'best-effort-uncertain') this.scheduleUncertain(current);
      },
      epoch,
    );
  }

  private async launchUncertainCreation(
    entry: WalletBestEffortUncertainEntry,
    epoch: bigint,
    restored: boolean,
    restoredKey: string,
  ): Promise<void> {
    const recovery = entryForOperation(this.entries.values(), entry.owner, entry.purpose);
    if (recovery?.stage !== 'best-effort-uncertain') return;
    this.transition(recovery, {
      kind: 'uncertain-attempt-launched',
      readinessEpoch: epoch,
      reason: recovery.reason,
      newRegistryGeneration: restored,
    });
    this.inFlight.delete(restoredKey);
    await this.flushPersistence();
    const provider = this.providerRegistry.provider(entry.owner.providerScope);
    if (!provider || !canLosePreIdResponse(provider)) return;
    const generation = this.lifecycle.generation();
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
    if (completed.kind !== 'created-reserved' || !this.lifecycle.isCurrent(generation)) return;
    await this.routeCompletion(entry, completed, generation);
  }

  private async routeCompletion(
    entry: WalletBestEffortUncertainEntry | WalletOperationRecoveryEntry,
    completed: Extract<WalletOfferCompletion, { kind: 'created-reserved' }>,
    generation: number,
  ): Promise<void> {
    const key = walletOperationKey(entry.owner, entry.purpose);
    if (entry.purpose.kind !== 'funding') {
      this.inFlight.set(`completed:${key}`, { promise: Promise.resolve(), completion: completed });
      return;
    }
    const sinkKey = sessionKey(entry.owner.installationPlayerId, entry.owner.peerSessionId);
    const attached = this.attachedFundingSessions.get(sinkKey);
    if (attached?.purpose) await this.handleFundingOutcome(attached, completed, generation);
    else
      this.inFlight.set(`completed:${key}`, { promise: Promise.resolve(), completion: completed });
  }

  async awaitOwner(owner: WalletOperationOwner): Promise<void> {
    await Promise.resolve();
    for (;;) {
      const entries = this.snapshot();
      const pending = [...this.inFlight.entries()]
        .filter(([key]) => flightBelongsToOwner(key, entries, owner))
        .map(([, flight]) => flight.promise);
      if (pending.length === 0) return;
      await Promise.allSettled(pending);
    }
  }

  private dispatch(command: WalletOperationCommand, coordinated = false): void {
    const reduction = reduceWalletOperation(this.entries.values(), command);
    this.entries = new Map(
      reduction.nextState.map((entry) => [walletOperationEntryKey(entry), entry]),
    );
    if (reduction.effects.some((effect) => effect.kind === 'persist')) {
      this.markDirty(coordinated);
    }
    for (const effect of reduction.effects) {
      if (effect.kind === 'persist') {
        if (this.coordinatedRevision === null) this.persistSnapshot();
      } else if (effect.kind === 'notify') this.notify();
      else if (effect.kind === 'cancel') {
        if (effect.coordinated) {
          this.inFlight.set(`coordinated:${effect.tradeId}`, { promise: Promise.resolve() });
        } else if (!this.inFlight.has(`coordinated:${effect.tradeId}`)) {
          this.scheduleCancellation(effect.tradeId);
        }
      } else if (effect.kind === 'funding') {
        const key = sessionKey(effect.installationPlayerId, effect.peerSessionId);
        this.restoreAttachedFunding(key);
        this.scheduleFunding(key);
      } else {
        const entry = this.entries.get(effect.key);
        if (effect.kind === 'recover' && entry?.stage === 'creating') {
          this.scheduleExactRecovery(entry);
        } else if (
          effect.kind === 'uncertain' &&
          (entry?.stage === 'best-effort-uncertain' ||
            entry?.stage === 'best-effort-cancellation-uncertain')
        ) {
          this.scheduleUncertain(entry);
        }
      }
    }
  }

  // prettier-ignore
  private transition(entry: WalletOperationEntry, transition: WalletOperationTransition, coordinated = false): void {
    this.dispatch({ ...transition, key: walletOperationEntryKey(entry), owner: entry.owner, purpose: entry.purpose }, coordinated);
  }

  // prettier-ignore
  private trade(tradeId: string): WalletOperationTradeState | null {
    const entry = this.entries.get(walletOperationTradeKey(tradeId)); return entry && entry.stage !== 'creating' && entry.stage !== 'best-effort-uncertain' ? entry : null;
  }

  // prettier-ignore
  private markDirty(coordinated = false): void { this.dirty = true; this.revision += 1; if (coordinated) this.coordinatedRevision = this.revision; }

  private persistSnapshot(): void {
    if (!this.persist) return;
    const snapshot = this.snapshot();
    const revision = this.revision;
    const generation = this.lifecycle.generation();
    this.lastPersistence = this.persist(snapshot).then(
      () => {
        if (this.lifecycle.isCurrent(generation) && this.revision === revision) this.dirty = false;
      },
      (error) => {
        this.dirty = true;
        if (error instanceof StorageAuthorityLostError) {
          this.authorityLost = error;
          throw error;
        }
        log(`[wallet-operation-runtime] persistence failed: ${String(error)}`);
      },
    );
  }

  // prettier-ignore
  private async providerMutation<T>(generation: number, effect: () => Promise<T>): Promise<T> {
    await this.flushPersistence(); if (!this.lifecycle.isCurrent(generation)) throw new StorageAuthorityLostError(); return effect();
  }

  private coalesce<T>(
    key: string,
    launch: () => Promise<T>,
    resume?: () => void,
    epoch?: bigint,
  ): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) {
      if (
        epoch !== undefined &&
        (existing.pendingEpoch === undefined || epoch > existing.pendingEpoch)
      )
        existing.pendingEpoch = epoch;
      return existing.promise as Promise<T>;
    }
    const flight: WalletOperationFlight = {
      promise: Promise.resolve()
        .then(launch)
        .finally(() => {
          if (this.inFlight.get(key) === flight) this.inFlight.delete(key);
          if (flight.pendingEpoch !== undefined) resume?.();
        }),
    };
    this.inFlight.set(key, flight);
    return flight.promise as Promise<T>;
  }

  private transferToCurrent(owner: WalletOperationOwner, apply: () => void): void {
    const generation = this.lifecycle.generation();
    if (this.hydratedGeneration !== generation && this.hydrationState === 'ready') {
      this.resetHydration(false);
    }
    void this.awaitHydrated()
      .then(() => {
        const key = `transfer:${walletOperationOwnerKey(owner)}`;
        const existing = this.inFlight.get(key);
        if (existing) return existing.promise;
        const promise = (async () => {
          if (!this.lifecycle.isCurrent(generation)) return;
          if (
            !this.sessionScope ||
            walletProviderScopeKey(this.sessionScope) !==
              walletProviderScopeKey(owner.providerScope)
          ) {
            throw new Error(
              'Internal wallet consistency error: stale wallet response scope does not match the saved session',
            );
          }
          apply();
          await this.flushPersistence();
          if (this.lifecycle.isCurrent(generation)) this.resumeAll();
        })();
        const flight: WalletOperationFlight = { promise };
        this.inFlight.set(key, flight);
        const cleanup = () => {
          if (this.inFlight.get(key) === flight) this.inFlight.delete(key);
        };
        void promise.then(cleanup, cleanup);
        return promise;
      })
      .catch((error) => {
        if (!(error instanceof StorageAuthorityLostError)) {
          log(`[wallet-operation-runtime] stale response transfer failed: ${String(error)}`);
        }
      });
  }

  // prettier-ignore
  private notify(): void { for (const listener of this.listeners) listener(); }
  // prettier-ignore
  // prettier-ignore
  private retireTransientWork(): void {
    this.inFlight.clear();
    for (const attached of this.attachedFundingSessions.values()) {
      attached.owner = null;
      attached.purpose = null;
      attached.request = null;
    }
  }

  private reset(hard: boolean, hydrated: boolean): void {
    this.providerRegistry.clear();
    this.entries.clear();
    this.retireTransientWork();
    this.attachedFundingSessions.clear();
    this.sessionScope = null;
    this.hydratedGeneration = hydrated ? this.lifecycle.generation() : null;
    if (!hard) this.listeners.clear();
    this.initialized = hard;
    this.dirty = false;
    this.coordinatedRevision = null;
    this.revision = hard ? this.revision + 1 : 0;
    this.lastPersistence = Promise.resolve();
    this.authorityLost = null;
    this.resetHydration(hydrated);
    if (hard) this.notify();
  }
  // prettier-ignore
  clearForHardReset(): void { this.reset(true, true); }
  // prettier-ignore
  resetForTests(hydrated = true): void { this.reset(false, hydrated); }

  // prettier-ignore
  private resetHydration(ready: boolean): void {
    this.hydrationState = ready ? 'ready' : 'pending'; this.hydrationPromise = new Promise<void>((resolve, reject) => { this.hydrationResolve = resolve; this.hydrationReject = reject; });
    void this.hydrationPromise.catch(() => {}); if (ready) this.hydrationResolve();
  }
}

export const walletOperationRuntime = new WalletOperationRuntime(walletProviderRegistry);
