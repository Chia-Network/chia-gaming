import type {
  WalletOfferBeginOutcome,
  WalletOfferCancellationBeginOutcome,
  WalletOfferOperation,
  WalletOfferProvider,
  WalletOfferRequest,
} from '../../types/ChiaGaming';
import { log } from '../../services/log';
import { StorageAuthorityLostError } from './indexedDb';
import { isRecoverableProvider } from './providerCapabilities';
import { storageRepository } from './storageRepository';

export interface ProviderFlight {
  promise: Promise<unknown>;
  pendingEpoch?: bigint;
}

export function coalesceProviderFlight<T>(
  flights: Map<string, ProviderFlight>,
  key: string,
  launch: () => Promise<T>,
  resume?: () => void,
  epoch?: bigint,
): Promise<T> {
  const existing = flights.get(key);
  if (existing) {
    if (
      epoch !== undefined &&
      (existing.pendingEpoch === undefined || epoch > existing.pendingEpoch)
    ) {
      existing.pendingEpoch = epoch;
    }
    return existing.promise as Promise<T>;
  }
  const flight: ProviderFlight = {
    ...(epoch === undefined ? {} : { pendingEpoch: epoch }),
    promise: Promise.resolve()
      .then(launch)
      .finally(() => {
        if (flights.get(key) === flight) flights.delete(key);
        if (flight.pendingEpoch !== undefined) resume?.();
      }),
  };
  flights.set(key, flight);
  return flight.promise as Promise<T>;
}

async function checkpoint(generation: number): Promise<void> {
  try {
    await storageRepository.flushAggregate();
  } catch (error) {
    if (error instanceof StorageAuthorityLostError) throw error;
    log(`[provider-execution] aggregate persistence failed: ${String(error)}`);
  }
  if (!storageRepository.isGenerationCurrent(generation)) throw new StorageAuthorityLostError();
}

export async function advanceProviderCreation(
  generation: number,
  provider: WalletOfferProvider,
  operation: WalletOfferOperation,
  request: WalletOfferRequest,
  recoveryId?: string,
): Promise<WalletOfferBeginOutcome> {
  await checkpoint(generation);
  if (recoveryId === undefined) return provider.beginCreation(operation, request);
  if (!isRecoverableProvider(provider)) {
    throw new Error('Provider cannot reconcile persisted creation');
  }
  return provider.reconcileCreation(operation, request, recoveryId);
}

export async function advanceProviderCancellation(
  generation: number,
  provider: WalletOfferProvider,
  providerReservationId: string,
  recoveryId?: string,
): Promise<WalletOfferCancellationBeginOutcome> {
  await checkpoint(generation);
  if (recoveryId !== undefined) {
    if (!isRecoverableProvider(provider)) {
      throw new Error('Provider cannot reconcile persisted cancellation');
    }
    return provider.reconcileCancellation(providerReservationId, recoveryId);
  }
  if (provider.capability === 'best-effort' || provider.capability === 'terminal') {
    return provider.cancel(providerReservationId);
  }
  return provider.beginCancellation(providerReservationId);
}

export async function checkpointProviderState(generation: number): Promise<void> {
  await checkpoint(generation);
}
