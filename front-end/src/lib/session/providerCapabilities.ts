import type { WalletOfferProvider } from '../../types/ChiaGaming';

export function isRecoverableProvider(
  provider: WalletOfferProvider,
): provider is Extract<
  WalletOfferProvider,
  { capability: 'recoverable' | 'recoverable-after-begin' }
> {
  return provider.capability === 'recoverable' || provider.capability === 'recoverable-after-begin';
}

export function canLosePreIdResponse(provider: WalletOfferProvider): boolean {
  return provider.capability === 'best-effort' || provider.capability === 'recoverable-after-begin';
}
