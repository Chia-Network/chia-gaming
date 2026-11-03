import 'fake-indexeddb/auto';
import { createApplication } from '../application/Application';
import { channelFundingRuntime } from '../session/channelFundingRuntime';
import { storageRepository } from '../session/storageRepository';
import { fakeBlockchainInfo } from '../wallet/FakeBlockchainInterface';
import { cloudBlockchainInfo } from '../wallet/CloudBlockchainInterface';
import { realBlockchainInfo } from '../wallet/RealBlockchainInterface';
import { WalletConnection } from '../wallet/WalletConnection';
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
  const wallet = new WalletConnection('player', (event) => {
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

it('keeps publishing policy in its owning application', async () => {
  const first = createApplication();
  const second = createApplication();
  await first.dispatch({ type: 'toggle-publish' });
  await first.dispatch({ type: 'confirm' });
  expect(first.snapshot().transactionPublishNerfed).toBe(true);
  expect(second.snapshot().transactionPublishNerfed).toBe(false);
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
      const wallet = new WalletConnection('player', emit);
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
      const wallet = new WalletConnection('player', emit);
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
  const wallet = new WalletConnection('player', jest.fn());
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
    const wallet = new WalletConnection('player', emit);
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
  const wallet = new WalletConnection('player', emit);
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
