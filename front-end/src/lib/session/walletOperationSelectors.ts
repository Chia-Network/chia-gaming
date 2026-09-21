import {
  walletOperationKey,
  walletOperationOwnerKey,
  walletProviderScopeKey,
  type WalletOperationEntry,
  type WalletOperationHandoffEvidence,
  type WalletOperationOwner,
  type WalletOperationPurpose,
  type WalletOperationRecoveryEntry,
  type WalletOperationRecoveryRequest,
  type WalletOperationTradeState,
} from './walletOperationStore';
import type { WalletOfferProvider, WalletOfferRequest } from '../../types/ChiaGaming';
import type { CanonicalFundingRequest } from './fundingRequest';

export function walletSessionKey(installationPlayerId: string, peerSessionId: string): string {
  return `${installationPlayerId.length}:${installationPlayerId}${peerSessionId.length}:${peerSessionId}`;
}

export function providerRequestFromRecovery(
  owner: WalletOperationOwner,
  request: WalletOperationRecoveryRequest,
): WalletOfferRequest {
  if (request.kind === 'fee') return structuredClone(request);
  const canonical = request.canonical;
  return {
    kind: 'funding',
    uniqueId: owner.installationPlayerId,
    offer: { '1': -BigInt(canonical.amount) },
    extraConditions: canonical.conditions.map(({ opcode, args }) => ({ opcode, args: [...args] })),
    ...(canonical.coin_id === undefined ? {} : { coinIds: [canonical.coin_id] }),
    ...(canonical.max_height === undefined ? {} : { maxHeight: BigInt(canonical.max_height) }),
    openingFee: BigInt(canonical.fee),
  };
}

export function restoredFundingForSink(
  entries: readonly WalletOperationEntry[],
  sinkKey: string,
):
  | (WalletOperationRecoveryEntry & {
      purpose: Extract<WalletOperationPurpose, { kind: 'funding' }>;
      request: { kind: 'funding'; canonical: CanonicalFundingRequest };
    })
  | null {
  const matches = entries.filter(
    (
      entry,
    ): entry is WalletOperationRecoveryEntry & {
      purpose: Extract<WalletOperationPurpose, { kind: 'funding' }>;
      request: { kind: 'funding'; canonical: CanonicalFundingRequest };
    } =>
      entry.stage === 'creating' &&
      entry.disposition === 'active' &&
      entry.purpose.kind === 'funding' &&
      entry.request.kind === 'funding' &&
      walletSessionKey(entry.owner.installationPlayerId, entry.owner.peerSessionId) === sinkKey,
  );
  if (matches.length > 1) throw new Error('Conflicting restored funding recoveries');
  return matches[0] ?? null;
}

export function flightBelongsToOwner(
  key: string,
  entries: readonly WalletOperationEntry[],
  owner: WalletOperationOwner,
): boolean {
  if (
    key.startsWith('restored:') ||
    key.startsWith('completed:') ||
    key.startsWith('coordinated:')
  ) {
    return false;
  }
  const ownerKey = walletOperationOwnerKey(owner);
  if (key.startsWith('cancel:')) {
    const tradeId = key.slice(7);
    return entries.some(
      (entry) =>
        entry.stage !== 'creating' &&
        entry.stage !== 'best-effort-uncertain' &&
        entry.tradeId === tradeId &&
        walletOperationOwnerKey(entry.owner) === ownerKey,
    );
  }
  return entries.some(
    (entry) =>
      walletOperationOwnerKey(entry.owner) === ownerKey &&
      key.includes(walletOperationKey(entry.owner, entry.purpose)),
  );
}

export function isRecoverableProvider(
  provider: WalletOfferProvider,
): provider is Extract<
  WalletOfferProvider,
  { capability: 'recoverable' | 'recoverable-after-begin' }
> {
  return provider.capability === 'recoverable' || provider.capability === 'recoverable-after-begin';
}

export function canLosePreIdResponse(provider: WalletOfferProvider): boolean {
  return provider.capability === 'best-effort' || provider.capability === 'recoverable-after-begin';
}

export function creationRecoveryHandoff(
  owner: WalletOperationOwner,
  purpose: WalletOperationPurpose,
  request: WalletOperationRecoveryRequest,
  recoveryId: string,
  recovery: WalletOperationEntry | null,
  retired: boolean,
): WalletOperationHandoffEvidence {
  return {
    kind: 'creation-recovery',
    owner,
    purpose,
    request,
    recoveryId,
    disposition:
      (recovery && 'disposition' in recovery && recovery.disposition === 'cancel-on-create') ||
      retired
        ? 'cancel-on-create'
        : 'active',
    reason: 'wallet-offer-creation-recovery-identified-after-authority-change',
    ...(recovery?.orphanRisk ? { orphanRisk: recovery.orphanRisk } : {}),
  };
}

export function creationUncertaintyHandoff(
  owner: WalletOperationOwner,
  purpose: WalletOperationPurpose,
  request: WalletOperationRecoveryRequest,
  recovery: WalletOperationEntry | null,
  retired: boolean,
  readinessEpoch: bigint,
  reason: string,
): WalletOperationHandoffEvidence {
  return {
    kind: 'creation-uncertainty',
    owner,
    purpose,
    request,
    disposition:
      (recovery && 'disposition' in recovery && recovery.disposition === 'cancel-on-create') ||
      retired
        ? 'cancel-on-create'
        : 'active',
    readinessEpoch,
    reason,
    orphanRisk: 'pre-id-response-lost',
  };
}

export function cancellationRecoveryHandoff(
  entry: WalletOperationTradeState,
  recoveryId: string,
): WalletOperationHandoffEvidence {
  return {
    kind: 'cancellation-recovery',
    owner: entry.owner,
    purpose: entry.purpose,
    tradeId: entry.tradeId,
    recoveryId,
  };
}

export function cancellationUncertaintyHandoff(
  entry: WalletOperationTradeState,
  readinessEpoch: bigint,
): WalletOperationHandoffEvidence {
  return {
    kind: 'cancellation-uncertainty',
    owner: entry.owner,
    purpose: entry.purpose,
    tradeId: entry.tradeId,
    readinessEpoch,
    reason: 'cloud-cancellation-response-lost-orphan-risk',
  };
}

export function entryForOperation(
  entries: Iterable<WalletOperationEntry>,
  owner: WalletOperationOwner,
  purpose: WalletOperationPurpose,
): WalletOperationEntry | null {
  const key = walletOperationKey(owner, purpose);
  const matches = [...entries].filter(
    (entry) => walletOperationKey(entry.owner, entry.purpose) === key,
  );
  const recovery = matches.filter(
    (entry) => entry.stage === 'creating' || entry.stage === 'best-effort-uncertain',
  );
  if (recovery.length > 1) {
    throw new Error('Wallet operation contains contradictory recovery entries');
  }
  return recovery[0] ?? matches[0] ?? null;
}

export function entriesForOwner(
  entries: readonly WalletOperationEntry[],
  owner: WalletOperationOwner,
): WalletOperationEntry[] {
  const key = walletOperationOwnerKey(owner);
  return entries.filter((entry) => walletOperationOwnerKey(entry.owner) === key);
}

export function ownerForSession(
  entries: readonly WalletOperationEntry[],
  installationPlayerId: string,
  peerSessionId: string,
): WalletOperationOwner | null {
  const owners = entries
    .filter(
      (entry) =>
        entry.owner.installationPlayerId === installationPlayerId &&
        entry.owner.peerSessionId === peerSessionId,
    )
    .map((entry) => entry.owner);
  const unique = owners.filter(
    (owner, index) =>
      owners.findIndex(
        (candidate) => walletOperationOwnerKey(candidate) === walletOperationOwnerKey(owner),
      ) === index,
  );
  if (unique.length > 1) {
    throw new Error('Wallet operations for one session span multiple provider scopes');
  }
  const owner = unique[0];
  return owner ? structuredClone(owner) : null;
}

export function recoveryReadiness(
  entries: readonly WalletOperationEntry[],
  scopeKeys: ReadonlySet<string>,
): 'ready' | 'wallet-unavailable' | 'scope-mismatch' {
  if (entries.length === 0) return 'ready';
  if (scopeKeys.size === 0) return 'wallet-unavailable';
  return entries.some((entry) => !scopeKeys.has(walletProviderScopeKey(entry.owner.providerScope)))
    ? 'scope-mismatch'
    : 'ready';
}

export function scopeStatus(
  entries: readonly WalletOperationEntry[],
  scopeKeys: ReadonlySet<string>,
  installationPlayerId: string,
  peerSessionId: string,
): { kind: 'ready' } | { kind: 'unavailable' } | { kind: 'mismatch' } {
  const relevant = entries.filter(
    (entry) =>
      entry.owner.installationPlayerId === installationPlayerId &&
      entry.owner.peerSessionId === peerSessionId,
  );
  if (relevant.length === 0) return { kind: 'ready' };
  if (scopeKeys.size === 0) return { kind: 'unavailable' };
  return relevant.every((entry) => scopeKeys.has(walletProviderScopeKey(entry.owner.providerScope)))
    ? { kind: 'ready' }
    : { kind: 'mismatch' };
}
