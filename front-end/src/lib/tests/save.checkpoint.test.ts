import { storageRepository } from '../session/storageRepository';
import {
  readSessionRecord,
  readWalletOperationRecord,
  SESSION_DB_NAME,
} from '../session/indexedDb';
import {
  DIAGNOSTIC_LOG_LIMIT,
  DIAGNOSTIC_LOG_UTF8_BYTE_LIMIT,
  diagnosticLogUtf8Bytes,
  HUMAN_HISTORY_LIMIT,
  WASM_NOTIFICATION_HISTORY_LIMIT,
} from '../session/historyLimits';
import { baseSave } from './session_save_envelope.fixtures';
import { walletOperationRuntime } from '../session/walletOperationRuntime';
import {
  decodeWalletOperationEntries,
  decodeWalletOperationRecord,
  WALLET_OPERATION_RECORD_SCHEMA,
  WALLET_OPERATION_RECORD_VERSION,
} from '../session/walletOperationCodec';
import {
  clearTestGlobal,
  requireLive,
  sampleSession,
  saveLiveFields,
  setTestGlobal,
  testIndexedDb,
} from './save.harness';

describe('session persistence: checkpoint', () => {
  it('round-trips the strict wallet operation record envelope', async () => {
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

    await storageRepository.persist(
      storageRepository.mutateRecords('write-wallet-operations', entries),
    );

    expect(await readWalletOperationRecord()).toEqual({
      schema: WALLET_OPERATION_RECORD_SCHEMA,
      version: WALLET_OPERATION_RECORD_VERSION,
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

    const combined = storageRepository.persist(storageRepository.checkpoint(session, retained));
    const laterCleanup = storageRepository.persist(
      storageRepository.mutateRecords('write-wallet-operations', []),
    );
    await Promise.all([combined, laterCleanup]);

    expect(await readSessionRecord()).toEqual(session);
    expect((await readWalletOperationRecord())?.entries).toEqual([]);
  });

  it.each([
    [
      'wrong schema',
      {
        schema: 'wrong-wallet-schema',
        version: WALLET_OPERATION_RECORD_VERSION,
        entries: [],
      },
    ],
    [
      'v3 predecessor',
      {
        schema: WALLET_OPERATION_RECORD_SCHEMA,
        version: 3n,
        entries: [],
      },
    ],
    [
      'v4 predecessor',
      {
        schema: WALLET_OPERATION_RECORD_SCHEMA,
        version: 4n,
        entries: [],
      },
    ],
    [
      'wrong version',
      {
        schema: WALLET_OPERATION_RECORD_SCHEMA,
        version: WALLET_OPERATION_RECORD_VERSION + 1n,
        entries: [],
      },
    ],
    [
      'unknown root field',
      {
        schema: WALLET_OPERATION_RECORD_SCHEMA,
        version: WALLET_OPERATION_RECORD_VERSION,
        entries: [],
        unknown: true,
      },
    ],
    ['old bare array', []],
  ])('rejects a wallet operation record with %s', (_label, record) => {
    expect(() => decodeWalletOperationRecord(record)).toThrow();
  });

  it.each([
    [
      'uppercase funding coin id',
      {
        kind: 'funding',
        canonical: {
          amount: '1',
          fee: '0',
          conditions: [],
          coin_id: 'AB'.repeat(32),
        },
      },
    ],
    [
      'prefixed fee target id',
      {
        kind: 'fee',
        uniqueId: 'installation',
        fee: 1n,
        concurrentSpendCoinId: `0x${'ab'.repeat(32)}`,
      },
    ],
  ])('rejects a creating recovery with %s', (_label, request) => {
    expect(() =>
      decodeWalletOperationEntries([
        {
          owner: {
            installationPlayerId: 'installation',
            peerSessionId: 'peer-session',
            providerScope: { provider: 'simulator', identity: 'installation' },
          },
          purpose: { kind: request.kind, operationId: 'operation' },
          stage: 'creating',
          disposition: 'active',
          recoveryId: 'recovery',
          request,
          reason: 'pending',
        },
      ]),
    ).toThrow();
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
      decodeWalletOperationEntries([
        {
          ...operation,
          stage: 'creating',
          disposition: 'active',
          recoveryId: 'SignatureRequest_first',
          request: {
            kind: 'funding',
            canonical: { amount: '1', fee: '0', conditions: [] },
          },
          reason: 'pending',
        },
        {
          ...operation,
          stage: 'creating',
          disposition: 'active',
          recoveryId: 'SignatureRequest_second',
          request: {
            kind: 'funding',
            canonical: { amount: '1', fee: '0', conditions: [] },
          },
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
      disposition: 'active' as const,
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
      decodeWalletOperationEntries(creatingFirst ? [creating, trade] : [trade, creating]),
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
      decodeWalletOperationEntries([
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
    await storageRepository.flushSessionSave();

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

    storageRepository._resetForTests();
    const loaded = await storageRepository.peekSession();
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

  it('propagates IndexedDB write failure to durability callers', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    clearTestGlobal('indexedDB');
    try {
      const scheduled = saveLiveFields();

      await expect(storageRepository.flushSessionSave()).rejects.toThrow(
        'IndexedDB is unavailable',
      );
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
    walletOperationRuntime.registerReserved(
      'trade-atomic',
      owner,
      { kind: 'fee', operationId: 'submission-atomic' },
      'fee-offer-created',
    );
    saveLiveFields({
      ...sampleSession,
      serializedGameSession: new Uint8Array([1]),
    });
    await storageRepository.flushSessionSave();
    await walletOperationRuntime.flushPersistence();

    walletOperationRuntime.settleOperation(
      owner,
      { kind: 'fee', operationId: 'submission-atomic' },
      'retained-for-replay',
      'fee-source-attached',
      true,
    );
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

    await expect(storageRepository.flushSessionSave()).rejects.toThrow();
    await expect(scheduled).rejects.toThrow();
    transactionSpy.mockRestore();
    errorSpy.mockRestore();

    const afterAbort = requireLive(await readSessionRecord());
    expect(afterAbort.live.serializedGameSession).toEqual(new Uint8Array([1]));
    expect((await readWalletOperationRecord())?.entries).toEqual([
      expect.objectContaining({ tradeId: 'trade-atomic', stage: 'reserved' }),
    ]);
    expect(walletOperationRuntime.isDirty()).toBe(true);
    expect(walletOperationRuntime.snapshot()).toEqual([
      expect.objectContaining({ tradeId: 'trade-atomic', stage: 'retained-for-replay' }),
    ]);

    const healed = saveLiveFields({
      ...sampleSession,
      serializedGameSession: new Uint8Array([2]),
    });
    await storageRepository.flushSessionSave();
    await healed;

    const afterHeal = requireLive(await readSessionRecord());
    expect(afterHeal.live.serializedGameSession).toEqual(new Uint8Array([2]));
    expect((await readWalletOperationRecord())?.entries).toEqual([
      expect.objectContaining({ tradeId: 'trade-atomic', stage: 'retained-for-replay' }),
    ]);
    expect(walletOperationRuntime.isDirty()).toBe(false);

    storageRepository._resetForTests();
    const restored = requireLive(await storageRepository.claimAndHydrateSession());
    expect(restored.live.serializedGameSession).toEqual(new Uint8Array([2]));
    expect(walletOperationRuntime.snapshot()).toEqual([
      expect.objectContaining({ tradeId: 'trade-atomic', stage: 'retained-for-replay' }),
    ]);
  });

  it('keeps serialized session bytes out of localStorage', async () => {
    saveLiveFields();
    await storageRepository.flushSessionSave();

    expect(localStorage.getItem('appState')).toBeNull();
    const localValues = Array.from({ length: localStorage.length }, (_, i) =>
      localStorage.getItem(localStorage.key(i)!),
    ).join('\n');
    expect(localValues).not.toMatch(
      /serializedGameSession|unackedMessages|\$bytes|000102ff|AAEC\/w==/,
    );
  });

  it('leaves obsolete monolithic localStorage state untouched', () => {
    storageRepository._resetForTests();
    localStorage.setItem('appState', '{"obsolete":true}');

    storageRepository.loadState();

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
    await storageRepository.flushSessionSave();
    storageRepository._resetForTests();

    const loaded = requireLive(await storageRepository.peekSession());
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
    await storageRepository.flushSessionSave();
    storageRepository._resetForTests();

    const loaded = requireLive(await storageRepository.peekSession());
    expect(loaded.history.diagnosticLog).toEqual([newer]);
    expect(diagnosticLogUtf8Bytes(loaded.history.diagnosticLog ?? [])).toBeLessThanOrEqual(
      DIAGNOSTIC_LOG_UTF8_BYTE_LIMIT,
    );
  });
});
