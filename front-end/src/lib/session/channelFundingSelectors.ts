import {
  channelFundingKey,
  type ChannelFundingEntry,
  type ChannelFundingOwner,
  type ChannelFundingPurpose,
  type ChannelFundingRecoveryEntry,
  type ChannelFundingRecoveryRequest,
} from './channelFundingStore';
import type { WalletOfferRequest } from '../../types/ChiaGaming';
import type { CanonicalFundingRequest } from './fundingRequest';
import { providerOwnerKey, providerScopeKey } from './providerKeys';

export function walletSessionKey(installationPlayerId: string, peerSessionId: string): string {
  return `${installationPlayerId.length}:${installationPlayerId}${peerSessionId.length}:${peerSessionId}`;
}

export function providerRequestFromRecovery(
  owner: ChannelFundingOwner,
  request: ChannelFundingRecoveryRequest,
): WalletOfferRequest {
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
  entries: readonly ChannelFundingEntry[],
  sinkKey: string,
):
  | (ChannelFundingRecoveryEntry & {
      purpose: Extract<ChannelFundingPurpose, { kind: 'funding' }>;
      request: { kind: 'funding'; canonical: CanonicalFundingRequest };
    })
  | null {
  const matches = entries.filter(
    (
      entry,
    ): entry is ChannelFundingRecoveryEntry & {
      purpose: Extract<ChannelFundingPurpose, { kind: 'funding' }>;
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

export function entryForOperation(
  entries: Iterable<ChannelFundingEntry>,
  owner: ChannelFundingOwner,
  purpose: ChannelFundingPurpose,
): ChannelFundingEntry | null {
  const key = channelFundingKey(owner, purpose);
  const matches = [...entries].filter(
    (entry) => channelFundingKey(entry.owner, entry.purpose) === key,
  );
  const recovery = matches.filter(
    (entry) => entry.stage === 'creating' || entry.stage === 'best-effort-uncertain',
  );
  if (recovery.length > 1) {
    throw new Error('Channel funding contains contradictory recovery entries');
  }
  return recovery[0] ?? matches[0] ?? null;
}

export function entriesForOwner(
  entries: readonly ChannelFundingEntry[],
  owner: ChannelFundingOwner,
): ChannelFundingEntry[] {
  const key = providerOwnerKey(owner);
  return entries.filter((entry) => providerOwnerKey(entry.owner) === key);
}

export function recoveryReadiness(
  entries: ReadonlyArray<Pick<ChannelFundingEntry, 'owner'>>,
  scopeKeys: ReadonlySet<string>,
): 'ready' | 'wallet-unavailable' | 'scope-mismatch' {
  if (entries.length === 0) return 'ready';
  if (scopeKeys.size === 0) return 'wallet-unavailable';
  return entries.some((entry) => !scopeKeys.has(providerScopeKey(entry.owner.providerScope)))
    ? 'scope-mismatch'
    : 'ready';
}
