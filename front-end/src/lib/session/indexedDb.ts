import type { SessionSave } from './saveEnvelope';
import {
  decodeWalletOperationRecord,
  encodeWalletOperationRecord,
  type WalletOperationEntry,
  type WalletOperationRecord,
} from './walletOperationStore';
import { decode, encode, type BencodexValue } from 'chia-gaming-bencodex';

export const SESSION_DB_NAME = 'chia-gaming-session';
const SESSION_DB_VERSION = 4;
const SESSION_STORE_NAME = 'session';
const SESSION_RECORD_KEY = 'current';
const REJECTION_STORE_NAME = 'rejections';
const WALLET_OPERATION_STORE_NAME = 'wallet-reservations';
const WALLET_OPERATION_RECORD_KEY = 'current';
const COORDINATION_STORE_NAME = 'coordination';
const COORDINATION_RECORD_KEY = 'authority';
const COORDINATION_SCHEMA = 'chia-gaming-storage-authority';
const COORDINATION_VERSION = 1;
export const MAX_DURABLE_REJECTION_TOMBSTONES = 8;
export const REJECTION_TOMBSTONE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

export interface DurableStorageAuthority {
  ownerTabId: string;
  writeEpoch: bigint;
  resetEpoch: bigint;
}

interface CoordinationRecord extends DurableStorageAuthority {
  schema: typeof COORDINATION_SCHEMA;
  version: typeof COORDINATION_VERSION;
  resetStatus: 'active' | 'pending';
}

let afterNextAuthorityCheckForTests: (() => void) | null = null;
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

export class InvalidWalletOperationRecordError extends Error {
  constructor(cause: unknown) {
    super('Stored wallet operation record is malformed', { cause });
    this.name = 'InvalidWalletOperationRecordError';
  }
}

export class StorageAuthorityLostError extends Error {
  readonly code = 'STORAGE_AUTHORITY_LOST';

  constructor() {
    super('Durable storage authority was lost to another owner or epoch');
    this.name = 'StorageAuthorityLostError';
  }
}

export interface ClaimedStorageSnapshot {
  authority: DurableStorageAuthority;
  sessionRecord: unknown | null;
  sessionError?: InvalidSessionRecordError;
  walletOperationRecord: WalletOperationRecord | null;
  walletOperationError?: InvalidWalletOperationRecordError;
  rejectionTombstones: DurableRejectionTombstone[];
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

function deobfuscateRecord(masked: Uint8Array): unknown {
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
  return fromBencodexValue(decode(plaintext));
}

function decodeRawSessionRecord(record: unknown): unknown | null {
  if (record == null) return null;
  if (!(record instanceof Uint8Array)) {
    throw new InvalidSessionRecordError(
      new Error('Session record is not an obfuscated binary envelope'),
    );
  }
  try {
    const decoded = deobfuscateRecord(record);
    if (
      !decoded ||
      typeof decoded !== 'object' ||
      Array.isArray(decoded) ||
      decoded instanceof Uint8Array
    ) {
      throw new Error('Obfuscated session record did not decode to an object');
    }
    return decoded;
  } catch (error) {
    throw new InvalidSessionRecordError(error);
  }
}

function decodeRawWalletOperationRecord(record: unknown): WalletOperationRecord | null {
  if (record == null) return null;
  if (!(record instanceof Uint8Array)) {
    throw new InvalidWalletOperationRecordError(
      new Error('Wallet operation record is not an obfuscated binary record'),
    );
  }
  try {
    return decodeWalletOperationRecord(deobfuscateRecord(record));
  } catch (error) {
    throw new InvalidWalletOperationRecordError(error);
  }
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
      if (!db.objectStoreNames.contains(WALLET_OPERATION_STORE_NAME)) {
        db.createObjectStore(WALLET_OPERATION_STORE_NAME);
      }
      if (!db.objectStoreNames.contains(COORDINATION_STORE_NAME)) {
        db.createObjectStore(COORDINATION_STORE_NAME);
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

function initialCoordinationRecord(): CoordinationRecord {
  return {
    schema: COORDINATION_SCHEMA,
    version: COORDINATION_VERSION,
    ownerTabId: '',
    writeEpoch: 0n,
    resetEpoch: 0n,
    resetStatus: 'active',
  };
}

function decodeCoordinationRecord(value: unknown): CoordinationRecord {
  if (value === undefined) return initialCoordinationRecord();
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 6
  ) {
    throw new Error('Stored coordination authority is malformed');
  }
  const record = value as Partial<CoordinationRecord>;
  if (
    record.schema !== COORDINATION_SCHEMA ||
    record.version !== COORDINATION_VERSION ||
    typeof record.ownerTabId !== 'string' ||
    typeof record.writeEpoch !== 'bigint' ||
    record.writeEpoch < 0n ||
    typeof record.resetEpoch !== 'bigint' ||
    record.resetEpoch < 0n ||
    (record.resetStatus !== 'active' && record.resetStatus !== 'pending')
  ) {
    throw new Error('Stored coordination authority is malformed');
  }
  return record as CoordinationRecord;
}

function requestResult<T>(request: IDBRequest<T>, failure: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error(failure));
  });
}

async function readCoordinationRecord(transaction: IDBTransaction): Promise<CoordinationRecord> {
  return decodeCoordinationRecord(
    await requestResult(
      transaction.objectStore(COORDINATION_STORE_NAME).get(COORDINATION_RECORD_KEY),
      'Failed to read storage coordination authority',
    ),
  );
}

function putCoordinationRecord(transaction: IDBTransaction, record: CoordinationRecord): void {
  transaction.objectStore(COORDINATION_STORE_NAME).put(record, COORDINATION_RECORD_KEY);
}

function authorityMatches(
  record: CoordinationRecord,
  authority: DurableStorageAuthority,
  resetStatus: CoordinationRecord['resetStatus'] = 'active',
): boolean {
  return (
    record.ownerTabId === authority.ownerTabId &&
    record.writeEpoch === authority.writeEpoch &&
    record.resetEpoch === authority.resetEpoch &&
    record.resetStatus === resetStatus
  );
}

async function openValidatedMutation(
  db: IDBDatabase,
  stores: string | string[],
  authority: DurableStorageAuthority,
): Promise<IDBTransaction> {
  const names = typeof stores === 'string' ? [stores] : stores;
  const transaction = db.transaction(
    [...new Set([...names, COORDINATION_STORE_NAME])],
    'readwrite',
  );
  const record = await readCoordinationRecord(transaction);
  if (!authorityMatches(record, authority)) {
    transaction.abort();
    try {
      await transactionComplete(transaction);
    } catch {
      // The abort is intentional: stale authority must not mutate any store.
    }
    throw new StorageAuthorityLostError();
  }
  const afterAuthorityCheck = afterNextAuthorityCheckForTests;
  afterNextAuthorityCheckForTests = null;
  afterAuthorityCheck?.();
  return transaction;
}

async function claimAndReadDurableStorageRaw(ownerTabId: string): Promise<ClaimedStorageSnapshot> {
  if (typeof indexedDB === 'undefined') {
    throw new Error('IndexedDB is unavailable; durable storage authority cannot be claimed');
  }
  const db = await openDatabase();
  try {
    const transaction = db.transaction(
      [
        COORDINATION_STORE_NAME,
        SESSION_STORE_NAME,
        WALLET_OPERATION_STORE_NAME,
        REJECTION_STORE_NAME,
      ],
      'readwrite',
    );
    const current = await readCoordinationRecord(transaction);
    if (current.resetStatus === 'pending') {
      transaction.abort();
      throw new Error('A durable hard reset is pending');
    }
    const claimed: CoordinationRecord = {
      ...current,
      ownerTabId,
      writeEpoch: current.writeEpoch + 1n,
      resetStatus: 'active',
    };
    const sessionRaw = await requestResult(
      transaction.objectStore(SESSION_STORE_NAME).get(SESSION_RECORD_KEY),
      'Failed to read session record while claiming storage authority',
    );
    const walletRaw = await requestResult(
      transaction.objectStore(WALLET_OPERATION_STORE_NAME).get(WALLET_OPERATION_RECORD_KEY),
      'Failed to read wallet operation record while claiming storage authority',
    );
    const rejectionRaw = await requestResult(
      transaction.objectStore(REJECTION_STORE_NAME).getAll(),
      'Failed to read rejection records while claiming storage authority',
    );
    putCoordinationRecord(transaction, claimed);
    await transactionComplete(transaction);
    const authority = {
      ownerTabId,
      writeEpoch: claimed.writeEpoch,
      resetEpoch: claimed.resetEpoch,
    };
    let sessionRecord: unknown | null = null;
    let sessionError: InvalidSessionRecordError | undefined;
    try {
      sessionRecord = decodeRawSessionRecord(sessionRaw);
    } catch (error) {
      if (!(error instanceof InvalidSessionRecordError)) throw error;
      sessionError = error;
    }
    let walletOperationRecord: WalletOperationRecord | null = null;
    let walletOperationError: InvalidWalletOperationRecordError | undefined;
    try {
      walletOperationRecord = decodeRawWalletOperationRecord(walletRaw);
    } catch (error) {
      if (!(error instanceof InvalidWalletOperationRecordError)) throw error;
      walletOperationError = error;
    }
    return {
      authority,
      sessionRecord,
      ...(sessionError ? { sessionError } : {}),
      walletOperationRecord,
      ...(walletOperationError ? { walletOperationError } : {}),
      rejectionTombstones: parseCurrentRejectionTombstones(rejectionRaw),
    };
  } finally {
    db.close();
  }
}

async function beginDurableHardResetRaw(ownerTabId: string): Promise<DurableStorageAuthority> {
  if (typeof indexedDB === 'undefined') {
    throw new Error('IndexedDB is unavailable; hard reset cannot be durably fenced');
  }
  const db = await openDatabase();
  try {
    const transaction = db.transaction(COORDINATION_STORE_NAME, 'readwrite');
    const current = await readCoordinationRecord(transaction);
    const reset: CoordinationRecord = {
      ...current,
      ownerTabId,
      writeEpoch: current.writeEpoch + 1n,
      resetEpoch: current.resetEpoch + 1n,
      resetStatus: 'pending',
    };
    putCoordinationRecord(transaction, reset);
    await transactionComplete(transaction);
    return {
      ownerTabId,
      writeEpoch: reset.writeEpoch,
      resetEpoch: reset.resetEpoch,
    };
  } finally {
    db.close();
  }
}

async function validatePendingHardResetAuthority(
  authority: DurableStorageAuthority,
): Promise<void> {
  const db = await openDatabase();
  try {
    const transaction = db.transaction(COORDINATION_STORE_NAME, 'readonly');
    const record = await readCoordinationRecord(transaction);
    await transactionComplete(transaction);
    if (!authorityMatches(record, authority, 'pending')) {
      throw new StorageAuthorityLostError();
    }
  } finally {
    db.close();
  }
}

/** @internal test-only: run once after authority validation, before mutation commit. */
export function _afterNextStorageAuthorityCheckForTests(callback: () => void): void {
  afterNextAuthorityCheckForTests = callback;
}

export async function readSessionRecord(): Promise<unknown | null> {
  if (typeof indexedDB === 'undefined') return null;
  const db = await openDatabase();
  try {
    const transaction = db.transaction(SESSION_STORE_NAME, 'readonly');
    const request = transaction.objectStore(SESSION_STORE_NAME).get(SESSION_RECORD_KEY);
    const record = await new Promise<unknown>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Failed to read session record'));
    });
    await transactionComplete(transaction);
    return decodeRawSessionRecord(record);
  } finally {
    db.close();
  }
}

async function performWriteSessionRecord(
  record: SessionSave,
  authority: DurableStorageAuthority,
): Promise<void> {
  if (typeof indexedDB === 'undefined') {
    throw new Error('IndexedDB is unavailable; refusing to send without durable session storage');
  }
  const db = await openDatabase();
  try {
    const transaction = await openValidatedMutation(db, SESSION_STORE_NAME, authority);
    transaction.objectStore(SESSION_STORE_NAME).put(obfuscateRecord(record), SESSION_RECORD_KEY);
    await transactionComplete(transaction);
  } finally {
    db.close();
  }
}

function writeSessionRecordRaw(
  record: SessionSave,
  authority: DurableStorageAuthority,
): Promise<void> {
  return performWriteSessionRecord(structuredClone(record), authority);
}

async function writeSessionAndWalletOperationRecordsRaw(
  session: SessionSave,
  entries: WalletOperationEntry[],
  authority: DurableStorageAuthority,
): Promise<void> {
  if (typeof indexedDB === 'undefined') {
    throw new Error('IndexedDB is unavailable; session and wallet operation record remain dirty');
  }
  const sessionSnapshot = structuredClone(session);
  const ledgerRecord = encodeWalletOperationRecord(structuredClone(entries));
  const db = await openDatabase();
  try {
    const transaction = await openValidatedMutation(
      db,
      [SESSION_STORE_NAME, WALLET_OPERATION_STORE_NAME],
      authority,
    );
    transaction
      .objectStore(SESSION_STORE_NAME)
      .put(obfuscateRecord(sessionSnapshot), SESSION_RECORD_KEY);
    transaction
      .objectStore(WALLET_OPERATION_STORE_NAME)
      .put(obfuscateRecord(ledgerRecord), WALLET_OPERATION_RECORD_KEY);
    await transactionComplete(transaction);
  } finally {
    db.close();
  }
}

async function deleteSessionRecordRaw(authority: DurableStorageAuthority): Promise<void> {
  if (typeof indexedDB === 'undefined') {
    throw new Error('IndexedDB is unavailable; session record was not deleted');
  }
  const db = await openDatabase();
  try {
    const transaction = await openValidatedMutation(db, SESSION_STORE_NAME, authority);
    transaction.objectStore(SESSION_STORE_NAME).delete(SESSION_RECORD_KEY);
    await transactionComplete(transaction);
  } finally {
    db.close();
  }
}

export async function readWalletOperationRecord(): Promise<WalletOperationRecord | null> {
  if (typeof indexedDB === 'undefined') return null;
  const db = await openDatabase();
  try {
    const transaction = db.transaction(WALLET_OPERATION_STORE_NAME, 'readonly');
    const request = transaction
      .objectStore(WALLET_OPERATION_STORE_NAME)
      .get(WALLET_OPERATION_RECORD_KEY);
    const record = await new Promise<unknown>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error ?? new Error('Failed to read wallet operation record'));
    });
    await transactionComplete(transaction);
    return decodeRawWalletOperationRecord(record);
  } finally {
    db.close();
  }
}

async function writeWalletOperationRecordRaw(
  entries: WalletOperationEntry[],
  authority: DurableStorageAuthority,
): Promise<void> {
  if (typeof indexedDB === 'undefined') {
    throw new Error('IndexedDB is unavailable; wallet operation record remains dirty');
  }
  const record = encodeWalletOperationRecord(structuredClone(entries));
  const db = await openDatabase();
  try {
    const transaction = await openValidatedMutation(db, WALLET_OPERATION_STORE_NAME, authority);
    transaction
      .objectStore(WALLET_OPERATION_STORE_NAME)
      .put(obfuscateRecord(record), WALLET_OPERATION_RECORD_KEY);
    await transactionComplete(transaction);
  } finally {
    db.close();
  }
}

async function deleteWalletOperationRecordRaw(authority: DurableStorageAuthority): Promise<void> {
  if (typeof indexedDB === 'undefined') {
    throw new Error('IndexedDB is unavailable; wallet operation record was not deleted');
  }
  const db = await openDatabase();
  try {
    const transaction = await openValidatedMutation(db, WALLET_OPERATION_STORE_NAME, authority);
    transaction.objectStore(WALLET_OPERATION_STORE_NAME).delete(WALLET_OPERATION_RECORD_KEY);
    await transactionComplete(transaction);
  } finally {
    db.close();
  }
}

/** IndexedDB transaction port consumed only by StorageCoordinator. */
export const indexedDbStoragePort = {
  claimAndRead: claimAndReadDurableStorageRaw,
  beginHardReset: beginDurableHardResetRaw,
  validatePendingHardReset: validatePendingHardResetAuthority,
  writeSession: writeSessionRecordRaw,
  writeCheckpoint: writeSessionAndWalletOperationRecordsRaw,
  deleteSession: deleteSessionRecordRaw,
  writeWalletOperations: writeWalletOperationRecordRaw,
  deleteWalletOperations: deleteWalletOperationRecordRaw,
  pruneRejections: pruneRejectionTombstonesRaw,
  writeRejection: writeRejectionTombstoneRaw,
  replaceSessionWithRejection: replaceSessionWithRejectionTombstoneRaw,
  deleteRejection: deleteRejectionTombstoneRaw,
};

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

function parseCurrentRejectionTombstones(records: unknown[]): DurableRejectionTombstone[] {
  const cutoff = Date.now() - REJECTION_TOMBSTONE_TTL_MS;
  return records
    .flatMap((record) => {
      if (!(record instanceof Uint8Array)) return [];
      const parsed = parseRejectionTombstone(deobfuscateRecord(record));
      return parsed ? [parsed] : [];
    })
    .filter((record) => record.createdAt >= cutoff)
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(-MAX_DURABLE_REJECTION_TOMBSTONES);
}

async function listRejectionTombstonesInTransaction(
  transaction: IDBTransaction,
  deleteExpired: boolean,
): Promise<DurableRejectionTombstone[]> {
  const store = transaction.objectStore(REJECTION_STORE_NAME);
  const records = await requestResult(store.getAll(), 'Failed to read rejection records');
  const parsed = records.flatMap((record) => {
    if (!(record instanceof Uint8Array)) return [];
    const parsedRecord = parseRejectionTombstone(deobfuscateRecord(record));
    return parsedRecord ? [parsedRecord] : [];
  });
  const cutoff = Date.now() - REJECTION_TOMBSTONE_TTL_MS;
  if (deleteExpired) {
    for (const record of parsed) {
      if (record.createdAt < cutoff) {
        store.delete(rejectionTombstoneKey(record.peerId, record.sessionId));
      }
    }
  }
  return parsed
    .filter((record) => record.createdAt >= cutoff)
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(-MAX_DURABLE_REJECTION_TOMBSTONES);
}

export async function readRejectionTombstones(): Promise<DurableRejectionTombstone[]> {
  if (typeof indexedDB === 'undefined') return [];
  const db = await openDatabase();
  try {
    const transaction = db.transaction(REJECTION_STORE_NAME, 'readonly');
    const records = await listRejectionTombstonesInTransaction(transaction, false);
    await transactionComplete(transaction);
    return records;
  } finally {
    db.close();
  }
}

async function pruneRejectionTombstonesRaw(authority: DurableStorageAuthority): Promise<void> {
  if (typeof indexedDB === 'undefined') {
    throw new Error('IndexedDB is unavailable; rejection records were not pruned');
  }
  const db = await openDatabase();
  try {
    const transaction = await openValidatedMutation(db, REJECTION_STORE_NAME, authority);
    await listRejectionTombstonesInTransaction(transaction, true);
    await transactionComplete(transaction);
  } finally {
    db.close();
  }
}

async function performWriteRejectionTombstone(
  tombstone: DurableRejectionTombstone,
  clearSession: boolean,
  authority: DurableStorageAuthority,
): Promise<void> {
  if (typeof indexedDB === 'undefined') {
    throw new Error('IndexedDB is unavailable; refusing to reject without durable storage');
  }
  const db = await openDatabase();
  try {
    const transaction = await openValidatedMutation(
      db,
      clearSession ? [REJECTION_STORE_NAME, SESSION_STORE_NAME] : REJECTION_STORE_NAME,
      authority,
    );
    const store = transaction.objectStore(REJECTION_STORE_NAME);
    const existing = await listRejectionTombstonesInTransaction(transaction, true);
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

function writeRejectionTombstoneRaw(
  tombstone: DurableRejectionTombstone,
  authority: DurableStorageAuthority,
): Promise<void> {
  return performWriteRejectionTombstone(tombstone, false, authority);
}

function replaceSessionWithRejectionTombstoneRaw(
  tombstone: DurableRejectionTombstone,
  authority: DurableStorageAuthority,
): Promise<void> {
  return performWriteRejectionTombstone(tombstone, true, authority);
}

async function deleteRejectionTombstoneRaw(
  peerId: string,
  sessionId: string,
  authority: DurableStorageAuthority,
): Promise<void> {
  if (typeof indexedDB === 'undefined') {
    throw new Error('IndexedDB is unavailable; rejection record was not deleted');
  }
  const db = await openDatabase();
  try {
    const transaction = await openValidatedMutation(db, REJECTION_STORE_NAME, authority);
    transaction.objectStore(REJECTION_STORE_NAME).delete(rejectionTombstoneKey(peerId, sessionId));
    await transactionComplete(transaction);
  } finally {
    db.close();
  }
}
