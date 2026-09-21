import { storageRepository } from '../session/storageRepository';
import {
  _afterNextStorageAuthorityCheckForTests,
  readSessionRecord,
  readWalletOperationRecord,
  StorageAuthorityLostError,
  StorageAuthorityRequiredError,
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
  it('commits semantic writes and distinguishes ordinary failure from authority loss', async () => {
    await expect(storageRepository.saveWalletOperations([])).resolves.toBeUndefined();

    setTestGlobal('indexedDB', {
      open: () => {
        throw new Error('ordinary storage failure');
      },
    });
    await expect(storageRepository.saveWalletOperations([])).rejects.toThrow(
      'ordinary storage failure',
    );
    expect(storageRepository.hasAuthority()).toBe(true);
    setTestGlobal('indexedDB', testIndexedDb);

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    storageRepository.holdNextMutationForTests(held);
    const stale = storageRepository.saveWalletOperations([]);
    await storageRepository.claimLease();
    release();
    await expect(stale).rejects.toBeInstanceOf(StorageAuthorityLostError);
  });

  it('rejects every explicit persistence request without storage authority', async () => {
    storageRepository.loseAuthority('takeover');

    await expect(storageRepository.saveWalletOperations([])).rejects.toBeInstanceOf(
      StorageAuthorityLostError,
    );
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
    await expect(storageRepository.saveWalletOperations([])).resolves.toBeUndefined();
  });

  it('merges allowed pre-authority preferences and history into the claimed session', async () => {
    saveLiveFields();
    await storageRepository.flushSessionSave();

    storageRepository._resetForTests();
    const buffered = saveHistory({ diagnosticLog: ['recovery dialog log'] });
    await storageRepository.updatePreference({ key: 'theme', value: 'dark' });
    await expect(buffered).resolves.toBeUndefined();

    const claimed = requireLive(await storageRepository.claimAndHydrateSession());
    expect(claimed.live.serializedGameSession).toEqual(sampleSession.serializedGameSession);
    expect(claimed.history.diagnosticLog).toEqual(['recovery dialog log']);
    expect(claimed.preferences.theme).toBe('dark');
    expect(requireLive(await readSessionRecord()).history.diagnosticLog).toEqual([
      'recovery dialog log',
    ]);
    expect(requireLive(await readSessionRecord()).preferences.theme).toBe('dark');
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
    const oldWrite = storageRepository.saveWalletOperations([
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
    ]);

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
    const winningWrite = storageRepository.saveWalletOperations([winningEntry]);
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

    await storageRepository.saveWalletOperations([authorizedEntry]);
    expect(takeover).toBeDefined();
    await takeover;

    const winningEntry = {
      ...authorizedEntry,
      tradeId: 'winning-after-takeover',
      owner: { ...authorizedEntry.owner, peerSessionId: 'winning-peer' },
      purpose: { kind: 'funding' as const, operationId: 'winning-operation' },
      reason: 'winning-generation',
    };
    await storageRepository.saveWalletOperations([winningEntry]);

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

    await storageRepository.saveSessionAndWalletOperations(predecessor, []);
    expect(claim).toBeDefined();
    await expect(claim).resolves.toMatchObject({
      identity: { playerId: 'predecessor-player' },
      preferences: { blockchainType: 'simulator' },
    });
  });

  it('rejects session, terminal, rejection, and wallet mutations before claim', async () => {
    storageRepository._resetForTests();
    const rejection = {
      kind: 'inbound-receipt' as const,
      peerId: 'peer',
      sessionId: 'ab'.repeat(16),
      messageNumber: 1n,
      remoteNumber: 1n,
      unackedMessages: [],
      createdAt: Date.now(),
    };
    const terminal = baseSave({
      channelStatus: { state: 'ResolvedClean' },
      coinsOfInterest: [],
      terminalIStarted: true,
    });
    if (terminal.phase !== 'terminal') throw new Error('expected terminal fixture');
    const preHandshake = baseSave({
      pairingToken: 'pre-claim',
      iStarted: true,
      myContribution: '1',
      theirContribution: '1',
      perGameAmount: '1',
    });
    if (preHandshake.phase !== 'pre-handshake') {
      throw new Error('expected pre-handshake fixture');
    }

    await expect(saveLiveFields()).rejects.toBeInstanceOf(StorageAuthorityRequiredError);
    await expect(
      storageRepository.replaceSession({
        walletProviderScope: preHandshake.walletProviderScope,
        pairing: preHandshake.pairing,
        transport: preHandshake.transport,
      }),
    ).rejects.toBeInstanceOf(StorageAuthorityRequiredError);
    await expect(
      storageRepository.patchPreHandshakeTransport(preHandshake.transport),
    ).rejects.toBeInstanceOf(StorageAuthorityRequiredError);
    await expect(storageRepository.clearSession()).rejects.toBeInstanceOf(
      StorageAuthorityRequiredError,
    );
    await expect(storageRepository.clearGameSessionPreservingHistory()).rejects.toBeInstanceOf(
      StorageAuthorityRequiredError,
    );
    await expect(storageRepository.writeRejection(rejection)).rejects.toBeInstanceOf(
      StorageAuthorityRequiredError,
    );
    await expect(storageRepository.replaceSessionWithRejection(rejection)).rejects.toBeInstanceOf(
      StorageAuthorityRequiredError,
    );
    await expect(
      storageRepository.deleteRejection(rejection.peerId, rejection.sessionId),
    ).rejects.toBeInstanceOf(StorageAuthorityRequiredError);
    await expect(storageRepository.saveWalletOperations([])).rejects.toBeInstanceOf(
      StorageAuthorityRequiredError,
    );
    await expect(
      storageRepository.saveSessionAndWalletOperations(preHandshake, []),
    ).rejects.toBeInstanceOf(StorageAuthorityRequiredError);
    await expect(
      storageRepository.saveTerminalSession({
        walletProviderScope: { provider: 'simulator', identity: 'installation' },
        terminal: terminal.terminal,
        presentation: terminal.presentation,
      }),
    ).rejects.toBeInstanceOf(StorageAuthorityRequiredError);
  });
});
