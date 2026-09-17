const requestMock = jest.fn();

const relayerMock = {
  connected: true,
  on: jest.fn(),
  off: jest.fn(),
};
let mockClientAvailable = true;
let mockSessionAvailable = true;
const mockClient = {
  core: { relayer: relayerMock },
  request: requestMock,
  session: { keys: ['topic-1'] },
};

jest.mock('../../hooks/useWalletConnect', () => ({
  walletConnectState: {
    getClient: () => (mockClientAvailable ? mockClient : undefined),
    getSession: () => (mockSessionAvailable ? { topic: 'topic-1' } : undefined),
    getAddress: () => '123',
    getChainId: () => 'chia:mainnet',
  },
}));

jest.mock('../../services/log', () => ({
  log: jest.fn(),
}));

import { ChiaMethod } from '../../constants/wallet-connect';
import {
  rpc,
  WalletConnectResponseError,
  WalletConnectTransportError,
} from '../../hooks/WalletConnectRpc';

describe('WalletConnect RPC adapter', () => {
  beforeEach(() => {
    requestMock.mockReset();
    mockClientAvailable = true;
    mockSessionAvailable = true;
    relayerMock.connected = true;
  });

  it('formats WalletConnect requests with fingerprint and chain context', async () => {
    requestMock.mockResolvedValueOnce({ height: 7n, success: true });

    await expect(rpc.getHeightInfo({ usePeakHeight: true })).resolves.toMatchObject({ height: 7n });

    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock.mock.calls[0][0]).toMatchObject({
      topic: 'topic-1',
      chainId: 'chia:mainnet',
      request: {
        method: ChiaMethod.GetHeightInfo,
        params: {
          usePeakHeight: true,
          fingerprint: 123,
        },
      },
    });
  });

  it('unwraps WalletConnect data payloads', async () => {
    requestMock.mockResolvedValueOnce({
      data: { confirmedWalletBalance: 11n },
      success: true,
    });

    await expect(rpc.getWalletBalance({ walletId: 1n })).resolves.toMatchObject({
      confirmedWalletBalance: 11n,
    });

    expect(requestMock.mock.calls[0][0].request.params).toMatchObject({
      walletId: 1n,
      fingerprint: 123,
    });
  });

  it('rewrites only negative request bigints to decimal strings for the WC wire', async () => {
    requestMock.mockResolvedValueOnce({ success: true });

    await rpc.createOfferForIds({
      offer: { '1': 100n, '2': -50n },
      fee: 1n,
      driverDict: {},
    });

    expect(requestMock.mock.calls[0][0].request.params).toEqual({
      offer: { '1': 100n, '2': '-50' },
      fee: 1n,
      driverDict: {},
      fingerprint: 123,
    });
  });

  it('requests off-chain offer cancellation with wallet context', async () => {
    requestMock.mockResolvedValueOnce({ success: true });

    await rpc.cancelOffer({ tradeId: 'trade-id', secure: false, fee: 0n });

    expect(requestMock.mock.calls[0][0].request).toEqual({
      method: ChiaMethod.CancelOffer,
      params: {
        tradeId: 'trade-id',
        secure: false,
        fee: 0n,
        fingerprint: 123,
      },
    });
  });

  it('rejects WalletConnect error payloads with method context', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    requestMock.mockResolvedValueOnce({
      error: { message: 'boom', code: 123 },
    });

    await expect(rpc.getHeightInfo({})).rejects.toBeInstanceOf(WalletConnectResponseError);
    consoleError.mockRestore();
  });

  it('treats a rejected request while connected as a wallet response', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    requestMock.mockRejectedValueOnce(new Error('arbitrary wallet refusal'));

    await expect(rpc.pushTransactions({ transactions: [] })).rejects.toBeInstanceOf(
      WalletConnectResponseError,
    );
    consoleError.mockRestore();
  });

  it('tags missing session and disconnected relayer failures as transport', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockSessionAvailable = false;
    await expect(rpc.getHeightInfo({})).rejects.toBeInstanceOf(WalletConnectTransportError);

    mockSessionAvailable = true;
    requestMock.mockImplementationOnce(async () => {
      relayerMock.connected = false;
      throw new Error('request failed');
    });
    await expect(rpc.getHeightInfo({})).rejects.toBeInstanceOf(WalletConnectTransportError);
    consoleError.mockRestore();
  });
});
