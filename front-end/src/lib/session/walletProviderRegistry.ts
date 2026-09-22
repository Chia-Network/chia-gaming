import type { WalletOfferProvider, WalletProviderScope } from '../../types/ChiaGaming';
import { providerScopeKey } from './providerKeys';

export type WalletProviderRegistryEvent =
  | { kind: 'attached'; provider: WalletOfferProvider; readinessEpoch: number }
  | { kind: 'ready'; provider: WalletOfferProvider; readinessEpoch: number }
  | { kind: 'detached'; provider: WalletOfferProvider; readinessEpoch: number };

/**
 * Sole owner of wallet-provider attachment and readiness epochs.
 *
 * An epoch advances only when a scope becomes newly usable. Repeated readiness
 * notifications for the same epoch are observable but retain the epoch, which
 * lets ChannelFundingRuntime deduplicate replacement attempts durably.
 */
export class WalletProviderRegistry {
  private readonly providers = new Map<string, WalletOfferProvider>();
  private readonly epochs = new Map<string, number>();
  private readonly listeners = new Set<(event: WalletProviderRegistryEvent) => void>();

  attach(provider: WalletOfferProvider): number {
    const key = providerScopeKey(provider.scope);
    const current = this.providers.get(key);
    if (current === provider) return this.epochs.get(key) ?? 0;
    this.providers.set(key, provider);
    const readinessEpoch = (this.epochs.get(key) ?? 0) + 1;
    this.epochs.set(key, readinessEpoch);
    this.emit({ kind: 'attached', provider, readinessEpoch });
    return readinessEpoch;
  }

  ready(provider: WalletOfferProvider): number {
    const key = providerScopeKey(provider.scope);
    if (this.providers.get(key) !== provider) return this.epochs.get(key) ?? 0;
    const readinessEpoch = this.epochs.get(key) ?? 1;
    this.epochs.set(key, readinessEpoch);
    this.emit({ kind: 'ready', provider, readinessEpoch });
    return readinessEpoch;
  }

  reconnectReady(provider: WalletOfferProvider): number {
    const key = providerScopeKey(provider.scope);
    if (this.providers.get(key) !== provider) return this.attach(provider);
    const readinessEpoch = (this.epochs.get(key) ?? 0) + 1;
    this.epochs.set(key, readinessEpoch);
    this.emit({ kind: 'ready', provider, readinessEpoch });
    return readinessEpoch;
  }

  detach(provider: WalletOfferProvider): void {
    const key = providerScopeKey(provider.scope);
    if (this.providers.get(key) !== provider) return;
    this.providers.delete(key);
    this.emit({ kind: 'detached', provider, readinessEpoch: this.epochs.get(key) ?? 0 });
  }

  provider(scope: WalletProviderScope): WalletOfferProvider | null {
    return this.providers.get(providerScopeKey(scope)) ?? null;
  }

  hasScope(scope: WalletProviderScope): boolean {
    return this.providers.has(providerScopeKey(scope));
  }

  readinessEpoch(scope: WalletProviderScope): number {
    return this.epochs.get(providerScopeKey(scope)) ?? 0;
  }

  scopeKeys(): ReadonlySet<string> {
    return new Set(this.providers.keys());
  }

  subscribe(listener: (event: WalletProviderRegistryEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  clear(): void {
    const attached = [...this.providers.values()];
    this.providers.clear();
    for (const provider of attached) {
      this.emit({
        kind: 'detached',
        provider,
        readinessEpoch: this.epochs.get(providerScopeKey(provider.scope)) ?? 0,
      });
    }
  }

  private emit(event: WalletProviderRegistryEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

export const walletProviderRegistry = new WalletProviderRegistry();
