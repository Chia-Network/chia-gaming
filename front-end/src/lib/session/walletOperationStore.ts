import type {
  WalletOfferMaterial,
  WalletOfferCompletion,
  WalletOfferOperation,
  WalletOfferRequest,
  WalletProviderScope,
} from '../../types/ChiaGaming';
import type { CanonicalFundingRequest } from './fundingRequest';
import { jsonStringify } from '../../util/jsonSafe';

export type WalletOperationOwner = WalletOfferOperation['owner'];
export type WalletOperationPurpose = WalletOfferOperation['purpose'];

export interface WalletOperationLifecycle {
  generation(): number;
  isCurrent(generation: number): boolean;
}

export interface WalletOperationCheckpoint {
  entries: WalletOperationEntry[];
  revision: number;
}

export interface FundingMaterialSink {
  getOwner(): WalletOperationOwner | null;
  isReady(): boolean;
  isRetired(): boolean;
  releaseAfterPersistence(key: string, effect: () => Promise<void>): Promise<void>;
  mutate<T>(work: () => T): Promise<T>;
  materialDelivered(material: WalletOfferMaterial): void;
  walletFailed(message: string): void;
  reportWarning(message: string): void;
  requestCheckpoint(): void;
  scheduleCleanup(): void;
  track(effect: Promise<void>): void;
}

export interface FundingDemand {
  owner: WalletOperationOwner | null;
  purpose: Extract<WalletOperationPurpose, { kind: 'funding' }>;
  request: CanonicalFundingRequest;
  sinkKey: string;
  scheduledGeneration: number | null;
  launched: boolean;
}

export interface WalletOperationFlight {
  promise: Promise<unknown>;
  pendingEpoch?: bigint;
  completion?: WalletOfferCompletion;
}

export type WalletOperationStage =
  | 'creating'
  | 'best-effort-uncertain'
  | 'reserved'
  | 'retained-for-replay'
  | 'cancel-required'
  | 'best-effort-cancellation-uncertain'
  | 'cancelling';

export interface WalletOperationEntryBase {
  owner: WalletOperationOwner;
  purpose: WalletOperationPurpose;
  reason: string;
  orphanRisk?: 'pre-id-response-lost';
}

export type WalletOperationRecoveryEntry = WalletOperationEntryBase & {
  stage: 'creating';
  disposition: 'active' | 'cancel-on-create';
  recoveryId: string;
  request: WalletOperationRecoveryRequest;
};

export type WalletBestEffortUncertainEntry = WalletOperationEntryBase & {
  stage: 'best-effort-uncertain';
  disposition: 'active' | 'cancel-on-create';
  request: WalletOperationRecoveryRequest;
  generation: bigint;
  lastAttemptEpoch: bigint;
};

export type WalletOperationRecoveryRequest =
  | { kind: 'funding'; canonical: CanonicalFundingRequest }
  | Extract<WalletOfferRequest, { kind: 'fee' }>;

export type WalletOperationTradeEntry = WalletOperationEntryBase & {
  stage: Exclude<
    WalletOperationStage,
    'creating' | 'best-effort-uncertain' | 'best-effort-cancellation-uncertain' | 'cancelling'
  >;
  tradeId: string;
};

export type WalletBestEffortCancellationUncertainEntry = WalletOperationEntryBase & {
  stage: 'best-effort-cancellation-uncertain';
  tradeId: string;
  generation: bigint;
  lastAttemptEpoch: bigint;
};

export type WalletOperationCancellationEntry = WalletOperationEntryBase & {
  stage: 'cancelling';
  tradeId: string;
  recoveryId: string;
};

export type WalletOperationEntry =
  | WalletOperationRecoveryEntry
  | WalletBestEffortUncertainEntry
  | WalletOperationTradeEntry
  | WalletBestEffortCancellationUncertainEntry
  | WalletOperationCancellationEntry;
export type WalletOperationTradeState = Exclude<
  WalletOperationEntry,
  WalletOperationRecoveryEntry | WalletBestEffortUncertainEntry
>;

export const MAX_WALLET_OPERATION_REASON_LENGTH = 256;

export type WalletOperationEntryKey = string & {
  readonly __walletOperationEntryKey: unique symbol;
};

function tupleKey(parts: readonly string[]): string {
  return parts.map((part) => `${part.length}:${part}`).join('');
}

export function walletOperationRecoveryKey(
  owner: WalletOperationOwner,
  purpose: WalletOperationPurpose,
): WalletOperationEntryKey {
  return `operation:${walletOperationKey(owner, purpose)}` as WalletOperationEntryKey;
}

export function walletOperationTradeKey(tradeId: string): WalletOperationEntryKey {
  return `trade:${tradeId}` as WalletOperationEntryKey;
}

export function walletOperationEntryKey(entry: WalletOperationEntry): WalletOperationEntryKey {
  if (entry.stage === 'creating' || entry.stage === 'best-effort-uncertain') {
    return walletOperationRecoveryKey(entry.owner, entry.purpose);
  }
  return walletOperationTradeKey(entry.tradeId);
}

export function walletOperationKey(
  owner: WalletOperationOwner,
  purpose: WalletOperationPurpose,
): string {
  return tupleKey([walletOperationOwnerKey(owner), purpose.kind, purpose.operationId]);
}

export function walletOperationOwnerPrefix(owner: WalletOperationOwner): string {
  const ownerKey = walletOperationOwnerKey(owner);
  return `${ownerKey.length}:${ownerKey}`;
}

export function walletOperationOwnerKey(owner: WalletOperationOwner): string {
  return tupleKey([
    owner.installationPlayerId,
    owner.peerSessionId,
    walletProviderScopeKey(owner.providerScope),
  ]);
}

export function walletProviderScopeKey(scope: WalletProviderScope): string {
  switch (scope.provider) {
    case 'cloud':
      return tupleKey(['cloud', scope.walletId]);
    case 'walletconnect':
      return tupleKey(['walletconnect', scope.fingerprint, scope.chainId]);
    case 'simulator':
      return tupleKey(['simulator', scope.identity]);
  }
}

export type WalletOperationTransition =
  | { kind: 'retire'; reason: string }
  | {
      kind: 'creation-pending';
      recoveryId: string;
      request: WalletOperationRecoveryRequest;
      reason: string;
      retired: boolean;
    }
  | {
      kind: 'creation-uncertain';
      request: WalletOperationRecoveryRequest;
      generation: bigint;
      readinessEpoch: bigint;
      reason: string;
      retired: boolean;
      orphanRisk?: 'pre-id-response-lost';
    }
  | {
      kind: 'uncertain-attempt-launched';
      readinessEpoch: bigint;
      reason: string;
      newRegistryGeneration?: boolean;
    }
  | { kind: 'creation-unavailable'; reason: string }
  | { kind: 'creation-rejected' }
  | { kind: 'creation-completed'; tradeId?: string; reason: string }
  | { kind: 'creation-recovery-identified'; recoveryId: string; reason: string }
  | { kind: 'reserve'; tradeId: string; reason: string }
  | { kind: 'stale-result'; tradeId: string; reason: string }
  | { kind: 'consume' }
  | { kind: 'retain-for-replay'; reason: string }
  | { kind: 'require-cancellation'; reason: string }
  | { kind: 'cancellation-pending'; recoveryId: string }
  | { kind: 'cancellation-uncertain'; readinessEpoch: bigint; reason: string }
  | {
      kind: 'uncertain-cancellation-attempt-launched';
      readinessEpoch: bigint;
      reason: string;
      newRegistryGeneration?: boolean;
    }
  | { kind: 'cancellation-recovery-identified'; recoveryId: string }
  | { kind: 'cancellation-unavailable'; reason: string }
  | { kind: 'cancellation-failed'; reason: string }
  | { kind: 'cancellation-completed' };

export type WalletOperationState = Iterable<WalletOperationEntry>;

export type WalletOperationHandoffEvidence =
  | {
      kind: 'creation-recovery';
      owner: WalletOperationOwner;
      purpose: WalletOperationPurpose;
      recoveryId: string;
      request: WalletOperationRecoveryRequest;
      disposition: 'active' | 'cancel-on-create';
      reason: string;
      orphanRisk?: 'pre-id-response-lost';
    }
  | {
      kind: 'creation-uncertainty';
      owner: WalletOperationOwner;
      purpose: WalletOperationPurpose;
      request: WalletOperationRecoveryRequest;
      disposition: 'active' | 'cancel-on-create';
      readinessEpoch: bigint;
      reason: string;
      orphanRisk: 'pre-id-response-lost';
    }
  | {
      kind: 'created-trade';
      owner: WalletOperationOwner;
      purpose: WalletOperationPurpose;
      tradeId: string;
      reason: string;
      orphanRisk?: 'pre-id-response-lost';
    }
  | {
      kind: 'cancellation-recovery';
      owner: WalletOperationOwner;
      purpose: WalletOperationPurpose;
      tradeId: string;
      recoveryId: string;
    }
  | {
      kind: 'cancellation-uncertainty';
      owner: WalletOperationOwner;
      purpose: WalletOperationPurpose;
      tradeId: string;
      readinessEpoch: bigint;
      reason: string;
    };

export type WalletOperationCommand =
  | { kind: 'hydrate'; entries: readonly WalletOperationEntry[]; replace: boolean }
  | { kind: 'handoff-evidence'; evidence: WalletOperationHandoffEvidence }
  | { kind: 'install'; entry: WalletOperationEntry }
  | { kind: 'remove'; key: WalletOperationEntryKey }
  | {
      kind: 'settle';
      owner: WalletOperationOwner;
      purpose: WalletOperationPurpose;
      disposition: 'consumed' | 'cancel-required' | 'retained-for-replay';
      reason: string;
      coordinated: boolean;
    }
  | {
      kind: 'settle-trade';
      tradeId: string;
      disposition: 'consumed' | 'cancel-required' | 'retained-for-replay';
      reason: string;
      coordinated: boolean;
    }
  | {
      kind: 'retire-session';
      installationPlayerId: string;
      peerSessionId: string;
      reason: string;
      coordinated: boolean;
    }
  | {
      kind: 'creation-result';
      owner: WalletOperationOwner;
      purpose: WalletOperationPurpose;
      completion: WalletOfferCompletion;
      reason: string;
    }
  | {
      kind: 'resume';
      scope?: WalletProviderScope;
      owner?: WalletOperationOwner;
    }
  | (WalletOperationTransition & {
      key: WalletOperationEntryKey;
      owner: WalletOperationOwner;
      purpose: WalletOperationPurpose;
    });

export type WalletOperationEffect =
  | { kind: 'persist' }
  | { kind: 'notify' }
  | { kind: 'cancel'; tradeId: string; coordinated: boolean }
  | { kind: 'recover'; key: WalletOperationEntryKey }
  | { kind: 'funding'; installationPlayerId: string; peerSessionId: string }
  | { kind: 'uncertain'; key: WalletOperationEntryKey };

export interface WalletOperationReduction {
  nextState: WalletOperationEntry[];
  effects: WalletOperationEffect[];
}

function operationReason(reason: string): string {
  return reason.slice(0, MAX_WALLET_OPERATION_REASON_LENGTH);
}

export function walletOperationHandoffKey(evidence: WalletOperationHandoffEvidence): string {
  if (evidence.kind === 'creation-recovery' || evidence.kind === 'creation-uncertainty') {
    return walletOperationRecoveryKey(evidence.owner, evidence.purpose);
  }
  return walletOperationTradeKey(evidence.tradeId);
}

function entryFromHandoff(evidence: WalletOperationHandoffEvidence): WalletOperationEntry {
  const common = {
    owner: evidence.owner,
    purpose: evidence.purpose,
    reason: operationReason(
      'reason' in evidence ? evidence.reason : 'wallet-operation-evidence-handoff',
    ),
  };
  switch (evidence.kind) {
    case 'creation-recovery':
      return {
        ...common,
        stage: 'creating',
        disposition: evidence.disposition,
        recoveryId: evidence.recoveryId,
        request: structuredClone(evidence.request),
        ...(evidence.orphanRisk ? { orphanRisk: evidence.orphanRisk } : {}),
      };
    case 'creation-uncertainty':
      return {
        ...common,
        stage: 'best-effort-uncertain',
        disposition: evidence.disposition,
        request: structuredClone(evidence.request),
        generation: 0n,
        lastAttemptEpoch: evidence.readinessEpoch,
        orphanRisk: evidence.orphanRisk,
      };
    case 'created-trade':
      return {
        ...common,
        stage: 'cancel-required',
        tradeId: evidence.tradeId,
        ...(evidence.orphanRisk ? { orphanRisk: evidence.orphanRisk } : {}),
      };
    case 'cancellation-recovery':
      return {
        ...common,
        stage: 'cancelling',
        tradeId: evidence.tradeId,
        recoveryId: evidence.recoveryId,
      };
    case 'cancellation-uncertainty':
      return {
        ...common,
        stage: 'best-effort-cancellation-uncertain',
        tradeId: evidence.tradeId,
        generation: 0n,
        lastAttemptEpoch: evidence.readinessEpoch,
      };
  }
}

/**
 * The sole exhaustive durable wallet-operation reducer. Runtime code owns
 * mutable maps and interprets effects, but cannot manufacture a stage.
 */
export function reduceWalletOperation(
  state: WalletOperationState,
  command: WalletOperationCommand,
): WalletOperationReduction {
  let nextState = [...state];
  const remove = (key: WalletOperationEntryKey): boolean => {
    const index = nextState.findIndex((entry) => walletOperationEntryKey(entry) === key);
    if (index < 0) return false;
    nextState.splice(index, 1);
    return true;
  };
  const install = (entry: WalletOperationEntry): void => {
    const operation = walletOperationKey(entry.owner, entry.purpose);
    for (const current of nextState) {
      if (
        walletOperationEntryKey(current) === walletOperationEntryKey(entry) ||
        walletOperationKey(current.owner, current.purpose) !== operation
      ) {
        continue;
      }
      const recovery = current.stage === 'creating' || current.stage === 'best-effort-uncertain';
      const incomingRecovery =
        entry.stage === 'creating' || entry.stage === 'best-effort-uncertain';
      const cancellation =
        current.stage === 'cancel-required' ||
        current.stage === 'best-effort-cancellation-uncertain' ||
        current.stage === 'cancelling';
      const incomingCancellation =
        entry.stage === 'cancel-required' ||
        entry.stage === 'best-effort-cancellation-uncertain' ||
        entry.stage === 'cancelling';
      if (
        recovery !== incomingRecovery &&
        !((recovery && incomingCancellation) || (incomingRecovery && cancellation))
      ) {
        throw new Error('Wallet operation cannot own recovery and trade stages together');
      }
    }
    remove(walletOperationEntryKey(entry));
    nextState.push(structuredClone(entry));
  };
  if (command.kind === 'hydrate') {
    nextState = command.replace ? [] : nextState.map((entry) => structuredClone(entry));
    let dirty = false;
    for (const diskEntry of command.entries) {
      const conflict = nextState.some(
        (entry) => walletOperationEntryKey(entry) === walletOperationEntryKey(diskEntry),
      );
      if (conflict) continue;
      if (diskEntry.stage === 'reserved') {
        const promoted = reduceWalletOperation([diskEntry], {
          kind: 'require-cancellation',
          key: walletOperationEntryKey(diskEntry),
          owner: diskEntry.owner,
          purpose: diskEntry.purpose,
          reason: 'orphaned-reservation-restored',
        }).nextState[0]!;
        install(promoted);
        dirty = true;
      } else install(diskEntry);
    }
    return {
      nextState,
      effects: dirty ? [{ kind: 'persist' }, { kind: 'notify' }] : [{ kind: 'notify' }],
    };
  }
  if (command.kind === 'handoff-evidence') {
    const evidence = command.evidence;
    const incoming = entryFromHandoff(evidence);
    let accepted = incoming;
    const otherOwner = nextState.some(
      (entry) =>
        entry.owner.installationPlayerId === incoming.owner.installationPlayerId &&
        entry.owner.peerSessionId === incoming.owner.peerSessionId &&
        walletOperationOwnerKey(entry.owner) !== walletOperationOwnerKey(incoming.owner),
    );
    if (otherOwner) throw new Error('Wallet evidence belongs to another hydrated owner');
    const key = walletOperationEntryKey(incoming);
    const current = nextState.find((entry) => walletOperationEntryKey(entry) === key) ?? null;
    if (evidence.kind === 'creation-recovery' || evidence.kind === 'creation-uncertainty') {
      if (incoming.stage !== 'creating' && incoming.stage !== 'best-effort-uncertain') {
        throw new Error('Invalid wallet creation handoff evidence');
      }
      if (current) {
        if (
          (current.stage !== 'creating' && current.stage !== 'best-effort-uncertain') ||
          jsonStringify(current.request) !== jsonStringify(incoming.request) ||
          current.disposition !== incoming.disposition ||
          current.orphanRisk !== incoming.orphanRisk ||
          (current.stage === 'creating' &&
            incoming.stage === 'creating' &&
            current.recoveryId !== incoming.recoveryId)
        ) {
          throw new Error('Wallet creation evidence conflicts with hydrated recovery');
        }
        if (current.stage === 'best-effort-uncertain' && incoming.stage === 'creating') {
          install(incoming);
          return { nextState, effects: [{ kind: 'persist' }, { kind: 'notify' }] };
        }
        return { nextState, effects: [] };
      }
    } else if (evidence.kind === 'created-trade') {
      if (current) {
        if (
          walletOperationKey(current.owner, current.purpose) !==
          walletOperationKey(incoming.owner, incoming.purpose)
        ) {
          throw new Error('Created trade evidence conflicts with hydrated trade');
        }
        return { nextState, effects: [] };
      }
    } else {
      if (
        !current ||
        current.stage === 'creating' ||
        current.stage === 'best-effort-uncertain' ||
        walletOperationKey(current.owner, current.purpose) !==
          walletOperationKey(incoming.owner, incoming.purpose)
      ) {
        throw new Error('Cancellation evidence has no matching hydrated trade');
      }
      if (current.stage === 'cancelling') {
        if (
          evidence.kind === 'cancellation-recovery' &&
          current.recoveryId !== evidence.recoveryId
        ) {
          throw new Error('Cancellation evidence conflicts with hydrated recovery');
        }
        return { nextState, effects: [] };
      }
      if (current.stage === 'best-effort-cancellation-uncertain') {
        if (evidence.kind === 'cancellation-uncertainty') {
          return { nextState, effects: [] };
        }
      } else if (current.stage !== 'cancel-required') {
        throw new Error('Cancellation evidence conflicts with hydrated trade stage');
      }
      accepted =
        evidence.kind === 'cancellation-recovery'
          ? { ...current, stage: 'cancelling', recoveryId: evidence.recoveryId }
          : {
              ...current,
              stage: 'best-effort-cancellation-uncertain',
              generation: 0n,
              lastAttemptEpoch: evidence.readinessEpoch,
              reason: operationReason(evidence.reason),
            };
    }
    install(accepted);
    return { nextState, effects: [{ kind: 'persist' }, { kind: 'notify' }] };
  }
  if (command.kind === 'install') {
    install(command.entry);
    return { nextState, effects: [{ kind: 'persist' }, { kind: 'notify' }] };
  }
  if (command.kind === 'remove') {
    return {
      nextState,
      effects: remove(command.key) ? [{ kind: 'persist' }, { kind: 'notify' }] : [],
    };
  }
  if (command.kind === 'settle') {
    const operation = walletOperationKey(command.owner, command.purpose);
    const effects: WalletOperationEffect[] = [];
    let changed = false;
    for (const entry of [...nextState]) {
      if (
        walletOperationKey(entry.owner, entry.purpose) !== operation ||
        entry.stage === 'creating' ||
        entry.stage === 'best-effort-uncertain'
      ) {
        continue;
      }
      const transition: WalletOperationTransition =
        command.disposition === 'consumed'
          ? { kind: 'consume' }
          : command.disposition === 'cancel-required'
            ? { kind: 'require-cancellation', reason: command.reason }
            : { kind: 'retain-for-replay', reason: command.reason };
      const reduced = reduceWalletOperation(nextState, {
        ...transition,
        key: walletOperationEntryKey(entry),
        owner: entry.owner,
        purpose: entry.purpose,
      });
      if (reduced.effects.length === 0) continue;
      nextState = reduced.nextState;
      changed = true;
      if (command.disposition === 'cancel-required') {
        effects.push({ kind: 'cancel', tradeId: entry.tradeId, coordinated: command.coordinated });
      }
    }
    return {
      nextState,
      effects: changed ? [{ kind: 'persist' }, { kind: 'notify' }, ...effects] : [],
    };
  }
  if (command.kind === 'settle-trade') {
    const current = nextState.find(
      (entry) =>
        entry.stage !== 'creating' &&
        entry.stage !== 'best-effort-uncertain' &&
        entry.tradeId === command.tradeId,
    );
    if (!current) return { nextState, effects: [] };
    const transition: WalletOperationTransition =
      command.disposition === 'consumed'
        ? { kind: 'consume' }
        : command.disposition === 'cancel-required'
          ? { kind: 'require-cancellation', reason: command.reason }
          : { kind: 'retain-for-replay', reason: command.reason };
    const reduced = reduceWalletOperation(nextState, {
      ...transition,
      key: walletOperationEntryKey(current),
      owner: current.owner,
      purpose: current.purpose,
    });
    if (reduced.effects.length && command.disposition === 'cancel-required') {
      reduced.effects.push({
        kind: 'cancel',
        tradeId: command.tradeId,
        coordinated: command.coordinated,
      });
    }
    return reduced;
  }
  if (command.kind === 'retire-session') {
    const effects: WalletOperationEffect[] = [];
    let changed = false;
    for (const entry of [...nextState]) {
      if (
        entry.owner.installationPlayerId !== command.installationPlayerId ||
        entry.owner.peerSessionId !== command.peerSessionId ||
        entry.stage === 'retained-for-replay'
      ) {
        continue;
      }
      const reduced = reduceWalletOperation(nextState, {
        kind: 'retire',
        key: walletOperationEntryKey(entry),
        owner: entry.owner,
        purpose: entry.purpose,
        reason: command.reason,
      });
      if (reduced.effects.length === 0) continue;
      nextState = reduced.nextState;
      changed = true;
      if (
        entry.stage !== 'creating' &&
        entry.stage !== 'best-effort-uncertain' &&
        !command.coordinated
      ) {
        effects.push({ kind: 'cancel', tradeId: entry.tradeId, coordinated: false });
      }
    }
    return {
      nextState,
      effects: changed ? [{ kind: 'persist' }, { kind: 'notify' }, ...effects] : [],
    };
  }
  if (command.kind === 'creation-result') {
    const current =
      nextState.find(
        (entry) =>
          walletOperationKey(entry.owner, entry.purpose) ===
          walletOperationKey(command.owner, command.purpose),
      ) ?? null;
    if (!current && command.completion.kind !== 'created') {
      return { nextState, effects: [] };
    }
    const key = current
      ? walletOperationEntryKey(current)
      : command.completion.kind === 'created' && command.completion.tradeId
        ? walletOperationTradeKey(command.completion.tradeId)
        : walletOperationRecoveryKey(command.owner, command.purpose);
    const transition: WalletOperationTransition =
      command.completion.kind === 'unavailable'
        ? { kind: 'creation-unavailable', reason: command.completion.reason }
        : command.completion.kind === 'failure'
          ? { kind: 'creation-rejected' }
          : {
              kind: 'creation-completed',
              tradeId: command.completion.tradeId,
              reason: command.reason,
            };
    return reduceWalletOperation(nextState, {
      ...transition,
      key,
      owner: command.owner,
      purpose: command.purpose,
    });
  }
  if (command.kind === 'resume') {
    const scope = command.scope ? walletProviderScopeKey(command.scope) : null;
    const owner = command.owner ? walletOperationOwnerKey(command.owner) : null;
    const effects: WalletOperationEffect[] = [];
    for (const entry of nextState) {
      if (
        (scope && walletProviderScopeKey(entry.owner.providerScope) !== scope) ||
        (owner && walletOperationOwnerKey(entry.owner) !== owner)
      ) {
        continue;
      }
      if (entry.stage === 'cancel-required' || entry.stage === 'cancelling') {
        effects.push({ kind: 'cancel', tradeId: entry.tradeId, coordinated: false });
      } else if (entry.stage === 'creating') {
        if (entry.disposition === 'cancel-on-create') {
          effects.push({ kind: 'recover', key: walletOperationEntryKey(entry) });
        } else if (entry.purpose.kind === 'funding') {
          effects.push({
            kind: 'funding',
            installationPlayerId: entry.owner.installationPlayerId,
            peerSessionId: entry.owner.peerSessionId,
          });
        }
      } else if (
        entry.stage === 'best-effort-uncertain' ||
        entry.stage === 'best-effort-cancellation-uncertain'
      ) {
        effects.push({ kind: 'uncertain', key: walletOperationEntryKey(entry) });
      }
    }
    return { nextState, effects };
  }

  const current = nextState.find((entry) => walletOperationEntryKey(entry) === command.key) ?? null;
  const owner = command.owner;
  const purpose = command.purpose;
  const common = { owner, purpose };
  const provenance = current?.orphanRisk ? { orphanRisk: current.orphanRisk } : {};
  const transitioned: WalletOperationEntry | null = (() => {
    switch (command.kind) {
      case 'creation-pending':
        if (current !== null && current.stage !== 'creating') {
          throw new Error('Creation launch requires an empty or creating operation');
        }
        return {
          ...common,
          ...(current?.orphanRisk ? { orphanRisk: current.orphanRisk } : {}),
          stage: 'creating',
          disposition:
            current?.disposition === 'cancel-on-create' || command.retired
              ? 'cancel-on-create'
              : 'active',
          recoveryId: command.recoveryId,
          request: structuredClone(command.request),
          reason: operationReason(command.reason),
        } satisfies WalletOperationEntry;
      case 'creation-uncertain':
        if (current !== null) throw new Error('Uncertain creation requires an empty operation');
        return {
          ...common,
          stage: 'best-effort-uncertain',
          disposition: command.retired ? 'cancel-on-create' : 'active',
          request: structuredClone(command.request),
          generation: command.generation,
          lastAttemptEpoch: command.readinessEpoch,
          reason: operationReason(command.reason),
          ...(command.orphanRisk ? { orphanRisk: command.orphanRisk } : {}),
        } satisfies WalletOperationEntry;
      case 'uncertain-attempt-launched':
        if (current?.stage !== 'best-effort-uncertain') {
          throw new Error('Replacement launch requires best-effort uncertainty');
        }
        if (!command.newRegistryGeneration && command.readinessEpoch <= current.lastAttemptEpoch) {
          return current;
        }
        return {
          ...current,
          generation: current.generation + 1n,
          lastAttemptEpoch: command.readinessEpoch,
          reason: operationReason(command.reason),
        };
      case 'creation-unavailable':
        if (current?.stage !== 'creating' && current?.stage !== 'best-effort-uncertain') {
          return current;
        }
        return { ...current, reason: operationReason(command.reason) };
      case 'creation-rejected':
        if (current?.stage !== 'creating' && current?.stage !== 'best-effort-uncertain') {
          throw new Error('Creation rejection requires an active creation');
        }
        return null;
      case 'creation-completed': {
        if (current?.stage !== 'creating' && current?.stage !== 'best-effort-uncertain') {
          if (current !== null) throw new Error('Creation completion requires an active creation');
          if (!command.tradeId) return null;
          return {
            ...common,
            stage: 'reserved',
            tradeId: command.tradeId,
            reason: operationReason(command.reason),
          } satisfies WalletOperationEntry;
        }
        if (!command.tradeId) return null;
        return {
          ...common,
          ...provenance,
          stage: current.disposition === 'cancel-on-create' ? 'cancel-required' : 'reserved',
          tradeId: command.tradeId,
          reason: operationReason(command.reason),
        } satisfies WalletOperationEntry;
      }
      case 'creation-recovery-identified':
        if (current?.stage !== 'best-effort-uncertain') {
          throw new Error('Creation recovery identification requires best-effort uncertainty');
        }
        return {
          ...common,
          ...provenance,
          stage: 'creating',
          disposition: current.disposition,
          recoveryId: command.recoveryId,
          request: current.request,
          reason: operationReason(command.reason),
        } satisfies WalletOperationEntry;
      case 'reserve':
        if (current !== null) {
          if (
            current.stage === 'creating' ||
            current.stage === 'best-effort-uncertain' ||
            walletOperationKey(current.owner, current.purpose) !==
              walletOperationKey(owner, purpose)
          ) {
            throw new Error('Reservation conflicts with another wallet operation');
          }
          return current;
        }
        return {
          ...common,
          stage: 'reserved',
          tradeId: command.tradeId,
          reason: operationReason(command.reason),
        } satisfies WalletOperationEntry;
      case 'stale-result':
        if (current !== null) {
          if (
            current.stage !== 'reserved' &&
            current.stage !== 'retained-for-replay' &&
            current.stage !== 'cancel-required' &&
            current.stage !== 'cancelling'
          ) {
            throw new Error('Stale result conflicts with an active creation');
          }
          if (current.tradeId !== command.tradeId) {
            throw new Error('Stale result conflicts with another trade');
          }
        }
        return {
          ...common,
          ...provenance,
          stage: 'cancel-required',
          tradeId: command.tradeId,
          reason: operationReason(command.reason),
        } satisfies WalletOperationEntry;
      case 'consume':
        if (current === null) return null;
        if (
          current.stage === 'creating' ||
          current.stage === 'best-effort-uncertain' ||
          current.stage === 'best-effort-cancellation-uncertain'
        ) {
          throw new Error('Cannot consume an incomplete creation');
        }
        return null;
      case 'retain-for-replay':
        if (
          current?.stage !== 'reserved' &&
          current?.stage !== 'retained-for-replay' &&
          current?.stage !== 'cancel-required'
        ) {
          throw new Error('Replay retention requires a trade');
        }
        return {
          ...current,
          stage: 'retained-for-replay',
          reason: operationReason(command.reason),
        };
      case 'retire':
        if (current === null || current.stage === 'retained-for-replay') return current;
        if (current.stage === 'creating' || current.stage === 'best-effort-uncertain') {
          return {
            ...current,
            disposition: 'cancel-on-create',
            reason: operationReason(command.reason),
          };
        }
        if (current.stage === 'best-effort-cancellation-uncertain') {
          return { ...current, reason: operationReason(command.reason) };
        }
        return {
          ...common,
          ...provenance,
          stage: 'cancel-required',
          tradeId: current.tradeId,
          reason: operationReason(command.reason),
        } satisfies WalletOperationEntry;
      case 'require-cancellation':
        if (current === null) return null;
        if (current.stage === 'creating' || current.stage === 'best-effort-uncertain') {
          return {
            ...current,
            disposition: 'cancel-on-create',
            reason: operationReason(command.reason),
          };
        }
        if (current.stage === 'best-effort-cancellation-uncertain') {
          return { ...current, reason: operationReason(command.reason) };
        }
        return {
          ...common,
          ...provenance,
          stage: 'cancel-required',
          tradeId: current.tradeId,
          reason: operationReason(command.reason),
        } satisfies WalletOperationEntry;
      case 'cancellation-pending':
        if (current?.stage !== 'cancel-required') {
          throw new Error('Pending cancellation requires cancel-required state');
        }
        return { ...current, stage: 'cancelling', recoveryId: command.recoveryId };
      case 'cancellation-uncertain':
        if (current?.stage !== 'cancel-required') {
          throw new Error('Uncertain cancellation requires cancel-required state');
        }
        return {
          ...current,
          stage: 'best-effort-cancellation-uncertain',
          generation: 0n,
          lastAttemptEpoch: command.readinessEpoch,
          reason: operationReason(command.reason),
        };
      case 'uncertain-cancellation-attempt-launched':
        if (current?.stage !== 'best-effort-cancellation-uncertain') {
          throw new Error('Cancellation replacement requires best-effort uncertainty');
        }
        if (!command.newRegistryGeneration && command.readinessEpoch <= current.lastAttemptEpoch) {
          return current;
        }
        return {
          ...current,
          generation: current.generation + 1n,
          lastAttemptEpoch: command.readinessEpoch,
          reason: operationReason(command.reason),
        };
      case 'cancellation-recovery-identified':
        if (current?.stage !== 'best-effort-cancellation-uncertain') {
          throw new Error('Cancellation recovery identification requires best-effort uncertainty');
        }
        return { ...current, stage: 'cancelling', recoveryId: command.recoveryId };
      case 'cancellation-unavailable':
        if (current?.stage !== 'best-effort-cancellation-uncertain') return current;
        return { ...current, reason: operationReason(command.reason) };
      case 'cancellation-failed':
        if (
          current?.stage !== 'cancelling' &&
          current?.stage !== 'best-effort-cancellation-uncertain'
        ) {
          throw new Error('Cancellation failure requires cancelling state');
        }
        return {
          ...common,
          ...provenance,
          stage: 'cancel-required',
          tradeId: current.tradeId,
          reason: operationReason(command.reason),
        } satisfies WalletOperationEntry;
      case 'cancellation-completed':
        if (
          current?.stage !== 'cancel-required' &&
          current?.stage !== 'best-effort-cancellation-uncertain' &&
          current?.stage !== 'cancelling'
        ) {
          throw new Error('Cancellation completion requires cancellation state');
        }
        return null;
    }
  })();
  if (transitioned === current) return { nextState, effects: [] };
  remove(command.key);
  if (transitioned) install(transitioned);
  return { nextState, effects: [{ kind: 'persist' }, { kind: 'notify' }] };
}
