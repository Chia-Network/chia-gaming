const mockClient = {
  session: { keys: [] as string[], get: jest.fn(), length: 0 },
  on: jest.fn(),
  connect: jest.fn(),
  disconnect: jest.fn(async () => {}),
  core: {
    pairing: {
      disconnect: jest.fn(async () => {}),
      getPairings: jest.fn((): { topic: string }[] => []),
    },
  },
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

const uriFor = (topic: string) => `wc:${topic}@2?relay-protocol=irn&symKey=deadbeef`;

describe('WalletConnect pairing teardown', () => {
  beforeEach(async () => {
    // walletConnectState is a module singleton, so drop any pairing a previous
    // test left pending before clearing the call records.
    await walletConnectState.init();
    await walletConnectState.disconnect();
    mockClient.session.keys = [];
    mockClient.on.mockClear();
    mockClient.connect.mockReset();
    mockClient.disconnect.mockClear();
    mockClient.core.pairing.disconnect.mockClear();
    mockClient.core.pairing.getPairings.mockReturnValue([]);
  });

  it('cancels a pending pairing on disconnect when no session exists', async () => {
    mockClient.connect.mockResolvedValue({
      uri: uriFor('abc123def'),
      approval: async () => ({}),
    });

    const { uri } = await walletConnectState.startConnect();
    expect(uri).toContain('wc:abc123def@2');

    await walletConnectState.disconnect();

    expect(mockClient.core.pairing.disconnect).toHaveBeenCalledWith({ topic: 'abc123def' });
    // No session was ever established, so the session-level disconnect is skipped.
    expect(mockClient.disconnect).not.toHaveBeenCalled();
  });

  it('disconnects every known session topic on forgetConnections', async () => {
    mockClient.session.keys = ['topic-1', 'topic-2'];

    await walletConnectState.forgetConnections();

    expect(mockClient.disconnect).toHaveBeenCalledTimes(2);
    expect(mockClient.disconnect).toHaveBeenCalledWith(
      expect.objectContaining({ topic: 'topic-1' }),
    );
    expect(mockClient.disconnect).toHaveBeenCalledWith(
      expect.objectContaining({ topic: 'topic-2' }),
    );
  });

  it('disconnects stored pairings too, so a fresh connect leaves none live', async () => {
    mockClient.session.keys = ['session-topic'];
    mockClient.core.pairing.getPairings.mockReturnValue([
      { topic: 'pairing-1' },
      { topic: 'pairing-2' },
    ]);

    await walletConnectState.forgetConnections();

    expect(mockClient.core.pairing.disconnect).toHaveBeenCalledWith({ topic: 'pairing-1' });
    expect(mockClient.core.pairing.disconnect).toHaveBeenCalledWith({ topic: 'pairing-2' });
  });

  it('cancels the pairing when the wallet rejects the proposal', async () => {
    expectConsoleError('connect() approval FAILED or rejected');
    mockClient.connect.mockResolvedValue({
      uri: uriFor('badbeef'),
      approval: async () => {
        throw new Error('User rejected.');
      },
    });

    const { approval } = await walletConnectState.startConnect();
    await expect(walletConnectState.connect(approval)).rejects.toThrow('User rejected.');

    expect(mockClient.core.pairing.disconnect).toHaveBeenCalledWith({ topic: 'badbeef' });
  });

  it('leaves the current pairing alone when a superseded approval rejects', async () => {
    expectConsoleError('connect() approval FAILED or rejected');
    let rejectApproval: (reason: Error) => void = () => undefined;
    mockClient.connect.mockResolvedValueOnce({
      uri: uriFor('a11a11'),
      approval: () =>
        new Promise((_resolve, reject) => {
          rejectApproval = reject;
        }),
    });

    const { approval } = await walletConnectState.startConnect();
    const stale = walletConnectState.connect(approval as () => Promise<never>);

    // The user asks for a new QR before the wallet answers the first proposal.
    mockClient.connect.mockResolvedValueOnce({
      uri: uriFor('b22b22'),
      approval: async () => ({}),
    });
    await walletConnectState.startConnect();
    mockClient.core.pairing.disconnect.mockClear();

    rejectApproval(new Error('Proposal expired.'));
    await expect(stale).rejects.toThrow('Proposal expired.');

    expect(mockClient.core.pairing.disconnect).not.toHaveBeenCalled();
  });

  it('cancels a pairing whose creation raced ahead of a disconnect', async () => {
    expectConsoleError('startConnect() FAILED');
    let releaseConnect: (result: { uri: string; approval: () => Promise<unknown> }) => void = () =>
      undefined;
    mockClient.connect.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseConnect = resolve;
        }),
    );

    const pending = walletConnectState.startConnect();
    // The user cancels while client.connect() is still in flight, so there is
    // no pairing topic to tear down yet.
    await walletConnectState.disconnect();
    releaseConnect({ uri: uriFor('facade'), approval: async () => ({}) });

    await expect(pending).rejects.toThrow(/cancelled/i);
    expect(mockClient.core.pairing.disconnect).toHaveBeenCalledWith({ topic: 'facade' });
  });

  it('cancels the previous pairing when a new QR is requested', async () => {
    mockClient.connect
      .mockResolvedValueOnce({ uri: uriFor('aaa111'), approval: async () => ({}) })
      .mockResolvedValueOnce({ uri: uriFor('bbb222'), approval: async () => ({}) });

    await walletConnectState.startConnect();
    expect(mockClient.core.pairing.disconnect).not.toHaveBeenCalled();

    await walletConnectState.startConnect();

    expect(mockClient.core.pairing.disconnect).toHaveBeenCalledWith({ topic: 'aaa111' });
    expect(mockClient.core.pairing.disconnect).not.toHaveBeenCalledWith({ topic: 'bbb222' });
  });
});
