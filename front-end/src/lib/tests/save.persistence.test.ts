import {
  peekSession,
  clearSession,
  hasSavedSessionMarker,
  shouldOfferResumeOrStartOver,
  markSavedSession,
  clearSavedSessionMarker,
  markAutoResumeOnce,
  peekAutoResumeOnce,
  clearAutoResumeOnce,
  clearSessionWithInboundRejectionReceipt,
  clearSessionWithRejectionTombstone,
  claimLease,
  loadState,
  flushSessionSave,
  getPlayerId,
  hydrateSessionCacheFromDisk,
  reclaimLease,
  _resetForTests,
} from '../../hooks/save';
import {
  _afterNextStorageAuthorityCheckForTests,
  _holdNextStorageMutationForTests,
  MAX_DURABLE_REJECTION_TOMBSTONES,
  readRejectionTombstones,
  readSessionRecord,
  readWalletReservationRecord,
  REJECTION_TOMBSTONE_TTL_MS,
  rejectionTombstoneKey,
  SESSION_DB_NAME,
  writeRejectionTombstone,
  writeSessionAndWalletReservationRecords,
  writeSessionRecord,
  writeWalletReservationRecord,
} from '../session/indexedDb';
import {
  DIAGNOSTIC_LOG_LIMIT,
  DIAGNOSTIC_LOG_UTF8_BYTE_LIMIT,
  diagnosticLogUtf8Bytes,
  HUMAN_HISTORY_LIMIT,
  WASM_NOTIFICATION_HISTORY_LIMIT,
} from '../session/historyLimits';
import { baseSave } from './session_save_envelope.fixtures';
import {
  WalletReservationLedger,
  walletReservationLedger,
} from '../session/walletReservationLedger';
import {
  decodeWalletReservationLedger,
  decodeWalletReservationRecord,
  WALLET_RESERVATION_RECORD_SCHEMA,
  WALLET_RESERVATION_RECORD_VERSION,
} from '../session/walletReservationLedgerSchema';
import {
  clearTestGlobal,
  makeStorage,
  requireLive,
  sampleSession,
  saveHistory,
  saveLiveFields,
  savePreferences,
  setTestGlobal,
  testIndexedDb,
} from './save.harness';

describe('session persistence', () => {
  it('round-trips the strict wallet reservation record envelope', async () => {
    const entries = [
      {
        tradeId: 'trade-round-trip',
        owner: {
          installationPlayerId: 'installation',
          peerSessionId: 'peer-session',
          providerScope: { provider: 'simulator' as const, identity: 'installation' },
        },
        purpose: { kind: 'funding' as const, operationId: 'funding-operation' },
        stage: 'reserved' as const,
        reason: 'wallet-offer-created',
      },
    ];

    await writeWalletReservationRecord(entries);

    expect(await readWalletReservationRecord()).toEqual({
      schema: WALLET_RESERVATION_RECORD_SCHEMA,
      version: WALLET_RESERVATION_RECORD_VERSION,
      entries,
    });
  });

  it('orders ledger-only writes after an already-requested combined checkpoint', async () => {
    const session = baseSave({ playerId: 'ordered-session' });
    const retained = [
      {
        tradeId: 'trade-ordered',
        owner: {
          installationPlayerId: 'installation',
          peerSessionId: 'peer-session',
          providerScope: { provider: 'simulator' as const, identity: 'installation' },
        },
        purpose: { kind: 'fee' as const, operationId: 'submission-ordered' },
        stage: 'retained-for-replay' as const,
        reason: 'fee-source-attached',
      },
    ];

    const combined = writeSessionAndWalletReservationRecords(session, retained);
    const laterCleanup = writeWalletReservationRecord([]);
    await Promise.all([combined, laterCleanup]);

    expect(await readSessionRecord()).toEqual(session);
    expect((await readWalletReservationRecord())?.entries).toEqual([]);
  });

  it.each([
    [
      'wrong schema',
      {
        schema: 'wrong-wallet-schema',
        version: WALLET_RESERVATION_RECORD_VERSION,
        entries: [],
      },
    ],
    [
      'v3 predecessor',
      {
        schema: WALLET_RESERVATION_RECORD_SCHEMA,
        version: 3n,
        entries: [],
      },
    ],
    [
      'wrong version',
      {
        schema: WALLET_RESERVATION_RECORD_SCHEMA,
        version: WALLET_RESERVATION_RECORD_VERSION + 1n,
        entries: [],
      },
    ],
    [
      'unknown root field',
      {
        schema: WALLET_RESERVATION_RECORD_SCHEMA,
        version: WALLET_RESERVATION_RECORD_VERSION,
        entries: [],
        unknown: true,
      },
    ],
    ['old bare array', []],
  ])('rejects a wallet reservation record with %s', (_label, record) => {
    expect(() => decodeWalletReservationRecord(record)).toThrow();
  });

  it('does not hydrate a persisted bare ledger array', () => {
    expect(() => new WalletReservationLedger().hydrateFromDisk([])).toThrow(
      'Garbled wallet reservation record',
    );
  });

  it('reports malformed ledger boot hydration and leaves the record on disk', async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(SESSION_DB_NAME);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('wallet-reservations', 'readwrite');
      transaction.objectStore('wallet-reservations').put({ malformed: true }, 'current');
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    db.close();

    _resetForTests();
    const hydration = await hydrateSessionCacheFromDisk();
    expect(hydration).toEqual({
      status: 'failed',
      error: 'Stored wallet reservation ledger is malformed',
    });

    const verifyDb = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(SESSION_DB_NAME);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const stored = await new Promise<unknown>((resolve, reject) => {
      const transaction = verifyDb.transaction('wallet-reservations', 'readonly');
      const request = transaction.objectStore('wallet-reservations').get('current');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    verifyDb.close();
    expect(stored).toEqual({ malformed: true });
  });

  it('rejects more than one creating entry for the same wallet operation', () => {
    const operation = {
      owner: {
        installationPlayerId: 'installation',
        peerSessionId: 'peer-session',
        providerScope: { provider: 'simulator' as const, identity: 'installation' },
      },
      purpose: { kind: 'funding' as const, operationId: 'funding-operation' },
    };
    expect(() =>
      decodeWalletReservationLedger([
        {
          ...operation,
          stage: 'creating',
          recoveryId: 'SignatureRequest_first',
          request: { kind: 'funding', uniqueId: 'installation', offer: { '1': -1n } },
          reason: 'pending',
        },
        {
          ...operation,
          stage: 'creating',
          recoveryId: 'SignatureRequest_second',
          request: { kind: 'funding', uniqueId: 'installation', offer: { '1': -1n } },
          reason: 'pending',
        },
      ]),
    ).toThrow(/contradictory.*operation ownership/i);
  });

  it.each([
    ['creation first', true],
    ['trade first', false],
  ])('rejects creating and trade ownership for one operation with %s', (_label, creatingFirst) => {
    const operation = {
      owner: {
        installationPlayerId: 'installation',
        peerSessionId: 'peer-session',
        providerScope: { provider: 'simulator' as const, identity: 'installation' },
      },
      purpose: { kind: 'fee' as const, operationId: 'submission' },
    };
    const creating = {
      ...operation,
      stage: 'creating' as const,
      recoveryId: 'SignatureRequest_pending',
      request: {
        kind: 'fee' as const,
        uniqueId: 'installation',
        fee: 1n,
        concurrentSpendCoinId: 'ab'.repeat(32),
      },
      reason: 'pending',
    };
    const trade = {
      ...operation,
      stage: 'reserved' as const,
      tradeId: 'trade-existing',
      reason: 'created',
    };

    expect(() =>
      decodeWalletReservationLedger(creatingFirst ? [creating, trade] : [trade, creating]),
    ).toThrow(/contradictory.*operation ownership/i);
  });

  it('allows multiple distinct trade entries for one wallet operation', () => {
    const operation = {
      owner: {
        installationPlayerId: 'installation',
        peerSessionId: 'peer-session',
        providerScope: { provider: 'simulator' as const, identity: 'installation' },
      },
      purpose: { kind: 'fee' as const, operationId: 'submission' },
    };
    expect(
      decodeWalletReservationLedger([
        {
          ...operation,
          stage: 'reserved',
          tradeId: 'trade-first',
          reason: 'created',
        },
        {
          ...operation,
          stage: 'retained-for-replay',
          tradeId: 'trade-second',
          reason: 'attached',
        },
      ]),
    ).toHaveLength(2);
  });

  it('obfuscates and round-trips one raw binary/bigint record through IndexedDB', async () => {
    saveLiveFields({
      ...sampleSession,
    });
    await flushSessionSave();

    const stored = await new Promise<{ count: number; record: unknown }>((resolve, reject) => {
      const open = indexedDB.open(SESSION_DB_NAME);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction('session', 'readonly');
        const store = tx.objectStore('session');
        const count = store.count();
        const record = store.get('current');
        tx.onerror = () => reject(tx.error);
        tx.oncomplete = () => {
          db.close();
          resolve({
            count: count.result,
            record: record.result,
          });
        };
      };
    });

    expect(stored.count).toBe(1);
    expect(stored.record).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(stored.record as Uint8Array)).not.toContain(
      'serializedGameSession',
    );

    _resetForTests();
    const loaded = await peekSession();
    expect(loaded).toMatchObject({ phase: 'live' });
    expect(loaded?.phase === 'live' && loaded.live.serializedGameSession).toBeInstanceOf(
      Uint8Array,
    );
    expect(loaded?.phase === 'live' && loaded.live.unackedMessages[0].msg).toBeInstanceOf(
      Uint8Array,
    );
    expect(typeof (loaded?.phase === 'live' && loaded.live.messageNumber)).toBe('bigint');
    expect(loaded?.history.humanHistory).toEqual(['human1']);
    expect(loaded).not.toHaveProperty('log');
  });

  it('bounds rejection tombstones without replacing the active session record', async () => {
    saveLiveFields();
    await flushSessionSave();
    await Promise.all(
      Array.from({ length: MAX_DURABLE_REJECTION_TOMBSTONES + 1 }, (_, index) =>
        writeRejectionTombstone({
          kind: 'outbound-reject',
          peerId: `peer-${index}`,
          sessionId: index.toString(16).padStart(32, '0'),
          messageNumber: 2n,
          remoteNumber: 1n,
          unackedMessages: [{ msgno: 1n, msg: new Uint8Array([index]) }],
          createdAt: Date.now() + index,
        }),
      ),
    );

    const tombstones = await readRejectionTombstones();
    expect(tombstones).toHaveLength(MAX_DURABLE_REJECTION_TOMBSTONES);
    expect(tombstones[0].peerId).toBe('peer-1');
    _resetForTests();
    expect(await peekSession()).toMatchObject({ phase: 'live' });
  });

  it('keeps same-session rejection tombstones distinct across peers', async () => {
    const sessionId = 'ab'.repeat(16);
    const routed = new Map([
      [rejectionTombstoneKey('peer-a', sessionId), 'a'],
      [rejectionTombstoneKey('peer-b', sessionId), 'b'],
    ]);
    expect(routed.size).toBe(2);
    await Promise.all(
      ['peer-a', 'peer-b'].map((peerId, index) =>
        writeRejectionTombstone({
          kind: 'outbound-reject',
          peerId,
          sessionId,
          messageNumber: 2n,
          remoteNumber: 1n,
          unackedMessages: [{ msgno: 1n, msg: new Uint8Array([index]) }],
          createdAt: Date.now() + index,
        }),
      ),
    );

    expect(await readRejectionTombstones()).toEqual([
      expect.objectContaining({ peerId: 'peer-a', sessionId }),
      expect.objectContaining({ peerId: 'peer-b', sessionId }),
    ]);
  });

  it('retains empty inbound receipts and expires stale rejection records', async () => {
    const now = Date.now();
    await writeRejectionTombstone({
      kind: 'inbound-receipt',
      peerId: 'expired-peer',
      sessionId: 'cd'.repeat(16),
      messageNumber: 1n,
      remoteNumber: 4n,
      unackedMessages: [],
      createdAt: now - REJECTION_TOMBSTONE_TTL_MS - 1,
    });
    await writeRejectionTombstone({
      kind: 'inbound-receipt',
      peerId: 'current-peer',
      sessionId: 'ef'.repeat(16),
      messageNumber: 1n,
      remoteNumber: 7n,
      unackedMessages: [],
      createdAt: now,
    });

    expect(await readRejectionTombstones()).toEqual([
      expect.objectContaining({
        kind: 'inbound-receipt',
        peerId: 'current-peer',
        remoteNumber: 7n,
        unackedMessages: [],
      }),
    ]);
  });

  it('waits for the ordered mutation tail before publicly reading tombstones', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    _holdNextStorageMutationForTests(held);
    const write = writeRejectionTombstone({
      kind: 'inbound-receipt',
      peerId: 'tail-peer',
      sessionId: 'fa'.repeat(16),
      messageNumber: 1n,
      remoteNumber: 3n,
      unackedMessages: [],
      createdAt: Date.now(),
    });
    let readSettled = false;
    const read = readRejectionTombstones().then((records) => {
      readSettled = true;
      return records;
    });

    await Promise.resolve();
    expect(readSettled).toBe(false);
    release();
    await write;
    expect(await read).toEqual([expect.objectContaining({ peerId: 'tail-peer' })]);
  });

  it('atomically replaces the active session with an inbound rejection receipt', async () => {
    saveLiveFields();
    await flushSessionSave();
    await clearSessionWithInboundRejectionReceipt({
      peerId: 'rejecting-peer',
      sessionId: '12'.repeat(16),
      messageNumber: 1n,
      remoteNumber: 6n,
      unackedMessages: [],
      createdAt: Date.now(),
    });

    _resetForTests();
    expect(await peekSession()).toBeNull();
    expect(await readRejectionTombstones()).toEqual([
      expect.objectContaining({
        kind: 'inbound-receipt',
        peerId: 'rejecting-peer',
        remoteNumber: 6n,
      }),
    ]);
  });

  it('atomically replaces the active session with an outbound rejection tombstone', async () => {
    saveLiveFields();
    await flushSessionSave();
    await clearSessionWithRejectionTombstone({
      kind: 'outbound-reject',
      peerId: 'rejected-peer',
      sessionId: '34'.repeat(16),
      messageNumber: 2n,
      remoteNumber: 1n,
      unackedMessages: [{ msgno: 1n, msg: new Uint8Array([0xaa]) }],
      createdAt: Date.now(),
    });

    _resetForTests();
    expect(await peekSession()).toBeNull();
    expect(await readRejectionTombstones()).toEqual([
      expect.objectContaining({
        kind: 'outbound-reject',
        peerId: 'rejected-peer',
        messageNumber: 2n,
      }),
    ]);
  });

  it('sets the saved-session marker when a resumable record is written', async () => {
    expect(hasSavedSessionMarker()).toBe(false);

    saveLiveFields();
    await flushSessionSave();
    expect(hasSavedSessionMarker()).toBe(true);

    await clearSession();
    expect(hasSavedSessionMarker()).toBe(false);
  });

  it('keeps an explicit pre-game marker across blockchainType preference writes', async () => {
    markSavedSession();
    savePreferences({ blockchainType: 'simulator' });
    await flushSessionSave();

    expect(hasSavedSessionMarker()).toBe(true);
    expect(await peekSession()).toMatchObject({
      preferences: { blockchainType: 'simulator' },
    });
  });

  it('treats leftover blockchainType without a marker as resume-worthy', async () => {
    savePreferences({ blockchainType: 'walletconnect' });
    await flushSessionSave();
    clearSavedSessionMarker();

    expect(shouldOfferResumeOrStartOver()).toBe(true);
    expect(await peekSession()).toMatchObject({
      preferences: { blockchainType: 'walletconnect' },
    });
    expect(hasSavedSessionMarker()).toBe(true);
  });

  it('treats leftover hubUrl without a marker as resume-worthy', async () => {
    savePreferences({ hubUrl: 'http://localhost:3003' });
    await flushSessionSave();
    clearSavedSessionMarker();

    expect(shouldOfferResumeOrStartOver()).toBe(true);
    expect(await peekSession()).toMatchObject({
      preferences: { hubUrl: 'http://localhost:3003' },
    });
    expect(hasSavedSessionMarker()).toBe(true);
  });

  it('shouldOfferResumeOrStartOver is false on a clean slate', () => {
    expect(shouldOfferResumeOrStartOver()).toBe(false);
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
    await flushSessionSave();
    expect(hasSavedSessionMarker()).toBe(true);

    // Simulate marker-only boot: memory has preferences, IndexedDB has the cradle.
    _resetForTests();
    await claimLease();
    expect(hasSavedSessionMarker()).toBe(true);
    expect(loadState()).not.toHaveProperty('live');

    saveHistory({ diagnosticLog: ['boot log'] });
    await flushSessionSave();

    _resetForTests();
    const loaded = requireLive(await peekSession());
    expect(loaded.live.serializedGameSession).toEqual(sampleSession.serializedGameSession);
    expect(loaded.pairing.token).toBe(sampleSession.pairingToken);
    expect(loaded.history.diagnosticLog).toEqual(['boot log']);
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
    await flushSessionSave();

    saveLiveFields({
      ...sampleSession,
      serializedGameSession: second,
      pairingToken: 'tok-v2',
    });
    await flushSessionSave();

    _resetForTests();
    const loaded = requireLive(await peekSession());
    expect(loaded.live.serializedGameSession).toEqual(second);
    expect(loaded.pairing.token).toBe('tok-v2');
  });

  it('returns a pre-game blockchainType record when the boot marker is set', async () => {
    localStorage.setItem('appState_savedSession', '1');
    await writeSessionRecord(baseSave({ playerId: 'player', blockchainType: 'simulator' }));
    expect(await peekSession()).toMatchObject({
      preferences: { blockchainType: 'simulator' },
    });
    expect(hasSavedSessionMarker()).toBe(true);
  });

  it('clears the marker for a present but empty IndexedDB record', async () => {
    localStorage.setItem('appState_savedSession', '1');
    await writeSessionRecord(baseSave({ playerId: 'player' }));
    expect(await peekSession()).toBeNull();
    expect(hasSavedSessionMarker()).toBe(false);
  });

  it('propagates IndexedDB write failure to durability callers', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    clearTestGlobal('indexedDB');
    try {
      const scheduled = saveLiveFields();

      await expect(flushSessionSave()).rejects.toThrow('IndexedDB is unavailable');
      await expect(scheduled).rejects.toThrow('IndexedDB is unavailable');
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      setTestGlobal('indexedDB', testIndexedDb);
    }
  });

  it('atomically checkpoints coordinated session and ledger transitions and heals after abort', async () => {
    const owner = {
      installationPlayerId: 'installation',
      peerSessionId: 'peer-session',
      providerScope: { provider: 'simulator' as const, identity: 'installation' },
    };
    walletReservationLedger.registerReserved(
      'trade-atomic',
      owner,
      { kind: 'fee', operationId: 'submission-atomic' },
      'fee-offer-created',
    );
    saveLiveFields({
      ...sampleSession,
      serializedGameSession: new Uint8Array([1]),
    });
    await flushSessionSave();
    await walletReservationLedger.flushPersistence();

    walletReservationLedger.retainForReplayCoordinated('trade-atomic');
    const scheduled = saveLiveFields({
      ...sampleSession,
      serializedGameSession: new Uint8Array([2]),
    });
    const originalTransaction = IDBDatabase.prototype.transaction;
    const transactionSpy = jest
      .spyOn(IDBDatabase.prototype, 'transaction')
      .mockImplementation(function (
        this: IDBDatabase,
        storeNames: string | string[],
        mode?: IDBTransactionMode,
        options?: IDBTransactionOptions,
      ) {
        const transaction = originalTransaction.call(this, storeNames, mode, options);
        if (
          Array.isArray(storeNames) &&
          storeNames.includes('session') &&
          storeNames.includes('wallet-reservations') &&
          mode === 'readwrite'
        ) {
          queueMicrotask(() => transaction.abort());
        }
        return transaction;
      });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(flushSessionSave()).rejects.toThrow();
    await expect(scheduled).rejects.toThrow();
    transactionSpy.mockRestore();
    errorSpy.mockRestore();

    const afterAbort = requireLive(await readSessionRecord());
    expect(afterAbort.live.serializedGameSession).toEqual(new Uint8Array([1]));
    expect((await readWalletReservationRecord())?.entries).toEqual([
      expect.objectContaining({ tradeId: 'trade-atomic', stage: 'reserved' }),
    ]);
    expect(walletReservationLedger.isDirty()).toBe(true);
    expect(walletReservationLedger.snapshot()).toEqual([
      expect.objectContaining({ tradeId: 'trade-atomic', stage: 'retained-for-replay' }),
    ]);

    const healed = saveLiveFields({
      ...sampleSession,
      serializedGameSession: new Uint8Array([2]),
    });
    await flushSessionSave();
    await healed;

    const afterHeal = requireLive(await readSessionRecord());
    expect(afterHeal.live.serializedGameSession).toEqual(new Uint8Array([2]));
    expect((await readWalletReservationRecord())?.entries).toEqual([
      expect.objectContaining({ tradeId: 'trade-atomic', stage: 'retained-for-replay' }),
    ]);
    expect(walletReservationLedger.isDirty()).toBe(false);

    _resetForTests();
    const restored = requireLive(await peekSession());
    expect(restored.live.serializedGameSession).toEqual(new Uint8Array([2]));
    expect(walletReservationLedger.snapshot()).toEqual([
      expect.objectContaining({ tradeId: 'trade-atomic', stage: 'retained-for-replay' }),
    ]);
  });

  it('keeps serialized session bytes out of localStorage', async () => {
    saveLiveFields();
    await flushSessionSave();

    expect(localStorage.getItem('appState')).toBeNull();
    const localValues = Array.from({ length: localStorage.length }, (_, i) =>
      localStorage.getItem(localStorage.key(i)!),
    ).join('\n');
    expect(localValues).not.toMatch(
      /serializedGameSession|unackedMessages|\$bytes|000102ff|AAEC\/w==/,
    );
  });

  it('leaves obsolete monolithic localStorage state untouched', () => {
    _resetForTests();
    localStorage.setItem('appState', '{"obsolete":true}');

    loadState();

    expect(localStorage.getItem('appState')).toBe('{"obsolete":true}');
  });

  it('persists only the configured recent history entries', async () => {
    saveLiveFields({
      ...sampleSession,
      humanHistory: Array.from({ length: HUMAN_HISTORY_LIMIT + 2 }, (_, i) => `human-${i}`),
      wasmNotificationHistory: Array.from(
        { length: WASM_NOTIFICATION_HISTORY_LIMIT + 2 },
        (_, i) => `wasm-${i}`,
      ),
      diagnosticLog: Array.from({ length: DIAGNOSTIC_LOG_LIMIT + 2 }, (_, i) => `diag-${i}`),
    });
    await flushSessionSave();
    _resetForTests();

    const loaded = requireLive(await peekSession());
    expect(loaded.history.humanHistory).toHaveLength(HUMAN_HISTORY_LIMIT);
    expect(loaded.history.humanHistory?.[0]).toBe('human-2');
    expect(loaded.history.wasmNotificationHistory).toHaveLength(WASM_NOTIFICATION_HISTORY_LIMIT);
    expect(loaded.history.wasmNotificationHistory?.[0]).toBe('wasm-2');
    expect(loaded.history.diagnosticLog).toHaveLength(DIAGNOSTIC_LOG_LIMIT);
    expect(loaded.history.diagnosticLog?.[0]).toBe('diag-2');
  });

  it('round-trips only newest complete diagnostics within the UTF-8 byte budget', async () => {
    const older = `older:${'😀'.repeat(40_000)}`;
    const newer = `newer:${'界'.repeat(60_000)}`;
    saveLiveFields({
      ...sampleSession,
      diagnosticLog: [older, newer],
    });
    await flushSessionSave();
    _resetForTests();

    const loaded = requireLive(await peekSession());
    expect(loaded.history.diagnosticLog).toEqual([newer]);
    expect(diagnosticLogUtf8Bytes(loaded.history.diagnosticLog ?? [])).toBeLessThanOrEqual(
      DIAGNOSTIC_LOG_UTF8_BYTE_LIMIT,
    );
  });

  it('returns null when nothing is saved', async () => {
    expect(await peekSession()).toBeNull();
  });

  it('clearSession asynchronously deletes resumable state', async () => {
    saveLiveFields();
    await flushSessionSave();
    await clearSession();
    _resetForTests();
    expect(await peekSession()).toBeNull();
  });

  it('orders clearSession before an immediate unawaited replacement save', async () => {
    saveLiveFields({
      ...sampleSession,
      serializedGameSession: new Uint8Array([1]),
    });
    await flushSessionSave();

    const cleared = clearSession();
    const saved = saveLiveFields({
      ...sampleSession,
      serializedGameSession: new Uint8Array([2]),
      pairingToken: 'replacement-after-clear',
    });
    const flushed = flushSessionSave();
    await Promise.all([cleared, saved, flushed]);

    const persisted = requireLive(await readSessionRecord());
    expect(persisted.live.serializedGameSession).toEqual(new Uint8Array([2]));
    expect(persisted.pairing.token).toBe('replacement-after-clear');
  });

  it('does not let an old lease generation overwrite the winning ledger', async () => {
    await claimLease();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    _holdNextStorageMutationForTests(held);
    const oldWrite = writeWalletReservationRecord([
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

    await reclaimLease();
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
    const winningWrite = writeWalletReservationRecord([winningEntry]);
    release();
    await Promise.all([oldWrite, winningWrite]);

    expect((await readWalletReservationRecord())?.entries).toEqual([winningEntry]);
  });

  it('serializes a takeover requested after authorization before the winning write', async () => {
    await claimLease();
    let takeover: Promise<unknown> | undefined;
    _afterNextStorageAuthorityCheckForTests(() => {
      takeover = reclaimLease();
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

    await writeWalletReservationRecord([authorizedEntry]);
    expect(takeover).toBeDefined();
    await takeover;

    const winningEntry = {
      ...authorizedEntry,
      tradeId: 'winning-after-takeover',
      owner: { ...authorizedEntry.owner, peerSessionId: 'winning-peer' },
      purpose: { kind: 'funding' as const, operationId: 'winning-operation' },
      reason: 'winning-generation',
    };
    await writeWalletReservationRecord([winningEntry]);

    expect((await readWalletReservationRecord())?.entries).toEqual([winningEntry]);
  });

  it('clearSession deletes the session while preserving the independent ledger', async () => {
    walletReservationLedger.registerReserved(
      'trade-clear',
      {
        installationPlayerId: 'installation',
        peerSessionId: 'peer-session',
        providerScope: { provider: 'simulator' as const, identity: 'installation' },
      },
      { kind: 'funding', operationId: 'funding-operation' },
    );
    await walletReservationLedger.flushPersistence();
    await clearSession();
    _resetForTests();

    await peekSession();
    expect(walletReservationLedger.snapshot()).toEqual([
      expect.objectContaining({
        tradeId: 'trade-clear',
        stage: 'cancel-required',
        reason: 'orphaned-reservation-restored',
      }),
    ]);
  });

  it('hydrates the independent ledger without a session record or marker', async () => {
    _resetForTests();
    await writeWalletReservationRecord([
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
    ]);
    clearSavedSessionMarker();

    expect(await peekSession()).toBeNull();
    expect(walletReservationLedger.snapshot()).toEqual([
      expect.objectContaining({
        tradeId: 'trade-independent',
        stage: 'cancel-required',
        reason: 'orphaned-reservation-restored',
      }),
    ]);
  });

  it('restores retained fee sources without promoting them to cancellation', async () => {
    _resetForTests();
    await writeWalletReservationRecord([
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
    ]);

    await peekSession();

    expect(walletReservationLedger.snapshot()).toEqual([
      expect.objectContaining({
        tradeId: 'trade-retained',
        stage: 'retained-for-replay',
        reason: 'fee-source-attached',
      }),
    ]);
  });

  it.each(['session deletion', 'rejection tombstone'])(
    '%s preserves the ledger store',
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
      await writeWalletReservationRecord([entry]);
      saveLiveFields();
      await flushSessionSave();
      if (kind === 'session deletion') {
        await clearSession();
      } else {
        await clearSessionWithRejectionTombstone({
          kind: 'outbound-reject',
          peerId: 'peer',
          sessionId: '0'.repeat(32),
          messageNumber: 2n,
          remoteNumber: 1n,
          unackedMessages: [],
          createdAt: Date.now(),
        });
      }
      expect((await readWalletReservationRecord())?.entries).toEqual([entry]);
    },
  );

  it('saveSession preserves blockchainType', async () => {
    saveLiveFields({ ...sampleSession, blockchainType: 'walletconnect' });
    await flushSessionSave();
    expect((await peekSession())?.preferences.blockchainType).toBe('walletconnect');
  });

  it('saveSession swallows quota-exceeded errors', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const storage = makeStorage();
    const origSetItem = storage.setItem.bind(storage);
    let firstCall = true;
    storage.setItem = (key: string, value: string) => {
      if (!firstCall) throw new DOMException('quota exceeded');
      firstCall = false;
      origSetItem(key, value);
    };
    setTestGlobal('localStorage', storage);
    getPlayerId();
    expect(() => saveLiveFields()).not.toThrow();
    spy.mockRestore();
  });
});
