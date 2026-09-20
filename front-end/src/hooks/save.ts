import { MIN_NONZERO_FEE_MOJOS } from '../constants/fees';
import {
  type ClaimedStorageSnapshot,
  deleteSessionRecord,
  type DurableRejectionTombstone,
  InvalidSessionRecordError,
  readSessionRecord,
  readWalletReservationRecord,
  replaceSessionWithRejectionTombstone,
  StorageAuthorityLostError,
  writeSessionAndWalletReservationRecords,
  writeWalletReservationRecord,
} from '../lib/session/indexedDb';
import { isDenseNumericByteObject } from '../lib/reactPropSafe';
import {
  HUMAN_HISTORY_LIMIT,
  recentDiagnosticEntries,
  recentEntries,
  WASM_NOTIFICATION_HISTORY_LIMIT,
} from '../lib/session/historyLimits';
import {
  SESSION_SAVE_SCHEMA,
  SESSION_SAVE_VERSION,
  type BlockchainType,
  type ChiaNetwork,
  type LiveSessionSave,
  type PreHandshakeSessionSave,
  type SessionHistorySave,
  type SessionIdentitySave,
  type SessionPairingSave,
  type SessionPreferencesSave,
  type SessionPresentationSave,
  type SessionSave,
  type SessionTransportSave,
  type TerminalSessionSave,
} from '../lib/session/saveEnvelope';
import {
  decodeSessionSaveEnvelope,
  SESSION_SAVE_ENVELOPE_VERSION,
} from '../lib/session/persistence';
import { hardResetStorage, type HardResetResult } from './saveHardReset';
import { loadPreferences, savePreferences } from './savePreferences';
import {
  checkLease,
  beginHardResetPersistence,
  capturePersistenceFence,
  claimLease,
  clearAutoResumeOnce,
  clearLease,
  clearSavedSessionMarker,
  fencePersistence,
  hasSavedSessionMarker,
  hasStorageAuthority,
  hasWalletConnectStorage,
  installStorageCoordination,
  isFenced,
  isPersistenceFenceCurrent,
  isLeaseConflict,
  markAutoResumeOnce,
  markSavedSession,
  loseAuthority,
  offFenced,
  onFenced,
  peekAutoResumeOnce,
  randomHex,
  reclaimLease,
  releaseLeaseIfOwner,
  resetStorageCoordinationForTests,
} from './saveCoordination';
import { walletReservationLedger } from '../lib/session/walletReservationLedger';
import { decodeWalletReservationRecord } from '../lib/session/walletReservationLedgerSchema';

export {
  checkLease,
  claimLease,
  clearAutoResumeOnce,
  clearLease,
  clearSavedSessionMarker,
  hasSavedSessionMarker,
  isLeaseConflict,
  markAutoResumeOnce,
  markSavedSession,
  offFenced,
  onFenced,
  peekAutoResumeOnce,
  reclaimLease,
  releaseLeaseIfOwner,
};

export type { PersistedGameState } from '@games/host';
export type {
  LiveSessionSave,
  PreHandshakeSessionSave,
  SessionPairingSave,
  SessionPresentationSave,
  SessionSave,
  TerminalSessionSave,
} from '../lib/session/saveEnvelope';

export const CURRENT_VERSION = SESSION_SAVE_ENVELOPE_VERSION;

type CommonSaveFields = Pick<SessionSave, 'identity' | 'preferences' | 'history'>;
type PreAuthorityPatch = {
  identity?: Partial<SessionIdentitySave>;
  preferences?: Partial<SessionPreferencesSave>;
  history?: Partial<SessionHistorySave>;
};

function commonFields(state: SessionSave): CommonSaveFields {
  return {
    identity: structuredClone(state.identity),
    preferences: structuredClone(state.preferences),
    history: structuredClone(state.history),
  };
}

function preferencesEnvelope(common: CommonSaveFields): SessionSave {
  return {
    schema: SESSION_SAVE_SCHEMA,
    version: SESSION_SAVE_VERSION,
    phase: 'preferences',
    ...common,
  };
}

function isDurableSession(state: SessionSave): boolean {
  return state.phase !== 'preferences';
}

function stopPersistenceForHardReset(): void {
  cached = null;
  stagedTerminal = null;
  if (!isFenced()) fencePersistence();
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  settleScheduledPersist();
  identityDiskChecked = true;
  sessionCacheHydratedFromDisk = true;
  walletReservationLedgerHydration = null;
}

// --- In-memory cache + debounced persistence ---

let cached: SessionSave | null = null;
let stagedTerminal: SessionSave | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistPromise: Promise<void> | null = null;
let resolvePersist: (() => void) | null = null;
let rejectPersist: ((reason: unknown) => void) | null = null;
let persistAuthorityLostListener: (() => void) | null = null;
const PERSIST_DEBOUNCE_MS = 300;

/**
 * True when prefs remember a wallet choice and/or hub, or WC left storage.
 * Independent of whether a game session / cradle exists.
 */
export function hasConnectionPreferences(state: SessionSave = loadPreferences()): boolean {
  return !!(
    state.preferences.blockchainType ||
    state.preferences.hubUrl ||
    hasWalletConnectStorage()
  );
}

/**
 * True when boot should offer Resume / Start Over.
 * Connection prefs count even with no game session; the session marker
 * covers durable cradles / prior explicit save intent.
 */
export function shouldOfferResumeOrStartOver(state: SessionSave = loadPreferences()): boolean {
  return hasConnectionPreferences(state) || hasSavedSessionMarker();
}

/** Force the boot Resume/Start Over dialog on next load. */
function assertNoNumbers(obj: unknown, path: string): void {
  if (obj === null || obj === undefined) return;
  if (typeof obj === 'number') {
    const msg = `[save] BUG: found number where bigint expected at "${path}" (value=${obj})`;
    console.error(msg);
    if (typeof window !== 'undefined' && window.alert) {
      window.alert(msg);
    }
    throw new Error(msg);
  }
  if (ArrayBuffer.isView(obj)) return;
  if (typeof obj !== 'object') return;
  if (!Array.isArray(obj) && isDenseNumericByteObject(obj)) {
    const msg = `[save] BUG: degraded numeric-keyed byte object at "${path}" (refusing to persist)`;
    console.error(msg);
    throw new Error(msg);
  }
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      assertNoNumbers(obj[i], `${path}[${i}]`);
    }
  } else {
    for (const key of Object.keys(obj as Record<string, unknown>)) {
      assertNoNumbers((obj as Record<string, unknown>)[key], `${path}.${key}`);
    }
  }
}

function decodeCompatibleSessionRecord(state: unknown): SessionSave | null {
  try {
    return decodeSessionSaveEnvelope(state).save;
  } catch (error) {
    console.error('[save] rejecting incompatible session record:', error);
    return null;
  }
}

async function readCompatibleSessionRecord(): Promise<{
  record: SessionSave | null;
  discarded: boolean;
}> {
  let record: unknown | null;
  try {
    record = await readSessionRecord();
  } catch (error) {
    if (!(error instanceof InvalidSessionRecordError)) throw error;
    console.error('[save] rejecting unreadable session record:', error);
    await deleteSessionRecord();
    markSavedSession();
    return { record: null, discarded: true };
  }
  if (!record) return { record: null, discarded: false };
  const decoded = decodeCompatibleSessionRecord(record);
  if (!decoded) {
    await deleteSessionRecord();
    markSavedSession();
    return { record: null, discarded: true };
  }
  return { record: decoded, discarded: false };
}

/**
 * True when disk state should keep the boot Resume/Start Over marker.
 * Includes finished/terminal channel snapshots (no live cradle) so a clean
 * shutdown does not silently boot into leftover hub prefs with no dialog.
 */
function capPersistedHistories(state: SessionSave): void {
  if (state.history.humanHistory) {
    state.history.humanHistory = recentEntries(state.history.humanHistory, HUMAN_HISTORY_LIMIT);
  }
  if (state.history.wasmNotificationHistory) {
    state.history.wasmNotificationHistory = recentEntries(
      state.history.wasmNotificationHistory,
      WASM_NOTIFICATION_HISTORY_LIMIT,
    );
  }
  if (state.history.diagnosticLog) {
    state.history.diagnosticLog = recentDiagnosticEntries(state.history.diagnosticLog);
  }
}

function queueWrite(state: SessionSave): Promise<void> {
  const fence = capturePersistenceFence();
  const snapshot = structuredClone(state);
  const ledgerCheckpoint = walletReservationLedger.checkpoint();
  capPersistedHistories(snapshot);
  assertNoNumbers(snapshot, 'SessionSave');
  decodeSessionSaveEnvelope(snapshot);
  const write = writeSessionAndWalletReservationRecords(
    snapshot,
    ledgerCheckpoint.entries,
    () => !isFenced(),
  )
    .then(() => {
      if (!isPersistenceFenceCurrent(fence)) {
        throw new StorageAuthorityLostError(fence.durableAuthority, fence.durableAuthority);
      }
      walletReservationLedger.combinedCheckpointPersisted(ledgerCheckpoint);
      // Only *set* the boot marker for a durable game session here. Pre-game
      // wallet connection marks explicitly in Shell; preference-only writes must
      // not clear that marker (previously saveSession({ blockchainType }) wiped
      // it, so reload restored the wallet type with no Resume/Start Over).
      if (isDurableSession(snapshot)) {
        markSavedSession();
      }
    })
    .catch((error) => {
      if (error instanceof StorageAuthorityLostError) {
        loseAuthority('durable-authority-lost');
      }
      throw error;
    });
  return write;
}

function settleScheduledPersist(error?: unknown): void {
  if (persistAuthorityLostListener) {
    offFenced(persistAuthorityLostListener);
    persistAuthorityLostListener = null;
  }
  const resolve = resolvePersist;
  const reject = rejectPersist;
  persistPromise = null;
  resolvePersist = null;
  rejectPersist = null;
  if (error === undefined) resolve?.();
  else reject?.(error);
}

export function flushSessionSave(): Promise<void> {
  if (!hasStorageAuthority()) return Promise.resolve();
  return hydrateSessionCacheFromDiskStrict().then(async () => {
    if (!cached || isFenced()) {
      await walletReservationLedger.persistIfDirty();
      return;
    }
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    const pending = persistPromise;
    const resolve = resolvePersist;
    const reject = rejectPersist;
    if (persistAuthorityLostListener) {
      offFenced(persistAuthorityLostListener);
      persistAuthorityLostListener = null;
    }
    persistPromise = null;
    resolvePersist = null;
    rejectPersist = null;
    if (stagedTerminal) {
      const terminal = stagedTerminal;
      let write: Promise<void>;
      try {
        write = queueWrite(terminal).then(() => {
          if (stagedTerminal !== terminal) return;
          cached = terminal;
          stagedTerminal = null;
          savePreferences(terminal);
        });
      } catch (error) {
        reject?.(error);
        return Promise.reject(error);
      }
      void write.then(
        () => resolve?.(),
        (error) => {
          console.error('[save] failed to persist terminal session state:', error);
          reject?.(error);
        },
      );
      return pending ? Promise.all([pending, write]).then(() => {}) : write;
    }
    if (
      !isDurableSession(cached) &&
      hasSavedSessionMarker() &&
      !hasConnectionPreferences(cached) &&
      walletReservationLedger.snapshot().length === 0
    ) {
      const error = new Error(
        'Refusing to persist non-resumable in-memory state over a marked saved session',
      );
      console.error('[save]', error.message);
      reject?.(error);
      return Promise.reject(error);
    }
    let write: Promise<void>;
    try {
      write = queueWrite(cached);
    } catch (error) {
      reject?.(error);
      return Promise.reject(error);
    }
    void write.then(
      () => resolve?.(),
      (error) => {
        console.error('[save] failed to persist session state:', error);
        reject?.(error);
      },
    );
    return pending ?? write;
  });
}

function schedulePersist(): Promise<void> {
  if (!hasStorageAuthority() || isFenced()) return Promise.resolve();
  if (persistPromise) return persistPromise;
  persistPromise = new Promise<void>((resolve, reject) => {
    resolvePersist = resolve;
    rejectPersist = reject;
  });
  void persistPromise.catch(() => {});
  const fence = capturePersistenceFence();
  persistAuthorityLostListener = () => {
    settleScheduledPersist(
      new StorageAuthorityLostError(fence.durableAuthority, fence.durableAuthority),
    );
  };
  onFenced(persistAuthorityLostListener);
  const timer = setTimeout(() => {
    persistTimer = null;
    void flushSessionSave().catch((error) => {
      // The write path classifies/logs failures. Settle here as well when
      // hydration failed before flushSessionSave could take the scheduled promise.
      settleScheduledPersist(error);
    });
  }, PERSIST_DEBOUNCE_MS);
  if (typeof timer === 'object' && 'unref' in timer) timer.unref();
  persistTimer = timer;
  return persistPromise;
}

installStorageCoordination(stopPersistenceForHardReset);

/**
 * True once we have either confirmed there is no disk identity to restore, or
 * finished merging IndexedDB into the cache. Until then, getSessionId must not
 * mint — a boot-time mint would write a new id into preferences and clobber
 * the durable hub session_id on the next peek/hydrate merge.
 */
let identityDiskChecked = false;
let sessionCacheHydratedFromDisk = false;
let walletReservationLedgerHydration: Promise<void> | null = null;
let preAuthorityPatch: PreAuthorityPatch = {};

/** @internal — reset module state between test cases */
export function _resetForTests(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  settleScheduledPersist();
  cached = null;
  stagedTerminal = null;
  identityDiskChecked = false;
  sessionCacheHydratedFromDisk = false;
  walletReservationLedgerHydration = null;
  preAuthorityPatch = {};
  resetStorageCoordinationForTests();
  walletReservationLedger.resetForTests();
}

export function loadState(): SessionSave {
  if (!cached) cached = loadPreferences();
  return cached;
}

export function hydrateWalletReservationLedger(): Promise<void> {
  if (!hasStorageAuthority()) return Promise.resolve();
  if (walletReservationLedgerHydration) return walletReservationLedgerHydration;
  walletReservationLedger.beginHydration();
  walletReservationLedgerHydration = (async () => {
    const record = await readWalletReservationRecord();
    walletReservationLedger.hydrateFromDisk(record);
  })().catch((error) => {
    walletReservationLedger.failHydration(error);
    throw error;
  });
  return walletReservationLedgerHydration;
}

/**
 * Ensure in-memory `cached` includes any resumable IndexedDB record before
 * mutating/persisting. Boot can show the resume dialog from the sync marker
 * without reading IndexedDB; without this, preference-only patches (logs,
 * alerts, etc.) would overwrite the durable cradle with a non-resumable
 * record and make Resume report "saved session unavailable".
 *
 * If memory is already resumable, leave it alone — a newer in-memory cradle
 * must not be replaced by a stale IndexedDB snapshot on flush.
 *
 * Also restores hub identity (sessionId / playerId) from disk when
 * preferences lack them, even if the record is not fully resumable — so a
 * reload never remints session_id over a durable id still on disk.
 */
/** @returns true when an incompatible IndexedDB schema was wiped (marker kept). */
async function hydrateSessionCacheFromDiskStrict(): Promise<boolean> {
  if (isFenced()) {
    identityDiskChecked = true;
    sessionCacheHydratedFromDisk = true;
    return false;
  }
  await hydrateWalletReservationLedger();
  // Memory already holding durable game state must win over IndexedDB. Do not
  // require sessionId here: handshake saves often persist a cradle before any
  // hub identity exists. The old `&& cached.sessionId` guard fell through
  // in that case, re-read the older disk snapshot, and clobbered the newer
  // in-memory cradle on every flush — freezing the first persisted size.
  if (cached && isDurableSession(cached)) {
    identityDiskChecked = true;
    sessionCacheHydratedFromDisk = true;
    return false;
  }
  if (!hasSavedSessionMarker()) {
    identityDiskChecked = true;
    sessionCacheHydratedFromDisk = true;
    return false;
  }

  // Do not flush a prefs-only cache over disk. Cancel the debounce; the caller
  // will schedule a new persist after merging with the hydrated record.
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (persistPromise && cached && !isDurableSession(cached)) {
    settleScheduledPersist();
  }

  const { record, discarded } = await readCompatibleSessionRecord();
  identityDiskChecked = true;
  sessionCacheHydratedFromDisk = true;
  if (!record) {
    if (!discarded) return false;
    // Same wipe+marker policy as peekSession: remove the unreadable record but
    // keep the boot marker so reload still forces Resume/Start Over.
    cached = loadPreferences();
    return true;
  }
  const mem = cached ?? loadPreferences();
  if (isDurableSession(record)) {
    cached = {
      ...record,
      identity: {
        playerId: mem.identity.playerId || record.identity.playerId,
        sessionId: mem.identity.sessionId || record.identity.sessionId,
        myHubPlayerId: mem.identity.myHubPlayerId || record.identity.myHubPlayerId,
      },
      preferences: {
        ...record.preferences,
        ...Object.fromEntries(
          Object.entries(mem.preferences).filter(([, value]) => value !== undefined),
        ),
      },
      history: {
        humanHistory: mem.history.humanHistory ?? record.history.humanHistory,
        diagnosticLog: mem.history.diagnosticLog ?? record.history.diagnosticLog,
        wasmNotificationHistory:
          mem.history.wasmNotificationHistory ?? record.history.wasmNotificationHistory,
      },
    };
    capPersistedHistories(cached);
    savePreferences(cached);
    return false;
  }

  // Non-resumable record: still pull hub identity if prefs lack it.
  cached = {
    ...mem,
    identity: {
      sessionId: mem.identity.sessionId || record.identity.sessionId,
      playerId: mem.identity.playerId || record.identity.playerId,
      myHubPlayerId: mem.identity.myHubPlayerId || record.identity.myHubPlayerId,
    },
  };
  savePreferences(cached);
  return false;
}

function mergeClaimedSession(record: SessionSave | null, patch: PreAuthorityPatch): SessionSave {
  const base = record ?? loadPreferences();
  return {
    ...base,
    identity: { ...base.identity, ...patch.identity },
    preferences: { ...base.preferences, ...patch.preferences },
    history: { ...base.history, ...patch.history },
  };
}

async function installClaimedStorageSnapshot(
  snapshot: ClaimedStorageSnapshot,
): Promise<SessionSave | null> {
  if (snapshot.walletReservationError) {
    walletReservationLedger.beginHydration();
    walletReservationLedger.failHydration(snapshot.walletReservationError);
    throw snapshot.walletReservationError;
  }
  walletReservationLedger.hydrateClaimedSnapshot(snapshot.walletReservationRecord);
  walletReservationLedgerHydration = Promise.resolve();

  let record: SessionSave | null = null;
  let discarded = false;
  if (snapshot.sessionError) {
    console.error('[save] rejecting unreadable session record:', snapshot.sessionError);
    await deleteSessionRecord();
    markSavedSession();
    discarded = true;
  } else if (snapshot.sessionRecord) {
    record = decodeCompatibleSessionRecord(snapshot.sessionRecord);
    if (!record) {
      await deleteSessionRecord();
      markSavedSession();
      discarded = true;
    }
  }

  const patch = preAuthorityPatch;
  preAuthorityPatch = {};
  cached = mergeClaimedSession(record, patch);
  capPersistedHistories(cached);
  identityDiskChecked = true;
  sessionCacheHydratedFromDisk = true;
  savePreferences(cached);

  const hasPatch = Object.keys(patch).length > 0;
  if (hasPatch) await queueWrite(cached);
  if (discarded) return null;
  if (record && isDurableSession(record)) {
    markSavedSession();
    return cached;
  }
  if (
    hasConnectionPreferences(cached) ||
    walletReservationLedger.snapshot().length > 0 ||
    hasSavedSessionMarker()
  ) {
    return cached;
  }
  return null;
}

export async function claimAndHydrateSession(): Promise<SessionSave | null> {
  const snapshot = await claimLease();
  return installClaimedStorageSnapshot(snapshot);
}

export type BootStorageHydrationResult =
  | { status: 'ready'; discardedSession: boolean }
  | { status: 'failed'; error: string };

export async function hydrateSessionCacheFromDisk(): Promise<BootStorageHydrationResult> {
  try {
    if (!hasStorageAuthority()) {
      const [session, ledger] = await Promise.all([
        readSessionRecord(),
        readWalletReservationRecord(),
      ]);
      if (session) decodeSessionSaveEnvelope(session);
      if (ledger) decodeWalletReservationRecord(ledger);
      return { status: 'ready', discardedSession: false };
    }
    return {
      status: 'ready',
      discardedSession: await hydrateSessionCacheFromDiskStrict(),
    };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function mutate(fn: (state: SessionSave) => SessionSave | void): Promise<void> {
  if (!hasStorageAuthority()) {
    const state = loadState();
    const before = commonFields(state);
    cached = fn(state) ?? state;
    const after = commonFields(cached);
    const changed = <T extends object>(previous: T, next: T): Partial<T> =>
      Object.fromEntries(
        Object.keys(next).flatMap((key) => {
          const beforeValue = previous[key as keyof T];
          const afterValue = next[key as keyof T];
          const encodeComparable = (value: unknown) =>
            JSON.stringify(value, (_name, entry) =>
              typeof entry === 'bigint' ? `${entry}n` : entry,
            );
          return encodeComparable(beforeValue) === encodeComparable(afterValue)
            ? []
            : [[key, structuredClone(afterValue)]];
        }),
      ) as Partial<T>;
    const identity = changed(before.identity, after.identity);
    const preferences = changed(before.preferences, after.preferences);
    const history = changed(before.history, after.history);
    if (Object.keys(identity).length > 0) {
      preAuthorityPatch.identity = { ...preAuthorityPatch.identity, ...identity };
    }
    if (Object.keys(preferences).length > 0) {
      preAuthorityPatch.preferences = { ...preAuthorityPatch.preferences, ...preferences };
    }
    if (Object.keys(history).length > 0) {
      preAuthorityPatch.history = { ...preAuthorityPatch.history, ...history };
    }
    savePreferences(cached);
    return Promise.resolve();
  }
  // Fast path: memory already has the resumable session, or there is no
  // marked disk session to protect. Keep this synchronous so preference
  // helpers can read their own writes immediately.
  if (
    (cached && isDurableSession(cached)) ||
    !hasSavedSessionMarker() ||
    sessionCacheHydratedFromDisk
  ) {
    const state = loadState();
    cached = fn(state) ?? state;
    savePreferences(cached);
    return schedulePersist();
  }
  return hydrateSessionCacheFromDiskStrict().then(() => {
    const state = loadState();
    cached = fn(state) ?? state;
    savePreferences(cached);
    return schedulePersist();
  });
}

// --- Convenience accessors ---

export function getPlayerId(): string {
  const state = loadState();
  if (hasStorageAuthority()) {
    savePreferences(state);
  } else {
    preAuthorityPatch.identity = {
      ...preAuthorityPatch.identity,
      playerId: state.identity.playerId,
    };
  }
  return state.identity.playerId;
}

/**
 * Await before identify / hub connect on boot. Restores sessionId from
 * IndexedDB when preferences are empty, then mints only if still missing.
 * Hub player_id is assigned by the hub from this secret — never client-chosen.
 */
export async function ensureHubIdentity(): Promise<string> {
  if (!hasStorageAuthority()) {
    await peekSession();
    if (loadState().identity.sessionId) return loadState().identity.sessionId!;
    throw new Error('Hub identity cannot be minted before durable storage authority is claimed');
  }
  if (hasSavedSessionMarker() && !identityDiskChecked) {
    await hydrateSessionCacheFromDiskStrict();
  }
  identityDiskChecked = true;
  return getSessionId();
}

export function getMyHubPlayerId(): string | undefined {
  return loadState().identity.myHubPlayerId;
}

export function getSessionId(): string {
  const state = loadState();
  if (state.identity.sessionId) return state.identity.sessionId;
  if (!hasStorageAuthority()) {
    throw new Error(
      'getSessionId called before ensureHubIdentity and durable storage authority was claimed',
    );
  }
  // A saved-session marker means disk may still hold the real hub
  // session_id. Minting here would poison preferences and win the merge.
  if (hasSavedSessionMarker() && !identityDiskChecked) {
    throw new Error(
      'getSessionId called before ensureHubIdentity/hydrate with a saved session marker',
    );
  }
  state.identity.sessionId = randomHex();
  savePreferences(state);
  // Also land in IndexedDB so a later hydrate cannot "lose" the id that only
  // lived in localStorage preferences.
  void schedulePersist();
  return state.identity.sessionId;
}

export function regenerateSessionId(): string {
  identityDiskChecked = true;
  const state = loadState();
  state.identity.sessionId = randomHex();
  state.identity.myHubPlayerId = undefined;
  if (hasStorageAuthority()) {
    savePreferences(state);
    void schedulePersist();
  } else {
    preAuthorityPatch.identity = {
      ...preAuthorityPatch.identity,
      sessionId: state.identity.sessionId,
      myHubPlayerId: undefined,
    };
  }
  return state.identity.sessionId;
}

export function clearSessionId(): void {
  // Intentional clear — next getSessionId may mint a replacement.
  identityDiskChecked = true;
  mutate((s) => {
    s.identity.sessionId = undefined;
    s.identity.myHubPlayerId = undefined;
  });
}

export function getBlockchainType(): BlockchainType | undefined {
  return loadState().preferences.blockchainType;
}

export function getNetwork(): ChiaNetwork {
  return loadState().preferences.network ?? 'mainnet';
}

export function setNetwork(network: ChiaNetwork): void {
  mutate((s) => {
    s.preferences.network = network;
  });
}

export type SessionCacheUpdate =
  | {
      scope: 'common';
      identity?: Partial<SessionIdentitySave>;
      preferences?: Partial<SessionPreferencesSave>;
      history?: Partial<SessionHistorySave>;
    }
  | {
      scope: 'live';
      pairing: SessionPairingSave;
      live: LiveSessionSave['live'];
      presentation: SessionPresentationSave;
      history?: Partial<SessionHistorySave>;
    };

export function saveSession(update: SessionCacheUpdate): Promise<void> {
  return mutate((s) => {
    switch (update.scope) {
      case 'common':
        Object.assign(s.identity, update.identity);
        Object.assign(s.preferences, update.preferences);
        Object.assign(s.history, update.history);
        break;
      case 'live': {
        const common = commonFields(s);
        Object.assign(common.history, update.history);
        const next: LiveSessionSave = {
          schema: SESSION_SAVE_SCHEMA,
          version: SESSION_SAVE_VERSION,
          phase: 'live',
          ...common,
          pairing: structuredClone(update.pairing),
          live: structuredClone(update.live),
          presentation: structuredClone(update.presentation),
        };
        capPersistedHistories(next);
        return next;
      }
    }
    capPersistedHistories(s);
  });
}

walletReservationLedger.configurePersistence(async (entries) => {
  if (!hasStorageAuthority()) return;
  const fence = capturePersistenceFence();
  try {
    await writeWalletReservationRecord(entries);
  } catch (error) {
    if (error instanceof StorageAuthorityLostError) {
      loseAuthority('durable-authority-lost');
    }
    throw error;
  }
  if (!isPersistenceFenceCurrent(fence)) {
    throw new Error('Wallet reservation persistence was fenced before it executed');
  }
});

export function patchPreHandshakeTransport(transport: SessionTransportSave): Promise<void> {
  return mutate((state) => {
    if (state.phase === 'pre-handshake') {
      state.transport = structuredClone(transport);
      return;
    }
    if (state.phase === 'live') {
      Object.assign(state.live, structuredClone(transport));
      return;
    }
    throw new Error(`Cannot patch session transport while session phase is ${state.phase}`);
  });
}

/** Clear peer relay identifiers when the current phase owns pairing state. */
export function clearSessionPairing(): Promise<void> {
  return mutate((state) => {
    if (state.phase === 'live' || state.phase === 'pre-handshake') {
      state.pairing.peerId = undefined;
    }
  });
}

function freshSessionState(previous: SessionSave): SessionSave {
  return preferencesEnvelope(commonFields(previous));
}

/**
 * Atomically replace the current durable session envelope. The previous disk
 * record and in-memory cache remain authoritative unless the replacement write
 * succeeds.
 */
export async function replaceSession(checkpoint: {
  pairing: SessionPairingSave;
  transport: SessionTransportSave;
  identity?: Partial<SessionIdentitySave>;
  history?: Partial<SessionHistorySave>;
}): Promise<void> {
  await hydrateSessionCacheFromDiskStrict();
  if (persistPromise) await flushSessionSave();
  const common = commonFields(loadState());
  Object.assign(common.identity, checkpoint.identity);
  Object.assign(common.history, checkpoint.history);
  const replacement: PreHandshakeSessionSave = {
    schema: SESSION_SAVE_SCHEMA,
    version: SESSION_SAVE_VERSION,
    phase: 'pre-handshake',
    ...common,
    pairing: structuredClone(checkpoint.pairing),
    transport: structuredClone(checkpoint.transport),
  };
  capPersistedHistories(replacement);
  await queueWrite(replacement);
  cached = replacement;
  stagedTerminal = null;
  savePreferences(replacement);
}

/**
 * Persist a terminal channel snapshot without any state that could restart its
 * protocol. Display/history fields supplied by the caller are retained.
 */
export function saveTerminalSession(fields: {
  terminal: TerminalSessionSave['terminal'];
  presentation: SessionPresentationSave;
}): Promise<void> {
  return mutate((s) => {
    return applyTerminalFields(s, fields);
  });
}

function applyTerminalFields(
  state: SessionSave,
  fields: {
    terminal: TerminalSessionSave['terminal'];
    presentation: SessionPresentationSave;
  },
): TerminalSessionSave {
  const terminal: TerminalSessionSave = {
    schema: SESSION_SAVE_SCHEMA,
    version: SESSION_SAVE_VERSION,
    phase: 'terminal',
    ...commonFields(state),
    terminal: structuredClone(fields.terminal),
    presentation: structuredClone(fields.presentation),
  };
  capPersistedHistories(terminal);
  return terminal;
}

/**
 * Prepare terminal display state without replacing the retryable live cache.
 * flushSessionSave promotes it only after the IndexedDB write succeeds.
 */
export async function stageTerminalSession(fields: {
  terminal: TerminalSessionSave['terminal'];
  presentation: SessionPresentationSave;
}): Promise<void> {
  await hydrateSessionCacheFromDiskStrict();
  const current = loadState();
  stagedTerminal = {
    schema: SESSION_SAVE_SCHEMA,
    version: SESSION_SAVE_VERSION,
    phase: 'terminal',
    ...commonFields(current),
    terminal: structuredClone(fields.terminal),
    presentation: structuredClone(fields.presentation),
  };
  capPersistedHistories(stagedTerminal);
}

export function discardStagedTerminalSession(): void {
  stagedTerminal = null;
}

/**
 * Returns the current state if there's anything worth resuming — a
 * serialized cradle, pairing token, finished/terminal channel snapshot,
 * remembered wallet and/or hub choice, or leftover WalletConnect storage.
 */
export async function peekSession(): Promise<SessionSave | null> {
  if (!hasStorageAuthority()) {
    const [rawSession, rawLedger] = await Promise.all([
      readSessionRecord(),
      readWalletReservationRecord(),
    ]);
    if (rawLedger) decodeWalletReservationRecord(rawLedger);
    const inspected = rawSession ? decodeCompatibleSessionRecord(rawSession) : null;
    if (inspected) {
      const local = loadPreferences();
      cached = {
        ...mergeClaimedSession(inspected, preAuthorityPatch),
        identity: {
          playerId: local.identity.playerId || inspected.identity.playerId,
          sessionId: local.identity.sessionId || inspected.identity.sessionId,
          myHubPlayerId: local.identity.myHubPlayerId || inspected.identity.myHubPlayerId,
        },
      };
      identityDiskChecked = true;
      sessionCacheHydratedFromDisk = true;
      if (isDurableSession(inspected) || hasConnectionPreferences(inspected)) return cached;
    }
    const preferences = loadPreferences();
    return hasConnectionPreferences(preferences) || rawLedger?.entries.length ? preferences : null;
  }
  // Hydrate before any flush so a prefs-only in-memory cache cannot overwrite
  // a durable resumable record that the boot marker is advertising.
  const wipedIncompatible = await hydrateSessionCacheFromDiskStrict();
  if (persistPromise) await flushSessionSave();
  const { record, discarded } = await readCompatibleSessionRecord();
  if (discarded) {
    // Wipe the unreadable record but keep the boot marker so reload still
    // forces Resume/Start Over instead of silently booting into leftover
    // preference state (e.g. blockchainType).
    cached = loadPreferences();
    return null;
  }
  if (record) {
    const preferences = loadPreferences();
    // Never let a disk record clobber stable local identity. Hub player_id
    // is keyed by session_id; reminting on reload breaks pre-cradle routing.
    cached = {
      ...record,
      identity: {
        playerId: preferences.identity.playerId || record.identity.playerId,
        sessionId: preferences.identity.sessionId || record.identity.sessionId,
        myHubPlayerId: preferences.identity.myHubPlayerId || record.identity.myHubPlayerId,
      },
      preferences: {
        ...record.preferences,
        ...Object.fromEntries(
          Object.entries(preferences.preferences).filter(([, value]) => value !== undefined),
        ),
      },
    };
    capPersistedHistories(cached);
    savePreferences(cached);
    if (isDurableSession(cached)) {
      markSavedSession();
      return cached;
    }
    if (hasConnectionPreferences(cached) || walletReservationLedger.snapshot().length > 0) {
      markSavedSession();
      return cached;
    }
    clearSavedSessionMarker();
    return null;
  }
  cached = loadPreferences();
  if (hasConnectionPreferences(cached)) {
    markSavedSession();
    return cached;
  }
  // Hydrate already wiped an incompatible schema and kept the marker; do not
  // clear it here (that would undo the wipe+marker policy).
  if (!wipedIncompatible) {
    clearSavedSessionMarker();
  }
  return null;
}

export function clearSession(): Promise<void> {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  settleScheduledPersist();
  const prev = loadState();
  cached = freshSessionState(prev);
  savePreferences(cached);
  const fence = capturePersistenceFence();
  const deletePromise = deleteSessionRecord().then(() => {
    if (!isPersistenceFenceCurrent(fence)) return;
    if (
      cached?.preferences.blockchainType ||
      cached?.preferences.hubUrl ||
      walletReservationLedger.snapshot().length > 0
    ) {
      markSavedSession();
    } else {
      clearSavedSessionMarker();
    }
  });
  return deletePromise;
}

export function clearSessionWithInboundRejectionReceipt(
  receipt: Omit<DurableRejectionTombstone, 'kind'>,
): Promise<void> {
  return clearSessionWithRejectionTombstone({
    ...receipt,
    kind: 'inbound-receipt',
  });
}

export function clearSessionWithRejectionTombstone(
  tombstone: DurableRejectionTombstone,
): Promise<void> {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  settleScheduledPersist();
  const prev = loadState();
  cached = freshSessionState(prev);
  savePreferences(cached);
  const fence = capturePersistenceFence();
  const replacePromise = replaceSessionWithRejectionTombstone(tombstone).then(() => {
    if (!isPersistenceFenceCurrent(fence)) return;
    if (
      cached?.preferences.blockchainType ||
      cached?.preferences.hubUrl ||
      walletReservationLedger.snapshot().length > 0
    ) {
      markSavedSession();
    } else {
      clearSavedSessionMarker();
    }
  });
  return replacePromise;
}

/**
 * Drop durable cradle/game state only after we know a new session can start
 * (e.g. deploy assets loaded). Keeps connection prefs, history/logs, and any
 * pre-cradle handshake fields (pairingToken, amounts, peer ids, timeouts).
 */
export async function clearGameSessionPreservingHistory(): Promise<void> {
  const prev = loadState();
  const checkpoint =
    prev.phase === 'live'
      ? {
          pairing: structuredClone(prev.pairing),
          transport: {
            messageNumber: prev.live.messageNumber,
            remoteNumber: prev.live.remoteNumber,
            unackedMessages: structuredClone(prev.live.unackedMessages),
            disposition: prev.live.disposition,
            terminalHandoff: structuredClone(prev.live.terminalHandoff),
          },
        }
      : prev.phase === 'pre-handshake'
        ? {
            pairing: structuredClone(prev.pairing),
            transport: structuredClone(prev.transport),
          }
        : null;
  await clearSession();
  if (checkpoint) {
    await replaceSession(checkpoint);
  }
}

export async function hardReset(): Promise<HardResetResult> {
  const authority = await beginHardResetPersistence();
  stopPersistenceForHardReset();
  walletReservationLedger.clearForHardReset();
  return hardResetStorage(authority);
}

// --- Alias ---

/** Return the stored hub alias without inventing a fallback. */
export function peekAlias(): string | undefined {
  return loadState().preferences.alias;
}

export function getAlias(): string {
  const state = loadState();
  if (state.preferences.alias) return state.preferences.alias;
  const generated = `Player_${randomHex().substring(0, 8)}`;
  state.preferences.alias = generated;
  if (hasStorageAuthority()) {
    savePreferences(state);
  } else {
    preAuthorityPatch.preferences = { ...preAuthorityPatch.preferences, alias: generated };
  }
  return generated;
}

export function setAlias(alias: string): void {
  mutate((s) => {
    s.preferences.alias = alias;
  });
}

// --- Theme ---

export function getTheme(): 'dark' | 'light' | undefined {
  return loadState().preferences.theme;
}

export function setTheme(theme: 'dark' | 'light'): void {
  mutate((s) => {
    s.preferences.theme = theme;
  });
}

// --- Default fee ---

export function getDefaultFee(): bigint {
  return loadState().preferences.defaultFee ?? MIN_NONZERO_FEE_MOJOS;
}

export function setDefaultFee(fee: bigint): void {
  mutate((s) => {
    s.preferences.defaultFee = fee;
  });
}

export function getFeeUnit(): 'mojo' | 'xch' {
  return loadState().preferences.feeUnit ?? 'mojo';
}

export function setFeeUnit(unit: 'mojo' | 'xch'): void {
  mutate((s) => {
    s.preferences.feeUnit = unit;
  });
}

// --- Active tab ---

export function getActiveTab(): string | undefined {
  return loadState().preferences.activeTab;
}

export function setActiveTab(tab: string): void {
  mutate((s) => {
    s.preferences.activeTab = tab;
  });
}

// --- Notification badges ---

export function getUnreadGame(): boolean {
  return loadState().preferences.unreadGame ?? false;
}

export function setUnreadGame(v: boolean): void {
  mutate((s) => {
    s.preferences.unreadGame = v || undefined;
  });
}

export function getWalletAlert(): boolean {
  return loadState().preferences.walletAlert ?? false;
}

export function setWalletAlert(v: boolean): void {
  mutate((s) => {
    s.preferences.walletAlert = v || undefined;
  });
}

export function getHubAlert(): boolean {
  return loadState().preferences.hubAlert ?? false;
}

export function setHubAlert(v: boolean): void {
  mutate((s) => {
    s.preferences.hubAlert = v || undefined;
  });
}

// --- Hub URL ---

export function getHubUrl(): string | undefined {
  return loadState().preferences.hubUrl;
}

export function setHubUrl(url: string | undefined): void {
  mutate((s) => {
    s.preferences.hubUrl = url || undefined;
  });
  if (url) markSavedSession();
}
