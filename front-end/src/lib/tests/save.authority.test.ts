import { storageRepository } from '../session/storageRepository';
import {
  _afterNextStorageAuthorityCheckForTests,
  readSessionRecord,
  readWalletOperationRecord,
  StorageAuthorityLostError,
} from '../session/indexedDb';
import { baseSave } from './session_save_envelope.fixtures';
import { walletOperationRuntime } from '../session/walletOperationRuntime';
import {
  requireLive,
  sampleSession,
  saveHistory,
  saveLiveFields,
  setTestGlobal,
  testIndexedDb,
} from './save.harness';

describe('session persistence: authority', () => {
  it('returns the explicit committed, failed, and authority-lost mutation outcomes', async () => {
    await expect(storageRepository.mutateRecords('write-wallet-operations', [])).resolves.toEqual({
      status: 'committed',
    });

    setTestGlobal('indexedDB', {
      open: () => {
        throw new Error('ordinary storage failure');
      },
    });
    await expect(storageRepository.mutateRecords('write-wallet-operations', [])).resolves.toEqual({
      status: 'failed',
      error: expect.objectContaining({ message: 'ordinary storage failure' }),
    });
    setTestGlobal('indexedDB', testIndexedDb);

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    storageRepository.holdNextMutationForTests(held);
    const stale = storageRepository.mutateRecords('write-wallet-operations', []);
    await storageRepository.claimLease();
    release();
    await expect(stale).resolves.toEqual({
      status: 'authority-lost',
      error: expect.any(StorageAuthorityLostError),
    });
  });

  it('rejects every explicit persistence request without storage authority', async () => {
    storageRepository.loseAuthority('takeover');

    await expect(
      storageRepository.persist(storageRepository.mutateRecords('write-wallet-operations', [])),
    ).rejects.toBeInstanceOf(StorageAuthorityLostError);
    await expect(storageRepository.flushSessionSave()).rejects.toBeInstanceOf(
      StorageAuthorityLostError,
    );

    walletOperationRuntime.registerReserved(
      'trade-without-authority',
      {
        installationPlayerId: 'installation',
        peerSessionId: 'peer-session',
        providerScope: { provider: 'simulator', identity: 'installation' },
      },
      { kind: 'funding', operationId: 'operation-without-authority' },
    );
    await expect(walletOperationRuntime.flushPersistence()).rejects.toBeInstanceOf(
      StorageAuthorityLostError,
    );
  });

  it('treats the localStorage lease as a hint, not a write authority', async () => {
    localStorage.setItem('appState_activeTab', 'stale-hint');
    await expect(storageRepository.mutateRecords('write-wallet-operations', [])).resolves.toEqual({
      status: 'committed',
    });
  });

  it('buffers pre-authority history and merges it into the claimed session', async () => {
    saveLiveFields();
    await storageRepository.flushSessionSave();

    storageRepository._resetForTests();
    const buffered = saveHistory({ diagnosticLog: ['recovery dialog log'] });
    await expect(buffered).resolves.toBeUndefined();

    const claimed = requireLive(await storageRepository.claimAndHydrateSession());
    expect(claimed.live.serializedGameSession).toEqual(sampleSession.serializedGameSession);
    expect(claimed.history.diagnosticLog).toEqual(['recovery dialog log']);
    expect(requireLive(await readSessionRecord()).history.diagnosticLog).toEqual([
      'recovery dialog log',
    ]);
  });

  it('does not let an old lease generation overwrite the winning ledger', async () => {
    await storageRepository.claimLease();
    const authorityLost = jest.fn();
    const unsubscribe = storageRepository.onAuthorityLost(authorityLost);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    storageRepository.holdNextMutationForTests(held);
    const oldWrite = storageRepository.persist(
      storageRepository.mutateRecords('write-wallet-operations', [
        {
          tradeId: 'old-generation',
          owner: {
            installationPlayerId: 'installation',
            peerSessionId: 'old-peer',
            providerScope: { provider: 'simulator', identity: 'installation' },
          },
          purpose: { kind: 'funding', operationId: 'old-operation' },
          stage: 'reserved',
          reason: 'old-tab-result',
        },
      ]),
    );

    await storageRepository.claimLease();
    const winningEntry = {
      tradeId: 'winning-generation',
      owner: {
        installationPlayerId: 'installation',
        peerSessionId: 'winning-peer',
        providerScope: { provider: 'simulator' as const, identity: 'installation' },
      },
      purpose: { kind: 'funding' as const, operationId: 'winning-operation' },
      stage: 'reserved' as const,
      reason: 'winning-tab-result',
    };
    const winningWrite = storageRepository.persist(
      storageRepository.mutateRecords('write-wallet-operations', [winningEntry]),
    );
    release();
    await expect(oldWrite).rejects.toBeInstanceOf(StorageAuthorityLostError);
    await winningWrite;

    expect(authorityLost).not.toHaveBeenCalled();
    expect((await readWalletOperationRecord())?.entries).toEqual([winningEntry]);
    unsubscribe();
  });

  it('rejects a scheduled save when authority is lost before the debounce fires', async () => {
    jest.useFakeTimers();
    try {
      const scheduled = saveLiveFields({
        ...sampleSession,
        serializedGameSession: new Uint8Array([8]),
      });

      storageRepository.loseAuthority('takeover');

      await expect(scheduled).rejects.toBeInstanceOf(StorageAuthorityLostError);
      jest.advanceTimersByTime(300);
      await Promise.resolve();
    } finally {
      jest.useRealTimers();
    }
  });

  it('serializes a takeover requested after authorization before the winning write', async () => {
    await storageRepository.claimLease();
    let takeover: Promise<unknown> | undefined;
    _afterNextStorageAuthorityCheckForTests(() => {
      takeover = storageRepository.claimLease();
    });
    const authorizedEntry = {
      tradeId: 'authorized-before-takeover',
      owner: {
        installationPlayerId: 'installation',
        peerSessionId: 'old-peer',
        providerScope: { provider: 'simulator' as const, identity: 'installation' },
      },
      purpose: { kind: 'funding' as const, operationId: 'old-operation' },
      stage: 'reserved' as const,
      reason: 'authorized-before-takeover',
    };

    await storageRepository.persist(
      storageRepository.mutateRecords('write-wallet-operations', [authorizedEntry]),
    );
    expect(takeover).toBeDefined();
    await takeover;

    const winningEntry = {
      ...authorizedEntry,
      tradeId: 'winning-after-takeover',
      owner: { ...authorizedEntry.owner, peerSessionId: 'winning-peer' },
      purpose: { kind: 'funding' as const, operationId: 'winning-operation' },
      reason: 'winning-generation',
    };
    await storageRepository.persist(
      storageRepository.mutateRecords('write-wallet-operations', [winningEntry]),
    );

    expect((await readWalletOperationRecord())?.entries).toEqual([winningEntry]);
  });

  it('claims and reads the predecessor write from the same transaction boundary', async () => {
    let claim: ReturnType<typeof storageRepository.claimAndHydrateSession> | undefined;
    _afterNextStorageAuthorityCheckForTests(() => {
      claim = storageRepository.claimAndHydrateSession();
    });
    const predecessor = baseSave({
      playerId: 'predecessor-player',
      blockchainType: 'simulator',
    });

    await storageRepository.persist(storageRepository.mutateRecords('write-session', predecessor));
    expect(claim).toBeDefined();
    await expect(claim).resolves.toMatchObject({
      identity: { playerId: 'predecessor-player' },
      preferences: { blockchainType: 'simulator' },
    });
  });
});
