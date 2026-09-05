import { expectConsoleError } from '../../../scripts/testSetup';
import { SessionController } from '../../hooks/SessionController';
import type { ChiaGame, WasmConnection, WasmResult } from '../../types/ChiaGaming';
import { restoreSession } from '../../hooks/blobSingleton';
import { WasmStateInit } from '../../hooks/WasmStateInit';
import {
  flushSessionSave,
  hasSavedSessionMarker,
  markSavedSession,
  peekSession,
} from '../../hooks/save';
import { validateSessionSaveEnvelope } from '../session/persistence';
import { writeSessionRecord } from '../session/indexedDb';
import { liveSave } from './session_save_envelope.fixtures';
import {
  channelStatus,
  clearTestGlobal,
  createReadyBlob,
  enc,
  makeMockCradle,
  makePeerConn,
  mockBlockchain,
  mockWasmConnection,
  saveLiveSession,
  setActiveBlob,
  setTestGlobal,
  testIndexedDb,
  wasmResult,
} from './message_protocol.harness';
import { TEST_PROTOCOL_IDS } from './protocolIdentities';

describe('WASM command persistence', () => {
  it('debounces successful eventless mutations and ignores read-only polling', async () => {
    jest.useFakeTimers();
    const { blob, cradle } = createReadyBlob();
    setActiveBlob(blob);
    const save = jest.fn();
    blob.onSaveNeeded = save;
    (cradle as unknown as { make_move: jest.Mock }).make_move = jest.fn(() => wasmResult());

    try {
      expect(blob.makeMove('7', null)).toBe('queued');
      expect(blob.makeMove('7', null)).toBe('queued');
      expect(save).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(499);
      expect(save).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      expect(save).toHaveBeenCalledTimes(1);

      blob.reportNewBlock(2n);
      await jest.advanceTimersByTimeAsync(500);
      expect(save).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
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
    blob.onSaveNeeded = save;
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
  it('routes a rejected background save to the durability channel', async () => {
    jest.useFakeTimers();
    const { blob } = createReadyBlob();
    setActiveBlob(blob);
    const warnings: string[] = [];
    const sub = blob.getObservable().subscribe((event) => {
      if (event.type === 'durability-error') warnings.push(event.error);
    });
    blob.onSaveNeeded = () => Promise.reject(new Error('background write failed'));

    try {
      blob.scheduleSave();
      await jest.advanceTimersByTimeAsync(500);
      expect(warnings).toEqual(['Session storage failed: background write failed.']);
    } finally {
      sub.unsubscribe();
      jest.useRealTimers();
    }
  });

  it('defers a background snapshot until queued WASM events drain', async () => {
    jest.useFakeTimers();
    const { blob } = createReadyBlob();
    setActiveBlob(blob);
    const save = jest.fn(() => {
      expect((blob as any).eventQueue).toEqual([]);
    });
    blob.onSaveNeeded = save;

    try {
      blob.scheduleSave();
      await jest.advanceTimersByTimeAsync(499);
      blob.processResult({
        ...wasmResult(),
        events: [{ Notification: { ActionFailed: { reason: 'late rejection' } } }],
      });
      clearTimeout((blob as any).drainTimer);
      (blob as any).drainTimer = null;

      await jest.advanceTimersByTimeAsync(1);
      expect(save).not.toHaveBeenCalled();

      blob.flushDeferredWork();
      await jest.advanceTimersByTimeAsync(500);
      expect(save).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('warns the user and keeps messages and ACKs queued', async () => {
    const helloBytes = enc('hello');
    const { blob, sentMessages, sentAcks } = createReadyBlob(() => ({
      events: [{ OutboundMessage: helloBytes }],
    }));
    setActiveBlob(blob);
    const warnings: string[] = [];
    const sub = blob.getObservable().subscribe((event) => {
      if (event.type === 'durability-error') warnings.push(event.error);
    });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    clearTestGlobal('indexedDB');
    try {
      blob.deliverMessage(1n, enc('trigger'));
      blob.flushDeferredWork();
      await expect(blob.flushPendingWork()).rejects.toThrow();

      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('remain queued');
      expect(sentMessages).toEqual([]);
      expect(sentAcks).toEqual([]);
      expect(blob.unackedMessages).toContainEqual({ msgno: 1n, msg: helloBytes });
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      setTestGlobal('indexedDB', testIndexedDb);
    }

    await blob.flushPendingSave();
    await blob.flushPendingWork();

    expect(sentMessages).toEqual([{ msgno: 1, msg: helloBytes }]);
    expect(sentAcks).toEqual([1]);
    sub.unsubscribe();
  });

  it('requires onSaveNeeded to update cached synchronously before returning', async () => {
    const { loadState } = await import('../../hooks/save');
    const outbound = enc('outbound');
    const { blob, cradle, sentMessages } = createReadyBlob(() => ({
      events: [{ OutboundMessage: outbound }],
    }));
    setActiveBlob(blob);

    const cradleBytes = new Uint8Array([7, 7, 7, 7]);
    (cradle.serialize as jest.Mock).mockReturnValue(cradleBytes);
    let saveReturned = false;
    blob.onSaveNeeded = () => {
      const fields = blob.getWasmFields();
      if (!fields) throw new Error('expected save fields');
      const pending = saveLiveSession({
        ...fields,
        serializedGameSession: cradle.serialize(),
        pairingToken: 'sync-cradle',
      });
      // Cached must already contain the cradle before the returned Promise
      // settles — durability flushes immediately after starting onSaveNeeded.
      expect(loadState().phase === 'live' && loadState().live.serializedGameSession).toEqual(
        cradleBytes,
      );
      saveReturned = true;
      return pending;
    };

    blob.deliverMessage(1n, enc('trigger'));
    await blob.flushPendingWork();

    expect(saveReturned).toBe(true);
    const persisted = await peekSession();
    expect(persisted?.phase === 'live' && persisted.live.serializedGameSession).toEqual(
      cradleBytes,
    );
    expect(sentMessages).toEqual([{ msgno: 1, msg: outbound }]);
  });

  it('does not send when cradle serialization fails', async () => {
    const outbound = enc('outbound');
    const { blob, cradle, sentMessages, sentAcks } = createReadyBlob(() => ({
      events: [{ OutboundMessage: outbound }],
    }));
    setActiveBlob(blob);
    const previousFields = blob.getWasmFields();
    if (!previousFields) throw new Error('expected save fields');
    void saveLiveSession({
      ...previousFields,
      serializedGameSession: new Uint8Array([9, 9, 9]),
      pairingToken: 'previous-durable-record',
    });
    await flushSessionSave();
    (cradle.serialize as jest.Mock).mockImplementation(() => {
      throw new Error('malformed cradle serialization');
    });
    blob.onSaveNeeded = () => {
      // Serialize failures throw from getWasmFields; null means not ready yet.
      const fields = blob.getWasmFields();
      if (!fields) return Promise.resolve();
      return saveLiveSession(fields as unknown as Record<string, unknown>);
    };

    blob.deliverMessage(1n, enc('trigger'));
    await expect(blob.flushPendingWork()).rejects.toThrow('malformed cradle serialization');

    expect(sentMessages).toEqual([]);
    expect(sentAcks).toEqual([]);
    blob.cleanup();
    setActiveBlob(null);
    const saved = await peekSession();
    expect(saved?.phase === 'live' && saved.live.serializedGameSession).toEqual(
      new Uint8Array([9, 9, 9]),
    );
  });
});

describe('resendUnacked', () => {
  it('re-sends all un-acked messages via sendMessage', () => {
    const { blob, sentMessages } = createReadyBlob();
    setActiveBlob(blob);

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

  it('restores counters before spilling buffered messages and replaying unacked', async () => {
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
      diagnosticLog: ['diagnostic'],
    });
    expect(() => validateSessionSaveEnvelope(save)).not.toThrow();
    await blob.beginRestore(restoreSession(blob, save, wasmStateInit));
    unsubscribe();

    expect(cradle.deliver_message).not.toHaveBeenCalled();
    expect(sentAcks).toEqual([1]);
    expect(sentMessages).toEqual([{ msgno: 4, msg: enc('outbound') }]);
    expect(cradle.resubmit_submitted).not.toHaveBeenCalled();
    expect(blob.messageNumber).toBe(5n);
    expect(blob.remoteNumber).toBe(1n);
    expect(blob.wasmNotificationHistory).toEqual(['notification']);
    expect(blob.diagnosticLog).toEqual(['diagnostic']);
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

  it.each([
    ['missing', undefined],
    ['mismatched', 2n],
  ])(
    'rejects and deletes a record with a %s cradle schema',
    async (_label, gameSessionSchemaVersion) => {
      expectConsoleError('[save] rejecting incompatible session record');
      markSavedSession();
      await writeSessionRecord({
        version: 22n,
        playerId: 'restore-schema-player',
        rewardPuzzleHash: '11'.repeat(32),
        serializedGameSession: new Uint8Array([1, 2, 3]),
        gameSessionSchemaVersion,
        pairingToken: 'restore-schema-test',
      });
      const { deserializeMock } = makeRestoreHarness(makeMockCradle);

      expect(deserializeMock).not.toHaveBeenCalled();
      expect(hasSavedSessionMarker()).toBe(true);
      expect(await peekSession()).toBeNull();
    },
  );

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
    await flushSessionSave();
    const { blob, wasmStateInit, deserializeMock } = makeRestoreHarness(() => {
      throw new Error('corrupt current-schema cradle');
    });
    const save = (await peekSession())!;

    await expect(restoreSession(blob, save, wasmStateInit)).rejects.toThrow(
      'corrupt current-schema cradle',
    );

    expect(deserializeMock).toHaveBeenCalledTimes(1);
    const saved = await peekSession();
    expect(saved?.phase === 'live' && saved.live.serializedGameSession).toEqual(
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
