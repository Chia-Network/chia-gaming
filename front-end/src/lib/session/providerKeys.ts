import type { WalletOfferOperation, WalletProviderScope } from '../../types/ChiaGaming';

export type ProviderOwner = WalletOfferOperation['owner'];

function tupleKey(parts: readonly string[]): string {
  return parts.map((part) => `${part.length}:${part}`).join('');
}

export function providerScopeKey(scope: WalletProviderScope): string {
  switch (scope.provider) {
    case 'cloud':
      return tupleKey(['cloud', scope.walletId]);
    case 'walletconnect':
      return tupleKey(['walletconnect', scope.fingerprint, scope.chainId]);
    case 'simulator':
      return tupleKey(['simulator', scope.identity]);
  }
}

export function providerOwnerKey(owner: ProviderOwner): string {
  return tupleKey([
    owner.installationPlayerId,
    owner.peerSessionId,
    providerScopeKey(owner.providerScope),
  ]);
}
