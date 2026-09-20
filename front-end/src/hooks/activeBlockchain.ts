import { InternalBlockchainInterface } from '../types/ChiaGaming';
import { BlockchainPoller } from './BlockchainPoller';
import { walletOperationService } from '../lib/session/walletOperationService';
import { hydrateWalletOperations } from '../lib/session/sessionCache';

let active: BlockchainPoller | null = null;

export function activate(
  blockchain: InternalBlockchainInterface,
  pollIntervalMs: number,
): BlockchainPoller {
  if (active) {
    active.detachWalletOperationProvider();
    active.stopBalanceInterest();
    active.stop();
  }
  active = new BlockchainPoller(blockchain, pollIntervalMs, undefined, walletOperationService);
  void hydrateWalletOperations().then(
    () => walletOperationService.retryCancelRequired(),
    (error) => console.error('[save] failed to hydrate wallet operation record:', error),
  );
  active.start();
  return active;
}

export function deactivate(): void {
  if (active) {
    active.detachWalletOperationProvider();
    active.stopBalanceInterest();
    active.stop();
    active = null;
  }
}

export function getActiveBlockchain(): BlockchainPoller {
  if (!active) throw new Error('No blockchain selected');
  return active;
}
