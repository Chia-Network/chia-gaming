import type { WalletOfferProvider } from '../../types/ChiaGaming';
import { log } from '../../services/log';
import type { ChannelFundingEntry } from './channelFundingStore';
import type { FeeAttachment } from './feeAttachmentStore';
import type { DurableApplicationState } from './saveEnvelope';
import { walletProviderRegistry } from './walletProviderRegistry';
import { isRecoverableProvider } from './providerCapabilities';
import { providerRequestFromRecovery } from './channelFundingSelectors';
import { providerScopeKey } from './providerKeys';
import { storageRepository } from './storageRepository';

/** Once replay is discarded, provider cancellation is best effort, not session debt. */
export function retireWalletReservations(
  state: DurableApplicationState,
  peerSessionId?: string,
): DurableApplicationState {
  const retired = (entry: ChannelFundingEntry | FeeAttachment) =>
    peerSessionId === undefined || entry.owner.peerSessionId === peerSessionId;
  cancelRetiredWalletReservations(
    [...state.channelFundingOperations, ...state.feeAttachments].filter(retired),
  );
  return {
    ...state,
    channelFundingOperations: state.channelFundingOperations.filter((entry) => !retired(entry)),
    feeAttachments: state.feeAttachments.filter((entry) => !retired(entry)),
  };
}

export function cancelRetiredWalletReservations(
  entries: readonly (ChannelFundingEntry | FeeAttachment)[],
): void {
  for (const entry of entries) {
    const provider = walletProviderRegistry.provider(entry.owner.providerScope);
    if (provider)
      // Let the retirement mutation remove its entries before checking live ownership.
      void Promise.resolve()
        .then(() => cancelReservation(provider, entry))
        .catch((error) => {
          log(`[wallet-retirement] best-effort cancellation failed: ${String(error)}`);
        });
  }
}

async function cancelReservation(
  provider: WalletOfferProvider,
  entry: ChannelFundingEntry | FeeAttachment,
): Promise<void> {
  if (entry.stage === 'best-effort-uncertain') return;
  let id: string;
  if (entry.stage === 'creating') {
    if (!isRecoverableProvider(provider)) return;
    const request =
      'submissionId' in entry
        ? entry.request
        : providerRequestFromRecovery(entry.owner, entry.request);
    const purpose =
      'submissionId' in entry
        ? { kind: 'fee' as const, operationId: entry.submissionId }
        : entry.purpose;
    const outcome = await provider.reconcileCreation(
      { owner: entry.owner, purpose },
      request,
      entry.recoveryId,
    );
    if (outcome.kind !== 'created-reserved') return;
    id = outcome.tradeId;
  } else {
    id = entry.providerReservationId;
  }
  if (hasLiveReservation(provider, id)) return;
  let outcome =
    entry.stage === 'cancelling' && isRecoverableProvider(provider)
      ? await provider.reconcileCancellation(id, entry.recoveryId)
      : provider.capability === 'best-effort' || provider.capability === 'terminal'
        ? await provider.cancel(id)
        : await provider.beginCancellation(id);
  if (outcome.status === 'pending' && isRecoverableProvider(provider)) {
    if (hasLiveReservation(provider, id)) return;
    outcome = await provider.reconcileCancellation(id, outcome.recoveryId);
  }
  if (outcome.status !== 'cancelled' && outcome.status !== 'already-terminal') {
    log(
      `[wallet-retirement] best-effort cancellation incomplete reservation=${id} status=${outcome.status}`,
    );
  }
}

function hasLiveReservation(provider: WalletOfferProvider, id: string): boolean {
  const state = storageRepository.loadState();
  return [...state.channelFundingOperations, ...state.feeAttachments].some(
    (entry) =>
      entry.stage !== 'creating' &&
      entry.stage !== 'best-effort-uncertain' &&
      entry.providerReservationId === id &&
      providerScopeKey(entry.owner.providerScope) === providerScopeKey(provider.scope),
  );
}
