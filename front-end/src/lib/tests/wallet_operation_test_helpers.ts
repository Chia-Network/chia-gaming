import { storageRepository } from '../session/storageRepository';
import {
  walletOperationTradeKey,
  type WalletOperationEntry,
  type WalletOperationOwner,
  type WalletOperationPurpose,
} from '../session/walletOperationStore';

export function installReservedWalletObligation(
  tradeId: string,
  owner: WalletOperationOwner,
  purpose: WalletOperationPurpose,
  reason = 'wallet-offer-created',
): WalletOperationEntry {
  storageRepository.reduceWallet({
    kind: 'reserve',
    key: walletOperationTradeKey(tradeId),
    owner,
    purpose,
    tradeId,
    reason,
  });
  const entry = storageRepository
    .walletObligations()
    .find((candidate) => candidate.stage === 'reserved' && candidate.tradeId === tradeId);
  if (!entry) throw new Error(`Failed to install reserved wallet obligation ${tradeId}`);
  return structuredClone(entry);
}
