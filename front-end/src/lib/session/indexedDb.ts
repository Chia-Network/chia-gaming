import type { SessionSave } from './saveEnvelope';
import { decode, encode, type BencodexValue } from 'chia-gaming-bencodex';

export const SESSION_DB_NAME = 'chia-gaming-session';
const SESSION_DB_VERSION = 2;
const SESSION_STORE_NAME = 'session';
const SESSION_RECORD_KEY = 'current';
const REJECTION_STORE_NAME = 'rejections';
export const MAX_DURABLE_REJECTION_TOMBSTONES = 8;
export const REJECTION_TOMBSTONE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
let rejectionWriteQueue: Promise<void> = Promise.resolve();
const OBFUSCATION_KEY = new Uint8Array([
  0x4a, 0x7f, 0x2c, 0x91, 0xd3, 0x56, 0xe8, 0x1b, 0xa0, 0x63, 0xf5, 0x38, 0xc4, 0x87, 0x0e, 0x6d,
]);
const SALT_LEN = 16;
const ARRAY_BUFFER_TAG = '\0arrayBuffer';
const NUMBER_TAG = '\0number';

export class InvalidSessionRecordError extends Error {
  constructor(cause: unknown) {
    super('Stored session record is malformed', { cause });
    this.name = 'InvalidSessionRecordError';
  }
}

function rc4Keystream(key: Uint8Array, length: number): Uint8Array {
  const state = new Uint8Array(256);
  for (let i = 0; i < state.length; i++) state[i] = i;
  let j = 0;
  for (let i = 0; i < state.length; i++) {
    j = (j + state[i] + key[i % key.length]) & 0xff;
    [state[i], state[j]] = [state[j], state[i]];
  }
  const stream = new Uint8Array(length);
  let i = 0;
  j = 0;
  for (let offset = 0; offset < length; offset++) {
    i = (i + 1) & 0xff;
    j = (j + state[i]) & 0xff;
    [state[i], state[j]] = [state[j], state[i]];
    stream[offset] = state[(state[i] + state[j]) & 0xff];
  }
  return stream;
}

function toBencodexValue(value: unknown): BencodexValue {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'bigint' ||
    typeof value === 'string' ||
    value instanceof Uint8Array
  ) {
    return value;
  }
  if (typeof value === 'number') {
    return { [NUMBER_TAG]: String(value) };
  }
  if (value instanceof ArrayBuffer) {
    return { [ARRAY_BUFFER_TAG]: new Uint8Array(value) };
  }
  if (Array.isArray(value)) {
    return value.map(toBencodexValue);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, entry]) =>
        entry === undefined ? [] : [[key, toBencodexValue(entry)]],
      ),
    );
  }
  throw new Error(`Cannot encode session value of type ${typeof value}`);
}

function fromBencodexValue(value: BencodexValue): unknown {
  if (value instanceof Map) {
    if (value.size === 1 && value.has(NUMBER_TAG)) {
      const number = value.get(NUMBER_TAG);
      if (typeof number !== 'string') {
        throw new Error('Session record has an invalid number tag');
      }
      return Number(number);
    }
    if (value.size === 1 && value.has(ARRAY_BUFFER_TAG)) {
      const bytes = value.get(ARRAY_BUFFER_TAG);
      if (!(bytes instanceof Uint8Array)) {
        throw new Error('Session record has an invalid ArrayBuffer tag');
      }
      return bytes.buffer;
    }
    return Object.fromEntries(
      [...value.entries()].map(([key, entry]) => {
        if (typeof key !== 'string') {
          throw new Error('Session record contains a non-text key');
        }
        return [key, fromBencodexValue(entry)];
      }),
    );
  }
  if (Array.isArray(value)) {
    return value.map(fromBencodexValue);
  }
  return value;
}

function obfuscateRecord(record: unknown): Uint8Array {
  const plaintext = encode(toBencodexValue(record));
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const key = new Uint8Array(SALT_LEN + OBFUSCATION_KEY.length);
  key.set(salt);
  key.set(OBFUSCATION_KEY, SALT_LEN);
  const stream = rc4Keystream(key, plaintext.length);
  const masked = new Uint8Array(SALT_LEN + plaintext.length);
  masked.set(salt);
  for (let i = 0; i < plaintext.length; i++) {
    masked[SALT_LEN + i] = plaintext[i] ^ stream[i];
  }
  return masked;
}

function deobfuscateSessionRecord(masked: Uint8Array): unknown {
  if (masked.length < SALT_LEN) {
    throw new Error('Obfuscated session record is missing its salt');
  }
  const salt = masked.slice(0, SALT_LEN);
  const ciphertext = masked.slice(SALT_LEN);
  const key = new Uint8Array(SALT_LEN + OBFUSCATION_KEY.length);
  key.set(salt);
  key.set(OBFUSCATION_KEY, SALT_LEN);
  const stream = rc4Keystream(key, ciphertext.length);
  const plaintext = new Uint8Array(ciphertext.length);
  for (let i = 0; i < ciphertext.length; i++) {
    plaintext[i] = ciphertext[i] ^ stream[i];
  }
  const record = fromBencodexValue(decode(plaintext));
  if (
    !record ||
    typeof record !== 'object' ||
    Array.isArray(record) ||
    record instanceof Uint8Array
  ) {
    throw new Error('Obfuscated session record did not decode to an object');
  }
  return record;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(SESSION_DB_NAME, SESSION_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SESSION_STORE_NAME)) {
        db.createObjectStore(SESSION_STORE_NAME);
      }
      if (!db.objectStoreNames.contains(REJECTION_STORE_NAME)) {
        db.createObjectStore(REJECTION_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Failed to open session database'));
    request.onblocked = () => reject(new Error('Session database open was blocked'));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('Session transaction aborted'));
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('Session transaction failed'));
  });
}

function deleteDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(SESSION_DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () =>
      reject(request.error ?? new Error('Failed to delete stale session database'));
    request.onblocked = () => reject(new Error('Stale session database deletion was blocked'));
  });
}

export async function readSessionRecord(): Promise<unknown | null> {
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
    if (record == null) return null;
    if (!(record instanceof Uint8Array)) {
      throw new InvalidSessionRecordError(
        new Error('Session record is not an obfuscated binary envelope'),
      );
    }
    try {
      return deobfuscateSessionRecord(record);
    } catch (error) {
      throw new InvalidSessionRecordError(error);
    }
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

export async function writeSessionRecord(record: SessionSave): Promise<void> {
  if (typeof indexedDB === 'undefined') {
    throw new Error('IndexedDB is unavailable; refusing to send without durable session storage');
  }
  const db = await openDatabase();
  try {
    const transaction = db.transaction(SESSION_STORE_NAME, 'readwrite');
    transaction.objectStore(SESSION_STORE_NAME).put(obfuscateRecord(record), SESSION_RECORD_KEY);
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

export interface DurableRejectionTombstone {
  kind: 'outbound-reject' | 'inbound-receipt';
  peerId: string;
  sessionId: string;
  messageNumber: bigint;
  remoteNumber: bigint;
  unackedMessages: Array<{ msgno: bigint; msg: Uint8Array }>;
  createdAt: number;
}

export function rejectionTombstoneKey(peerId: string, sessionId: string): string {
  return JSON.stringify([peerId, sessionId]);
}

function parseRejectionTombstone(value: unknown): DurableRejectionTombstone | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<DurableRejectionTombstone>;
  if (
    typeof candidate.peerId !== 'string' ||
    (candidate.kind !== 'outbound-reject' && candidate.kind !== 'inbound-receipt') ||
    typeof candidate.sessionId !== 'string' ||
    !/^[0-9a-f]{32}$/.test(candidate.sessionId) ||
    typeof candidate.messageNumber !== 'bigint' ||
    typeof candidate.remoteNumber !== 'bigint' ||
    typeof candidate.createdAt !== 'number' ||
    !Array.isArray(candidate.unackedMessages) ||
    candidate.unackedMessages.some(
      (message) =>
        !message || typeof message.msgno !== 'bigint' || !(message.msg instanceof Uint8Array),
    )
  ) {
    return null;
  }
  return candidate as DurableRejectionTombstone;
}

export async function readRejectionTombstones(): Promise<DurableRejectionTombstone[]> {
  if (typeof indexedDB === 'undefined') return [];
  const db = await openDatabase();
  try {
    const transaction = db.transaction(REJECTION_STORE_NAME, 'readonly');
    const request = transaction.objectStore(REJECTION_STORE_NAME).getAll();
    const records = await new Promise<unknown[]>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error ?? new Error('Failed to read rejection records'));
    });
    await transactionComplete(transaction);
    const parsed = records.flatMap((record) => {
      if (!(record instanceof Uint8Array)) return [];
      const parsed = parseRejectionTombstone(deobfuscateSessionRecord(record));
      return parsed ? [parsed] : [];
    });
    const cutoff = Date.now() - REJECTION_TOMBSTONE_TTL_MS;
    const expired = parsed.filter((record) => record.createdAt < cutoff);
    await Promise.all(
      expired.map((record) => deleteRejectionTombstone(record.peerId, record.sessionId)),
    );
    return parsed
      .filter((record) => record.createdAt >= cutoff)
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(-MAX_DURABLE_REJECTION_TOMBSTONES);
  } finally {
    db.close();
  }
}

async function performWriteRejectionTombstone(
  tombstone: DurableRejectionTombstone,
  clearSession: boolean,
): Promise<void> {
  if (typeof indexedDB === 'undefined') {
    throw new Error('IndexedDB is unavailable; refusing to reject without durable storage');
  }
  const existing = await readRejectionTombstones();
  const db = await openDatabase();
  try {
    const transaction = db.transaction(
      clearSession ? [REJECTION_STORE_NAME, SESSION_STORE_NAME] : REJECTION_STORE_NAME,
      'readwrite',
    );
    const store = transaction.objectStore(REJECTION_STORE_NAME);
    const retained = existing
      .filter(
        (record) => record.peerId !== tombstone.peerId || record.sessionId !== tombstone.sessionId,
      )
      .sort((a, b) => a.createdAt - b.createdAt);
    while (retained.length >= MAX_DURABLE_REJECTION_TOMBSTONES) {
      const evicted = retained.shift()!;
      store.delete(rejectionTombstoneKey(evicted.peerId, evicted.sessionId));
    }
    store.put(
      obfuscateRecord(tombstone),
      rejectionTombstoneKey(tombstone.peerId, tombstone.sessionId),
    );
    if (clearSession) {
      transaction.objectStore(SESSION_STORE_NAME).delete(SESSION_RECORD_KEY);
    }
    await transactionComplete(transaction);
  } finally {
    db.close();
  }
}

export function writeRejectionTombstone(tombstone: DurableRejectionTombstone): Promise<void> {
  const write = rejectionWriteQueue.then(() => performWriteRejectionTombstone(tombstone, false));
  rejectionWriteQueue = write.catch(() => {});
  return write;
}

export function replaceSessionWithInboundRejectionReceipt(
  tombstone: DurableRejectionTombstone & { kind: 'inbound-receipt' },
): Promise<void> {
  const write = rejectionWriteQueue.then(() => performWriteRejectionTombstone(tombstone, true));
  rejectionWriteQueue = write.catch(() => {});
  return write;
}

export async function deleteRejectionTombstone(peerId: string, sessionId: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  const db = await openDatabase();
  try {
    const transaction = db.transaction(REJECTION_STORE_NAME, 'readwrite');
    transaction.objectStore(REJECTION_STORE_NAME).delete(rejectionTombstoneKey(peerId, sessionId));
    await transactionComplete(transaction);
  } finally {
    db.close();
  }
}
