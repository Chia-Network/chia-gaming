import { InternalBlockchainInterface } from '../types/ChiaGaming';
import { BlockchainPoller } from './BlockchainPoller';

let active: BlockchainPoller | null = null;

export function activate(
  blockchain: InternalBlockchainInterface,
  pollIntervalMs: number,
): BlockchainPoller {
  if (active) {
    active.stop();
  }
  active = new BlockchainPoller(blockchain, pollIntervalMs);
  blockchain.startMonitoring().catch((err: unknown) => {
    console.warn('[blockchain-core] startMonitoring failed', err);
  });
  active.start();
  return active;
}

export function deactivate(): void {
  if (active) {
    active.stop();
    active = null;
  }
}

export function getActiveBlockchain(): BlockchainPoller {
  if (!active) throw new Error('No blockchain selected');
  return active;
}
