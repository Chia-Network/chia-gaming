import type { WalletOfferProvider } from '../../types/ChiaGaming';
import { WalletProviderRegistry } from '../session/walletProviderRegistry';

describe('WalletProviderRegistry', () => {
  it('owns one attachment and advances only reconnect readiness epochs', () => {
    const registry = new WalletProviderRegistry();
    const provider: WalletOfferProvider = {
      capability: 'best-effort',
      scope: {
        provider: 'walletconnect',
        fingerprint: '123',
        chainId: 'chia:testnet11',
      },
      beginCreation: jest.fn(),
      cancel: jest.fn(),
    };
    const events: string[] = [];
    registry.subscribe((event) => events.push(`${event.kind}:${event.readinessEpoch}`));

    expect(registry.attach(provider)).toBe(1);
    expect(registry.ready(provider)).toBe(1);
    expect(registry.ready(provider)).toBe(1);
    expect(registry.provider(provider.scope)).toBe(provider);
    registry.detach(provider);
    registry.detach(provider);
    expect(registry.attach(provider)).toBe(2);

    expect(events).toEqual(['attached:1', 'ready:1', 'ready:1', 'detached:1', 'attached:2']);
  });
});
