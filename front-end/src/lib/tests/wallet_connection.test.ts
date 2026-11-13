import 'fake-indexeddb/auto';
import { expectConsoleError } from '../../../scripts/testSetup';
import { createApplication } from '../application/Application';
import { channelFundingRuntime } from '../session/channelFundingRuntime';
import { storageRepository } from '../session/storageRepository';
import { fakeBlockchainInfo } from '../wallet/FakeBlockchainInterface';
import { cloudBlockchainInfo } from '../wallet/CloudBlockchainInterface';
import { realBlockchainInfo } from '../wallet/RealBlockchainInterface';
import { sageBlockchainInfo } from '../wallet/SageBlockchainInterface';
import { WalletConnection } from '../wallet/WalletConnection';
import { BlockchainPoller } from '../wallet/BlockchainPoller';
import type { ConnectionSetup } from '../../types/ChiaGaming';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe('Cloud vault selection through the wallet owner', () => {
  const first = { id: 'Wallet_a', name: 'First', address: null };
  const second = { id: 'Wallet_b', name: 'Second', address: null };

  beforeEach(() => {
    jest.spyOn(cloudBlockchainInfo, 'beginConnect').mockResolvedValue({
      qrUri: '',
      skipQr: true,
      finalize: jest.fn(),
    });
    jest.spyOn(cloudBlockchainInfo, 'isConnected').mockReturnValue(false);
    jest.spyOn(cloudBlockchainInfo, 'isReadyForPlay').mockReturnValue(false);
    jest.spyOn(cloudBlockchainInfo, 'onConnectionChange').mockReturnValue(() => {});
    jest.spyOn(cloudBlockchainInfo, 'onPlayReadinessChange').mockReturnValue(() => {});
    jest.spyOn(cloudBlockchainInfo, 'listWallets').mockResolvedValue([first, second]);
    jest.spyOn(cloudBlockchainInfo, 'getWalletIdentity').mockReturnValue(first);
  });

  it('clears replaced grants and ignores an older connection list', async () => {
    const wallet = new WalletConnection(() => {});
    try {
      await wallet.connect('cloud');
      expect(wallet.view.grantedWallets).toEqual([first, second]);
      const oldList = deferred<(typeof first)[]>();
      jest.mocked(cloudBlockchainInfo.listWallets).mockReturnValueOnce(oldList.promise);
      jest.mocked(cloudBlockchainInfo.getWalletIdentity).mockReturnValue(second);
      await wallet.connect('cloud');
      expect(wallet.view.walletIdentity).toEqual(second);
      expect(wallet.view.grantedWallets).toEqual([]);
      jest.mocked(cloudBlockchainInfo.listWallets).mockResolvedValue([second]);
      await wallet.connect('cloud');
      oldList.resolve([first]);
      await Promise.resolve();
      expect(wallet.view.grantedWallets).toEqual([second]);
    } finally {
      wallet.stopLocalActivity();
    }
  });

  it('keeps replaced grants empty when the new list fails', async () => {
    const wallet = new WalletConnection(() => {});
    try {
      await wallet.connect('cloud');
      const list = deferred<(typeof first)[]>();
      jest.mocked(cloudBlockchainInfo.listWallets).mockReturnValueOnce(list.promise);
      await wallet.connect('cloud');
      expect(wallet.view.grantedWallets).toEqual([]);
      expectConsoleError('[wallet] listing granted wallets failed');
      list.reject(new Error('Wallet unavailable'));
      await Promise.resolve();
      expect(wallet.view.grantedWallets).toEqual([]);
    } finally {
      wallet.stopLocalActivity();
    }
  });

  it('exposes balance failures without treating unknown funds as zero, then clears on success', async () => {
    const start = jest.spyOn(BlockchainPoller.prototype, 'startBalanceInterest');
    const wallet = new WalletConnection(() => {});
    try {
      await wallet.connect('cloud');
      const callbacks = start.mock.calls.at(-1)![1];
      callbacks.onBalance(100n);
      callbacks.onError!(new Error('Wallet unavailable'));
      expect(wallet.view.balance).toBeUndefined();
      expect(wallet.view).toMatchObject({ balanceError: 'Wallet unavailable' });
      callbacks.onBalance(200n);
      expect(wallet.view).toMatchObject({ balance: 200n, balanceError: null });
    } finally {
      wallet.stopLocalActivity();
    }
  });

  it.each([false, true])(
    'finishes a vault switch only for its live owner, retired=%s',
    async (retired) => {
      const finish = deferred<void>();
      jest.spyOn(cloudBlockchainInfo, 'selectWallet').mockReturnValue(finish.promise);
      const emit = jest.fn();
      const wallet = new WalletConnection(emit);
      try {
        await wallet.connect('cloud');
        expect(wallet.view.grantedWallets).toEqual([first, second]);
        const switching = wallet.selectWallet(second.id);
        expect(wallet.view).toMatchObject({
          switchingWallet: true,
          walletIdentity: first,
          balance: undefined,
        });
        if (retired) wallet.stopLocalActivity();
        emit.mockClear();
        jest.mocked(cloudBlockchainInfo.getWalletIdentity).mockReturnValue(second);
        finish.resolve();
        await switching;
        if (retired) {
          expect(emit).not.toHaveBeenCalled();
          expect(wallet.sessionAccess()).toBeNull();
          expect(wallet.view.walletIdentity).toBeNull();
        } else {
          expect(wallet.view).toMatchObject({ switchingWallet: false, walletIdentity: second });
          expect(wallet.sessionAccess()).not.toBeNull();
        }
      } finally {
        wallet.stopLocalActivity();
      }
    },
  );

  it('discards a granted-vault list that arrives after retirement', async () => {
    const list = deferred<(typeof first)[]>();
    jest.mocked(cloudBlockchainInfo.listWallets).mockReturnValue(list.promise);
    const emit = jest.fn();
    const wallet = new WalletConnection(emit);
    await wallet.connect('cloud');
    wallet.stopLocalActivity();
    emit.mockClear();
    list.resolve([first, second]);
    await Promise.resolve();
    expect(emit).not.toHaveBeenCalled();
    expect(wallet.view.grantedWallets).toEqual([]);
  });
});

beforeEach(async () => {
  storageRepository._resetForTests();
  channelFundingRuntime.resetForTests();
  await storageRepository.claimApplicationState();
});
afterEach(async () => {
  await storageRepository.checkpointDomainMutations();
  jest.restoreAllMocks();
  channelFundingRuntime.resetForTests();
  storageRepository._resetForTests();
});

it('establishes simulator polling after an unavailable resume', async () => {
  jest.spyOn(fakeBlockchainInfo, 'beginConnect').mockRejectedValue(new Error('offline simulator'));
  jest.spyOn(fakeBlockchainInfo, 'isConnected').mockReturnValue(false);
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  const detached = jest.fn(() => expect(wallet.sessionAccess()).toBeNull());
  const wallet = new WalletConnection((event) => {
    if (event.type === 'detaching') detached();
  });
  try {
    await wallet.resume('simulator');
    expect(wallet.sessionAccess()).not.toBeNull();
    expect(wallet.view).toMatchObject({ connected: true, connecting: false, hasProvider: true });
  } finally {
    wallet.stopLocalActivity();
  }
  wallet.stopLocalActivity();
  expect(detached).toHaveBeenCalledTimes(1);
});

it.each(['connect', 'resume'] as const)(
  'uses claimed identity for %s when the wallet owner was constructed before reload recovery',
  async (method) => {
    const playerId = storageRepository.getPlayerId();
    await storageRepository.checkpointDomainMutations();
    storageRepository._resetForTests();
    const wallet = new WalletConnection(jest.fn());
    expect(storageRepository.getPlayerId()).not.toBe(playerId);
    await storageRepository.claimApplicationState();
    const begin = jest.spyOn(realBlockchainInfo, 'beginConnect').mockResolvedValue({
      qrUri: 'wc:restored',
      finalize: jest.fn(),
    });
    try {
      await wallet[method]('walletconnect');
      expect(begin.mock.calls[0]?.[0]).toBe(playerId);
    } finally {
      wallet.stopLocalActivity();
    }
  },
);

it('keeps publishing policy in its owning application', async () => {
  const first = createApplication();
  const second = createApplication();
  await first.dispatch({ type: 'toggle-publish' });
  await first.dispatch({ type: 'confirm' });
  expect(first.snapshot().transactionPublishNerfed).toBe(true);
  expect(second.snapshot().transactionPublishNerfed).toBe(false);
});

it.each([false, true])(
  'keeps pairing and wallet setup pending through completion, silent=%s',
  async (silent) => {
    const finish = deferred<void>();
    let paired!: () => void;
    jest.spyOn(realBlockchainInfo, 'beginConnect').mockResolvedValue({
      qrUri: 'wc:pairing',
      finalize: (_values, onPaired) => {
        paired = onPaired!;
        return finish.promise;
      },
    });
    jest.spyOn(realBlockchainInfo, 'getHeightInfo').mockReturnValue(new Promise(() => {}));
    jest.spyOn(realBlockchainInfo, 'getBalance').mockReturnValue(new Promise(() => {}));
    jest.spyOn(realBlockchainInfo, 'onConnectionChange').mockReturnValue(() => {});
    jest.spyOn(realBlockchainInfo, 'onPlayReadinessChange').mockReturnValue(() => {});
    const emit = jest.fn();
    const wallet = new WalletConnection(emit);
    try {
      let pending = wallet.connect('walletconnect', silent);
      await Promise.resolve();
      expect(wallet.view).toMatchObject({
        connected: false,
        connecting: !silent,
        setup: { qrUri: 'wc:pairing' },
      });
      if (silent) {
        await pending;
        pending = wallet.finalize();
      }
      paired();
      expect(wallet.view).toMatchObject({ connected: false, connecting: true, setup: null });
      expect(emit).not.toHaveBeenCalledWith({ type: 'connected' });
      finish.resolve();
      await expect(pending).resolves.toBe(true);
      expect(wallet.view).toMatchObject({ connected: true, connecting: false, setup: null });
    } finally {
      wallet.stopLocalActivity();
    }
  },
);

it('ignores an old pairing callback after cancellation and a new attempt', async () => {
  const finish = deferred<void>();
  const next = deferred<ConnectionSetup>();
  let paired!: () => void;
  jest
    .spyOn(realBlockchainInfo, 'beginConnect')
    .mockResolvedValueOnce({
      qrUri: 'wc:old',
      finalize: (_values, onPaired) => {
        paired = onPaired!;
        return finish.promise;
      },
    })
    .mockReturnValueOnce(next.promise);
  jest.spyOn(realBlockchainInfo, 'disconnect').mockResolvedValue();
  const emit = jest.fn();
  const wallet = new WalletConnection(emit);
  try {
    const old = wallet.connect('walletconnect');
    await Promise.resolve();
    await wallet.cancel();
    const current = wallet.connect('walletconnect', true);
    next.resolve({ qrUri: 'wc:current', finalize: jest.fn() });
    await current;
    emit.mockClear();
    paired();
    finish.resolve();
    await old;
    expect(wallet.view.setup?.qrUri).toBe('wc:current');
    expect(emit).not.toHaveBeenCalled();
  } finally {
    wallet.stopLocalActivity();
  }
});

describe.each([
  ['simulator', fakeBlockchainInfo],
  ['walletconnect', realBlockchainInfo],
  ['cloud', cloudBlockchainInfo],
] as const)('%s connection cancellation', (type, provider) => {
  beforeEach(() => {
    jest.spyOn(provider, 'disconnect').mockResolvedValue();
    jest.spyOn(provider, 'isConnected').mockReturnValue(false);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  it.each([
    ['connect', 'begin', 'resolve'],
    ['connect', 'begin', 'reject'],
    ['connect', 'finalize', 'resolve'],
    ['connect', 'finalize', 'reject'],
    ['resume', 'begin', 'resolve'],
    ['resume', 'begin', 'reject'],
    ['resume', 'finalize', 'resolve'],
    ['resume', 'finalize', 'reject'],
  ] as const)(
    'ignores %s %s that completes with %s after Cancel',
    async (method, stage, outcome) => {
      const begin = deferred<ConnectionSetup>();
      const finish = deferred<void>();
      const finalizing = deferred<void>();
      const setup: ConnectionSetup = {
        qrUri: '',
        skipQr: true,
        finalize: jest.fn(() => {
          finalizing.resolve();
          return finish.promise;
        }),
      };
      jest.spyOn(provider, 'beginConnect').mockReturnValue(begin.promise);
      const emit = jest.fn();
      const wallet = new WalletConnection(emit);
      try {
        const pending = method === 'connect' ? wallet.connect(type, true) : wallet.resume(type);
        if (stage === 'finalize') {
          begin.resolve(setup);
          await finalizing.promise;
        }
        await wallet.cancel();
        emit.mockClear();
        if (outcome === 'reject') {
          (stage === 'begin' ? begin : finish).reject(new Error('late failure'));
        } else if (stage === 'begin') {
          finish.resolve();
          begin.resolve(setup);
        } else {
          finish.resolve();
        }
        await pending;
        expect(wallet.sessionAccess()).toBeNull();
        expect(wallet.view).toMatchObject({
          walletType: undefined,
          connected: false,
          connecting: false,
          hasProvider: false,
          setup: null,
          showSetup: false,
          error: null,
        });
        expect(emit).not.toHaveBeenCalled();
        if (stage === 'begin') expect(setup.finalize).not.toHaveBeenCalled();
      } finally {
        wallet.stopLocalActivity();
      }
    },
  );

  it.each(['resolve', 'reject'] as const)(
    'ignores an old %s after a new attempt starts',
    async (outcome) => {
      const old = deferred<ConnectionSetup>();
      const current = deferred<ConnectionSetup>();
      jest
        .spyOn(provider, 'beginConnect')
        .mockReturnValueOnce(old.promise)
        .mockReturnValueOnce(current.promise);
      const emit = jest.fn();
      const wallet = new WalletConnection(emit);
      try {
        const first = wallet.resume(type);
        await wallet.cancel();
        const second = wallet.connect(type, true);
        emit.mockClear();
        if (outcome === 'reject') old.reject(new Error('old failure'));
        else old.resolve({ qrUri: 'old-pairing', finalize: jest.fn() });
        await first;
        expect(emit).not.toHaveBeenCalled();
        expect(wallet.view.connecting).toBe(true);
        await wallet.cancel();
        current.resolve({ qrUri: '', skipQr: true, finalize: jest.fn() });
        await second;
      } finally {
        wallet.stopLocalActivity();
      }
    },
  );
});

it('does not let a canceled form submission clear the next attempt’s connecting state', async () => {
  const finish = deferred<void>();
  const next = deferred<ConnectionSetup>();
  jest
    .spyOn(fakeBlockchainInfo, 'beginConnect')
    .mockResolvedValueOnce({ qrUri: 'sim://player', fields: {}, finalize: () => finish.promise })
    .mockReturnValueOnce(next.promise);
  jest.spyOn(fakeBlockchainInfo, 'disconnect').mockResolvedValue();
  const wallet = new WalletConnection(jest.fn());
  try {
    await wallet.connect('simulator');
    const first = wallet.finalize();
    await wallet.cancel();
    const second = wallet.resume('simulator');
    finish.resolve();
    await expect(first).resolves.toBe(false);
    expect(wallet.view.connecting).toBe(true);
    await wallet.cancel();
    next.resolve({ qrUri: '', skipQr: true, finalize: jest.fn() });
    await second;
  } finally {
    wallet.stopLocalActivity();
  }
});

it.each(['cancel', 'disconnect'] as const)(
  'finishing an old %s leaves a newer connection alone',
  async (method) => {
    const teardown = deferred<void>();
    jest.spyOn(fakeBlockchainInfo, 'disconnect').mockReturnValue(teardown.promise);
    jest.spyOn(fakeBlockchainInfo, 'beginConnect').mockResolvedValue({
      qrUri: '',
      skipQr: true,
      finalize: jest.fn(),
    });
    const emit = jest.fn();
    const wallet = new WalletConnection(emit);
    try {
      await wallet.resume('simulator');
      const stopping = wallet[method]();
      await wallet.resume('simulator');
      const current = wallet.sessionAccess();
      expect(current).not.toBeNull();
      emit.mockClear();
      teardown.resolve();
      await stopping;
      expect(wallet.sessionAccess()).toBe(current);
      expect(wallet.view).toMatchObject({
        walletType: 'simulator',
        connected: true,
        hasProvider: true,
      });
      expect(emit).not.toHaveBeenCalled();
    } finally {
      wallet.stopLocalActivity();
    }
  },
);

it('retiring the connection owner prevents a pending resume from attaching', async () => {
  const begin = deferred<ConnectionSetup>();
  jest.spyOn(fakeBlockchainInfo, 'beginConnect').mockReturnValue(begin.promise);
  const emit = jest.fn();
  const wallet = new WalletConnection(emit);
  try {
    const pending = wallet.resume('simulator');
    wallet.stopLocalActivity();
    emit.mockClear();
    begin.resolve({ qrUri: '', skipQr: true, finalize: jest.fn() });
    await pending;
    expect(wallet.sessionAccess()).toBeNull();
    expect(emit).not.toHaveBeenCalled();
  } finally {
    wallet.stopLocalActivity();
  }
});

it('connects Sage through the wallet owner and publishes the selected provider', async () => {
  const finalize = jest.fn(async () => {});
  const begin = jest.spyOn(sageBlockchainInfo, 'beginConnect').mockResolvedValue({
    qrUri: '',
    skipQr: true,
    finalize,
  });
  jest.spyOn(sageBlockchainInfo, 'getHeightInfo').mockReturnValue(new Promise(() => {}));
  jest.spyOn(sageBlockchainInfo, 'getBalance').mockReturnValue(new Promise(() => {}));
  jest.spyOn(sageBlockchainInfo, 'onConnectionChange').mockReturnValue(() => {});
  jest.spyOn(sageBlockchainInfo, 'onPlayReadinessChange').mockReturnValue(() => {});
  const wallet = new WalletConnection(jest.fn());
  try {
    await expect(wallet.connect('sage', false, true)).resolves.toBe(true);
    expect(begin).toHaveBeenCalledWith(storageRepository.getPlayerId(), true);
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(wallet.view).toMatchObject({ walletType: 'sage', connected: true, hasProvider: true });
    expect(storageRepository.query('blockchainType')).toBe('sage');
  } finally {
    wallet.stopLocalActivity();
  }
});
