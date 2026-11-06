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
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import CloudWalletApprovalNotice from '../../components/CloudWalletApprovalNotice';
import { expectConsoleError } from '../../../scripts/testSetup';
import { ChannelFundingRuntime } from '../session/channelFundingRuntime';
import { FeeAttachmentRuntime } from '../session/feeAttachmentRuntime';
import { SubmissionPump } from '../session/submissionPump';
import type { ChiaGame, TransactionSubmission } from '../../types/ChiaGaming';
import { storageRepository } from '../session/storageRepository';
import { WalletProviderRegistry } from '../session/walletProviderRegistry';
import { BlockchainPoller } from '../wallet/BlockchainPoller';
import {
  classifyCloudWalletSubmitError,
  CloudBlockchainInterface,
  cloudBlockchainInfo,
} from '../wallet/CloudBlockchainInterface';
import { clearCloudWalletAuth, saveCloudWalletAuth } from '../wallet/cloudWalletAuth';
import { CloudWalletResponseError } from '../wallet/cloudWalletOAuth';

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
    await storageRepository.write(storageRepository.patchApplicationState(() => empty));
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
        origin: 'https://vault.chia.net',
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
      origin: 'https://vault.chia.net',
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
      origin: 'https://vault.chia.net',
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

  it('holds a blocked creation until the user reopens the approval', async () => {
    jest.useFakeTimers();
    const close = jest.fn();
    const open = jest.fn((): unknown => null);
    (globalThis as unknown as { open: () => unknown }).open = open;
    setTestGlobal('addEventListener', jest.fn());
    setTestGlobal('removeEventListener', jest.fn());
    let status = 'PENDING';
    mockGraphql(() => ({
      signatureRequest: {
        id: 'SR_exact_popup',
        status,
        transaction: { offer: { bech32: 'offer1abc', offerId: 'Offer_1' } },
      },
    }));

    const iface = new CloudBlockchainInterface();
    const listener = jest.fn();
    iface.onBlockedApprovalsChange(listener);
    const completion = iface.reconcileWalletOffer(
      testOperation,
      { kind: 'funding', uniqueId: 'uid', offer: { '1': -1n } },
      'SR_exact_popup',
    );
    await jest.advanceTimersByTimeAsync(0);
    expect(iface.getBlockedApprovals()).toEqual([
      expect.objectContaining({ signatureRequestId: 'SR_exact_popup', source: 'funding' }),
    ]);
    expect(listener).toHaveBeenCalledTimes(1);

    expect(iface.openBlockedApproval()).toBe(false);
    expect(iface.getBlockedApprovals()).toHaveLength(1);

    open.mockReturnValue({ close });
    expect(iface.openBlockedApproval()).toBe(true);
    expect(iface.getBlockedApprovals()).toEqual([]);

    status = 'SUBMITTED';
    await jest.advanceTimersByTimeAsync(1500);
    await expect(completion).resolves.toEqual({
      kind: 'created-reserved',
      material: { kind: 'offer', offer: 'offer1abc' },
      tradeId: 'Offer_1',
    });
    expect(close).toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('completes a blocked approval that was approved elsewhere', async () => {
    jest.useFakeTimers();
    let status = 'PENDING';
    mockGraphql(() => ({
      signatureRequest: {
        id: 'SR_elsewhere',
        status,
        transaction: { offer: { bech32: 'offer1abc', offerId: 'Offer_1' } },
      },
    }));
    const iface = new CloudBlockchainInterface();
    const completion = iface.reconcileWalletOffer(
      testOperation,
      { kind: 'funding', uniqueId: 'uid', offer: { '1': -1n } },
      'SR_elsewhere',
    );
    await jest.advanceTimersByTimeAsync(0);
    expect(iface.getBlockedApprovals()).toHaveLength(1);

    status = 'SUBMITTED';
    await jest.advanceTimersByTimeAsync(1500);
    await expect(completion).resolves.toMatchObject({ kind: 'created-reserved' });
    expect(iface.getBlockedApprovals()).toEqual([]);
    jest.useRealTimers();
  });

  it('releases a deadline-bound fee to its no-fee fallback when the approval stays blocked', async () => {
    jest.useFakeTimers();
    mockGraphql(() => ({
      signatureRequest: { id: 'SR_fee', status: 'PENDING', transaction: null },
    }));
    const iface = new CloudBlockchainInterface();
    const completion = iface.reconcileWalletOffer(
      { ...testOperation, purpose: { kind: 'fee' as const, operationId: 'operation' } },
      { kind: 'fee', uniqueId: 'uid', fee: 10n, concurrentSpendCoinId: 'ab'.repeat(32) },
      'SR_fee',
    );
    await jest.advanceTimersByTimeAsync(59_000);
    expect(iface.getBlockedApprovals()).toHaveLength(1);

    await jest.advanceTimersByTimeAsync(1_000);
    await expect(completion).resolves.toEqual({
      kind: 'unavailable',
      reason: expect.stringMatching(/popup blocked/i),
    });
    expect(iface.getBlockedApprovals()).toEqual([]);
    jest.useRealTimers();
  });

  describe('approval window lifecycle', () => {
    const feeOperation = {
      ...testOperation,
      purpose: { kind: 'fee' as const, operationId: 'operation' },
    };
    const feeRequest = {
      kind: 'fee' as const,
      uniqueId: 'uid',
      fee: 10n,
      concurrentSpendCoinId: 'ab'.repeat(32),
    };
    const pendingFee = () => ({
      signatureRequest: { id: 'SR_fee', status: 'PENDING', transaction: null },
    });
    const signatureRequestQueries = (calls: Array<{ query: string }>) =>
      calls.filter(({ query }) => query.includes('signatureRequest(id: $id)')).length;
    const setPopup = (popup: unknown) => {
      (globalThis as unknown as { open: () => unknown }).open = () => popup;
    };

    beforeEach(() => {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
      setTestGlobal('addEventListener', jest.fn());
      setTestGlobal('removeEventListener', jest.fn());
      setPopup(null);
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('queries nothing further once a blocked fee wait has ended', async () => {
      const calls = mockGraphql(pendingFee);
      const iface = new CloudBlockchainInterface();
      for (let retry = 0; retry < 3; retry += 1) {
        const completion = iface.reconcileWalletOffer(feeOperation, feeRequest, 'SR_fee');
        await jest.advanceTimersByTimeAsync(60_000);
        await expect(completion).resolves.toMatchObject({ kind: 'unavailable' });

        const before = signatureRequestQueries(calls);
        await jest.advanceTimersByTimeAsync(15_000);
        expect(signatureRequestQueries(calls)).toBe(before);
      }
    });

    it('queries nothing further once cancellation status is rejected', async () => {
      const open = jest.fn(() => null);
      setTestGlobal('open', open);
      let status = 'PENDING';
      const calls = mockGraphql(() => ({
        signatureRequest: { id: 'SR_cancel', status },
      }));
      const completion = new CloudBlockchainInterface().reconcileWalletOfferCancellation(
        'Offer_1',
        'SR_cancel',
      );
      await jest.advanceTimersByTimeAsync(2_000);
      status = 'REJECTED';
      await jest.advanceTimersByTimeAsync(1_500);
      await expect(completion).resolves.toMatchObject({ status: 'rejected' });
      expect(open).not.toHaveBeenCalled();

      const before = signatureRequestQueries(calls);
      await jest.advanceTimersByTimeAsync(15_000);
      expect(signatureRequestQueries(calls)).toBe(before);
    });

    it.each(['browser', 'desktop'] as const)(
      'settles revoked %s delivery promptly and leaves the exact request available for observe-only recovery',
      async (surface) => {
        let allowed = true;
        let status = 'PENDING';
        let notify = () => {};
        const unsubscribe = jest.fn();
        const open = jest.fn(() => null);
        const openInBrowser = jest.fn(async () => true);
        setTestGlobal('open', open);
        if (surface === 'desktop') setTestGlobal('__chiaCloudWallet', { openInBrowser });
        const calls = mockGraphql(() => ({
          signatureRequest: {
            id: 'SR_fee',
            status,
            transaction: { offer: { bech32: 'offer1abc', offerId: 'Offer_1' } },
          },
        }));
        const iface = new CloudBlockchainInterface();
        let settled = false;
        const completion = iface
          .reconcileWalletOffer(feeOperation, feeRequest, 'SR_fee', {
            mode: 'delivery',
            allowApproval: () => allowed,
            onApprovalChange: (listener) => {
              notify = listener;
              return unsubscribe;
            },
          })
          .finally(() => {
            settled = true;
          });
        try {
          await jest.advanceTimersByTimeAsync(0);
          allowed = false;
          notify();
          await jest.advanceTimersByTimeAsync(0);
          expect(iface.getBlockedApprovals()).toEqual([]);
          expect(settled).toBe(true);
          await expect(completion).resolves.toMatchObject({
            kind: 'unavailable',
            reason: expect.stringMatching(/no longer needed/i),
          });
          expect(unsubscribe).toHaveBeenCalledTimes(1);
          const requests = calls.length;
          await jest.advanceTimersByTimeAsync(3000);
          expect(calls).toHaveLength(requests);

          let recovered = false;
          const cleanup = iface
            .reconcileWalletOffer(feeOperation, feeRequest, 'SR_fee', {
              mode: 'observe-only',
            })
            .finally(() => {
              recovered = true;
            });
          await jest.advanceTimersByTimeAsync(61_000);
          expect(recovered).toBe(false);
          status = 'SUBMITTED';
          await jest.advanceTimersByTimeAsync(1500);
          await expect(cleanup).resolves.toMatchObject({ kind: 'created-reserved' });
          expect(open).toHaveBeenCalledTimes(surface === 'browser' ? 1 : 0);
          expect(openInBrowser).toHaveBeenCalledTimes(surface === 'desktop' ? 1 : 0);
          expect(calls.every(({ variables }) => variables.id === 'SR_fee')).toBe(true);
        } finally {
          Reflect.deleteProperty(globalThis, '__chiaCloudWallet');
        }
      },
    );

    it.each(['blocked-approval', 'begin-response', 'teardown-before-response'] as const)(
      'settles a fee interrupted at %s without blocking delivery or independent cleanup',
      async (revokedAt) => {
        let feeStatus = 'PENDING';
        let queriesBeforeCleanup = 0;
        let ownerRetired = false;
        let supersedeDuringCreate = () => {};
        const calls = mockGraphql((query) => {
          if (query.includes('createOffer')) {
            supersedeDuringCreate();
            return { createOffer: { signatureRequest: { id: 'SR_pump_fee', status: 'PENDING' } } };
          }
          if (query.includes('cancelOffer')) return { cancelOffer: { signatureRequest: null } };
          return {
            signatureRequest: {
              id: 'SR_pump_fee',
              status: feeStatus,
              transaction: { offer: { bech32: 'offer1abc', offerId: 'Offer_pump' } },
            },
          };
        });
        const open = jest.fn(() => null);
        setTestGlobal('open', open);
        const iface = new CloudBlockchainInterface();
        jest.spyOn(iface, 'isConnected').mockReturnValue(true);
        jest.spyOn(iface, 'isReadyForPlay').mockReturnValue(true);
        const spend = jest.spyOn(iface, 'spend').mockResolvedValue({ status: 'acknowledged' });
        const height = jest.spyOn(iface, 'getHeightInfo').mockResolvedValue(123n);
        const blockchain = new BlockchainPoller(iface, 60_000);
        const provider = blockchain.rpc.getWalletOfferProvider();
        if (!provider || provider.capability !== 'recoverable-after-begin') {
          throw new Error('expected queued Cloud provider');
        }
        const reconcileCreation = jest.spyOn(provider, 'reconcileCreation');
        const cleanupCalls = () =>
          reconcileCreation.mock.calls.filter(
            ([, , , options]) => options?.mode === 'observe-only',
          );
        expect(provider).not.toBe(iface.getWalletOfferProvider());
        const owner = {
          installationPlayerId: 'player',
          peerSessionId: 'pump-session',
          providerScope: provider.scope,
        };
        storageRepository.ensureWalletContext(owner.providerScope);
        blockchain.refreshProviderReadiness();
        const finalize = jest.fn(() => ({
          protocol_bundle: { spends: [] },
          bundle: {},
          applied_fee: '0',
          fee_source_disposition: 'unused',
          variant_fingerprint: 'base',
          should_broadcast: true,
        }));
        const cradle = {
          finalize_submission_attempt: finalize,
          acknowledge_submission_attempt: jest.fn(),
          relinquish_submission_attempt: jest.fn(),
        } as unknown as ChiaGame;
        const reportLocalFailure = jest.fn();
        const pump = new SubmissionPump({
          getCradle: () => cradle,
          getBlockchain: () => blockchain,
          getRewardPuzzleHash: () => '11'.repeat(32),
          getWalletOwner: () => (ownerRetired ? null : owner),
          getInstallationPlayerId: () => owner.installationPlayerId,
          isRetired: () => ownerRetired,
          isPublishingDisabled: () => false,
          enqueueResult: async (work) => work(),
          releaseAfterPersistence: (_key, work) => Promise.resolve().then(work),
          requestCommit: jest.fn(),
          reportWarning: jest.fn(),
          reportLocalFailure,
          reportError: jest.fn(),
          requestFreshSync: jest.fn(),
        });
        const submission: TransactionSubmission = {
          id: 'pump-fee',
          attempt_token: 'first',
          predecessor_attempt_token: null,
          relationship: 'initial',
          bundle: { spends: [] },
          fee_request: { amount: '10', target: 'ab'.repeat(32) },
        };
        const settle = async (done: () => boolean) => {
          for (let turn = 0; turn < 100 && !done(); turn += 1) {
            await jest.advanceTimersByTimeAsync(10);
            await new Promise((resolve) => setImmediate(resolve));
          }
          expect(done()).toBe(true);
        };
        const successor: TransactionSubmission = {
          ...submission,
          attempt_token: 'successor',
          predecessor_attempt_token: 'first',
          relationship: 'exact',
        };
        try {
          if (revokedAt === 'begin-response') supersedeDuringCreate = () => pump.submit(successor);
          if (revokedAt === 'teardown-before-response') {
            supersedeDuringCreate = () => {
              ownerRetired = true;
              pump.retireAll();
              storageRepository.replaceFeeAttachments([]);
            };
          }
          pump.providerReady(true);
          pump.submit(submission);
          if (revokedAt === 'blocked-approval') {
            await settle(() => iface.getBlockedApprovals().length === 1);
            queriesBeforeCleanup = calls.filter(
              ({ variables }) => variables.id === 'SR_pump_fee',
            ).length;
            pump.submit(successor);
          } else {
            await settle(() => calls.some(({ query }) => query.includes('createOffer')));
          }
          let flushed = false;
          const flush = pump.flush().then(() => {
            flushed = true;
          });
          await settle(() => flushed && pump.isQuiescent());
          await flush;
          const deliveryCount = revokedAt === 'teardown-before-response' ? 0 : 1;
          expect(spend).toHaveBeenCalledTimes(deliveryCount);
          if (revokedAt === 'teardown-before-response') {
            expect(finalize).not.toHaveBeenCalled();
            expect(storageRepository.feeAttachments()).toEqual([]);
          } else {
            expect(finalize).toHaveBeenCalledWith(
              'successor',
              expect.objectContaining({ kind: 'failure' }),
            );
            expect(storageRepository.feeAttachments()).toEqual([
              expect.objectContaining({
                stage: 'creating',
                disposition: 'cancel-on-create',
                recoveryId: 'SR_pump_fee',
              }),
            ]);
          }
          expect(reportLocalFailure).not.toHaveBeenCalled();
          const creates = () => calls.filter(({ query }) => query.includes('createOffer'));
          expect(creates()).toHaveLength(1);
          // Revocation must start cleanup itself, without a readiness/reconnect/reload event.
          await settle(
            () =>
              calls.filter(({ variables }) => variables.id === 'SR_pump_fee').length >
              queriesBeforeCleanup,
          );
          expect(cleanupCalls()).toHaveLength(1);
          // Repeated cancellation joins the in-progress observer rather than starting another.
          if (revokedAt !== 'teardown-before-response') {
            pump.retire(submission.id);
            pump.retire(submission.id);
            await jest.advanceTimersByTimeAsync(0);
            expect(cleanupCalls()).toHaveLength(1);
          }
          // Pending observation must not occupy the broadcast or chain-read lane.
          let readFinished = false;
          let independentBroadcastFinished = false;
          const read = blockchain.rpc.getHeightInfo().then((value) => {
            readFinished = true;
            return value;
          });
          const broadcast = blockchain.rpc
            .spend('80', {}, '11'.repeat(32), 'independent transaction')
            .then((outcome) => {
              independentBroadcastFinished = true;
              return outcome;
            });
          await settle(() => readFinished && independentBroadcastFinished);
          await expect(read).resolves.toBe(123n);
          await expect(broadcast).resolves.toEqual({ status: 'acknowledged' });
          expect(height).toHaveBeenCalledTimes(1);
          expect(spend).toHaveBeenCalledTimes(deliveryCount + 1);
          if (revokedAt === 'teardown-before-response') {
            expect(storageRepository.feeAttachments()).toEqual([]);
          } else {
            expect(storageRepository.feeAttachments()).toEqual([
              expect.objectContaining({
                stage: 'creating',
                disposition: 'cancel-on-create',
                recoveryId: 'SR_pump_fee',
              }),
            ]);
          }
          feeStatus = 'SUBMITTED';
          await jest.advanceTimersByTimeAsync(1500);
          await settle(
            () => calls.filter(({ query }) => query.includes('cancelOffer')).length === 1,
          );
          expect(storageRepository.feeAttachments()).toEqual([]);
          expect(creates()).toHaveLength(1);
          expect(cleanupCalls()).toHaveLength(1);
          expect(calls.filter(({ query }) => query.includes('cancelOffer'))).toHaveLength(1);
          expect(
            calls
              .filter(({ query }) => query.includes('signatureRequest(id: $id)'))
              .every(({ variables }) => variables.id === 'SR_pump_fee'),
          ).toBe(true);
          expect(open).toHaveBeenCalledTimes(revokedAt === 'blocked-approval' ? 1 : 0);
          expect(iface.getBlockedApprovals()).toEqual([]);
        } finally {
          pump.retireAll();
          blockchain.detachProvider();
        }
      },
    );

    it('opens the first live approval on the first click after an earlier owner is revoked', async () => {
      let oldOwnerActive = true;
      let status = 'PENDING';
      mockGraphql((_query, variables) => ({
        signatureRequest: {
          id: variables.id,
          status,
          transaction: { offer: { bech32: 'offer1abc', offerId: 'Offer_1' } },
        },
      }));
      const iface = new CloudBlockchainInterface();
      const obsolete = iface.reconcileWalletOffer(feeOperation, feeRequest, 'SR_old', {
        mode: 'delivery',
        allowApproval: () => oldOwnerActive,
      });
      const live = iface.reconcileWalletOffer(feeOperation, feeRequest, 'SR_live');
      await jest.advanceTimersByTimeAsync(0);
      expect(
        iface.getBlockedApprovals().map(({ signatureRequestId }) => signatureRequestId),
      ).toEqual(['SR_old', 'SR_live']);
      // A click must choose the live entry even when an ownership notification has not arrived yet.
      oldOwnerActive = false;
      const open = jest.fn(() => ({ close: jest.fn(), closed: false }));
      setTestGlobal('open', open);
      const reopened = iface.openBlockedApproval();
      status = 'SUBMITTED';
      await jest.advanceTimersByTimeAsync(1500);
      await Promise.all([obsolete, live]);
      expect(reopened).toBe(true);
      expect(open).toHaveBeenCalledTimes(1);
      expect(open.mock.calls[0]).toEqual(
        expect.arrayContaining([expect.stringContaining('SR_live')]),
      );
      expect(iface.getBlockedApprovals()).toEqual([]);
    });

    it('does not limit a fee while its reopened approval window stays open', async () => {
      mockGraphql(pendingFee);
      const iface = new CloudBlockchainInterface();
      let settled = false;
      const completion = iface
        .reconcileWalletOffer(feeOperation, feeRequest, 'SR_fee')
        .finally(() => {
          settled = true;
        });
      await jest.advanceTimersByTimeAsync(30_000);
      setPopup({ close: jest.fn(), closed: false });
      expect(iface.openBlockedApproval()).toBe(true);

      await jest.advanceTimersByTimeAsync(5 * 60_000);
      expect(settled).toBe(false);
      expect(iface.getBlockedApprovals()).toEqual([]);

      await jest.advanceTimersByTimeAsync(10 * 60_000);
      await completion;
    });

    it('returns a closed reopened window to the prompt and restarts the fee wait', async () => {
      mockGraphql(pendingFee);
      const iface = new CloudBlockchainInterface();
      const completion = iface.reconcileWalletOffer(feeOperation, feeRequest, 'SR_fee');
      await jest.advanceTimersByTimeAsync(30_000);
      const popup = { close: jest.fn(), closed: false };
      setPopup(popup);
      expect(iface.openBlockedApproval()).toBe(true);
      await jest.advanceTimersByTimeAsync(2 * 60_000);

      popup.closed = true;
      await jest.advanceTimersByTimeAsync(1_000);
      expect(iface.getBlockedApprovals()).toEqual([
        expect.objectContaining({ signatureRequestId: 'SR_fee', reason: 'closed' }),
      ]);

      await jest.advanceTimersByTimeAsync(58_000);
      expect(iface.getBlockedApprovals()).toHaveLength(1);
      await jest.advanceTimersByTimeAsync(2_000);
      await expect(completion).resolves.toEqual({
        kind: 'unavailable',
        reason: expect.stringMatching(/window was closed/),
      });
      expect(iface.getBlockedApprovals()).toEqual([]);
    });

    it('treats a closed window that opened normally the same way, and lets the prompt reopen it', async () => {
      let status = 'PENDING';
      mockGraphql(() => ({
        signatureRequest: {
          id: 'SR_fee',
          status,
          transaction: { offer: { bech32: 'offer1abc', offerId: 'Offer_1' } },
        },
      }));
      const first = { close: jest.fn(), closed: false };
      setPopup(first);
      const iface = new CloudBlockchainInterface();
      const completion = iface.reconcileWalletOffer(feeOperation, feeRequest, 'SR_fee');
      await jest.advanceTimersByTimeAsync(0);
      expect(iface.getBlockedApprovals()).toEqual([]);

      first.closed = true;
      await jest.advanceTimersByTimeAsync(1_000);
      expect(iface.getBlockedApprovals()).toHaveLength(1);

      const second = { close: jest.fn(), closed: false };
      setPopup(second);
      expect(iface.openBlockedApproval()).toBe(true);
      expect(iface.getBlockedApprovals()).toEqual([]);

      status = 'SUBMITTED';
      await jest.advanceTimersByTimeAsync(1_500);
      await expect(completion).resolves.toMatchObject({ kind: 'created-reserved' });
      expect(second.close).toHaveBeenCalled();
    });

    it('keeps a shared approval window open until its last waiter finishes', async () => {
      let status = 'PENDING';
      mockGraphql(() => ({
        signatureRequest: {
          id: 'SR_fee',
          status,
          transaction: { offer: { bech32: 'offer1abc', offerId: 'Offer_1' } },
        },
      }));
      const popup = {
        closed: false,
        close: jest.fn(() => {
          popup.closed = true;
        }),
      };
      setPopup(popup);
      const iface = new CloudBlockchainInterface();
      const first = iface.reconcileWalletOffer(feeOperation, feeRequest, 'SR_fee');
      await jest.advanceTimersByTimeAsync(700);
      const second = iface.reconcileWalletOffer(feeOperation, feeRequest, 'SR_fee');
      await jest.advanceTimersByTimeAsync(100);

      status = 'SUBMITTED';
      await jest.advanceTimersByTimeAsync(800);
      await expect(first).resolves.toMatchObject({ kind: 'created-reserved' });
      expect(popup.close).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(500);
      expect(iface.getBlockedApprovals()).toEqual([]);
      await jest.advanceTimersByTimeAsync(300);
      await expect(second).resolves.toMatchObject({ kind: 'created-reserved' });
      expect(iface.getBlockedApprovals()).toEqual([]);
      expect(popup.close).toHaveBeenCalledTimes(1);
    });

    it('does not prompt again when the wallet closes its own window after approving', async () => {
      const popup = { close: jest.fn(), closed: false };
      setPopup(popup);
      let listener: ((event: MessageEvent) => void) | undefined;
      setTestGlobal(
        'addEventListener',
        jest.fn((_type: string, callback: (event: MessageEvent) => void) => {
          listener = callback;
        }),
      );
      let status = 'PENDING';
      mockGraphql(() => ({
        signatureRequest: {
          id: 'SR_fee',
          status,
          transaction: { offer: { bech32: 'offer1abc', offerId: 'Offer_1' } },
        },
      }));
      const iface = new CloudBlockchainInterface();
      const completion = iface.reconcileWalletOffer(feeOperation, feeRequest, 'SR_fee');
      await jest.advanceTimersByTimeAsync(0);

      listener?.({
        origin: 'https://vault.chia.net',
        source: popup,
        data: {
          type: 'chia-cloud-wallet/signature-request',
          signatureRequestId: 'SR_fee',
          status: 'approved',
        },
      } as unknown as MessageEvent);
      popup.closed = true;
      await jest.advanceTimersByTimeAsync(61_000);
      expect(iface.getBlockedApprovals()).toEqual([]);

      status = 'SUBMITTED';
      await jest.advanceTimersByTimeAsync(1_500);
      await expect(completion).resolves.toMatchObject({ kind: 'created-reserved' });
    });

    describe('a fee approved after its submission retired', () => {
      const settle = async (done: () => boolean) => {
        for (let turn = 0; turn < 200 && !done(); turn += 1) {
          await jest.advanceTimersByTimeAsync(10);
          await new Promise((resolve) => setImmediate(resolve));
        }
        expect(done()).toBe(true);
      };

      function feeWallet(onCreateOffer: () => void = () => {}) {
        const statuses = { fee: 'PENDING', cancel: 'PENDING', feePollFails: false };
        const calls = mockGraphql((query, variables) => {
          if (query.includes('createOffer')) {
            onCreateOffer();
            return { createOffer: { signatureRequest: { id: 'SR_fee', status: 'PENDING' } } };
          }
          if (query.includes('cancelOffer')) {
            return { cancelOffer: { signatureRequest: { id: 'SR_cancel', status: 'PENDING' } } };
          }
          if (variables.id === 'SR_fee' && statuses.feePollFails) {
            statuses.feePollFails = false;
            throw new TypeError('NetworkError when attempting to fetch resource.');
          }
          return variables.id === 'SR_fee'
            ? {
                signatureRequest: {
                  id: 'SR_fee',
                  status: statuses.fee,
                  transaction: { offer: { bech32: 'offer1abc', offerId: 'Offer_1' } },
                },
              }
            : { signatureRequest: { id: 'SR_cancel', status: statuses.cancel } };
        });
        const iface = new CloudBlockchainInterface();
        const provider = iface.getWalletOfferProvider();
        if (!provider) throw new Error('expected Cloud wallet provider');
        const owner = {
          installationPlayerId: 'player',
          peerSessionId: 'session',
          providerScope: provider.scope,
        };
        storageRepository.ensureWalletContext(owner.providerScope);
        const providers = new WalletProviderRegistry();
        providers.attach(provider);
        const newRuntime = () =>
          new FeeAttachmentRuntime(
            {
              isRetired: () => false,
              getOwner: () => owner,
              requestCommit: jest.fn(),
              reportWarning: jest.fn(),
            },
            providers,
          );
        return { calls, iface, newRuntime, owner, provider, providers, statuses };
      }

      async function retiredWhileBlocked(openBeforeRetiring = false) {
        const wallet = feeWallet();
        const runtime = wallet.newRuntime();
        let inactive = false;
        const reservation = runtime.reserve(wallet.owner, 'submission', feeRequest, () => inactive);
        await settle(() => wallet.iface.getBlockedApprovals().length === 1);
        const popup = { close: jest.fn(), closed: false };
        if (openBeforeRetiring) {
          setPopup(popup);
          expect(wallet.iface.openBlockedApproval()).toBe(true);
        }
        inactive = true;
        runtime.retire(wallet.owner, 'submission');
        return { ...wallet, reservation, runtime, popup };
      }

      const retiredRequest = expect.objectContaining({
        stage: 'creating',
        recoveryId: 'SR_fee',
        disposition: 'cancel-on-create',
      });
      const cancelOffers = (calls: Array<{ query: string }>) =>
        calls.filter(({ query }) => query.includes('cancelOffer')).length;

      async function expectCancellationAfterLaterReadiness({
        calls,
        provider,
        providers,
        statuses,
      }: Pick<ReturnType<typeof feeWallet>, 'calls' | 'provider' | 'providers' | 'statuses'>) {
        statuses.fee = 'SUBMITTED';
        await jest.advanceTimersByTimeAsync(3_000);
        expect(cancelOffers(calls)).toBe(0);
        expect(storageRepository.feeAttachments()).toEqual([retiredRequest]);

        providers.reconnectReady(provider);
        await settle(() =>
          storageRepository.feeAttachments().some(({ stage }) => stage === 'cancelling'),
        );
        expect(cancelOffers(calls)).toBe(1);

        statuses.cancel = 'SUBMITTED';
        await settle(() => storageRepository.feeAttachments().length === 0);
      }

      it.each([
        ['browser', false],
        ['browser', true],
        ['desktop', false],
        ['desktop', true],
      ] as const)(
        'observes a dead fee creation without approval on %s (restored=%s)',
        async (surface, restored) => {
          const open = jest.fn(() => null);
          const openInBrowser = jest.fn(async () => true);
          setTestGlobal('open', open);
          if (surface === 'desktop') setTestGlobal('__chiaCloudWallet', { openInBrowser });
          let retire = () => {};
          const wallet = feeWallet(() => retire());
          if (restored) {
            storageRepository.replaceFeeAttachments([
              {
                owner: wallet.owner,
                submissionId: 'submission',
                stage: 'creating',
                disposition: 'cancel-on-create',
                recoveryId: 'SR_fee',
                request: feeRequest,
                reason: 'fee-creation-pending',
              },
            ]);
          }
          const runtime = wallet.newRuntime();
          let reservation: ReturnType<FeeAttachmentRuntime['reserve']> | undefined;
          let inactive = false;
          retire = () => {
            inactive = true;
            runtime.retire(wallet.owner, 'submission');
          };
          try {
            if (!restored) {
              reservation = runtime.reserve(wallet.owner, 'submission', feeRequest, () => inactive);
              await expect(reservation).resolves.toMatchObject({ kind: 'unavailable' });
              expect(storageRepository.feeAttachments()).toEqual([retiredRequest]);
              wallet.providers.reconnectReady(wallet.provider);
            }
            await settle(() => wallet.calls.some(({ variables }) => variables.id === 'SR_fee'));
            expect(storageRepository.feeAttachments()).toEqual([retiredRequest]);
            wallet.statuses.fee = 'SUBMITTED';
            await settle(() =>
              storageRepository.feeAttachments().some(({ stage }) => stage === 'cancelling'),
            );
            expect(storageRepository.feeAttachments()).toEqual([
              expect.objectContaining({ providerReservationId: 'Offer_1', stage: 'cancelling' }),
            ]);
            wallet.statuses.cancel = 'SUBMITTED';
            await settle(() => storageRepository.feeAttachments().length === 0);
            if (reservation)
              await expect(reservation).resolves.toMatchObject({ kind: 'unavailable' });
            expect(open).not.toHaveBeenCalled();
            expect(openInBrowser).not.toHaveBeenCalled();
            expect(wallet.iface.getBlockedApprovals()).toEqual([]);
            expect(wallet.calls.filter(({ query }) => query.includes('createOffer'))).toHaveLength(
              restored ? 0 : 1,
            );
            expect(cancelOffers(wallet.calls)).toBe(1);
          } finally {
            runtime.detach();
            Reflect.deleteProperty(globalThis, '__chiaCloudWallet');
          }
        },
      );

      it.each(['blocked', 'open'] as const)(
        'revokes an active %s fee approval when its reservation is retired',
        async (approval) => {
          const popup = { close: jest.fn(), closed: false };
          const open = jest.fn(() => (approval === 'open' ? popup : null));
          setTestGlobal('open', open);
          const wallet = feeWallet();
          const runtime = wallet.newRuntime();
          // The reservation ledger must revoke approval even before the caller notices retirement.
          const reservation = runtime.reserve(wallet.owner, 'submission', feeRequest, () => false);
          await settle(() => wallet.calls.some(({ variables }) => variables.id === 'SR_fee'));
          expect(open).toHaveBeenCalledTimes(1);
          runtime.retire(wallet.owner, 'submission');
          if (approval === 'blocked') {
            expect(wallet.iface.openBlockedApproval()).toBe(true);
          } else {
            popup.closed = true;
            await jest.advanceTimersByTimeAsync(500);
          }
          expect(wallet.iface.getBlockedApprovals()).toEqual([]);
          await expect(reservation).resolves.toMatchObject({ kind: 'unavailable' });
          wallet.statuses.fee = 'SUBMITTED';
          wallet.providers.reconnectReady(wallet.provider);
          await settle(() =>
            storageRepository.feeAttachments().some(({ stage }) => stage === 'cancelling'),
          );
          wallet.statuses.cancel = 'SUBMITTED';
          await settle(() => storageRepository.feeAttachments().length === 0);
          await expect(reservation).resolves.toMatchObject({ kind: 'unavailable' });
          expect(open).toHaveBeenCalledTimes(1);
          runtime.detach();
        },
      );

      it('removes the approval banner immediately when the fee owner retires', async () => {
        const wallet = feeWallet();
        const runtime = wallet.newRuntime();
        const reservation = runtime.reserve(wallet.owner, 'submission', feeRequest, () => false);
        await settle(() => wallet.iface.getBlockedApprovals().length === 1);
        const getApprovals = jest
          .spyOn(cloudBlockchainInfo, 'getBlockedApprovals')
          .mockImplementation(() => wallet.iface.getBlockedApprovals());
        const subscribe = jest
          .spyOn(cloudBlockchainInfo, 'onBlockedApprovalsChange')
          .mockImplementation((listener) => wallet.iface.onBlockedApprovalsChange(listener));
        let renderer: ReactTestRenderer | undefined;
        try {
          act(() => {
            renderer = create(React.createElement(CloudWalletApprovalNotice));
          });
          expect(renderer!.toJSON()).not.toBeNull();
          act(() => runtime.retire(wallet.owner, 'submission'));
          expect(wallet.iface.getBlockedApprovals()).toEqual([]);
          expect(renderer!.toJSON()).toBeNull();
          await expect(reservation).resolves.toMatchObject({ kind: 'unavailable' });
          wallet.statuses.fee = 'SUBMITTED';
          wallet.providers.reconnectReady(wallet.provider);
          await settle(() =>
            storageRepository.feeAttachments().some(({ stage }) => stage === 'cancelling'),
          );
          wallet.statuses.cancel = 'SUBMITTED';
          await settle(() => storageRepository.feeAttachments().length === 0);
          await expect(reservation).resolves.toMatchObject({ kind: 'unavailable' });
        } finally {
          act(() => renderer?.unmount());
          getApprovals.mockRestore();
          subscribe.mockRestore();
          runtime.detach();
        }
      });

      it('stays durable when retirement beats the createOffer response', async () => {
        let retire = () => {};
        const wallet = feeWallet(() => retire());
        const runtime = wallet.newRuntime();
        let inactive = false;
        retire = () => {
          inactive = true;
          runtime.retire(wallet.owner, 'submission');
        };
        const reservation = runtime.reserve(wallet.owner, 'submission', feeRequest, () => inactive);
        await expect(reservation).resolves.toMatchObject({ kind: 'unavailable' });
        expect(wallet.calls.some(({ variables }) => variables.id === 'SR_fee')).toBe(false);
        expect(wallet.iface.getBlockedApprovals()).toEqual([]);
        expect(storageRepository.feeAttachments()).toEqual([retiredRequest]);

        wallet.statuses.fee = 'SUBMITTED';
        wallet.providers.reconnectReady(wallet.provider);
        await settle(() =>
          storageRepository.feeAttachments().some(({ stage }) => stage === 'cancelling'),
        );
        await expect(reservation).resolves.toMatchObject({ kind: 'unavailable' });
        expect(storageRepository.feeAttachments()).toEqual([
          expect.objectContaining({ providerReservationId: 'Offer_1' }),
        ]);

        wallet.statuses.cancel = 'SUBMITTED';
        await settle(() => storageRepository.feeAttachments().length === 0);
        runtime.detach();
      });

      it('keeps the known request after withdrawing its open approval', async () => {
        const { iface, reservation, runtime, popup, ...wallet } = await retiredWhileBlocked(true);
        await expect(reservation).resolves.toMatchObject({ kind: 'unavailable' });
        expect(popup.close).toHaveBeenCalled();
        popup.closed = true;
        await jest.advanceTimersByTimeAsync(500);
        expect(iface.getBlockedApprovals()).toEqual([]);
        expect(storageRepository.feeAttachments()).toEqual([retiredRequest]);

        setPopup(null);
        await expectCancellationAfterLaterReadiness(wallet);
        runtime.detach();
      });

      it('keeps the retired request when an observe-only status read fails', async () => {
        const { reservation, runtime, ...wallet } = await retiredWhileBlocked(true);
        await expect(reservation).resolves.toMatchObject({ kind: 'unavailable' });
        wallet.statuses.fee = 'SUBMITTED';
        wallet.statuses.feePollFails = true;
        wallet.providers.reconnectReady(wallet.provider);
        await runtime.awaitIdle();
        expect(storageRepository.feeAttachments()).toEqual([retiredRequest]);

        setPopup(null);
        await expectCancellationAfterLaterReadiness(wallet);
        runtime.detach();
      });

      it('keeps a restored request through unattended observation', async () => {
        saveCloudWalletAuth({
          accessToken: 'access-token',
          refreshToken: 'refresh-token',
          expiresAt: Date.now() + 60 * 60_000,
          walletId: 'Wallet_1',
        });
        const wallet = feeWallet();
        storageRepository.replaceFeeAttachments([
          {
            owner: wallet.owner,
            submissionId: 'submission',
            stage: 'creating',
            disposition: 'cancel-on-create',
            recoveryId: 'SR_fee',
            request: feeRequest,
            reason: 'fee-creation-pending',
          },
        ]);
        const runtime = wallet.newRuntime();
        await settle(() => wallet.calls.some(({ variables }) => variables.id === 'SR_fee'));
        expect(wallet.iface.getBlockedApprovals()).toEqual([]);
        await jest.advanceTimersByTimeAsync(10 * 60_000);
        await runtime.awaitIdle();
        expect(storageRepository.feeAttachments()).toEqual([retiredRequest]);

        await expectCancellationAfterLaterReadiness(wallet);
        runtime.detach();
      });

      it('cancels durably without another approval until a terminal status', async () => {
        const { calls, iface, reservation, runtime, statuses, providers, provider } =
          await retiredWhileBlocked();
        const opened: string[] = [];
        (globalThis as unknown as { open: (url: string) => unknown }).open = (url) => {
          opened.push(url);
          return { close: jest.fn(), closed: false };
        };
        expect(iface.openBlockedApproval()).toBe(true);
        expect(iface.getBlockedApprovals()).toEqual([]);
        await expect(reservation).resolves.toMatchObject({ kind: 'unavailable' });
        statuses.fee = 'SUBMITTED';
        providers.reconnectReady(provider);

        await settle(() =>
          storageRepository.feeAttachments().some(({ stage }) => stage === 'cancelling'),
        );
        expect(opened).toHaveLength(0);
        expect(iface.getBlockedApprovals()).toEqual([]);
        await expect(reservation).resolves.toMatchObject({ kind: 'unavailable' });
        expect(storageRepository.feeAttachments()).toEqual([
          expect.objectContaining({
            providerReservationId: 'Offer_1',
            stage: 'cancelling',
            recoveryId: 'SR_cancel',
          }),
        ]);

        statuses.cancel = 'SUBMITTED';
        await settle(() => storageRepository.feeAttachments().length === 0);
        expect(calls.filter(({ query }) => query.includes('cancelOffer'))).toHaveLength(1);
        runtime.detach();
      });

      it('keeps cancellation pending without an approval prompt when popups are blocked', async () => {
        const { iface, reservation, runtime, statuses, providers, provider } =
          await retiredWhileBlocked();
        const open = jest.fn(() => null);
        setTestGlobal('open', open);
        await expect(reservation).resolves.toMatchObject({ kind: 'unavailable' });
        statuses.fee = 'SUBMITTED';
        providers.reconnectReady(provider);

        await settle(() =>
          storageRepository.feeAttachments().some(({ stage }) => stage === 'cancelling'),
        );
        expect(open).not.toHaveBeenCalled();
        expect(iface.getBlockedApprovals()).toEqual([]);
        expect(storageRepository.feeAttachments()).toEqual([
          expect.objectContaining({ providerReservationId: 'Offer_1', stage: 'cancelling' }),
        ]);

        statuses.cancel = 'SUBMITTED';
        await settle(() => storageRepository.feeAttachments().length === 0);
        expect(iface.getBlockedApprovals()).toEqual([]);
        runtime.detach();
      });
    });
  });

  it('keeps Cloud submit rejection text free of stringified GraphQL errors', () => {
    const message = 'Failed to include transaction e3, error ASSERT_BEFORE_HEIGHT_RELATIVE_FAILED';
    const outcome = classifyCloudWalletSubmitError(
      new CloudWalletResponseError(message, [{ message }]),
    );
    expect(outcome).toEqual({ status: 'rejected', detail: message });
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
    const calls = mockGraphql(() => ({ cancelOffer: { signatureRequest: null } }));
    await expect(
      new CloudBlockchainInterface().beginWalletOfferCancellation('Offer_1'),
    ).resolves.toEqual({ status: 'cancelled' });
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
      status: 'unavailable',
      detail: expect.stringMatching(/Offer already cancelled by another client/),
    });
  });

  it('completes a returned SUBMITTED request, for a wallet that differs from the current source', async () => {
    mockGraphql(() => ({
      cancelOffer: { signatureRequest: { id: 'SR_cancel', status: 'SUBMITTED' } },
    }));
    await expect(
      new CloudBlockchainInterface().beginWalletOfferCancellation('Offer_1'),
    ).resolves.toEqual({ status: 'cancelled', detail: 'SUBMITTED' });
  });

  it.each([
    ['a missing payload', { cancelOffer: null }],
    ['a payload without the field', { cancelOffer: {} }],
    ['a request without an id', { cancelOffer: { signatureRequest: { status: 'SUBMITTED' } } }],
    [
      'a request with an empty status',
      { cancelOffer: { signatureRequest: { id: 'SR', status: '' } } },
    ],
  ])('rejects %s', async (_label, response) => {
    mockGraphql(() => response);
    await expect(
      new CloudBlockchainInterface().beginWalletOfferCancellation('Offer_1'),
    ).resolves.toEqual({
      status: 'rejected',
      detail: 'Cloud Wallet cancelOffer returned an invalid signatureRequest',
    });
  });

  describe("the wallet's cancelOffer errors", () => {
    const offerHex = 'ab'.repeat(32);
    const offerId = `Offer_${offerHex}`;
    const featureFlagMessage =
      'Organization does not have required feature flags: OFFER_CANCEL_OFF_CHAIN';

    /** A yoga error response: a failed nullable mutation field, with its code in extensions. */
    function walletError(code: string, message: string) {
      return {
        status: 200,
        ok: true,
        text: async () =>
          JSON.stringify({
            data: { cancelOffer: null },
            errors: [
              {
                message,
                locations: [{ line: 2, column: 11 }],
                path: ['cancelOffer'],
                extensions: { code },
              },
            ],
          }),
      };
    }

    function mockCancelOffer(respond: () => unknown) {
      const fetchMock = jest.fn(async () => respond());
      setTestGlobal('fetch', fetchMock);
      return fetchMock;
    }

    const succeeded = () => ({
      status: 200,
      ok: true,
      text: async () => JSON.stringify({ data: { cancelOffer: { signatureRequest: null } } }),
    });

    it.each([
      ['a taken or expired offer', `Offer with id ${offerHex} must be open to cancel off-chain`],
      ['an untracked offer', `Offer with id ${offerHex} is not tracked by this wallet`],
      ['an unknown offer', `Offer with id ${offerHex} not found`],
      ['an offer settled while pending', `Offer with id ${offerHex} has already been settled`],
    ])('treats %s as already terminal, with no notice', async (_label, message) => {
      mockCancelOffer(() => walletError('BAD_USER_INPUT', message));
      const iface = new CloudBlockchainInterface();
      await expect(iface.beginWalletOfferCancellation(offerId)).resolves.toEqual({
        status: 'already-terminal',
        detail: message,
      });
      expect(iface.getRefusedCancellations()).toEqual([]);
    });

    it('does not take a terminal error naming a different offer as this offer ending', async () => {
      const message = `Offer with id ${'cd'.repeat(32)} not found`;
      mockCancelOffer(() => walletError('BAD_USER_INPUT', message));
      const iface = new CloudBlockchainInterface();
      await expect(iface.beginWalletOfferCancellation(offerId)).resolves.toEqual({
        status: 'unavailable',
        detail: message,
      });
      expect(iface.getRefusedCancellations()).toEqual([{ offerId, detail: message }]);
    });

    it('does not read a terminal message under another code as this offer ending', async () => {
      const message = `Offer with id ${offerHex} not found`;
      mockCancelOffer(() => walletError('INTERNAL_SERVER_ERROR', message));
      await expect(
        new CloudBlockchainInterface().beginWalletOfferCancellation(offerId),
      ).resolves.toEqual({ status: 'unavailable', detail: message });
    });

    it('keeps an active on-chain cancel retryable and raises no notice', async () => {
      const message = `Offer with id ${offerHex} has an active on-chain transaction`;
      mockCancelOffer(() => walletError('BAD_USER_INPUT', message));
      const iface = new CloudBlockchainInterface();
      await expect(iface.beginWalletOfferCancellation(offerId)).resolves.toEqual({
        status: 'unavailable',
        detail: message,
      });
      expect(iface.getRefusedCancellations()).toEqual([]);
    });

    it('keeps a missing organization flag retryable and tells the user why', async () => {
      mockCancelOffer(() => walletError('UNAUTHORIZED', featureFlagMessage));
      const iface = new CloudBlockchainInterface();
      const listener = jest.fn();
      iface.onRefusedCancellationsChange(listener);
      await expect(iface.beginWalletOfferCancellation(offerId)).resolves.toEqual({
        status: 'unavailable',
        detail: featureFlagMessage,
      });
      expect(iface.getRefusedCancellations()).toEqual([{ offerId, detail: featureFlagMessage }]);
      expect(listener).toHaveBeenCalled();
    });

    it('keeps any other wallet refusal, whose coins may still be locked, retryable and visible', async () => {
      const message = 'Offer transaction tx1 is in PENDING state and cannot be cancelled off-chain';
      mockCancelOffer(() => walletError('BAD_USER_INPUT', message));
      const iface = new CloudBlockchainInterface();
      await expect(iface.beginWalletOfferCancellation(offerId)).resolves.toEqual({
        status: 'unavailable',
        detail: message,
      });
      expect(iface.getRefusedCancellations()).toEqual([{ offerId, detail: message }]);
    });

    it('keeps a dead grant retryable rather than retiring the record', async () => {
      mockCancelOffer(() => ({ status: 401, ok: false, text: async () => '' }));
      await expect(
        new CloudBlockchainInterface().beginWalletOfferCancellation(offerId),
      ).resolves.toMatchObject({ status: 'unavailable' });
    });

    it('clears the notice once a later attempt succeeds, and a dismissal lasts until the next refusal', async () => {
      let respond: () => unknown = () => walletError('UNAUTHORIZED', featureFlagMessage);
      mockCancelOffer(() => respond());
      const iface = new CloudBlockchainInterface();
      await iface.beginWalletOfferCancellation(offerId);
      iface.dismissRefusedCancellation(offerId);
      expect(iface.getRefusedCancellations()).toEqual([]);
      await iface.beginWalletOfferCancellation(offerId);
      expect(iface.getRefusedCancellations()).toHaveLength(1);
      respond = succeeded;
      await expect(iface.beginWalletOfferCancellation(offerId)).resolves.toEqual({
        status: 'cancelled',
      });
      expect(iface.getRefusedCancellations()).toEqual([]);
    });

    it('keeps the record when the failure arrives through the poller queue', async () => {
      expectConsoleError(/blockchain-poller height failed/);
      setTestGlobal(
        'fetch',
        jest.fn(async () => ({ status: 502, ok: false, text: async () => '' })),
      );
      const iface = new CloudBlockchainInterface();
      jest.spyOn(iface, 'isConnected').mockReturnValue(true);
      const providers = new WalletProviderRegistry();
      const poller = new BlockchainPoller(
        iface as never,
        60000,
        undefined,
        new ChannelFundingRuntime(providers),
      );
      poller.start();
      poller.refreshProviderReadiness();
      const provider = poller.rpc.getWalletOfferProvider();
      if (!provider) throw new Error('expected queued Cloud wallet provider');
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
          stage: 'cancel-required',
          providerReservationId: offerId,
          reason: 'fee-submission-retired',
        },
      ]);
      const reportWarning = jest.fn();
      new FeeAttachmentRuntime(
        {
          isRetired: () => false,
          getOwner: () => owner,
          requestCommit: jest.fn(),
          reportWarning,
        },
        providers,
      );
      for (let turn = 0; turn < 40; turn += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      poller.pauseChainPolling();

      expect(storageRepository.feeAttachments()).toEqual([
        expect.objectContaining({ providerReservationId: offerId }),
      ]);
      expect(reportWarning).not.toHaveBeenCalled();
    });

    describe.each(['fee', 'funding'] as const)('through the %s runtime', (kind) => {
      const quiesce = async () => {
        for (let turn = 0; turn < 40; turn += 1) {
          await new Promise((resolve) => setImmediate(resolve));
        }
      };

      async function start(respond: () => unknown) {
        const fetchMock = mockCancelOffer(respond);
        const iface = new CloudBlockchainInterface();
        const provider = iface.getWalletOfferProvider();
        if (!provider) throw new Error('expected Cloud wallet provider');
        const owner = {
          installationPlayerId: 'player',
          peerSessionId: 'session',
          providerScope: provider.scope,
        };
        storageRepository.ensureWalletContext(owner.providerScope);
        const providers = new WalletProviderRegistry();
        providers.attach(provider);
        const reportWarning = jest.fn();
        if (kind === 'fee') {
          storageRepository.replaceFeeAttachments([
            {
              owner,
              submissionId: 'submission',
              stage: 'cancel-required',
              providerReservationId: offerId,
              reason: 'fee-submission-retired',
            },
          ]);
          new FeeAttachmentRuntime(
            {
              isRetired: () => false,
              getOwner: () => owner,
              requestCommit: jest.fn(),
              reportWarning,
            },
            providers,
          );
        } else {
          storageRepository.replaceChannelFunding([
            {
              owner,
              purpose: { kind: 'funding', operationId: 'operation' },
              stage: 'cancel-required',
              providerReservationId: offerId,
              reason: 'channel-creation-timed-out',
            },
          ]);
          new ChannelFundingRuntime(providers).retryCancelRequired();
        }
        await quiesce();
        const entries = () =>
          kind === 'fee'
            ? storageRepository.feeAttachments()
            : storageRepository.channelFundingOperations();
        return { entries, fetchMock, iface, provider, providers, reportWarning };
      }

      it.each([
        ['a missing organization flag', 'UNAUTHORIZED', featureFlagMessage, 1],
        [
          'an active on-chain cancel',
          'BAD_USER_INPUT',
          `Offer with id ${offerHex} has an active on-chain transaction`,
          0,
        ],
      ])(
        'keeps the record after %s, retries once per reconnect, and clears on success',
        async (_label, code, message, notices) => {
          let respond: () => unknown = () => walletError(code, message);
          const wallet = await start(() => respond());

          const retained = expect.objectContaining({
            stage: 'best-effort-cancellation-uncertain',
            providerReservationId: offerId,
          });
          expect(wallet.fetchMock).toHaveBeenCalledTimes(1);
          expect(wallet.entries()).toEqual([retained]);
          expect(wallet.iface.getRefusedCancellations()).toHaveLength(notices);
          expect(wallet.reportWarning).not.toHaveBeenCalled();

          wallet.providers.ready(wallet.provider);
          await quiesce();
          expect(wallet.fetchMock).toHaveBeenCalledTimes(1);

          wallet.providers.reconnectReady(wallet.provider);
          await quiesce();
          expect(wallet.fetchMock).toHaveBeenCalledTimes(2);
          expect(wallet.entries()).toEqual([retained]);

          respond = succeeded;
          wallet.providers.reconnectReady(wallet.provider);
          await quiesce();
          expect(wallet.fetchMock).toHaveBeenCalledTimes(3);
          expect(wallet.entries()).toEqual([]);
          expect(wallet.iface.getRefusedCancellations()).toEqual([]);
          expect(wallet.reportWarning).not.toHaveBeenCalled();
        },
      );

      it.each([
        ['HTTP 502', () => ({ status: 502, ok: false, text: async () => '' })],
        [
          'an HTML 503',
          () => ({ status: 503, ok: false, text: async () => '<html>Unavailable</html>' }),
        ],
        ['a masked failure', () => walletError('INTERNAL_SERVER_ERROR', 'Unexpected error.')],
        ['a rate limit', () => walletError('RATE_LIMIT_EXCEEDED', 'Rate limit exceeded')],
        [
          'an uncoded error',
          () => ({
            status: 200,
            ok: true,
            text: async () => JSON.stringify({ errors: [{ message: 'Unexpected' }] }),
          }),
        ],
      ])('keeps the record, silently, after %s', async (_label, respond) => {
        const wallet = await start(respond);
        expect(wallet.fetchMock).toHaveBeenCalledTimes(1);
        expect(wallet.entries()).toEqual([
          expect.objectContaining({
            stage: 'best-effort-cancellation-uncertain',
            providerReservationId: offerId,
          }),
        ]);
        expect(wallet.iface.getRefusedCancellations()).toEqual([]);
        expect(wallet.reportWarning).not.toHaveBeenCalled();
      });

      it('forgets the record with no warning when the offer is already taken', async () => {
        const wallet = await start(() =>
          walletError(
            'BAD_USER_INPUT',
            `Offer with id ${offerHex} must be open to cancel off-chain`,
          ),
        );
        expect(wallet.entries()).toEqual([]);
        expect(wallet.reportWarning).not.toHaveBeenCalled();
      });

      it('forgets the record with no warning after a null signatureRequest', async () => {
        const wallet = await start(succeeded);
        expect(wallet.fetchMock).toHaveBeenCalledTimes(1);
        expect(wallet.entries()).toEqual([]);
        expect(wallet.reportWarning).not.toHaveBeenCalled();
      });
    });
  });

  it.each([
    ['browser', false],
    ['browser', true],
    ['desktop', false],
    ['desktop', true],
  ] as const)('polls %s cancellation noninteractively (restored=%s)', async (surface, restored) => {
    jest.useFakeTimers();
    const open = jest.fn(() => null);
    const openInBrowser = jest.fn(async () => true);
    setTestGlobal('open', open);
    setTestGlobal('addEventListener', jest.fn());
    setTestGlobal('removeEventListener', jest.fn());
    if (surface === 'desktop') setTestGlobal('__chiaCloudWallet', { openInBrowser });
    let status = 'PENDING';
    const calls = mockGraphql((query) =>
      query.includes('cancelOffer')
        ? { cancelOffer: { signatureRequest: { id: 'SR_cancel', status: 'PENDING' } } }
        : { signatureRequest: { id: 'SR_cancel', status } },
    );
    try {
      const iface = new CloudBlockchainInterface();
      if (!restored) {
        await expect(iface.beginWalletOfferCancellation('Offer_1')).resolves.toEqual({
          status: 'pending',
          recoveryId: 'SR_cancel',
        });
      }
      // A restored record supplies its existing ID without starting another cancellation.
      const cancellation = iface.reconcileWalletOfferCancellation('Offer_1', 'SR_cancel');
      await jest.advanceTimersByTimeAsync(0);
      const blocked = iface.getBlockedApprovals();
      status = 'SUBMITTED';
      await jest.advanceTimersByTimeAsync(1500);
      await expect(cancellation).resolves.toEqual({ status: 'cancelled', detail: 'SUBMITTED' });
      expect(open).not.toHaveBeenCalled();
      expect(openInBrowser).not.toHaveBeenCalled();
      expect(blocked).toEqual([]);
      expect(iface.getBlockedApprovals()).toEqual([]);
      const mutations = calls.filter((call) => call.query.includes('cancelOffer'));
      expect(mutations).toHaveLength(restored ? 0 : 1);
      if (!restored) {
        expect(mutations[0]!.variables.input).toMatchObject({ cancelOffChain: true, fee: '0' });
      }
    } finally {
      Reflect.deleteProperty(globalThis, '__chiaCloudWallet');
      jest.useRealTimers();
    }
  });

  it('keeps a pending cancellation unavailable after noninteractive polling times out', async () => {
    jest.useFakeTimers();
    saveCloudWalletAuth({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 60 * 60_000,
      walletId: 'Wallet_1',
    });
    const open = jest.fn(() => null);
    setTestGlobal('open', open);
    mockGraphql(() => ({ signatureRequest: { id: 'SR_cancel', status: 'PENDING' } }));
    try {
      const iface = new CloudBlockchainInterface();
      const cancellation = iface.reconcileWalletOfferCancellation('Offer_1', 'SR_cancel');
      await jest.advanceTimersByTimeAsync(10 * 60 * 1000);
      await expect(cancellation).resolves.toMatchObject({
        status: 'unavailable',
        detail: expect.stringMatching(/off.chain.*approval/i),
      });
      expect(open).not.toHaveBeenCalled();
      expect(iface.getBlockedApprovals()).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
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
    expect(close).not.toHaveBeenCalled();
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

  it('reports an absent single watched coin without failing the snapshot', async () => {
    const calls = mockGraphql((_query, variables) => {
      const endpoint = (variables.input as { endpoint: string }).endpoint;
      if (endpoint === 'get_coin_record_by_name') {
        throw new Error(`Coin record 0x${'aa'.repeat(32)} not found`);
      }
      return { coinset: { response: { success: true, coin_records: [] } } };
    });
    await expect(
      new CloudBlockchainInterface().getCoinRecordsByNames(['aa'.repeat(32)]),
    ).resolves.toEqual([]);
    expect(calls[0]!.variables.input).toEqual({
      walletId: 'Wallet_1',
      endpoint: 'get_coin_records_by_names',
      request: { names: ['aa'.repeat(32)], include_spent_coins: true },
    });
  });

  it('rejects coin-record batches when the Cloud query fails', async () => {
    mockGraphql((_query, variables) => {
      if ((variables.input as { endpoint?: string })?.endpoint === 'get_coin_records_by_names') {
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
      if ((variables.input as { endpoint?: string })?.endpoint === 'get_coin_records_by_names') {
        return {
          coinset: {
            response: {
              success: true,
              coin_records: [
                {
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
              ],
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

  it('uses batch Coinset queries for both single and multiple watched coins', async () => {
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
    const calls = mockGraphql(() => {
      return {
        coinset: {
          response: { success: true, coin_records: [record] },
        },
      };
    });
    const iface = new CloudBlockchainInterface();
    await expect(iface.getCoinRecordsByNames(['aa'.repeat(32)])).resolves.toHaveLength(1);
    await expect(
      iface.getCoinRecordsByNames(['aa'.repeat(32), 'bb'.repeat(32)]),
    ).resolves.toHaveLength(1);
    expect((calls[0]!.variables.input as any).request).toEqual({
      names: ['aa'.repeat(32)],
      include_spent_coins: true,
    });
    expect(
      calls.every(
        (call) =>
          (call.variables.input as { endpoint: string }).endpoint === 'get_coin_records_by_names',
      ),
    ).toBe(true);
    expect((calls[1]!.variables.input as any).request).toEqual({
      names: ['aa'.repeat(32), 'bb'.repeat(32)],
      include_spent_coins: true,
    });
  });

  it('returns no puzzle and solution for a coin that does not exist yet', async () => {
    const calls = mockGraphql((_query, variables) => {
      if ((variables.input as { endpoint: string }).endpoint === 'get_coin_record_by_name') {
        throw new Error('Coin record not found');
      }
      return { coinset: { response: { success: true, coin_records: [] } } };
    });
    await expect(
      new CloudBlockchainInterface().getPuzzleAndSolution('00'.repeat(72)),
    ).resolves.toBeNull();
    expect(calls).toHaveLength(1);
    expect((calls[0]!.variables.input as { endpoint: string }).endpoint).toBe(
      'get_coin_records_by_names',
    );
  });

  it('resolves spent height before requesting puzzle and solution', async () => {
    const calls = mockGraphql((_query, variables) => {
      const endpoint = (variables.input as { endpoint: string }).endpoint;
      if (endpoint === 'get_coin_records_by_names') {
        return {
          coinset: {
            response: {
              success: true,
              coin_records: [
                {
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
              ],
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
