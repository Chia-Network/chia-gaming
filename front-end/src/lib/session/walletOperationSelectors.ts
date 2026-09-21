import {
  walletOperationKey,
  walletOperationOwnerKey,
  walletProviderScopeKey,
  type WalletOperationEntry,
  type WalletOperationOwner,
  type WalletOperationPurpose,
  type WalletOperationRecoveryEntry,
  type WalletOperationRecoveryRequest,
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
  if (key === `transfer:${ownerKey}`) return true;
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
