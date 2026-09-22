import { InternalBlockchainInterface } from '../types/ChiaGaming';
import { BlockchainPoller } from './BlockchainPoller';
import { channelFundingRuntime } from '../lib/session/channelFundingRuntime';

let active: BlockchainPoller | null = null;

export function activate(
  blockchain: InternalBlockchainInterface,
  pollIntervalMs: number,
): BlockchainPoller {
  if (active) {
    active.detachProvider();
    active.stopBalanceInterest();
    active.stop();
  }
  active = new BlockchainPoller(blockchain, pollIntervalMs, undefined, channelFundingRuntime);
  channelFundingRuntime.retryCancelRequired();
  active.start();
  return active;
}

export function deactivate(): void {
  if (active) {
    active.detachProvider();
    active.stopBalanceInterest();
    active.stop();
    active = null;
  }
}

export function getActiveBlockchain(): BlockchainPoller {
  if (!active) throw new Error('No blockchain selected');
  return active;
}
