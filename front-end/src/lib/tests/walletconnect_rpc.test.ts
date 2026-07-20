const requestMock = jest.fn();

const relayerMock = {
  connected: true,
  on: jest.fn(),
  off: jest.fn(),
};

jest.mock('../../hooks/useWalletConnect', () => ({
  walletConnectState: {
    getClient: () => ({
      core: { relayer: relayerMock },
      request: requestMock,
      session: { keys: ['topic-1'] },
    }),
    getSession: () => ({ topic: 'topic-1' }),
    getAddress: () => '123',
    getChainId: () => 'chia:mainnet',
  },
}));

jest.mock('../../services/log', () => ({
  log: jest.fn(),
}));

import { ChiaMethod } from '../../constants/wallet-connect';
import { rpc } from '../../hooks/WalletConnectRpc';

describe('WalletConnect RPC adapter', () => {
  beforeEach(() => {
    requestMock.mockReset();
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

  it('rejects WalletConnect error payloads with method context', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    requestMock.mockResolvedValueOnce({
      error: { message: 'boom', code: 123 },
    });

    await expect(rpc.getHeightInfo({})).rejects.toThrow('WalletConnect RPC chia_getHeightInfo failed');
    consoleError.mockRestore();
  });
});
