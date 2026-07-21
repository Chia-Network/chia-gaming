// WalletConnect client metadata.
//
// Wallets display and fetch the dapp `url` / `icons` over the public internet.
// The web player can use `window.location.origin` for that. The Electron
// renderer runs under `app://local`, which wallets cannot open or fetch, so we
// fall back to a stable https identity (repo homepage + raw logo URL).

export const WC_PUBLIC_DAPP_URL = 'https://github.com/Chia-Network/chia-gaming';

export const WC_PUBLIC_DAPP_ICON =
  'https://raw.githubusercontent.com/Chia-Network/chia-gaming/main/front-end/public/images/chia_logo.png';

export type WalletConnectDappMetadata = {
  name: string;
  description: string;
  url: string;
  icons: string[];
};

/** Resolve WalletConnect metadata for the given renderer origin. */
export function walletConnectDappMetadata(
  origin: string = typeof window !== 'undefined' ? window.location.origin : '',
): WalletConnectDappMetadata {
  const httpOrigin = origin.startsWith('https://') || origin.startsWith('http://');
  const url = httpOrigin ? origin : WC_PUBLIC_DAPP_URL;
  const icons = httpOrigin ? [`${origin}/logo.png`] : [WC_PUBLIC_DAPP_ICON];
  return {
    name: 'Chia Gaming',
    description: 'Chia Gaming Platform',
    url,
    icons,
  };
}
