import 'fake-indexeddb/auto';
import {
  getChainId,
  getGenesisChallenge,
  getOptionalNamespaces,
  getRequiredNamespaces,
  ChiaMethod,
} from '../../constants/wallet-connect';
import { MAINNET_GENESIS_CHALLENGE, TESTNET_GENESIS_CHALLENGE } from '../../constants/env';
import { storageRepository } from '../session/storageRepository';

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
  beforeEach(async () => {
    storageRepository._resetForTests();
    setGlobal('localStorage', makeStorage());
    setGlobal('sessionStorage', makeStorage());
    await storageRepository.claimLease();
  });

  afterEach(() => {
    storageRepository._resetForTests();
    Reflect.deleteProperty(globalThis, 'localStorage');
    Reflect.deleteProperty(globalThis, 'sessionStorage');
  });

  it('defaults to mainnet', () => {
    expect(getChainId()).toBe('chia:mainnet');
    expect(getRequiredNamespaces().chia.chains).toEqual(['chia:mainnet']);
  });

  it('uses the testnet chain id when the preference is testnet', () => {
    storageRepository.updatePreference({ key: 'network', value: 'testnet' });
    expect(getChainId()).toBe('chia:testnet');
    expect(getRequiredNamespaces().chia.chains).toEqual(['chia:testnet']);
  });

  it('switches back to mainnet when the preference changes', () => {
    storageRepository.updatePreference({ key: 'network', value: 'testnet' });
    expect(getChainId()).toBe('chia:testnet');
    storageRepository.updatePreference({ key: 'network', value: 'mainnet' });
    expect(getChainId()).toBe('chia:mainnet');
  });

  it('proposes every method as optional while retaining required-method validation', () => {
    expect(getRequiredNamespaces().chia.methods).toEqual(
      Object.values(ChiaMethod).filter((method) => method !== ChiaMethod.GetFullNodePeerCount),
    );
    expect(getOptionalNamespaces().chia).toEqual({
      methods: Object.values(ChiaMethod),
      chains: ['chia:mainnet'],
      events: [],
    });
  });
});

describe('genesis challenge follows the network preference', () => {
  beforeEach(async () => {
    storageRepository._resetForTests();
    setGlobal('localStorage', makeStorage());
    setGlobal('sessionStorage', makeStorage());
    await storageRepository.claimLease();
  });

  afterEach(() => {
    storageRepository._resetForTests();
    Reflect.deleteProperty(globalThis, 'localStorage');
    Reflect.deleteProperty(globalThis, 'sessionStorage');
  });

  it('defaults to the mainnet genesis challenge', () => {
    expect(getGenesisChallenge()).toBe(MAINNET_GENESIS_CHALLENGE);
  });

  it('uses the testnet11 genesis challenge when the preference is testnet', () => {
    storageRepository.updatePreference({ key: 'network', value: 'testnet' });
    expect(getGenesisChallenge()).toBe(TESTNET_GENESIS_CHALLENGE);
  });

  it('switches back to mainnet when the preference changes', () => {
    storageRepository.updatePreference({ key: 'network', value: 'testnet' });
    expect(getGenesisChallenge()).toBe(TESTNET_GENESIS_CHALLENGE);
    storageRepository.updatePreference({ key: 'network', value: 'mainnet' });
    expect(getGenesisChallenge()).toBe(MAINNET_GENESIS_CHALLENGE);
  });

  it('uses the mainnet challenge for the simulator even when testnet is selected', async () => {
    storageRepository.updatePreference({ key: 'network', value: 'testnet' });
    await storageRepository.saveSession({
      scope: 'common',
      preferences: { blockchainType: 'simulator' },
    });
    expect(getGenesisChallenge()).toBe(MAINNET_GENESIS_CHALLENGE);
  });

  it('still uses the testnet challenge for WalletConnect when testnet is selected', async () => {
    storageRepository.updatePreference({ key: 'network', value: 'testnet' });
    await storageRepository.saveSession({
      scope: 'common',
      preferences: { blockchainType: 'walletconnect' },
    });
    expect(getGenesisChallenge()).toBe(TESTNET_GENESIS_CHALLENGE);
  });
});
