import { InternalBlockchainInterface } from '../types/ChiaGaming';
import { BlockchainPoller } from './BlockchainPoller';
import { walletReservationLedger } from '../lib/session/walletReservationLedger';

let active: BlockchainPoller | null = null;

export function activate(
  blockchain: InternalBlockchainInterface,
  pollIntervalMs: number,
): BlockchainPoller {
  if (active) {
    walletReservationLedger.detachRpc(active.rpc);
    active.stopBalanceInterest();
    active.stop();
  }
  active = new BlockchainPoller(blockchain, pollIntervalMs);
  walletReservationLedger.attachRpc(active.rpc);
  active.start();
  return active;
}

export function deactivate(): void {
  if (active) {
    walletReservationLedger.detachRpc(active.rpc);
    active.stopBalanceInterest();
    active.stop();
    active = null;
  }
}

export function getActiveBlockchain(): BlockchainPoller {
  if (!active) throw new Error('No blockchain selected');
  return active;
}
