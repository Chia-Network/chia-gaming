import {
  WC_PUBLIC_DAPP_ICON,
  WC_PUBLIC_DAPP_URL,
  walletConnectDappMetadata,
} from '../../util/walletConnectMetadata';

describe('walletConnectDappMetadata', () => {
  it('uses the page origin for http(s) deployments', () => {
    expect(walletConnectDappMetadata('https://play.example.com')).toEqual({
      name: 'Chia Gaming',
      description: 'Chia Gaming Platform',
      url: 'https://play.example.com',
      icons: ['https://play.example.com/logo.png'],
    });
  });

  it('falls back to a public https identity under the Electron app:// origin', () => {
    expect(walletConnectDappMetadata('app://local')).toEqual({
      name: 'Chia Gaming',
      description: 'Chia Gaming Platform',
      url: WC_PUBLIC_DAPP_URL,
      icons: [WC_PUBLIC_DAPP_ICON],
    });
    expect(WC_PUBLIC_DAPP_URL.startsWith('https://')).toBe(true);
    expect(WC_PUBLIC_DAPP_ICON.startsWith('https://')).toBe(true);
  });
});
