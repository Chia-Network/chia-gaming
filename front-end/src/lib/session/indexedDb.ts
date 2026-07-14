import type { SessionState } from '../../hooks/save';

export const SESSION_DB_NAME = 'chia-gaming-session';
const SESSION_DB_VERSION = 1;
const SESSION_STORE_NAME = 'session';
const SESSION_RECORD_KEY = 'current';

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(SESSION_DB_NAME, SESSION_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (db.objectStoreNames.contains(SESSION_STORE_NAME)) {
        db.deleteObjectStore(SESSION_STORE_NAME);
      }
      db.createObjectStore(SESSION_STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Failed to open session database'));
    request.onblocked = () => reject(new Error('Session database open was blocked'));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('Session transaction aborted'));
    transaction.onerror = () => reject(transaction.error ?? new Error('Session transaction failed'));
  });
}

function deleteDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(SESSION_DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('Failed to delete stale session database'));
    request.onblocked = () => reject(new Error('Stale session database deletion was blocked'));
  });
}

export async function readSessionRecord(): Promise<SessionState | null> {
  if (typeof indexedDB === 'undefined') return null;
  let db: IDBDatabase;
  try {
    db = await openDatabase();
  } catch (error) {
    if (error instanceof DOMException && error.name === 'VersionError') {
      await deleteDatabase();
      return null;
    }
    throw error;
  }
  try {
    const transaction = db.transaction(SESSION_STORE_NAME, 'readonly');
    const request = transaction.objectStore(SESSION_STORE_NAME).get(SESSION_RECORD_KEY);
    const record = await new Promise<unknown>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Failed to read session record'));
    });
    await transactionComplete(transaction);
    return record && typeof record === 'object' ? record as SessionState : null;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') {
      db.close();
      await deleteDatabase();
      return null;
    }
    throw error;
  } finally {
    db.close();
  }
}

export async function writeSessionRecord(record: SessionState): Promise<void> {
  if (typeof indexedDB === 'undefined') {
    throw new Error('IndexedDB is unavailable; refusing to send without durable session storage');
  }
  const db = await openDatabase();
  try {
    const transaction = db.transaction(SESSION_STORE_NAME, 'readwrite');
    transaction.objectStore(SESSION_STORE_NAME).put(record, SESSION_RECORD_KEY);
    await transactionComplete(transaction);
  } finally {
    db.close();
  }
}

export async function deleteSessionRecord(): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  const db = await openDatabase();
  try {
    const transaction = db.transaction(SESSION_STORE_NAME, 'readwrite');
    transaction.objectStore(SESSION_STORE_NAME).delete(SESSION_RECORD_KEY);
    await transactionComplete(transaction);
  } finally {
    db.close();
  }
}
