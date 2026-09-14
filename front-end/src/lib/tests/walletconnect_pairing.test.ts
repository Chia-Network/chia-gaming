const mockClient = {
  session: { keys: [] as string[], get: jest.fn(), length: 0 },
  on: jest.fn(),
  connect: jest.fn(),
  disconnect: jest.fn(async () => {}),
  core: { pairing: { disconnect: jest.fn(async () => {}) } },
};

const mockInit = jest.fn(async () => mockClient);

jest.mock('@walletconnect/sign-client', () => ({
  __esModule: true,
  default: { init: (...args: unknown[]) => mockInit(...args) },
}));

jest.mock('../../services/log', () => ({ log: jest.fn() }));

jest.mock('../../hooks/saveHardReset', () => ({
  startPendingWalletConnectWipe: jest.fn(async () => {}),
}));

jest.mock('../../constants/wallet-connect', () => ({
  getChainId: () => 'chia:mainnet',
  getRequiredNamespaces: () => ({
    chia: { methods: [], chains: ['chia:mainnet'], events: [] },
  }),
}));

jest.mock('../../util/walletConnectMetadata', () => ({
  walletConnectDappMetadata: () => ({
    name: 'test',
    description: 'test',
    url: 'https://example.test',
    icons: [],
  }),
}));

import { walletConnectState } from '../../hooks/useWalletConnect';

describe('WalletConnect pairing teardown', () => {
  beforeEach(() => {
    mockClient.session.keys = [];
    mockClient.on.mockClear();
    mockClient.connect.mockReset();
    mockClient.disconnect.mockClear();
    mockClient.core.pairing.disconnect.mockClear();
  });

  it('cancels a pending pairing on disconnect when no session exists', async () => {
    await walletConnectState.init();
    mockClient.connect.mockResolvedValue({
      uri: 'wc:abc123def@2?relay-protocol=irn&symKey=deadbeef',
      approval: async () => ({}),
    });

    const { uri } = await walletConnectState.startConnect();
    expect(uri).toContain('wc:abc123def@2');

    await walletConnectState.disconnect();

    expect(mockClient.core.pairing.disconnect).toHaveBeenCalledWith({ topic: 'abc123def' });
    // No session was ever established, so the session-level disconnect is skipped.
    expect(mockClient.disconnect).not.toHaveBeenCalled();
  });

  it('disconnects every known session topic on forgetSessions', async () => {
    await walletConnectState.init();
    mockClient.session.keys = ['topic-1', 'topic-2'];

    await walletConnectState.forgetSessions();

    expect(mockClient.disconnect).toHaveBeenCalledTimes(2);
    expect(mockClient.disconnect).toHaveBeenCalledWith(
      expect.objectContaining({ topic: 'topic-1' }),
    );
    expect(mockClient.disconnect).toHaveBeenCalledWith(
      expect.objectContaining({ topic: 'topic-2' }),
    );
  });
});
