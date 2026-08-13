import 'fake-indexeddb/auto';
import { getChainId, getRequiredNamespaces, ChiaMethod } from '../../constants/wallet-connect';
import { setNetwork, _resetForTests } from '../../hooks/save';

function makeStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => store.clear(),
    get length() {
      return store.size;
    },
    key: (i: number) => [...store.keys()][i] ?? null,
  };
}

function setGlobal(key: string, value: unknown) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

describe('WalletConnect chain id follows the network preference', () => {
  beforeEach(() => {
    _resetForTests();
    setGlobal('localStorage', makeStorage());
    setGlobal('sessionStorage', makeStorage());
  });

  afterEach(() => {
    _resetForTests();
    Reflect.deleteProperty(globalThis, 'localStorage');
    Reflect.deleteProperty(globalThis, 'sessionStorage');
  });

  it('defaults to mainnet', () => {
    expect(getChainId()).toBe('chia:mainnet');
    expect(getRequiredNamespaces().chia.chains).toEqual(['chia:mainnet']);
  });

  it('uses the testnet chain id when the preference is testnet', () => {
    setNetwork('testnet');
    expect(getChainId()).toBe('chia:testnet');
    expect(getRequiredNamespaces().chia.chains).toEqual(['chia:testnet']);
  });

  it('switches back to mainnet when the preference changes', () => {
    setNetwork('testnet');
    expect(getChainId()).toBe('chia:testnet');
    setNetwork('mainnet');
    expect(getChainId()).toBe('chia:mainnet');
  });

  it('always requests the full Chia method set', () => {
    const methods = getRequiredNamespaces().chia.methods;
    expect(methods).toEqual(Object.values(ChiaMethod));
  });
});
