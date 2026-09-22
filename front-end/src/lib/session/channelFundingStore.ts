import type { WalletOfferOperation } from '../../types/ChiaGaming';
import type { CanonicalFundingRequest } from './fundingRequest';
import { providerOwnerKey } from './providerKeys';

export type ChannelFundingOwner = WalletOfferOperation['owner'];
export type ChannelFundingPurpose = Extract<WalletOfferOperation['purpose'], { kind: 'funding' }>;
export type ChannelFundingRecoveryRequest = {
  kind: 'funding';
  canonical: CanonicalFundingRequest;
};

export interface ChannelFundingEntryBase {
  owner: ChannelFundingOwner;
  purpose: ChannelFundingPurpose;
  reason: string;
  orphanRisk?: 'pre-id-response-lost';
}

export type ChannelFundingRecoveryEntry = ChannelFundingEntryBase & {
  stage: 'creating';
  disposition: 'active' | 'cancel-on-create';
  recoveryId: string;
  request: ChannelFundingRecoveryRequest;
};
export type ChannelFundingUncertainEntry = ChannelFundingEntryBase & {
  stage: 'best-effort-uncertain';
  disposition: 'active' | 'cancel-on-create';
  request: ChannelFundingRecoveryRequest;
  lastAttemptEpoch: bigint;
};
export type ChannelFundingAwaitingEntry = ChannelFundingEntryBase & {
  stage: 'awaiting-channel';
  providerReservationId: string;
  request: ChannelFundingRecoveryRequest;
};
export type ChannelFundingCancellationUncertainEntry = ChannelFundingEntryBase & {
  stage: 'best-effort-cancellation-uncertain';
  providerReservationId: string;
  lastAttemptEpoch: bigint;
};
export type ChannelFundingCancellationEntry = ChannelFundingEntryBase & {
  stage: 'cancelling';
  providerReservationId: string;
  recoveryId: string;
};
export type ChannelFundingCancelRequiredEntry = ChannelFundingEntryBase & {
  stage: 'cancel-required';
  providerReservationId: string;
};
export type ChannelFundingEntry =
  | ChannelFundingRecoveryEntry
  | ChannelFundingUncertainEntry
  | ChannelFundingAwaitingEntry
  | ChannelFundingCancelRequiredEntry
  | ChannelFundingCancellationUncertainEntry
  | ChannelFundingCancellationEntry;
export type ChannelFundingTradeState = Exclude<
  ChannelFundingEntry,
  ChannelFundingRecoveryEntry | ChannelFundingUncertainEntry
>;

export const MAX_CHANNEL_FUNDING_REASON_LENGTH = 256;
export type ChannelFundingEntryKey = string & {
  readonly __channelFundingEntryKey: unique symbol;
};

function tupleKey(parts: readonly string[]): string {
  return parts.map((part) => `${part.length}:${part}`).join('');
}
export function channelFundingKey(
  owner: ChannelFundingOwner,
  purpose: ChannelFundingPurpose,
): string {
  return tupleKey([providerOwnerKey(owner), purpose.operationId]);
}
function channelFundingRecoveryKey(
  owner: ChannelFundingOwner,
  purpose: ChannelFundingPurpose,
): ChannelFundingEntryKey {
  return `operation:${channelFundingKey(owner, purpose)}` as ChannelFundingEntryKey;
}
export function channelFundingTradeKey(id: string): ChannelFundingEntryKey {
  return `reservation:${id}` as ChannelFundingEntryKey;
}
export function channelFundingEntryKey(entry: ChannelFundingEntry): ChannelFundingEntryKey {
  return entry.stage === 'creating' || entry.stage === 'best-effort-uncertain'
    ? channelFundingRecoveryKey(entry.owner, entry.purpose)
    : channelFundingTradeKey(entry.providerReservationId);
}
