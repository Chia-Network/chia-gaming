import { expectConsoleError } from '../../../scripts/testSetup';

import { storageRepository } from '../session/storageRepository';
import {
  hasSavedSessionMarker,
  markSavedSession,
  clearSavedSessionMarker,
  markAutoResumeOnce,
  peekAutoResumeOnce,
  clearAutoResumeOnce,
} from '../../hooks/saveCoordination';
import {
  indexedDbStoragePort,
  readApplicationState,
  SESSION_DB_NAME,
  StorageAuthorityLostError,
} from '../session/indexedDb';
import { baseSave } from './session_save_envelope.fixtures';
import { walletOperationRuntime } from '../session/walletOperationRuntime';
import { captureDurableApplicationState } from '../session/sessionMachinePersist';
import { freshSessionState } from '../session/sessionStateTransitions';
import type { DurableApplicationState } from '../session/saveEnvelope';
import {
  requireLive,
  sampleSession,
  saveHistory,
  saveLiveFields,
  savePreferences,
} from './save.harness';

async function writeRootTransform(
  transform: (state: DurableApplicationState) => DurableApplicationState,
): Promise<void> {
  await captureDurableApplicationState({ kind: 'transform', transform })?.write();
}

describe('session persistence: recovery', () => {
  it('advances and publishes lifecycle generation on loss and reclaim', async () => {
    const initial = storageRepository.lifecycleGeneration;
    const events: Array<[number, string]> = [];
    const unsubscribe = storageRepository.onLifecycle((generation, event) => {
      events.push([generation, event]);
    });

    storageRepository.loseAuthority('takeover');
    expect(storageRepository.isGenerationCurrent(initial)).toBe(false);
    await storageRepository.claimApplicationState();

    expect(events).toEqual([
      [initial + 1, 'authority-lost'],
      [initial + 2, 'claim'],
    ]);
    expect(storageRepository.isGenerationCurrent(initial + 2)).toBe(true);
    unsubscribe();
  });

  it('rejects a claim fenced after commit without installing or rewriting browser state', async () => {
    const before = storageRepository.loadState();
    storageRepository._replaceApplicationStateForTests({
      ...before,
      walletContext: { provider: 'simulator', identity: before.identity.playerId },
    });
    walletOperationRuntime.registerReserved(
      'pre-authority-trade',
      {
        installationPlayerId: before.identity.playerId,
        peerSessionId: 'pre-authority-session',
        providerScope: { provider: 'simulator', identity: before.identity.playerId },
      },
      { kind: 'funding', operationId: 'pre-authority-operation' },
    );
    await storageRepository.flushAggregate();
    storageRepository._resetForTests();
    const retainedPlayerId = storageRepository.loadState().identity.playerId;

    let release!: () => void;
    let committed!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reachedCommit = new Promise<void>((resolve) => {
      committed = resolve;
    });
    storageRepository.holdNextClaimAfterCommitForTests(barrier, committed);

    const claim = storageRepository.claimApplicationState();
    await reachedCommit;
    localStorage.setItem('appState_activeTab', 'winning-tab');
    storageRepository.loseAuthority('takeover');
    release();

    await expect(claim).rejects.toBeInstanceOf(StorageAuthorityLostError);
    expect(localStorage.getItem('appState_activeTab')).toBe('winning-tab');
    expect(storageRepository.loadState().identity.playerId).toBe(retainedPlayerId);
  });

  it('one authority claim installs the complete aggregate root', async () => {
    const rejection = {
      kind: 'inbound-receipt' as const,
      peerId: 'peer-root',
      sessionId: '12'.repeat(16),
      messageNumber: 2n,
      remoteNumber: 1n,
      unackedMessages: [],
      createdAt: 1,
    };
    await writeRootTransform((state) => ({
      ...state,
      rejectionTransports: [rejection],
    }));
    storageRepository._resetForTests();

    const claimed = await storageRepository.claimApplicationState();

    expect(claimed.rejectionTransports).toEqual([rejection]);
    expect(storageRepository.loadState().rejectionTransports).toEqual([rejection]);
    expect(claimed.walletObligations).toEqual(storageRepository.walletObligations());
  });

  it('reports malformed aggregate boot inspection and leaves the record on disk', async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(SESSION_DB_NAME);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction('application-state', 'readwrite');
        transaction.objectStore('application-state').put({ malformed: true }, 'current');
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally {
      db.close();
    }

    storageRepository._resetForTests();
    const inspection = await storageRepository.inspect();
    expect(inspection.applicationState).toBeNull();
    expect(inspection.applicationStateError).toBeInstanceOf(Error);

    const verifyDb = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(SESSION_DB_NAME);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    let stored: unknown;
    try {
      stored = await new Promise<unknown>((resolve, reject) => {
        const transaction = verifyDb.transaction('application-state', 'readonly');
        const request = transaction.objectStore('application-state').get('current');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally {
      verifyDb.close();
    }
    expect(stored).toEqual({ malformed: true });
  });

  it('sets the saved-session marker when a resumable record is written', async () => {
    expect(hasSavedSessionMarker()).toBe(false);

    saveLiveFields();
    await storageRepository.flushAggregate();
    expect(hasSavedSessionMarker()).toBe(true);

    await storageRepository.clearSession();
    expect(hasSavedSessionMarker()).toBe(false);
  });

  it('keeps an explicit pre-game marker across blockchainType preference writes', async () => {
    markSavedSession();
    savePreferences({ blockchainType: 'simulator' });
    await storageRepository.flushAggregate();

    expect(hasSavedSessionMarker()).toBe(true);
    expect(await storageRepository.readCurrentState()).toMatchObject({
      preferences: { blockchainType: 'simulator' },
    });
  });

  it('treats leftover blockchainType without a marker as resume-worthy', async () => {
    savePreferences({ blockchainType: 'walletconnect' });
    await storageRepository.flushAggregate();
    clearSavedSessionMarker();

    expect(storageRepository.shouldOfferResumeOrStartOver()).toBe(true);
    expect(await storageRepository.readCurrentState()).toMatchObject({
      preferences: { blockchainType: 'walletconnect' },
    });
    expect(hasSavedSessionMarker()).toBe(true);
  });

  it('treats leftover hubUrl without a marker as resume-worthy', async () => {
    savePreferences({ hubUrl: 'http://localhost:3003' });
    await storageRepository.flushAggregate();
    clearSavedSessionMarker();

    expect(storageRepository.shouldOfferResumeOrStartOver()).toBe(true);
    expect(await storageRepository.readCurrentState()).toMatchObject({
      preferences: { hubUrl: 'http://localhost:3003' },
    });
    expect(hasSavedSessionMarker()).toBe(true);
  });

  it('shouldOfferResumeOrStartOver is false on a clean slate', () => {
    expect(storageRepository.shouldOfferResumeOrStartOver()).toBe(false);
  });

  it('auto-resume once flag is one-shot in sessionStorage', () => {
    expect(peekAutoResumeOnce()).toBe(false);
    markAutoResumeOnce();
    expect(peekAutoResumeOnce()).toBe(true);
    // Second peek still true (latched) until cleared.
    expect(peekAutoResumeOnce()).toBe(true);
    clearAutoResumeOnce();
    expect(peekAutoResumeOnce()).toBe(false);
  });

  it('auto-resume latch survives clearing sessionStorage until clearAutoResumeOnce', () => {
    markAutoResumeOnce();
    expect(peekAutoResumeOnce()).toBe(true);
    sessionStorage.removeItem('appState_autoResumeOnce');
    expect(peekAutoResumeOnce()).toBe(true);
    clearAutoResumeOnce();
    expect(peekAutoResumeOnce()).toBe(false);
  });

  it('does not let preference-only patches clobber a durable cradle before hydrate', async () => {
    saveLiveFields();
    await storageRepository.flushAggregate();
    expect(hasSavedSessionMarker()).toBe(true);

    // Simulate marker-only boot: memory has preferences, IndexedDB has the cradle.
    storageRepository._resetForTests();
    await storageRepository.claimApplicationState();
    expect(hasSavedSessionMarker()).toBe(true);
    expect(storageRepository.loadState()).not.toHaveProperty('live');

    saveHistory({ diagnosticLog: ['boot log'] });
    await storageRepository.flushAggregate();

    storageRepository._resetForTests();
    const restored = await storageRepository.readCurrentState();
    const loaded = requireLive(restored);
    expect(loaded.live.serializedGameSession).toEqual(sampleSession.serializedGameSession);
    expect(loaded.pairing.token).toBe(sampleSession.pairingToken);
    expect(restored?.history.diagnosticLog).toEqual(['boot log']);
  });

  it('flush persists a newer in-memory cradle even when sessionId is unset', async () => {
    const first = new Uint8Array([1, 1, 1, 1]);
    const second = new Uint8Array([2, 2, 2, 2, 2, 2]);
    markSavedSession();
    saveLiveFields({
      ...sampleSession,
      serializedGameSession: first,
      pairingToken: 'tok-v1',
      // Intentionally omit sessionId — handshake saves often look like this.
    });
    await storageRepository.flushAggregate();

    saveLiveFields({
      ...sampleSession,
      serializedGameSession: second,
      pairingToken: 'tok-v2',
    });
    await storageRepository.flushAggregate();

    storageRepository._resetForTests();
    const loaded = requireLive(await storageRepository.readCurrentState());
    expect(loaded.live.serializedGameSession).toEqual(second);
    expect(loaded.pairing.token).toBe('tok-v2');
  });

  it('returns a pre-game blockchainType record when the boot marker is set', async () => {
    localStorage.setItem('appState_savedSession', '1');
    await storageRepository.checkpointApplicationState(
      baseSave({ playerId: 'player', blockchainType: 'simulator' }),
      [],
    );
    expect(await storageRepository.readCurrentState()).toMatchObject({
      preferences: { blockchainType: 'simulator' },
    });
    expect(hasSavedSessionMarker()).toBe(true);
  });

  it('clears the marker for a present but empty IndexedDB record', async () => {
    localStorage.setItem('appState_savedSession', '1');
    await storageRepository.checkpointApplicationState(baseSave({ playerId: 'player' }));
    expect(await storageRepository.readCurrentState()).toBeNull();
    expect(hasSavedSessionMarker()).toBe(false);
  });

  it('returns null when nothing is saved', async () => {
    expect(await storageRepository.readCurrentState()).toBeNull();
  });

  it('clearSession asynchronously deletes resumable state', async () => {
    saveLiveFields();
    await storageRepository.flushAggregate();
    await storageRepository.clearSession();
    storageRepository._resetForTests();
    expect(await storageRepository.readCurrentState()).toBeNull();
  });

  it('orders clearSession before an immediate unawaited replacement save', async () => {
    saveLiveFields({
      ...sampleSession,
      serializedGameSession: new Uint8Array([1]),
    });
    await storageRepository.flushAggregate();

    const cleared = storageRepository.clearSession();
    const saved = saveLiveFields({
      ...sampleSession,
      serializedGameSession: new Uint8Array([2]),
      pairingToken: 'replacement-after-clear',
    });
    const flushed = storageRepository.flushAggregate();
    await Promise.all([cleared, saved, flushed]);

    const persisted = requireLive(await readApplicationState());
    expect(persisted.live.serializedGameSession).toEqual(new Uint8Array([2]));
    expect(persisted.pairing.token).toBe('replacement-after-clear');
  });

  it('rejects an old combined checkpoint without reporting loss of a newer claim', async () => {
    let release!: () => void;
    let committed!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reachedCommit = new Promise<void>((resolve) => {
      committed = resolve;
    });
    const authorityLost = jest.fn();
    const unsubscribe = storageRepository.onAuthorityLost(authorityLost);
    storageRepository.holdNextCheckpointAfterCommitForTests(barrier, committed);

    saveLiveFields({
      ...sampleSession,
      serializedGameSession: new Uint8Array([7]),
    });
    const checkpoint = storageRepository.flushAggregate();
    await reachedCommit;
    await storageRepository.claimApplicationState();
    expectConsoleError('Durable storage authority was lost');
    release();

    await expect(checkpoint).rejects.toBeInstanceOf(StorageAuthorityLostError);
    expect(authorityLost).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('clearSession removes the session while preserving wallet obligations in the root', async () => {
    storageRepository._replaceApplicationStateForTests({
      ...storageRepository.loadState(),
      walletContext: { provider: 'simulator', identity: 'installation' },
    });
    walletOperationRuntime.registerReserved(
      'trade-clear',
      {
        installationPlayerId: 'installation',
        peerSessionId: 'peer-session',
        providerScope: { provider: 'simulator' as const, identity: 'installation' },
      },
      { kind: 'funding', operationId: 'funding-operation' },
    );
    await storageRepository.flushAggregate();
    await storageRepository.clearSession();
    storageRepository._resetForTests();

    await storageRepository.claimApplicationState();
    expect(storageRepository.walletObligations()).toEqual([
      expect.objectContaining({
        tradeId: 'trade-clear',
        stage: 'cancel-required',
        reason: 'orphaned-reservation-restored',
      }),
    ]);
  });

  it('installs wallet obligations from a root without a session', async () => {
    storageRepository._resetForTests();
    await storageRepository.claimApplicationState();
    const state = {
      ...storageRepository.loadState(),
      walletContext: { provider: 'simulator' as const, identity: 'installation' },
      walletObligations: [
        {
          tradeId: 'trade-independent',
          owner: {
            installationPlayerId: 'installation',
            peerSessionId: 'peer-session',
            providerScope: { provider: 'simulator' as const, identity: 'installation' },
          },
          purpose: { kind: 'fee', operationId: 'submission' },
          stage: 'reserved',
          reason: 'created-before-reload',
        },
      ],
    };
    storageRepository._replaceApplicationStateForTests(state);
    await storageRepository.checkpointApplicationState(state);
    clearSavedSessionMarker();

    expect(await storageRepository.claimApplicationState()).toMatchObject({ session: null });
    expect(storageRepository.walletObligations()).toEqual([
      expect.objectContaining({
        tradeId: 'trade-independent',
        stage: 'cancel-required',
        reason: 'orphaned-reservation-restored',
      }),
    ]);
  });

  it('restores retained fee sources without promoting them to cancellation', async () => {
    storageRepository._resetForTests();
    await storageRepository.claimApplicationState();
    const state = {
      ...storageRepository.loadState(),
      walletContext: { provider: 'simulator' as const, identity: 'installation' },
      walletObligations: [
        {
          tradeId: 'trade-retained',
          owner: {
            installationPlayerId: 'installation',
            peerSessionId: 'peer-session',
            providerScope: { provider: 'simulator' as const, identity: 'installation' },
          },
          purpose: { kind: 'fee', operationId: 'submission-7' },
          stage: 'retained-for-replay',
          reason: 'fee-source-attached',
        },
      ],
    };
    storageRepository._replaceApplicationStateForTests(state);
    await storageRepository.checkpointApplicationState(state);

    await storageRepository.claimApplicationState();

    expect(storageRepository.walletObligations()).toEqual([
      expect.objectContaining({
        tradeId: 'trade-retained',
        stage: 'retained-for-replay',
        reason: 'fee-source-attached',
      }),
    ]);
  });

  it.each(['session deletion', 'rejection tombstone'])(
    '%s preserves wallet-obligation siblings',
    async (kind) => {
      const entry = {
        tradeId: `trade-${kind}`,
        owner: {
          installationPlayerId: 'installation',
          peerSessionId: 'peer-session',
          providerScope: { provider: 'simulator' as const, identity: 'installation' },
        },
        purpose: { kind: 'funding' as const, operationId: 'funding' },
        stage: 'cancel-required' as const,
        reason: 'cleanup',
      };
      const state = {
        ...storageRepository.loadState(),
        walletContext: entry.owner.providerScope,
        walletObligations: [entry],
      };
      storageRepository._replaceApplicationStateForTests(state);
      await storageRepository.checkpointApplicationState(state);
      saveLiveFields({ ...sampleSession, walletProviderScope: entry.owner.providerScope });
      await storageRepository.flushAggregate();
      if (kind === 'session deletion') {
        await storageRepository.clearSession();
      } else {
        const rejection = {
          kind: 'outbound-reject',
          peerId: 'peer',
          sessionId: '0'.repeat(32),
          messageNumber: 2n,
          remoteNumber: 1n,
          unackedMessages: [],
          createdAt: Date.now(),
        } as const;
        await writeRootTransform((state) => ({
          ...freshSessionState(state),
          rejectionTransports: [rejection],
        }));
      }
      expect((await readApplicationState())?.walletObligations).toEqual([entry]);
    },
  );

  it('aggregate capture preserves blockchainType', async () => {
    saveLiveFields({ ...sampleSession, blockchainType: 'walletconnect' });
    await storageRepository.flushAggregate();
    expect((await storageRepository.readCurrentState())?.preferences.blockchainType).toBe(
      'walletconnect',
    );
  });

  it('keeps the latest root dirty after an ordinary write failure', async () => {
    const write = jest
      .spyOn(indexedDbStoragePort, 'writeApplicationState')
      .mockRejectedValueOnce(new Error('quota unavailable'));
    const scheduled = storageRepository.updatePreference({
      key: 'alias',
      value: 'Dirty Alice',
    });
    expectConsoleError('failed to persist session state');
    await expect(Promise.all([scheduled, storageRepository.flushAggregate()])).rejects.toThrow(
      'quota unavailable',
    );
    expect(storageRepository.loadState().preferences.alias).toBe('Dirty Alice');

    write.mockRestore();
    await storageRepository.flushAggregate();
    expect((await readApplicationState())?.preferences.alias).toBe('Dirty Alice');
  });
});
