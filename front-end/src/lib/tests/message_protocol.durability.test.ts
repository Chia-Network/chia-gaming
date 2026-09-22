import { expectConsoleError } from '../../../scripts/testSetup';
import { BlockchainPoller } from '../../hooks/BlockchainPoller';
import { SessionController } from '../../hooks/SessionController';
import type { ChiaGame, WasmConnection, WasmResult } from '../../types/ChiaGaming';
import { restoreSession } from '../../hooks/blobSingleton';
import { rehydrateDurableApplicationState } from '../session/persistence';
import { WasmStateInit } from '../../hooks/WasmStateInit';
import { storageRepository } from '../session/storageRepository';
import { decodeDurableApplicationState } from '../session/persistence';
import { DIAGNOSTIC_LOG_UTF8_BYTE_LIMIT, diagnosticLogUtf8Bytes } from '../session/historyLimits';
import { channelFundingRuntime } from '../session/channelFundingRuntime';
import { SESSION_DB_NAME } from '../session/indexedDb';

import { liveSave } from './session_save_envelope.fixtures';
import {
  channelStatus,
  createReadyBlob,
  enc,
  makeMockCradle,
  makePeerConn,
  mockBlockchain,
  mockRpc,
  mockWasmConnection,
  saveLiveSession,
  setActiveBlob,
  setTestBlockchain,
  setTestPersistence,
  wasmResult,
} from './message_protocol.harness';
import { TEST_PROTOCOL_IDS } from './protocolIdentities';

async function readRawApplicationState(): Promise<Uint8Array> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(SESSION_DB_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise<Uint8Array>((resolve, reject) => {
      const transaction = db.transaction('application-state', 'readonly');
      const request = transaction.objectStore('application-state').get('current');
      request.onsuccess = () => resolve(request.result as Uint8Array);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

describe('WASM command persistence', () => {
  it('coalesces successful eventless mutations and ignores read-only polling', async () => {
    const { blob, cradle } = createReadyBlob();
    setActiveBlob(blob);
    const save = jest.fn();
    setTestPersistence(blob, save);
    (cradle as unknown as { make_move: jest.Mock }).make_move = jest.fn(() => wasmResult());

    expect(blob.makeMove('7', null)).toBe('queued');
    expect(blob.makeMove('7', null)).toBe('queued');
    expect(save).not.toHaveBeenCalled();
    await blob.flushPendingWork();
    expect(save).toHaveBeenCalledTimes(1);

    blob.reportNewBlock(2n);
    await blob.flushPendingWork();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('keeps outbound delivery behind one immediate durability flush', async () => {
    jest.useFakeTimers();
    const outbound = enc('eventless-command-outbound');
    const { blob, cradle, sentMessages, sentAcks } = createReadyBlob();
    setActiveBlob(blob);
    const save = jest.fn(() => {
      expect(sentMessages).toEqual([]);
      expect(sentAcks).toEqual([]);
    });
    setTestPersistence(blob, save);
    (cradle as unknown as { make_move: jest.Mock }).make_move = jest.fn(() =>
      wasmResult({ events: [{ OutboundMessage: outbound }] }),
    );

    try {
      expect(blob.makeMove('7', null)).toBe('queued');
      expect(save).not.toHaveBeenCalled();
      expect(sentMessages).toEqual([]);

      await blob.flushPendingWork();
      expect(save).toHaveBeenCalledTimes(1);
      expect(sentMessages).toEqual([{ msgno: 1, msg: outbound }]);

      await jest.advanceTimersByTimeAsync(500);
      expect(save).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('durability failures', () => {
  it('emits once for differing failures until a successful checkpoint re-arms reporting', () => {
    const { blob } = createReadyBlob();
    const warnings: string[] = [];
    const retry = jest.fn();
    const unsubscribeRetry = blob.onTerminalFinalizationRetry(retry);
    const sub = blob.getObservable().subscribe((event) => {
      if (event.type === 'durability-error') warnings.push(event.error);
    });

    blob.reportDurabilityError(new Error('first failure'));
    blob.reportDurabilityError(new Error('different failure'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('first failure');

    blob.clearDurabilityError();
    expect(retry).not.toHaveBeenCalled();
    blob.reportDurabilityError(new Error('later episode'));
    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toContain('later episode');
    unsubscribeRetry();
    sub.unsubscribe();
  });

  it('routes a rejected background save to the durability channel', async () => {
    jest.useFakeTimers();
    const { blob, cradle } = createReadyBlob();
    setActiveBlob(blob);
    const warnings: string[] = [];
    const sub = blob.getObservable().subscribe((event) => {
      if (event.type === 'durability-error') warnings.push(event.error);
    });
    let fail = true;
    setTestPersistence(blob, () =>
      fail ? Promise.reject(new Error('background write failed')) : Promise.resolve(),
    );
    (cradle as unknown as { make_move: jest.Mock }).make_move = jest.fn(() => wasmResult());

    try {
      blob.makeMove('7', null);
      await jest.advanceTimersByTimeAsync(0);
      expect(warnings).toEqual([
        'Session storage failed: background write failed. The session is continuing without a durable checkpoint; progress may be lost if this page closes before storage succeeds.',
      ]);
      fail = false;
    } finally {
      sub.unsubscribe();
      jest.useRealTimers();
    }
  });

  it('drains queued WASM events before the coordinated snapshot', async () => {
    const { blob } = createReadyBlob();
    setActiveBlob(blob);
    const save = jest.fn(() => {
      expect((blob as any).eventQueue).toEqual([]);
    });
    setTestPersistence(blob, save);

    blob.processResult({
      ...wasmResult(),
      events: [{ Notification: { ActionFailed: { reason: 'late rejection' } } }],
    });
    await blob.flushPendingWork();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('keeps valid WASM state and releases reliable effects once across IndexedDB failure', async () => {
    const helloBytes = enc('hello');
    const { blob, cradle, sentMessages, sentAcks } = createReadyBlob(() => ({
      events: [{ OutboundMessage: helloBytes }],
    }));
    setActiveBlob(blob);
    const warnings: string[] = [];
    const sub = blob.getObservable().subscribe((event) => {
      if (event.type === 'durability-error') warnings.push(event.error);
    });
    let fail = true;
    setTestPersistence(blob, () =>
      fail ? Promise.reject(new Error('permanent write failure')) : Promise.resolve(),
    );
    try {
      blob.deliverMessage(1n, enc('trigger'));
      blob.flushDeferredWork();
      await expect(blob.flushPendingWork()).rejects.toThrow();

      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('continuing without a durable checkpoint');
      expect(cradle.deliver_message).toHaveBeenCalledTimes(1);
      expect(blob.remoteNumber).toBe(1n);
      expect(sentMessages).toEqual([{ msgno: 1, msg: helloBytes }]);
      expect(sentAcks).toEqual([1]);
      expect(blob.unackedMessages).toContainEqual({ msgno: 1n, msg: helloBytes });
    } finally {
      fail = false;
    }

    await blob.flushPendingSave();
    await blob.flushPendingWork();

    expect(cradle.deliver_message).toHaveBeenCalledTimes(1);
    expect(blob.remoteNumber).toBe(1n);
    expect(sentMessages).toEqual([{ msgno: 1, msg: helloBytes }]);
    expect(sentAcks).toEqual([1]);
    sub.unsubscribe();
  });

  it('launches cleanup after a failed write and checkpoints unresolved intent on retry', async () => {
    let finishCleanup!: () => void;
    const cleanup = new Promise<{ status: 'unavailable'; detail: string }>((resolve) => {
      finishCleanup = () => resolve({ status: 'unavailable', detail: 'wallet offline' });
    });
    const beginWalletOfferCancellation = jest.fn(() => cleanup);
    const { blob } = createReadyBlob();
    setActiveBlob(blob);
    setTestBlockchain(
      blob,
      new BlockchainPoller({ ...mockRpc, beginWalletOfferCancellation }, 60_000),
    );
    channelFundingRuntime.attachProvider(
      blob.blockchain.rpc.getWalletOfferProvider({
        installationPlayerId: 'test',
        peerSessionId: '00'.repeat(16),
      })!,
    );
    const checkpoints: Array<ReturnType<typeof blob.getWasmFields>> = [];
    let failPersistence = true;
    setTestPersistence(blob, async () => {
      checkpoints.push(blob.getWasmFields());
      if (failPersistence) throw new Error('disk full');
    });

    storageRepository._replaceApplicationStateForTests({
      ...storageRepository.loadState(),
      walletContext: { provider: 'simulator', identity: 'submission-handoff' },
      channelFundingOperations: [
        {
          providerReservationId: 'trade-unresolved',
          owner: {
            installationPlayerId: 'test',
            peerSessionId: '00'.repeat(16),
            providerScope: {
              provider: 'simulator',
              identity: 'submission-handoff',
            },
          },
          purpose: { kind: 'funding', operationId: 'funding-operation' },
          stage: 'cancel-required',
          reason: 'funding-offer-rejected',
        },
      ],
    });
    channelFundingRuntime.retryCancelRequired();

    await expect(blob.flushPendingSave()).rejects.toThrow('disk full');
    for (
      let attempt = 0;
      attempt < 30 && beginWalletOfferCancellation.mock.calls.length === 0;
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(beginWalletOfferCancellation).toHaveBeenCalledTimes(1);
    expect(blob.getWasmFields()).not.toHaveProperty('durabilityWarning');
    expect(storageRepository.channelFundingOperations()).toEqual([
      expect.objectContaining({
        providerReservationId: 'trade-unresolved',
        stage: 'cancel-required',
      }),
    ]);

    failPersistence = false;
    finishCleanup();
    await channelFundingRuntime.flush();
    await blob.flushPendingWork();
    await blob.flushPendingSave();

    expect(checkpoints).toHaveLength(2);
    expect(storageRepository.channelFundingOperations()).toEqual([
      expect.objectContaining({
        providerReservationId: 'trade-unresolved',
        stage: 'cancel-required',
      }),
    ]);
    expect(blob.getWasmFields()).not.toHaveProperty('durabilityWarning');
    expect(beginWalletOfferCancellation).toHaveBeenCalledTimes(1);
  });

  it('requires the prepared save to update cached synchronously before returning', async () => {
    const { storageRepository } = await import('../session/storageRepository');
    const outbound = enc('outbound');
    const { blob, cradle, sentMessages } = createReadyBlob(() => ({
      events: [{ OutboundMessage: outbound }],
    }));
    setActiveBlob(blob);

    const cradleBytes = new Uint8Array([7, 7, 7, 7]);
    (cradle.serialize as jest.Mock).mockReturnValue(cradleBytes);
    let saveReturned = false;
    setTestPersistence(blob, () => {
      const fields = blob.getWasmFields();
      if (!fields) throw new Error('expected save fields');
      const pending = saveLiveSession({
        ...fields,
        serializedGameSession: cradle.serialize(),
        pairingToken: 'sync-cradle',
      });
      // Cached must already contain the cradle before the returned Promise
      // settles — durability flushes immediately after starting the prepared save.
      const state = storageRepository.loadState();
      expect(state.session?.phase === 'live' && state.session.live.serializedGameSession).toEqual(
        cradleBytes,
      );
      saveReturned = true;
      return pending;
    });

    blob.deliverMessage(1n, enc('trigger'));
    await blob.flushPendingWork();

    expect(saveReturned).toBe(true);
    const persisted = await storageRepository.readCurrentState();
    expect(
      persisted?.session?.phase === 'live' && persisted.session.live.serializedGameSession,
    ).toEqual(cradleBytes);
    expect(sentMessages).toEqual([{ msgno: 1, msg: outbound }]);
  });

  it('releases the prepared outbound when persistence-time cradle serialization fails', async () => {
    const outbound = enc('outbound');
    const { blob, cradle, sentMessages, sentAcks } = createReadyBlob(() => ({
      events: [{ OutboundMessage: outbound }],
    }));
    setActiveBlob(blob);
    setTestPersistence(blob, () => Promise.resolve());
    await blob.flushPendingWork();
    await blob.flushPendingSave();
    const previousFields = blob.getWasmFields();
    if (!previousFields) throw new Error('expected save fields');
    void saveLiveSession({
      ...previousFields,
      serializedGameSession: new Uint8Array([9, 9, 9]),
      pairingToken: 'previous-durable-record',
    });
    await storageRepository.flushAggregate();
    (cradle.serialize as jest.Mock).mockImplementation(() => {
      throw new Error('malformed cradle serialization');
    });
    setTestPersistence(blob, () => {
      // Serialize failures throw from getWasmFields; null means not ready yet.
      const fields = blob.getWasmFields();
      if (!fields) return Promise.resolve();
      return saveLiveSession(fields as unknown as Record<string, unknown>);
    });

    blob.deliverMessage(1n, enc('trigger'));
    await expect(blob.flushPendingWork()).rejects.toThrow('malformed cradle serialization');

    expect(sentMessages).toEqual([{ msgno: 1, msg: outbound }]);
    expect(sentAcks).toEqual([1]);
    blob.cleanup();
    setActiveBlob(null);
    const saved = await storageRepository.readCurrentState();
    expect(saved?.session?.phase === 'live' && saved.session.live.serializedGameSession).toEqual(
      new Uint8Array([9, 9, 9]),
    );
  });
});

describe('resendUnacked', () => {
  it('re-sends all un-acked messages via sendMessage', async () => {
    const { blob, sentMessages } = createReadyBlob();
    setActiveBlob(blob);
    await blob.flushPendingSave();

    blob.messageNumber = 3n;
    blob.unackedMessages = [
      { msgno: 1n, msg: enc('a') },
      { msgno: 2n, msg: enc('b') },
    ];
    blob.resendUnacked();

    expect(sentMessages).toEqual([
      { msgno: 1, msg: enc('a') },
      { msgno: 2, msg: enc('b') },
    ]);
  });
});

describe('restore ordering', () => {
  it('replays buffered height and coin observations in arrival order after restore', () => {
    const sentMessages: Array<{ msgno: number; msg: Uint8Array }> = [];
    const sentAcks: number[] = [];
    const blob = new SessionController(
      mockBlockchain,
      'test',
      100n,
      100n,
      makePeerConn(sentMessages, sentAcks),
    );
    setActiveBlob(blob);
    const cradle = makeMockCradle();
    const firstSnapshot = [{ coin: 'first', created_height: 10n, spent_height: null }];
    const secondSnapshot = [{ coin: 'second', created_height: 11n, spent_height: 11n }];

    blob.loadWasm(mockWasmConnection);
    blob.reportNewBlock(10n);
    blob.reportCoinStates(10n, firstSnapshot);
    blob.reportNewBlock(11n);
    blob.reportCoinStates(11n, secondSnapshot);
    blob.setGameSession(cradle);

    expect(cradle.report_height).toHaveBeenNthCalledWith(1, 10n);
    expect(cradle.report_coin_states).toHaveBeenNthCalledWith(1, 10n, firstSnapshot);
    expect(cradle.report_height).toHaveBeenNthCalledWith(2, 11n);
    expect(cradle.report_coin_states).toHaveBeenNthCalledWith(2, 11n, secondSnapshot);
  });

  it('restores counters before spilling buffered messages without replaying unacked', async () => {
    const sentMessages: Array<{ msgno: number; msg: Uint8Array }> = [];
    const sentAcks: number[] = [];
    const blob = new SessionController(
      mockBlockchain,
      'test',
      100n,
      100n,
      makePeerConn(sentMessages, sentAcks),
    );
    setActiveBlob(blob);

    const cradle = makeMockCradle();
    const restoreWasmConnection = {
      game_session_serialization_schema: () => 4,
      registered_game_packages: () => [...TEST_PROTOCOL_IDS],
    } as unknown as WasmConnection;
    const wasmStateInit = {
      getWasmConnection: jest.fn(async () => restoreWasmConnection),
      deserializeGame: jest.fn(() => cradle),
    } as unknown as WasmStateInit;

    blob.kickSystem(2);
    blob.deliverMessage(1n, enc('already-processed'));
    await blob.flushPendingWork();
    const statuses: string[] = [];
    const unsubscribe = blob.onRestoreStatusChange((status) => statuses.push(status));

    const newestDiagnostic = `newest:${'界'.repeat(60_000)}`;
    const save = liveSave({
      version: 22n,
      playerId: 'p1',
      serializedGameSession: new Uint8Array([1, 2, 3]),
      gameSessionSchemaVersion: 4n,
      messageNumber: 5n,
      remoteNumber: 1n,
      iStarted: true,
      pairingToken: 'tok',
      myContribution: '100',
      theirContribution: '100',
      perGameAmount: '10',
      activeGameIds: [],
      rewardPuzzleHash: '11'.repeat(32),
      unackedMessages: [{ msgno: 4n, msg: enc('outbound') }],
      wasmNotificationHistory: ['notification'],
      diagnosticLog: [`older:${'😀'.repeat(40_000)}`, newestDiagnostic],
    });
    expect(() => decodeDurableApplicationState(save)).not.toThrow();
    await blob.beginRestore(
      restoreSession(blob, rehydrateDurableApplicationState(save), wasmStateInit),
    );
    unsubscribe();

    expect(cradle.deliver_message).not.toHaveBeenCalled();
    expect(sentAcks).toEqual([1]);
    expect(sentMessages).toEqual([]);
    expect(cradle.chain_snapshot_ready).not.toHaveBeenCalled();
    expect(blob.messageNumber).toBe(5n);
    expect(blob.remoteNumber).toBe(1n);
    expect(blob.wasmNotificationHistory).toEqual(['notification']);
    expect(blob.diagnosticLog).toEqual([newestDiagnostic]);
    expect(diagnosticLogUtf8Bytes(blob.diagnosticLog)).toBeLessThanOrEqual(
      DIAGNOSTIC_LOG_UTF8_BYTE_LIMIT,
    );
    expect(statuses).toEqual(['idle', 'restoring', 'restored']);
    expect(blob.getRestoreStatus()).toBe('restored');
  });

  it('marks restore failures and emits an error event', async () => {
    const sentMessages: Array<{ msgno: number; msg: Uint8Array }> = [];
    const sentAcks: number[] = [];
    const blob = new SessionController(
      mockBlockchain,
      'test',
      100n,
      100n,
      makePeerConn(sentMessages, sentAcks),
    );
    setActiveBlob(blob);

    const errors: string[] = [];
    const sub = blob.getObservable().subscribe({
      next: (evt) => {
        if (evt.type === 'error') errors.push(evt.error);
      },
    });

    await expect(blob.beginRestore(Promise.reject(new Error('restore broke')))).rejects.toThrow(
      'restore broke',
    );
    sub.unsubscribe();

    expect(blob.getRestoreStatus()).toBe('failed');
    expect(blob.getRestoreError()).toContain('restore broke');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('restore broke');
  });

  it('does not expose stack frames in user-facing error events', async () => {
    const sentMessages: Array<{ msgno: number; msg: Uint8Array }> = [];
    const sentAcks: number[] = [];
    const blob = new SessionController(
      mockBlockchain,
      'test',
      100n,
      100n,
      makePeerConn(sentMessages, sentAcks),
    );
    setActiveBlob(blob);

    const errors: string[] = [];
    const sub = blob.getObservable().subscribe({
      next: (evt) => {
        if (evt.type === 'error') errors.push(evt.error);
      },
    });
    const err = new Error('wallet rejected spend');
    err.stack = 'spend@http://localhost:3002/app/17818440673N/index.js:50242:15';

    await expect(blob.beginRestore(Promise.reject(err))).rejects.toThrow('wallet rejected spend');
    sub.unsubscribe();

    expect(errors).toEqual(['wallet rejected spend']);
    expect(blob.getRestoreError()).toBe('wallet rejected spend');
  });
});

describe('cradle serialization schema restore guard', () => {
  function makeRestoreHarness(deserializeGame: () => ChiaGame): {
    blob: SessionController;
    wasmStateInit: WasmStateInit;
    deserializeMock: jest.Mock;
  } {
    const blob = new SessionController(mockBlockchain, 'test', 100n, 100n, makePeerConn([], []));
    setActiveBlob(blob);
    const deserializeMock = jest.fn(deserializeGame);
    const wasmStateInit = {
      getWasmConnection: jest.fn(
        async () =>
          ({
            game_session_serialization_schema: () => 4,
            registered_game_packages: () => [...TEST_PROTOCOL_IDS],
          }) as unknown as WasmConnection,
      ),
      deserializeGame: deserializeMock,
    } as unknown as WasmStateInit;
    return { blob, wasmStateInit, deserializeMock };
  }

  it('rejects a whole aggregate with a missing cradle schema', async () => {
    const invalid = liveSave({
      serializedGameSession: new Uint8Array([1, 2, 3]),
      gameSessionSchemaVersion: undefined,
      pairingToken: 'restore-schema-test',
    });
    await expect(storageRepository.checkpointApplicationState(invalid)).rejects.toThrow();
    const { deserializeMock } = makeRestoreHarness(makeMockCradle);

    expect(deserializeMock).not.toHaveBeenCalled();
    expect(await storageRepository.readCurrentState()).toBeNull();
  });

  it('preserves the complete in-memory and durable aggregate on unsupported cradle schema', async () => {
    const save = liveSave({
      playerId: 'schema-evidence-player',
      serializedGameSession: new Uint8Array([1, 2, 3]),
      gameSessionSchemaVersion: 3n,
      pairingToken: 'unsupported-schema-test',
      diagnosticLog: ['preserve diagnostic evidence'],
      rejectionTransports: [
        {
          kind: 'outbound-reject',
          peerId: 'other-peer',
          sessionId: 'ab'.repeat(16),
          messageNumber: 2n,
          remoteNumber: 1n,
          unackedMessages: [{ msgno: 2n, msg: new Uint8Array([7, 8]) }],
          createdAt: 1,
        },
      ],
    });
    storageRepository._replaceApplicationStateForTests(save);
    await storageRepository.checkpointApplicationState(save);
    const memoryBefore = structuredClone(storageRepository.loadState());
    const durableBytesBefore = await readRawApplicationState();
    const { blob, wasmStateInit, deserializeMock } = makeRestoreHarness(makeMockCradle);

    await expect(
      restoreSession(blob, rehydrateDurableApplicationState(save), wasmStateInit),
    ).rejects.toThrow('Unsupported saved game format: cradle schema 3; current schema is 4');

    expect(deserializeMock).not.toHaveBeenCalled();
    expect(storageRepository.loadState()).toEqual(memoryBefore);
    expect(await readRawApplicationState()).toEqual(durableBytesBefore);
  });

  it('does not delete same-schema records that fail deserialization', async () => {
    void saveLiveSession({
      serializedGameSession: new Uint8Array([1, 2, 3]),
      gameSessionSchemaVersion: 4n,
      pairingToken: 'restore-corruption-test',
      messageNumber: 1n,
      remoteNumber: 0n,
      iStarted: true,
      activeGameIds: [],
      unackedMessages: [],
      myContribution: '100',
      theirContribution: '100',
      perGameAmount: '10',
      rewardPuzzleHash: '11'.repeat(32),
    });
    await storageRepository.flushAggregate();
    const { blob, wasmStateInit, deserializeMock } = makeRestoreHarness(() => {
      throw new Error('corrupt current-schema cradle');
    });
    const save = (await storageRepository.readCurrentState())!;

    await expect(
      restoreSession(blob, rehydrateDurableApplicationState(save), wasmStateInit),
    ).rejects.toThrow('corrupt current-schema cradle');

    expect(deserializeMock).toHaveBeenCalledTimes(1);
    const saved = await storageRepository.readCurrentState();
    expect(saved?.session?.phase === 'live' && saved.session.live.serializedGameSession).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });
});

describe('cleanShutdown calls shut_down on cradle', () => {
  it('calls shut_down on cradle', () => {
    const sentMessages: Array<{ msgno: number; msg: Uint8Array }> = [];
    const sentAcks: number[] = [];
    const blob = new SessionController(
      mockBlockchain,
      'test',
      100n,
      100n,
      makePeerConn(sentMessages, sentAcks),
    );
    setActiveBlob(blob);

    const cradle = {
      ...makeMockCradle(),
      shut_down: jest.fn(() => wasmResult()),
    } as unknown as ChiaGame;

    blob.loadWasm(mockWasmConnection);
    blob.setGameSession(cradle);
    blob.kickSystem(2);
    blob.reportCoinStates(1n, []);

    blob.cleanShutdown();

    expect((cradle as any).shut_down).toHaveBeenCalled();
  });
});

describe('abandon calls Rust through cradle', () => {
  it('delegates abandonment to the cradle', () => {
    const sentMessages: Array<{ msgno: number; msg: Uint8Array }> = [];
    const sentAcks: number[] = [];
    const blob = new SessionController(
      mockBlockchain,
      'test',
      100n,
      100n,
      makePeerConn(sentMessages, sentAcks),
    );
    setActiveBlob(blob);

    const cradle = makeMockCradle();
    blob.loadWasm(mockWasmConnection);
    blob.setGameSession(cradle);

    blob.abandon();

    expect((cradle as any).abandon).toHaveBeenCalled();
  });

  it('keeps the controller available when Rust rejects abandonment', () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const sentMessages: Array<{ msgno: number; msg: Uint8Array }> = [];
    const sentAcks: number[] = [];
    const blob = new SessionController(
      mockBlockchain,
      'test',
      100n,
      100n,
      makePeerConn(sentMessages, sentAcks),
    );
    setActiveBlob(blob);
    const cradle = {
      ...makeMockCradle(),
      abandon: jest.fn(() => {
        throw new Error('terminal handoff awaits acknowledgement');
      }),
    } as unknown as ChiaGame;
    const errors: string[] = [];
    blob.getObservable().subscribe((event) => {
      if (event.type === 'error') errors.push(event.error);
    });
    blob.loadWasm(mockWasmConnection);
    blob.setGameSession(cradle);

    blob.abandon();

    expect((cradle as any).abandon).toHaveBeenCalledTimes(1);
    expect((blob as any).cradle).toBe(cradle);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('terminal handoff awaits acknowledgement');
    errorSpy.mockRestore();
  });
});

describe('go-on-chain terminal remap', () => {
  it('keeps the channel ready for on-chain moves after leaving Active', () => {
    const sentMessages: Array<{ msgno: number; msg: Uint8Array }> = [];
    const sentAcks: number[] = [];
    const blob = new SessionController(
      mockBlockchain,
      'test',
      100n,
      100n,
      makePeerConn(sentMessages, sentAcks),
    );
    setActiveBlob(blob);
    blob.loadWasm(mockWasmConnection);
    blob.setGameSession(makeMockCradle());

    blob.processResult({
      ...wasmResult(),
      events: [{ Notification: { ChannelStatus: channelStatus({ state: 'Active' }) } }],
    });
    blob.flushDeferredWork();
    expect(blob.isChannelReady()).toBe(true);
    expect(blob.isOffChainActive()).toBe(true);

    blob.processResult({
      ...wasmResult(),
      events: [{ Notification: { ChannelStatus: channelStatus({ state: 'Unrolling' }) } }],
    });
    blob.flushDeferredWork();
    expect(blob.isChannelReady()).toBe(true);
    expect(blob.isOffChainActive()).toBe(false);
  });

  it('reports a successful go-on-chain transition before its notification drains', () => {
    const sentMessages: Array<{ msgno: number; msg: Uint8Array }> = [];
    const sentAcks: number[] = [];
    const blob = new SessionController(
      mockBlockchain,
      'test',
      100n,
      100n,
      makePeerConn(sentMessages, sentAcks),
    );
    setActiveBlob(blob);
    const cradle = {
      ...makeMockCradle(),
      go_on_chain: jest.fn(
        () =>
          ({
            ...wasmResult(),
            actionSucceeded: true,
            disposition: { kind: 'active' },
            events: [],
          }) as WasmResult,
      ),
    } as unknown as ChiaGame;
    blob.loadWasm(mockWasmConnection);
    blob.setGameSession(cradle);

    expect(blob.goOnChain()).toBe(true);
    expect(blob.onChain).toBe(true);
  });

  it('does not enter on-chain mode when Rust abandons terminally', () => {
    const sentMessages: Array<{ msgno: number; msg: Uint8Array }> = [];
    const sentAcks: number[] = [];
    const blob = new SessionController(
      mockBlockchain,
      'test',
      100n,
      100n,
      makePeerConn(sentMessages, sentAcks),
    );
    setActiveBlob(blob);
    const cradle = {
      ...makeMockCradle(),
      go_on_chain: jest.fn(
        () =>
          ({
            ...wasmResult(),
            disposition: { kind: 'terminal' },
            events: [
              {
                Notification: {
                  ChannelStatus: channelStatus({
                    state: 'ShuttingDown',
                    session_disposition: 'Abandoned',
                  }),
                },
              },
            ],
          }) as WasmResult,
      ),
    } as unknown as ChiaGame;
    blob.loadWasm(mockWasmConnection);
    blob.setGameSession(cradle);

    expect(blob.goOnChain()).toBe(false);
    expect((blob as any).onChain).toBe(false);
  });

  it('does not enter on-chain mode when the action fails in an active drain', () => {
    const sentMessages: Array<{ msgno: number; msg: Uint8Array }> = [];
    const sentAcks: number[] = [];
    const blob = new SessionController(
      mockBlockchain,
      'test',
      100n,
      100n,
      makePeerConn(sentMessages, sentAcks),
    );
    setActiveBlob(blob);
    const cradle = {
      ...makeMockCradle(),
      go_on_chain: jest.fn(
        () =>
          ({
            ...wasmResult(),
            actionSucceeded: false,
            disposition: { kind: 'active' },
            events: [
              {
                Notification: { ActionFailed: { reason: 'no channel coin spend info cached' } },
              },
            ],
          }) as WasmResult,
      ),
    } as unknown as ChiaGame;
    blob.loadWasm(mockWasmConnection);
    blob.setGameSession(cradle);

    expectConsoleError('no channel coin spend info cached');
    expect(blob.goOnChain()).toBe(false);
    expect((blob as any).onChain).toBe(false);
  });
});
