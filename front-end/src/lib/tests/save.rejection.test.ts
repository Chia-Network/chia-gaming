import { storageRepository } from '../session/storageRepository';
import {
  MAX_DURABLE_REJECTION_TOMBSTONES,
  REJECTION_TOMBSTONE_TTL_MS,
  rejectionTombstoneKey,
  SESSION_DB_NAME,
} from '../session/indexedDb';
import { saveLiveFields } from './save.harness';

describe('session persistence: rejection', () => {
  it('bounds rejection tombstones without replacing the active session record', async () => {
    saveLiveFields();
    await storageRepository.flushSessionSave();
    await Promise.all(
      Array.from({ length: MAX_DURABLE_REJECTION_TOMBSTONES + 1 }, (_, index) =>
        storageRepository.writeRejection({
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

    const tombstones = await storageRepository.readRejections();
    expect(tombstones).toHaveLength(MAX_DURABLE_REJECTION_TOMBSTONES);
    expect(tombstones[0].peerId).toBe('peer-1');
    storageRepository._resetForTests();
    expect(await storageRepository.peekSession()).toMatchObject({ phase: 'live' });
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
        storageRepository.writeRejection({
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

    expect(await storageRepository.readRejections()).toEqual([
      expect.objectContaining({ peerId: 'peer-a', sessionId }),
      expect.objectContaining({ peerId: 'peer-b', sessionId }),
    ]);
  });

  it('retains empty inbound receipts and expires stale rejection records', async () => {
    const now = Date.now();
    await storageRepository.writeRejection({
      kind: 'inbound-receipt',
      peerId: 'expired-peer',
      sessionId: 'cd'.repeat(16),
      messageNumber: 1n,
      remoteNumber: 4n,
      unackedMessages: [],
      createdAt: now - REJECTION_TOMBSTONE_TTL_MS - 1,
    });
    await storageRepository.writeRejection({
      kind: 'inbound-receipt',
      peerId: 'current-peer',
      sessionId: 'ef'.repeat(16),
      messageNumber: 1n,
      remoteNumber: 7n,
      unackedMessages: [],
      createdAt: now,
    });

    const transactionSpy = jest.spyOn(IDBDatabase.prototype, 'transaction');
    expect(await storageRepository.readRejections()).toEqual([
      expect.objectContaining({
        kind: 'inbound-receipt',
        peerId: 'current-peer',
        remoteNumber: 7n,
        unackedMessages: [],
      }),
    ]);
    expect(transactionSpy).toHaveBeenCalledWith('rejections', 'readonly');
    transactionSpy.mockRestore();
    const countRecords = async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(SESSION_DB_NAME);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        return await new Promise<number>((resolve, reject) => {
          const transaction = db.transaction('rejections', 'readonly');
          const request = transaction.objectStore('rejections').count();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      } finally {
        db.close();
      }
    };
    expect(await countRecords()).toBe(1);
    expect(await countRecords()).toBe(1);
  });

  it('claims with mixed rejection records and prunes only malformed or expired entries', async () => {
    const now = Date.now();
    await storageRepository.writeRejection({
      kind: 'inbound-receipt',
      peerId: 'valid-peer',
      sessionId: '11'.repeat(16),
      messageNumber: 1n,
      remoteNumber: 3n,
      unackedMessages: [],
      createdAt: now,
    });
    await storageRepository.writeRejection({
      kind: 'inbound-receipt',
      peerId: 'expired-peer',
      sessionId: '22'.repeat(16),
      messageNumber: 1n,
      remoteNumber: 4n,
      unackedMessages: [],
      createdAt: now - REJECTION_TOMBSTONE_TTL_MS - 1,
    });
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(SESSION_DB_NAME);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('rejections', 'readwrite');
      transaction.objectStore('rejections').put(new Uint8Array([1, 2, 3]), 'malformed');
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();

    storageRepository._resetForTests();
    const claimed = await storageRepository.claimAndRead('claiming-tab');
    expect(claimed.rejectionTombstones).toEqual([
      expect.objectContaining({ peerId: 'valid-peer', sessionId: '11'.repeat(16) }),
    ]);
    expect(await storageRepository.readRejections()).toEqual(claimed.rejectionTombstones);

    const reopened = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(SESSION_DB_NAME);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
      const transaction = reopened.transaction('rejections', 'readonly');
      const request = transaction.objectStore('rejections').getAllKeys();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    reopened.close();
    expect(keys).toEqual([rejectionTombstoneKey('valid-peer', '11'.repeat(16))]);
  });

  it('waits for the ordered mutation tail before publicly reading tombstones', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    storageRepository.holdNextMutationForTests(held);
    const write = storageRepository.writeRejection({
      kind: 'inbound-receipt',
      peerId: 'tail-peer',
      sessionId: 'fa'.repeat(16),
      messageNumber: 1n,
      remoteNumber: 3n,
      unackedMessages: [],
      createdAt: Date.now(),
    });
    let readSettled = false;
    const read = storageRepository.readRejections().then((records) => {
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
    await storageRepository.flushSessionSave();
    await storageRepository.replaceSessionWithRejection({
      kind: 'inbound-receipt',
      peerId: 'rejecting-peer',
      sessionId: '12'.repeat(16),
      messageNumber: 1n,
      remoteNumber: 6n,
      unackedMessages: [],
      createdAt: Date.now(),
    });

    storageRepository._resetForTests();
    expect(await storageRepository.peekSession()).toBeNull();
    expect(await storageRepository.readRejections()).toEqual([
      expect.objectContaining({
        kind: 'inbound-receipt',
        peerId: 'rejecting-peer',
        remoteNumber: 6n,
      }),
    ]);
  });

  it('atomically replaces the active session with an outbound rejection tombstone', async () => {
    saveLiveFields();
    await storageRepository.flushSessionSave();
    await storageRepository.replaceSessionWithRejection({
      kind: 'outbound-reject',
      peerId: 'rejected-peer',
      sessionId: '34'.repeat(16),
      messageNumber: 2n,
      remoteNumber: 1n,
      unackedMessages: [{ msgno: 1n, msg: new Uint8Array([0xaa]) }],
      createdAt: Date.now(),
    });

    storageRepository._resetForTests();
    expect(await storageRepository.peekSession()).toBeNull();
    expect(await storageRepository.readRejections()).toEqual([
      expect.objectContaining({
        kind: 'outbound-reject',
        peerId: 'rejected-peer',
        messageNumber: 2n,
      }),
    ]);
  });
});
