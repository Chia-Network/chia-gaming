jest.mock('../../hooks/useWalletConnect', () => ({
  walletConnectState: {
    getClient: jest.fn(),
    getSession: jest.fn(),
    getAddress: jest.fn(),
    getChainId: jest.fn(),
  },
}));

import { walletConnectState } from '../../hooks/useWalletConnect';
import { rpc } from '../../hooks/JsonRpcContext';
import {
  friendlyWalletMessage,
  normalizeWalletRpcError,
} from '../../util/walletError';

const wcInsufficientFundsError = {
  code: -32603,
  message: 'insufficient funds in wallet 1',
  data: { success: false, error: 'insufficient funds in wallet 1' },
};

describe('normalizeWalletRpcError', () => {
  it('extracts daemon error from WalletConnect JSON-RPC rejection', () => {
    const msg = normalizeWalletRpcError(wcInsufficientFundsError);
    expect(msg).toMatch(/insufficient funds/i);
  });

  it('extracts error from Error wrapping JSON payload', () => {
    const wrapped = new Error(JSON.stringify(wcInsufficientFundsError));
    expect(normalizeWalletRpcError(wrapped)).toMatch(/insufficient funds/i);
  });

  it('friendlyWalletMessage adds guidance for insufficient funds', () => {
    const friendly = friendlyWalletMessage('insufficient funds in wallet 1');
    expect(friendly).toMatch(/locked coins/i);
  });
});

describe('JsonRpcContext wallet RPC errors', () => {
  const mockRequest = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    (walletConnectState.getClient as jest.Mock).mockReturnValue({ request: mockRequest });
    (walletConnectState.getSession as jest.Mock).mockReturnValue({ topic: 'test-topic' });
    (walletConnectState.getAddress as jest.Mock).mockReturnValue('1');
    (walletConnectState.getChainId as jest.Mock).mockReturnValue('chia:mainnet');
  });

  it('rejects createOfferForIds with normalized insufficient funds message', async () => {
    mockRequest.mockRejectedValue(wcInsufficientFundsError);

    await expect(
      rpc.createOfferForIds({
        offer: { '1': 1_000_000_000_000n },
        allowUnsynced: true,
      }),
    ).rejects.toThrow(/insufficient funds in wallet 1/i);
  });

  it('rejects when wallet returns inline result.error', async () => {
    mockRequest.mockResolvedValue({
      error: 'Error creating offer: insufficient funds in wallet 1',
      success: false,
    });

    await expect(
      rpc.createOfferForIds({
        offer: { '1': 1_000_000_000_000n },
        allowUnsynced: true,
      }),
    ).rejects.toThrow(/insufficient funds/i);
  });
});
