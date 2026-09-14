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

import { expectConsoleError } from '../../../scripts/testSetup';
import { walletConnectState } from '../../hooks/useWalletConnect';

describe('WalletConnect pairing teardown', () => {
  beforeEach(async () => {
    mockClient.session.keys = [];
    mockClient.connect.mockReset();
    // The wallet state is a singleton; drop any pairing left pending by an
    // earlier test so each case starts with nothing outstanding.
    await walletConnectState.disconnect();
    mockClient.on.mockClear();
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

  it('cancels the pairing when the wallet rejects the approval', async () => {
    await walletConnectState.init();
    mockClient.connect.mockResolvedValue({
      uri: 'wc:abc123def@2?relay-protocol=irn&symKey=deadbeef',
      approval: async () => ({}),
    });

    await walletConnectState.startConnect();
    expectConsoleError('connect() approval FAILED or rejected');
    await expect(
      walletConnectState.connect(async () => {
        throw new Error('User rejected');
      }),
    ).rejects.toThrow('User rejected');

    expect(mockClient.core.pairing.disconnect).toHaveBeenCalledWith({ topic: 'abc123def' });
  });

  it('cancels the abandoned pairing when Link Wallet is retried after a rejection', async () => {
    await walletConnectState.init();
    mockClient.connect.mockResolvedValue({
      uri: 'wc:aaa111@2?relay-protocol=irn&symKey=deadbeef',
      approval: async () => ({}),
    });

    await walletConnectState.startConnect();
    expectConsoleError('connect() approval FAILED or rejected');
    await expect(
      walletConnectState.connect(async () => {
        throw new Error('User rejected');
      }),
    ).rejects.toThrow('User rejected');

    // Retrying Link Wallet goes through the fresh path: forget sessions, then
    // start a second pairing.
    mockClient.connect.mockResolvedValue({
      uri: 'wc:bbb222@2?relay-protocol=irn&symKey=deadbeef',
      approval: async () => ({}),
    });
    await walletConnectState.forgetSessions();
    await walletConnectState.startConnect();

    expect(mockClient.core.pairing.disconnect).toHaveBeenCalledTimes(1);
    expect(mockClient.core.pairing.disconnect).toHaveBeenCalledWith({ topic: 'aaa111' });

    // The retry's pairing is the one now tracked for teardown.
    await walletConnectState.disconnect();
    expect(mockClient.core.pairing.disconnect).toHaveBeenCalledWith({ topic: 'bbb222' });
  });

  it('cancels a pairing abandoned without any approval response before starting another', async () => {
    await walletConnectState.init();
    mockClient.connect.mockResolvedValue({
      uri: 'wc:ccc333@2?relay-protocol=irn&symKey=deadbeef',
      // The user never scans the QR, so this approval never settles.
      approval: () => new Promise<never>(() => {}),
    });

    await walletConnectState.startConnect();

    mockClient.connect.mockResolvedValue({
      uri: 'wc:ddd444@2?relay-protocol=irn&symKey=deadbeef',
      approval: async () => ({}),
    });
    await walletConnectState.startConnect();

    expect(mockClient.core.pairing.disconnect).toHaveBeenCalledWith({ topic: 'ccc333' });
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
