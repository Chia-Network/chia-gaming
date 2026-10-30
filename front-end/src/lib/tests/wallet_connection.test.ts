import 'fake-indexeddb/auto';
import { createApplication } from '../application/Application';
import { channelFundingRuntime } from '../session/channelFundingRuntime';
import { storageRepository } from '../session/storageRepository';
import { fakeBlockchainInfo } from '../wallet/FakeBlockchainInterface';
import { WalletConnection } from '../wallet/WalletConnection';

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
