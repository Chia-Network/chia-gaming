import { InternalBlockchainInterface } from '../types/ChiaGaming';
import { BlockchainPoller } from './BlockchainPoller';
import { walletOperationRuntime } from '../lib/session/walletOperationRuntime';

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
  active = new BlockchainPoller(blockchain, pollIntervalMs, undefined, walletOperationRuntime);
  walletOperationRuntime.retryCancelRequired();
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
