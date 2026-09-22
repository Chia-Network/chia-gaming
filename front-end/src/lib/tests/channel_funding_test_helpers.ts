import { storageRepository } from '../session/storageRepository';
import {
  type ChannelFundingEntry,
  type ChannelFundingOwner,
  type ChannelFundingPurpose,
} from '../session/channelFundingStore';

export function installAwaitingChannelFunding(
  providerReservationId: string,
  owner: ChannelFundingOwner,
  purpose: ChannelFundingPurpose,
  reason = 'wallet-offer-created',
): ChannelFundingEntry {
  const entry: ChannelFundingEntry = {
    owner,
    purpose,
    stage: 'awaiting-channel',
    providerReservationId,
    request: {
      kind: 'funding',
      canonical: { amount: '0', fee: '0', conditions: [] },
    },
    reason,
  };
  storageRepository.replaceChannelFunding([...storageRepository.channelFundingOperations(), entry]);
  return structuredClone(entry);
}
