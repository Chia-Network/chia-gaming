import { BlockchainPoller } from './BlockchainPoller';

let active: BlockchainPoller | null = null;

export function setActiveBlockchain(poller: BlockchainPoller) {
  active = poller;
}

export function getActiveBlockchain(): BlockchainPoller {
  if (!active) throw new Error('No blockchain selected');
  return active;
}
