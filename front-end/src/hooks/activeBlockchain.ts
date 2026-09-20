import { InternalBlockchainInterface } from '../types/ChiaGaming';
import { BlockchainPoller } from './BlockchainPoller';
import { walletReservationCoordinator } from '../lib/session/walletReservationLedger';
import { hydrateWalletReservationLedger } from './save';

let active: BlockchainPoller | null = null;
let activeWalletProvider: ReturnType<InternalBlockchainInterface['getWalletOfferProvider']> = null;
let walletProviderUnsubscribe: (() => void) | null = null;

function clearWalletProvider(): void {
  if (!activeWalletProvider) return;
  walletReservationCoordinator.detachProvider(activeWalletProvider);
  activeWalletProvider = null;
}

function refreshWalletProvider(): void {
  if (!active) return;
  const next = active.rpc.getWalletOfferProvider();
  if (next === activeWalletProvider) {
    if (next) walletReservationCoordinator.providerReady(next);
    return;
  }
  if (activeWalletProvider) walletReservationCoordinator.detachProvider(activeWalletProvider);
  activeWalletProvider = next;
  if (next) walletReservationCoordinator.attachProvider(next);
}

export function activate(
  blockchain: InternalBlockchainInterface,
  pollIntervalMs: number,
): BlockchainPoller {
  if (active) {
    clearWalletProvider();
    walletProviderUnsubscribe?.();
    walletProviderUnsubscribe = null;
    active.stopBalanceInterest();
    active.stop();
  }
  active = new BlockchainPoller(
    blockchain,
    pollIntervalMs,
    undefined,
    walletReservationCoordinator,
  );
  refreshWalletProvider();
  walletProviderUnsubscribe = active.rpc.onConnectionChange((connected) => {
    if (connected) refreshWalletProvider();
    else clearWalletProvider();
  });
  void hydrateWalletReservationLedger().then(
    () => walletReservationCoordinator.retryCancelRequired(),
    (error) => console.error('[save] failed to hydrate wallet reservation ledger:', error),
  );
  active.start();
  return active;
}

export function deactivate(): void {
  if (active) {
    clearWalletProvider();
    walletProviderUnsubscribe?.();
    walletProviderUnsubscribe = null;
    active.stopBalanceInterest();
    active.stop();
    active = null;
  }
}

export function getActiveBlockchain(): BlockchainPoller {
  if (!active) throw new Error('No blockchain selected');
  return active;
}
