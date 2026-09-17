function makeStorage() {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key(i: number) {
      return [...map.keys()][i] ?? null;
    },
    getItem(k: string) {
      return map.has(k) ? map.get(k)! : null;
    },
    setItem(k: string, v: string) {
      map.set(k, String(v));
    },
    removeItem(k: string) {
      map.delete(k);
    },
    clear() {
      map.clear();
    },
  };
}

function setTestGlobal(key: string, value: unknown) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value,
  });
}

setTestGlobal('localStorage', makeStorage());
setTestGlobal('sessionStorage', makeStorage());
setTestGlobal('window', globalThis);

// The Cloud Wallet fee comes from the global preference. Mock it so the test
// controls the fee without exercising the persistence/IndexedDB layer.
let mockFee = 0n;
jest.mock('../../hooks/save', () => ({
  getDefaultFee: () => mockFee,
  setDefaultFee: (fee: bigint) => {
    mockFee = fee;
  },
}));

import { CloudBlockchainInterface } from '../../hooks/CloudBlockchainInterface';
import { clearCloudWalletAuth, saveCloudWalletAuth } from '../../hooks/cloudWalletAuth';

/** Capture GraphQL bodies and return canned data keyed by query text. */
function mockGraphql(handler: (query: string, variables: Record<string, unknown>) => unknown) {
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const fetchMock = jest.fn(async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      query?: string;
      variables?: Record<string, unknown>;
    };
    const query = body.query ?? '';
    const variables = body.variables ?? {};
    calls.push({ query, variables });
    return {
      status: 200,
      ok: true,
      text: async () => JSON.stringify({ data: handler(query, variables) }),
    };
  });
  setTestGlobal('fetch', fetchMock);
  return calls;
}

function mockGraphqlError(message: string) {
  setTestGlobal(
    'fetch',
    jest.fn(async () => ({
      status: 200,
      ok: true,
      text: async () => JSON.stringify({ errors: [{ message }] }),
    })),
  );
}

describe('CloudBlockchainInterface fee support', () => {
  beforeEach(() => {
    setTestGlobal('localStorage', makeStorage());
    setTestGlobal('sessionStorage', makeStorage());
    clearCloudWalletAuth();
    mockFee = 0n;
    saveCloudWalletAuth({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 10 * 60_000,
      walletId: 'Wallet_1',
    });
    // openApprovePopup runs right after the mutation; returning null makes
    // createOfferForIds reject there, after the variables we assert on are sent.
    setTestGlobal('window', globalThis);
    (globalThis as unknown as { open: () => unknown }).open = () => null;
  });

  afterEach(() => {
    setTestGlobal('fetch', undefined);
  });

  function findSpendMutation(calls: Array<{ query: string; variables: Record<string, unknown> }>) {
    const call = calls.find((c) => c.query.includes('createSpendWithExtraConditions'));
    expect(call).toBeDefined();
    return (call!.variables.input ?? {}) as Record<string, unknown>;
  }

  it('createOfferForIds directly creates the message-bound funding child', async () => {
    const calls = mockGraphql((query) => {
      if (query.includes('createSpendWithExtraConditions')) {
        return {
          createSpendWithExtraConditions: { signatureRequest: { id: 'SR_1', status: 'PENDING' } },
        };
      }
      return {};
    });
    const iface = new CloudBlockchainInterface();
    const preLauncherPuzzleHash = 'ab'.repeat(32);
    await expect(
      iface.createOfferForIds(
        'uid',
        { '1': -1000n },
        [{ opcode: 67n, args: ['10', '', preLauncherPuzzleHash] }],
        undefined,
        undefined,
        500n,
      ),
    ).rejects.toThrow(/popup/i);
    const input = findSpendMutation(calls);
    expect(input.amount).toBe('1000');
    expect(input.fee).toBeUndefined();
    expect(input.extraConditions).toEqual([
      { opcode: '67', args: ['10', '', preLauncherPuzzleHash] },
      { opcode: '51', args: [preLauncherPuzzleHash, '1000'] },
    ]);
  });

  it('createOfferForIds omits the fee when zero', async () => {
    mockFee = 0n;
    const calls = mockGraphql((query) => {
      if (query.includes('createSpendWithExtraConditions')) {
        return {
          createSpendWithExtraConditions: { signatureRequest: { id: 'SR_1', status: 'PENDING' } },
        };
      }
      return {};
    });
    const iface = new CloudBlockchainInterface();
    await expect(iface.createOfferForIds('uid', { '1': -1000n })).rejects.toThrow(/popup/i);
    const input = findSpendMutation(calls);
    expect(input.amount).toBe('1000');
    expect(input.fee).toBeUndefined();
  });

  it('createFeeSpend uses the native fee and binds directly to the protocol coin', async () => {
    const calls = mockGraphql((query) => {
      if (query.includes('createSpendWithExtraConditions')) {
        return {
          createSpendWithExtraConditions: { signatureRequest: { id: 'SR_1', status: 'PENDING' } },
        };
      }
      return {};
    });
    const iface = new CloudBlockchainInterface();
    const protocolCoinId = 'ab'.repeat(32);
    await expect(iface.createFeeSpend(500n, protocolCoinId)).rejects.toThrow(/popup/i);
    const input = findSpendMutation(calls);
    expect(input.amount).toBe('0');
    expect(input.fee).toBe('500');
    expect(input.coinIds).toBeUndefined();
    expect(input.extraConditions).toEqual([{ opcode: '64', args: [protocolCoinId] }]);
  });

  it('selectCoins treats the supplied amount as the exact requirement', async () => {
    const nodeA = { name: '11'.repeat(32), amount: '100', puzzleHash: 'bb'.repeat(32) };
    const nodeB = { name: '22'.repeat(32), amount: '150', puzzleHash: 'dd'.repeat(32) };
    const records = [
      {
        name: '11'.repeat(32),
        amount: '100',
        puzzleHash: 'bb'.repeat(32),
        parentCoinName: 'aa'.repeat(32),
        spentBlockHeight: null,
      },
      {
        name: '22'.repeat(32),
        amount: '150',
        puzzleHash: 'dd'.repeat(32),
        parentCoinName: 'cc'.repeat(32),
        spentBlockHeight: null,
      },
    ];
    const handler = (query: string) => {
      if (query.includes('coinRecordsByNames')) return { coinRecordsByNames: records };
      return { coins: { edges: [{ node: nodeA }, { node: nodeB }] } };
    };

    mockGraphql(handler);
    const contributionCoin = await new CloudBlockchainInterface().selectCoins('uid', 100n);
    expect(contributionCoin?.startsWith('aa'.repeat(32) + 'bb'.repeat(32))).toBe(true);

    mockGraphql(handler);
    const feeCoin = await new CloudBlockchainInterface().selectCoins('uid', 150n);
    expect(feeCoin?.startsWith('cc'.repeat(32) + 'dd'.repeat(32))).toBe(true);
  });

  it('rejects coin-record batches when the Cloud query fails', async () => {
    mockGraphql((query) => {
      if (query.includes('coinRecordsByNames')) {
        throw new Error('cloud unavailable');
      }
      return {};
    });
    await expect(
      new CloudBlockchainInterface().getCoinRecordsByNames(['aa'.repeat(32)]),
    ).rejects.toThrow(/coin-record batch failed/i);
  });

  it('rejects coin-record batches containing incomplete identities', async () => {
    mockGraphql((query) => {
      if (query.includes('coinRecordsByNames')) {
        return {
          coinRecordsByNames: [
            {
              name: 'aa'.repeat(32),
              amount: '1',
              puzzleHash: 'bb',
              parentCoinName: 'cc'.repeat(32),
              createdBlockHeight: 1,
              spentBlockHeight: null,
            },
          ],
        };
      }
      return {};
    });
    await expect(
      new CloudBlockchainInterface().getCoinRecordsByNames(['aa'.repeat(32)]),
    ).rejects.toThrow(/incomplete coin identity/i);
  });

  it('finalize rejects a sub-floor fee before starting OAuth', async () => {
    mockGraphql(() => ({}));
    const iface = new CloudBlockchainInterface();
    // fresh=true clears stored auth so beginConnect returns the OAuth-config
    // path whose finalize collects the fee.
    const setup = await iface.beginConnect('uid', true);
    await expect(setup.finalize?.({ clientId: 'client-x', fee: 500n })).rejects.toThrow(
      /treated as zero/i,
    );
  });

  it('finalize accepts zero and a floor fee (failing later in OAuth, not the fee check)', async () => {
    mockGraphql(() => ({}));
    const iface = new CloudBlockchainInterface();
    // A fee that clears the floor check falls through to the OAuth flow, so the
    // rejection is some downstream OAuth error, never the fee-floor error.
    const setupZero = await iface.beginConnect('uid', true);
    await expect(setupZero.finalize?.({ clientId: 'client-x', fee: 0n })).rejects.not.toThrow(
      /treated as zero/i,
    );

    const setupFloor = await iface.beginConnect('uid', true);
    await expect(
      setupFloor.finalize?.({ clientId: 'client-x', fee: 100_000_000n }),
    ).rejects.not.toThrow(/treated as zero/i);
  });

  function sampleBundle() {
    return {
      aggregated_signature: '0x' + 'ab'.repeat(96),
      coin_spends: [
        {
          coin: {
            parent_coin_info: '0x' + '11'.repeat(32),
            puzzle_hash: '0x' + '22'.repeat(32),
            amount: 1n,
          },
          puzzle_reveal: '0x' + 'aa',
          solution: '0x' + 'bb',
        },
      ],
    };
  }

  it('classifies a non-accepted broadcast status as rejected', async () => {
    mockGraphql((query) => {
      if (query.includes('broadcastSpendBundle')) {
        return { broadcastSpendBundle: { status: 'FAILED' } };
      }
      return {};
    });
    const iface = new CloudBlockchainInterface();
    await expect(iface.spend('', sampleBundle(), '', 'test')).resolves.toEqual({
      status: 'rejected',
      detail: expect.stringMatching(/rejected: status=FAILED/),
    });
  });

  it.each([
    [undefined, 'rejected'],
    ['MYSTERY', 'rejected'],
    ['REJECTED', 'rejected'],
  ])('classifies Cloud broadcast status %# as %s', async (status, expected) => {
    mockGraphql((query) => {
      if (query.includes('broadcastSpendBundle')) {
        return { broadcastSpendBundle: status === undefined ? {} : { status } };
      }
      return {};
    });
    await expect(
      new CloudBlockchainInterface().spend('', sampleBundle(), '', 'test'),
    ).resolves.toMatchObject({ status: expected });
  });

  it.each([
    ['duplicate transaction already in mempool', 'acknowledged'],
    ['ALREADY_INCLUDING_TRANSACTION', 'acknowledged'],
    ['this transaction is already in the mempool', 'acknowledged'],
    ['transaction already included', 'acknowledged'],
    ['conflicts with an existing transaction in the mempool', 'rejected'],
    ['full node rejected spend: UNKNOWN_UNSPENT', 'rejected'],
    ['full node rejected spend: INVALID_FEE_LOW_FEE', 'rejected'],
    ['opaque Cloud Wallet failure', 'rejected'],
  ])('classifies Cloud service error "%s" as %s', async (message, expected) => {
    mockGraphqlError(message);
    await expect(
      new CloudBlockchainInterface().spend('', sampleBundle(), '', 'test'),
    ).resolves.toMatchObject({ status: expected });
  });

  it('classifies a Cloud GraphQL transport failure as unavailable', async () => {
    setTestGlobal(
      'fetch',
      jest.fn(async () => Promise.reject(new Error('network down'))),
    );
    await expect(
      new CloudBlockchainInterface().spend('', sampleBundle(), '', 'test'),
    ).resolves.toMatchObject({
      status: 'unavailable',
      detail: expect.stringContaining('network down'),
    });
  });

  it('spend broadcasts a bundle carrying a direct fee', async () => {
    mockGraphql((query) => {
      if (query.includes('broadcastSpendBundle')) {
        return { broadcastSpendBundle: { status: 'SUCCESS' } };
      }
      return {};
    });
    const iface = new CloudBlockchainInterface();
    await expect(iface.spend('', sampleBundle(), '', 'test', 500n)).resolves.toEqual({
      status: 'acknowledged',
      detail: 'SUCCESS',
    });
  });
});
