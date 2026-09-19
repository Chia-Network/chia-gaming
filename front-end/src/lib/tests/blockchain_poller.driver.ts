import { BlockchainPoller } from '../../hooks/BlockchainPoller';

type BlockchainPollerTestSeam = {
  pollOnce(): Promise<void>;
  ensureConnectionListener(): void;
};

function testSeam(poller: BlockchainPoller): BlockchainPollerTestSeam {
  return poller as unknown as BlockchainPollerTestSeam;
}

export function pollOnce(poller: BlockchainPoller): Promise<void> {
  return testSeam(poller).pollOnce();
}

export function ensureConnectionListener(poller: BlockchainPoller): void {
  testSeam(poller).ensureConnectionListener();
}
