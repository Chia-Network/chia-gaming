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

import 'fake-indexeddb/auto';
import { CloudBlockchainInterface } from '../../hooks/CloudBlockchainInterface';
import { clearCloudWalletAuth, saveCloudWalletAuth } from '../../hooks/cloudWalletAuth';
import { FeeAttachmentRuntime } from '../session/feeAttachmentRuntime';
import { storageRepository } from '../session/storageRepository';
import { WalletProviderRegistry } from '../session/walletProviderRegistry';

const testOperation = {
  owner: {
    installationPlayerId: 'player',
    peerSessionId: 'session',
    providerScope: { provider: 'simulator' as const, identity: 'player' },
  },
  purpose: { kind: 'funding' as const, operationId: 'operation' },
};

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

describe('CloudBlockchainInterface fee support', () => {
  beforeEach(async () => {
    setTestGlobal('localStorage', makeStorage());
    setTestGlobal('sessionStorage', makeStorage());
    clearCloudWalletAuth();
    storageRepository._resetForTests();
    await storageRepository.claimApplicationState();
    const empty = {
      ...storageRepository.loadState(),
      walletContext: null,
      channelFundingOperations: [],
      feeAttachments: [],
    };
    storageRepository._replaceApplicationStateForTests(empty);
    await storageRepository.checkpointApplicationState(empty);
    saveCloudWalletAuth({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 10 * 60_000,
      walletId: 'Wallet_1',
    });
    // openApprovePopup runs right after the mutation; returning null makes
    // Approval tracking starts only during reconciliation.
    setTestGlobal('window', globalThis);
    (globalThis as unknown as { open: () => unknown }).open = () => null;
  });

  afterEach(() => {
    setTestGlobal('fetch', undefined);
  });

  function findOfferMutation(calls: Array<{ query: string; variables: Record<string, unknown> }>) {
    const call = calls.find((c) => c.query.includes('createOffer'));
    expect(call).toBeDefined();
    return (call!.variables.input ?? {}) as Record<string, unknown>;
  }

  it('serializes each funding condition as one CLVM program', async () => {
    const calls = mockGraphql((query) => {
      if (query.includes('createOffer')) {
        return {
          createOffer: { signatureRequest: { id: 'SR_1', status: 'PENDING' } },
        };
      }
      return {};
    });
    const iface = new CloudBlockchainInterface();
    const preLauncherPuzzleHash = 'ab'.repeat(32);
    await expect(
      iface.beginWalletOffer(testOperation, {
        kind: 'funding',
        uniqueId: 'uid',
        offer: { '1': -1000n },
        extraConditions: [{ opcode: 67n, args: ['10', '', preLauncherPuzzleHash] }],
        openingFee: 500n,
      }),
    ).resolves.toEqual({ kind: 'pending', recoveryId: 'SR_1' });
    const input = findOfferMutation(calls);
    expect(input.offered).toEqual([{ amount: '1000' }]);
    expect(input.requested).toEqual([]);
    expect(input.fee).toBeUndefined();
    expect(input.extraConditions).toEqual([`ff43ff10ff80ffa0${preLauncherPuzzleHash}80`]);
  });

  it('adds ASSERT_BEFORE_HEIGHT_ABSOLUTE as a serialized condition', async () => {
    const calls = mockGraphql((query) => {
      if (query.includes('createOffer')) {
        return {
          createOffer: { signatureRequest: { id: 'SR_1', status: 'PENDING' } },
        };
      }
      return {};
    });
    const iface = new CloudBlockchainInterface();
    await expect(
      iface.beginWalletOffer(testOperation, {
        kind: 'funding',
        uniqueId: 'uid',
        offer: { '1': -1000n },
        maxHeight: 500n,
      }),
    ).resolves.toEqual({ kind: 'pending', recoveryId: 'SR_1' });
    expect(findOfferMutation(calls).extraConditions).toEqual(['ff57ff8201f480']);
  });

  it('begins a fee-only offer bound to the protocol coin', async () => {
    const calls = mockGraphql((query) => {
      if (query.includes('createOffer')) {
        return {
          createOffer: { signatureRequest: { id: 'SR_1', status: 'PENDING' } },
        };
      }
      return {};
    });
    const iface = new CloudBlockchainInterface();
    const protocolCoinId = 'ab'.repeat(32);
    await expect(
      iface.beginWalletOffer(
        { ...testOperation, purpose: { kind: 'fee', operationId: 'fee' } },
        {
          kind: 'fee',
          uniqueId: 'uid',
          fee: 500n,
          concurrentSpendCoinId: protocolCoinId,
        },
      ),
    ).resolves.toEqual({ kind: 'pending', recoveryId: 'SR_1' });
    const input = findOfferMutation(calls);
    expect(input.offered).toEqual([]);
    expect(input.requested).toEqual([]);
    expect(input.fee).toBe('500');
    expect(input.extraConditions).toEqual([`ff40ffa0${protocolCoinId}80`]);
  });

  it.each([
    [
      'funding',
      { kind: 'funding' as const, uniqueId: 'uid', offer: { '1': -1000n } },
      { createOffer: { signatureRequest: null } },
    ],
    [
      'fee',
      {
        kind: 'fee' as const,
        uniqueId: 'uid',
        fee: 500n,
        concurrentSpendCoinId: 'ab'.repeat(32),
      },
      { createOffer: { signatureRequest: { id: '', status: 'PENDING' } } },
    ],
  ])('keeps identity-less successful %s creation uncertain', async (_label, request, response) => {
    mockGraphql((query) => (query.includes('createOffer') ? response : {}));

    await expect(
      new CloudBlockchainInterface().beginWalletOffer(testOperation, request),
    ).resolves.toEqual({
      kind: 'unavailable',
      reason: expect.stringMatching(/without a signatureRequest ID/),
    });
  });

  it('reports fee-spend transport failure as unavailable', async () => {
    setTestGlobal('fetch', jest.fn().mockRejectedValue(new TypeError('network disconnected')));
    const iface = new CloudBlockchainInterface();

    await expect(
      iface.beginWalletOffer(
        { ...testOperation, purpose: { kind: 'fee', operationId: 'fee' } },
        {
          kind: 'fee',
          uniqueId: 'uid',
          fee: 500n,
          concurrentSpendCoinId: 'ab'.repeat(32),
        },
      ),
    ).resolves.toEqual({
      kind: 'unavailable',
      reason: expect.stringMatching(/network disconnected/i),
    });
  });

  it('returns the signed persisted offer after the request is submitted', async () => {
    const offer = `offer1${'a'.repeat(80)}`;
    (globalThis as unknown as { open: () => unknown }).open = () => ({ close: jest.fn() });
    setTestGlobal('addEventListener', jest.fn());
    setTestGlobal('removeEventListener', jest.fn());
    const calls = mockGraphql((query) => {
      if (query.includes('createOffer')) {
        return { createOffer: { signatureRequest: { id: 'SR_1', status: 'PENDING' } } };
      }
      if (query.includes('signatureRequest')) {
        return {
          signatureRequest: {
            id: 'SR_1',
            status: 'SUBMITTED',
            transaction: { offer: { bech32: offer, offerId: 'Offer_1' } },
          },
        };
      }
      return {};
    });

    await expect(
      new CloudBlockchainInterface().reconcileWalletOffer(
        testOperation,
        { kind: 'funding', uniqueId: 'uid', offer: { '1': -1000n } },
        'SR_1',
      ),
    ).resolves.toEqual({
      kind: 'created-reserved',
      material: { kind: 'offer', offer },
      tradeId: 'Offer_1',
    });
    const pollQuery = calls.find((call) => call.query.includes('transaction'))!.query;
    expect(pollQuery.replace(/\s+/g, ' ')).toContain('transaction { offer { bech32 offerId } }');
  });

  it('accepts a canonical bare approval id while rejecting empty and suffix collisions', async () => {
    jest.useFakeTimers();
    const popup = { close: jest.fn() };
    (globalThis as unknown as { open: () => unknown }).open = () => popup;
    let listener: ((event: MessageEvent) => void) | undefined;
    const add = jest.fn((_type: string, callback: (event: MessageEvent) => void) => {
      listener = callback;
    });
    const remove = jest.fn();
    setTestGlobal('addEventListener', add);
    setTestGlobal('removeEventListener', remove);
    mockGraphql((query) => {
      if (query.includes('createOffer')) {
        return {
          createOffer: {
            signatureRequest: { id: 'SignatureRequest_12', status: 'PENDING' },
          },
        };
      }
      return {
        signatureRequest: {
          id: 'SignatureRequest_12',
          status: 'PENDING',
          transaction: null,
        },
      };
    });
    const iface = new CloudBlockchainInterface();
    const operation = {
      owner: {
        installationPlayerId: 'player',
        peerSessionId: 'session',
        providerScope: { provider: 'simulator' as const, identity: 'player' },
      },
      purpose: { kind: 'funding' as const, operationId: 'op' },
    };
    const request = { kind: 'funding' as const, uniqueId: 'player', offer: { '1': -1n } };
    await expect(iface.beginWalletOffer(operation, request)).resolves.toEqual({
      kind: 'pending',
      recoveryId: 'SignatureRequest_12',
    });
    const completion = iface.reconcileWalletOffer(operation, request, 'SignatureRequest_12');
    await Promise.resolve();
    let settled = false;
    void completion.then(() => {
      settled = true;
    });
    for (const signatureRequestId of ['', '2', 'Request_12', 'xSignatureRequest_12']) {
      listener?.({
        origin: 'https://dev-testnet11.cw.chia.net',
        source: popup,
        data: {
          type: 'chia-cloud-wallet/signature-request',
          signatureRequestId,
          status: 'rejected',
        },
      } as unknown as MessageEvent);
      await Promise.resolve();
      expect(settled).toBe(false);
    }

    listener?.({
      origin: 'https://dev-testnet11.cw.chia.net',
      source: popup,
      data: {
        type: 'chia-cloud-wallet/signature-request',
        signatureRequestId: '12',
        status: 'rejected',
      },
    } as unknown as MessageEvent);
    await expect(completion).resolves.toEqual({
      kind: 'failure',
      reason: expect.stringMatching(/rejected/i),
    });
    expect(remove).toHaveBeenCalledWith('message', listener);
    expect(popup.close).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  it('accepts a canonical prefixed approval id for a bare request id', async () => {
    jest.useFakeTimers();
    const popup = { close: jest.fn() };
    (globalThis as unknown as { open: () => unknown }).open = () => popup;
    let listener: ((event: MessageEvent) => void) | undefined;
    setTestGlobal(
      'addEventListener',
      jest.fn((_type: string, callback: (event: MessageEvent) => void) => {
        listener = callback;
      }),
    );
    setTestGlobal('removeEventListener', jest.fn());
    mockGraphql(() => ({
      signatureRequest: {
        id: '34',
        status: 'PENDING',
        transaction: null,
      },
    }));
    const iface = new CloudBlockchainInterface();
    const request = { kind: 'funding' as const, uniqueId: 'player', offer: { '1': -1n } };
    const completion = iface.reconcileWalletOffer(testOperation, request, '34');
    await Promise.resolve();
    listener?.({
      origin: 'https://dev-testnet11.cw.chia.net',
      source: popup,
      data: {
        type: 'chia-cloud-wallet/signature-request',
        signatureRequestId: 'SignatureRequest_34',
        status: 'rejected',
      },
    } as unknown as MessageEvent);

    await expect(completion).resolves.toEqual({
      kind: 'failure',
      reason: expect.stringMatching(/rejected/i),
    });
    expect(popup.close).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  it('reconciles a reloaded signature request without creating a replacement offer', async () => {
    const offer = `offer1${'b'.repeat(80)}`;
    const popup = { close: jest.fn() };
    (globalThis as unknown as { open: () => unknown }).open = () => popup;
    setTestGlobal('addEventListener', jest.fn());
    setTestGlobal('removeEventListener', jest.fn());
    const calls = mockGraphql((query) => {
      if (query.includes('createOffer')) {
        return { createOffer: { signatureRequest: { id: 'SR_reload', status: 'PENDING' } } };
      }
      return {
        signatureRequest: {
          id: 'SR_reload',
          status: 'SUBMITTED',
          transaction: { offer: { bech32: offer, offerId: 'Offer_reload' } },
        },
      };
    });
    const operation = {
      owner: {
        installationPlayerId: 'player',
        peerSessionId: 'session',
        providerScope: { provider: 'simulator' as const, identity: 'player' },
      },
      purpose: { kind: 'funding' as const, operationId: 'op' },
    };
    const request = { kind: 'funding' as const, uniqueId: 'player', offer: { '1': -1n } };
    const first = new CloudBlockchainInterface();
    await expect(first.beginWalletOffer(operation, request)).resolves.toEqual({
      kind: 'pending',
      recoveryId: 'SR_reload',
    });

    await expect(
      new CloudBlockchainInterface().reconcileWalletOffer(operation, request, 'SR_reload'),
    ).resolves.toEqual({
      kind: 'created-reserved',
      material: { kind: 'offer', offer },
      tradeId: 'Offer_reload',
    });
    expect(calls.filter((call) => call.query.includes('mutation')).length).toBe(1);
    expect(calls.some((call) => call.query.includes('signatureRequest(id: $id)'))).toBe(true);
  });

  it('keeps temporary creation not-found unavailable for exact recovery', async () => {
    (globalThis as unknown as { open: () => unknown }).open = () => ({ close: jest.fn() });
    setTestGlobal('addEventListener', jest.fn());
    setTestGlobal('removeEventListener', jest.fn());
    mockGraphql(() => ({ signatureRequest: null }));

    await expect(
      new CloudBlockchainInterface().reconcileWalletOffer(
        testOperation,
        { kind: 'funding', uniqueId: 'uid', offer: { '1': -1n } },
        'SR_exact_not_found',
      ),
    ).resolves.toEqual({
      kind: 'unavailable',
      reason: expect.stringMatching(/temporarily not found/i),
    });
  });

  it('keeps a blocked creation popup unavailable for exact recovery', async () => {
    (globalThis as unknown as { open: () => unknown }).open = () => null;

    await expect(
      new CloudBlockchainInterface().reconcileWalletOffer(
        testOperation,
        { kind: 'funding', uniqueId: 'uid', offer: { '1': -1n } },
        'SR_exact_popup',
      ),
    ).resolves.toEqual({
      kind: 'unavailable',
      reason: expect.stringMatching(/popup blocked/i),
    });
  });

  it('keeps incomplete SUBMITTED creation unavailable after timeout', async () => {
    jest.useFakeTimers();
    saveCloudWalletAuth({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 20 * 60_000,
      walletId: 'Wallet_1',
    });
    (globalThis as unknown as { open: () => unknown }).open = () => ({ close: jest.fn() });
    setTestGlobal('addEventListener', jest.fn());
    setTestGlobal('removeEventListener', jest.fn());
    mockGraphql(() => ({
      signatureRequest: {
        id: 'SR_incomplete',
        status: 'SUBMITTED',
        transaction: { offer: null },
      },
    }));
    const completion = new CloudBlockchainInterface().reconcileWalletOffer(
      testOperation,
      { kind: 'funding', uniqueId: 'uid', offer: { '1': -1n } },
      'SR_incomplete',
    );
    await jest.advanceTimersByTimeAsync(10 * 60 * 1000);
    await expect(completion).resolves.toEqual({
      kind: 'unavailable',
      reason: expect.stringMatching(/timed out/i),
    });
    jest.useRealTimers();
  });

  it('cancels a persisted offer off chain by offerId', async () => {
    const calls = mockGraphql(() => ({
      cancelOffer: { signatureRequest: { id: 'SR_cancel', status: 'SUBMITTED' } },
    }));
    await expect(
      new CloudBlockchainInterface().beginWalletOfferCancellation('Offer_1'),
    ).resolves.toEqual({
      status: 'cancelled',
      detail: 'SUBMITTED',
    });
    const input = calls[0]!.variables.input as Record<string, unknown>;
    expect(input).toEqual({
      walletId: 'Wallet_1',
      offerId: 'Offer_1',
      fee: '0',
      cancelOffChain: true,
    });
  });

  it('preserves Cloud cancellation error details', async () => {
    setTestGlobal(
      'fetch',
      jest.fn(async () => ({
        status: 200,
        ok: true,
        text: async () =>
          JSON.stringify({ errors: [{ message: 'Offer already cancelled by another client' }] }),
      })),
    );

    await expect(
      new CloudBlockchainInterface().beginWalletOfferCancellation('Offer_1'),
    ).resolves.toEqual({
      status: 'rejected',
      detail: expect.stringMatching(/Offer already cancelled by another client/),
    });
  });

  it('accepts a structured exact-offer not-found code as already terminal', async () => {
    setTestGlobal(
      'fetch',
      jest.fn(async () => ({
        status: 200,
        ok: true,
        text: async () =>
          JSON.stringify({
            errors: [
              {
                message: 'offer is gone',
                extensions: { code: 'OFFER_NOT_FOUND', offerId: 'Offer_1' },
              },
            ],
          }),
      })),
    );

    await expect(
      new CloudBlockchainInterface().beginWalletOfferCancellation('Offer_1'),
    ).resolves.toEqual({
      status: 'already-terminal',
      detail: expect.stringMatching(/offer is gone/),
    });
  });

  it('classifies a blocked cancellation approval popup as unavailable', async () => {
    mockGraphql(() => ({
      cancelOffer: { signatureRequest: { id: 'SR_cancel', status: 'PENDING' } },
    }));

    const iface = new CloudBlockchainInterface();
    await expect(iface.beginWalletOfferCancellation('Offer_1')).resolves.toEqual({
      status: 'pending',
      recoveryId: 'SR_cancel',
    });
    await expect(iface.reconcileWalletOfferCancellation('Offer_1', 'SR_cancel')).resolves.toEqual({
      status: 'unavailable',
      detail: expect.stringMatching(/popup blocked/i),
    });
  });

  it.each([
    ['temporarily missing', { signatureRequest: null }],
    [
      'mismatched SUBMITTED response',
      { signatureRequest: { id: 'SR_other', status: 'SUBMITTED' } },
    ],
    ['malformed response', { signatureRequest: { id: 'SR_cancel', status: '' } }],
  ])('keeps a %s cancellation recovery unavailable', async (_label, response) => {
    (globalThis as unknown as { open: () => unknown }).open = () => ({ close: jest.fn() });
    setTestGlobal('addEventListener', jest.fn());
    setTestGlobal('removeEventListener', jest.fn());
    mockGraphql(() => response);

    await expect(
      new CloudBlockchainInterface().reconcileWalletOfferCancellation('Offer_1', 'SR_cancel'),
    ).resolves.toEqual({
      status: 'unavailable',
      detail: expect.stringMatching(/temporarily unavailable|incomplete/i),
    });
  });

  it('preserves cancellation recovery across a GraphQL response error without a new mutation', async () => {
    (globalThis as unknown as { open: () => unknown }).open = () => ({ close: jest.fn() });
    setTestGlobal('addEventListener', jest.fn());
    setTestGlobal('removeEventListener', jest.fn());
    const queries: string[] = [];
    setTestGlobal(
      'fetch',
      jest.fn(async (_url: string, init?: { body?: string }) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { query?: string };
        const query = body.query ?? '';
        queries.push(query);
        return {
          status: 200,
          ok: true,
          text: async () =>
            JSON.stringify(
              query.includes('cancelOffer')
                ? {
                    data: {
                      cancelOffer: {
                        signatureRequest: { id: 'SR_cancel_graphql', status: 'PENDING' },
                      },
                    },
                  }
                : { errors: [{ message: 'temporary GraphQL failure' }] },
            ),
        };
      }),
    );

    const iface = new CloudBlockchainInterface();
    const provider = iface.getWalletOfferProvider();
    expect(provider?.capability).toBe('recoverable-after-begin');
    if (!provider) throw new Error('expected Cloud wallet provider');
    const owner = {
      installationPlayerId: 'player',
      peerSessionId: 'session',
      providerScope: provider.scope,
    };
    storageRepository.ensureWalletContext(owner.providerScope);
    storageRepository.replaceFeeAttachments([
      {
        owner,
        submissionId: 'submission',
        stage: 'retained-for-replay',
        providerReservationId: 'Offer_1',
        reason: 'fee-source-attached',
      },
    ]);
    const providers = new WalletProviderRegistry();
    providers.attach(provider);
    const runtime = new FeeAttachmentRuntime(
      {
        isRetired: () => false,
        getOwner: () => owner,
        requestCommit: jest.fn(),
        reportWarning: jest.fn(),
      },
      providers,
    );
    runtime.retire(owner, 'submission');
    await runtime.awaitIdle();

    expect(storageRepository.feeAttachments()).toEqual([
      expect.objectContaining({
        providerReservationId: 'Offer_1',
        stage: 'cancelling',
        recoveryId: 'SR_cancel_graphql',
      }),
    ]);
    providers.ready(provider);
    await runtime.awaitIdle();

    expect(queries.filter((query) => query.includes('cancelOffer'))).toHaveLength(1);
    expect(queries.filter((query) => query.includes('signatureRequest(id: $id)'))).toHaveLength(2);
    expect(storageRepository.feeAttachments()).toEqual([
      expect.objectContaining({
        providerReservationId: 'Offer_1',
        stage: 'cancelling',
        recoveryId: 'SR_cancel_graphql',
      }),
    ]);
    runtime.detach();
  });

  it('does not complete cancellation while its signature request is pending', async () => {
    jest.useFakeTimers();
    let status = 'PENDING';
    const close = jest.fn();
    (globalThis as unknown as { open: () => unknown }).open = () => ({ close });
    setTestGlobal('addEventListener', jest.fn());
    setTestGlobal('removeEventListener', jest.fn());
    const calls = mockGraphql((query) => {
      if (query.includes('cancelOffer')) {
        return {
          cancelOffer: { signatureRequest: { id: 'SR_cancel', status: 'PENDING' } },
        };
      }
      return { signatureRequest: { id: 'SR_cancel', status } };
    });

    let settled = false;
    const iface = new CloudBlockchainInterface();
    await expect(iface.beginWalletOfferCancellation('Offer_1')).resolves.toEqual({
      status: 'pending',
      recoveryId: 'SR_cancel',
    });
    const cancellation = iface
      .reconcileWalletOfferCancellation('Offer_1', 'SR_cancel')
      .then((outcome) => {
        settled = true;
        return outcome;
      });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(calls.some((call) => call.query.includes('signatureRequest'))).toBe(true);

    status = 'SUBMITTED';
    await jest.advanceTimersByTimeAsync(1500);
    await expect(cancellation).resolves.toEqual({ status: 'cancelled', detail: 'SUBMITTED' });
    expect(close).toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('returns rejected for an explicitly failed cancellation signature request', async () => {
    (globalThis as unknown as { open: () => unknown }).open = () => ({ close: jest.fn() });
    setTestGlobal('addEventListener', jest.fn());
    setTestGlobal('removeEventListener', jest.fn());
    mockGraphql((query) => {
      if (query.includes('cancelOffer')) {
        return {
          cancelOffer: { signatureRequest: { id: 'SR_cancel', status: 'PENDING' } },
        };
      }
      return { signatureRequest: { id: 'SR_cancel', status: 'FAILED' } };
    });

    const iface = new CloudBlockchainInterface();
    await expect(iface.beginWalletOfferCancellation('Offer_1')).resolves.toEqual({
      status: 'pending',
      recoveryId: 'SR_cancel',
    });
    await expect(iface.reconcileWalletOfferCancellation('Offer_1', 'SR_cancel')).resolves.toEqual({
      status: 'rejected',
      detail: 'Cloud Wallet cancellation ended with status FAILED',
    });
  });

  it('does not preselect or pin Cloud wallet coins', async () => {
    const calls = mockGraphql(() => ({}));
    await expect(new CloudBlockchainInterface().selectCoins('uid', 100n)).resolves.toBeNull();
    expect(calls).toEqual([]);
  });

  it('rejects coin-record batches when the Cloud query fails', async () => {
    mockGraphql((_query, variables) => {
      if ((variables.input as { endpoint?: string })?.endpoint === 'get_coin_record_by_name') {
        throw new Error('cloud unavailable');
      }
      return {};
    });
    await expect(
      new CloudBlockchainInterface().getCoinRecordsByNames(['aa'.repeat(32)]),
    ).rejects.toThrow(/coin-record batch failed/i);
  });

  it('rejects coin-record batches containing incomplete identities', async () => {
    mockGraphql((_query, variables) => {
      if ((variables.input as { endpoint?: string })?.endpoint === 'get_coin_record_by_name') {
        return {
          coinset: {
            response: {
              success: true,
              coin_record: {
                coin: {
                  amount: '1',
                  puzzle_hash: 'bb',
                  parent_coin_info: 'cc'.repeat(32),
                },
                confirmed_block_index: 1,
                spent_block_index: 0,
                spent: false,
                coinbase: false,
                timestamp: 0,
              },
            },
          },
        };
      }
      return {};
    });
    await expect(
      new CloudBlockchainInterface().getCoinRecordsByNames(['aa'.repeat(32)]),
    ).rejects.toThrow(/incomplete coin record/i);
  });

  it('reads peak height from get_blockchain_state', async () => {
    const calls = mockGraphql(() => ({
      coinset: {
        response: {
          success: true,
          blockchain_state: { peak: { height: 1234 } },
        },
      },
    }));
    await expect(new CloudBlockchainInterface().getHeightInfo()).resolves.toBe(1234n);
    expect(calls[0]!.variables.input).toEqual({
      walletId: 'Wallet_1',
      endpoint: 'get_blockchain_state',
      request: {},
    });
  });

  it('uses singular and batch Coinset coin-record requests without reshaping the request', async () => {
    const record = {
      coin: {
        parent_coin_info: '11'.repeat(32),
        puzzle_hash: '22'.repeat(32),
        amount: '50',
      },
      confirmed_block_index: 10,
      spent_block_index: 0,
      spent: false,
      coinbase: false,
      timestamp: 123,
    };
    const calls = mockGraphql((_query, variables) => {
      const endpoint = (variables.input as { endpoint: string }).endpoint;
      return {
        coinset: {
          response:
            endpoint === 'get_coin_record_by_name'
              ? { success: true, coin_record: record }
              : { success: true, coin_records: [record] },
        },
      };
    });
    const iface = new CloudBlockchainInterface();
    await expect(iface.getCoinRecordsByNames(['aa'.repeat(32)])).resolves.toHaveLength(1);
    await expect(
      iface.getCoinRecordsByNames(['aa'.repeat(32), 'bb'.repeat(32)]),
    ).resolves.toHaveLength(1);
    expect((calls[0]!.variables.input as any).request).toEqual({ name: 'aa'.repeat(32) });
    expect((calls[1]!.variables.input as any).request).toEqual({
      names: ['aa'.repeat(32), 'bb'.repeat(32)],
      include_spent_coins: true,
    });
  });

  it('resolves spent height before requesting puzzle and solution', async () => {
    const calls = mockGraphql((_query, variables) => {
      const endpoint = (variables.input as { endpoint: string }).endpoint;
      if (endpoint === 'get_coin_record_by_name') {
        return {
          coinset: {
            response: {
              success: true,
              coin_record: {
                coin: {
                  parent_coin_info: '11'.repeat(32),
                  puzzle_hash: '22'.repeat(32),
                  amount: '50',
                },
                confirmed_block_index: 10,
                spent_block_index: 25,
                spent: true,
                coinbase: false,
                timestamp: 123,
              },
            },
          },
        };
      }
      return {
        coinset: {
          response: {
            success: true,
            coin_solution: { puzzle_reveal: '0xaa', solution: '0xbb' },
          },
        },
      };
    });
    await expect(
      new CloudBlockchainInterface().getPuzzleAndSolution('00'.repeat(72)),
    ).resolves.toEqual(['aa', 'bb']);
    expect((calls[1]!.variables.input as any).endpoint).toBe('get_puzzle_and_solution');
    expect((calls[1]!.variables.input as any).request.height).toBe(25);
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
    mockGraphql(() => ({
      coinset: { response: { success: false, status: 'FAILED' } },
    }));
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
    mockGraphql(() => ({
      coinset: {
        response: status === undefined ? {} : { success: false, status },
      },
    }));
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
    mockGraphql(() => ({
      coinset: { response: { success: false, error: message } },
    }));
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

  it('classifies a null Coinset response as unavailable', async () => {
    mockGraphql(() => ({
      coinset: { response: null },
    }));
    await expect(
      new CloudBlockchainInterface().spend('', sampleBundle(), '', 'test'),
    ).resolves.toMatchObject({
      status: 'unavailable',
      detail: expect.stringContaining('returned no response'),
    });
  });

  it('spend submits the exact Rust-selected bundle through Coinset', async () => {
    mockGraphql(() => ({
      coinset: { response: { success: true, status: 'SUCCESS' } },
    }));
    const iface = new CloudBlockchainInterface();
    await expect(iface.spend('', sampleBundle(), '', 'test', 500n)).resolves.toEqual({
      status: 'acknowledged',
      detail: 'SUCCESS',
    });
  });
});
