import {
  deleteSessionRecord,
  type DurableRejectionTombstone,
  InvalidSessionRecordError,
  readSessionRecord,
  replaceSessionWithInboundRejectionReceipt,
  writeSessionRecord,
} from '../lib/session/indexedDb';
import { isDenseNumericByteObject } from '../lib/reactPropSafe';
import {
  DIAGNOSTIC_LOG_LIMIT,
  HUMAN_HISTORY_LIMIT,
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
import { clearWalletConnectStorage, hardResetStorage } from './saveHardReset';
import { loadPreferences, savePreferences, writeRawObsoleteState } from './savePreferences';
import {
  checkLease,
  claimLease,
  clearAutoResumeOnce,
  clearLease,
  clearSavedSessionMarker,
  fencePersistence,
  hasSavedSessionMarker,
  hasWalletConnectStorage,
  installStorageCoordination,
  isFenced,
  isLeaseConflict,
  markAutoResumeOnce,
  markSavedSession,
  offFenced,
  onFenced,
  peekAutoResumeOnce,
  randomHex,
  reclaimLease,
  releaseLeaseIfOwner,
  resetStorageCoordinationForTests,
} from './saveCoordination';

export {
  checkLease,
  claimLease,
  clearAutoResumeOnce,
  clearLease,
  clearSavedSessionMarker,
  clearWalletConnectStorage,
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
  fencePersistence();
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  settleScheduledPersist();
}

// --- In-memory cache + debounced persistence ---

let cached: SessionSave | null = null;
let stagedTerminal: SessionSave | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistPromise: Promise<void> | null = null;
let resolvePersist: (() => void) | null = null;
let rejectPersist: ((reason: unknown) => void) | null = null;
let writeChain: Promise<void> = Promise.resolve();
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
    state.history.diagnosticLog = recentEntries(state.history.diagnosticLog, DIAGNOSTIC_LOG_LIMIT);
  }
}

function queueWrite(state: SessionSave): Promise<void> {
  const snapshot = structuredClone(state);
  capPersistedHistories(snapshot);
  assertNoNumbers(snapshot, 'SessionSave');
  decodeSessionSaveEnvelope(snapshot);
  writeChain = writeChain
    .catch(() => {})
    .then(async () => {
      if (isFenced()) return;
      await writeSessionRecord(snapshot);
      if (isFenced()) return;
      // Only *set* the boot marker for a durable game session here. Pre-game
      // wallet connection marks explicitly in Shell; preference-only writes must
      // not clear that marker (previously saveSession({ blockchainType }) wiped
      // it, so reload restored the wallet type with no Resume/Start Over).
      if (isDurableSession(snapshot)) {
        markSavedSession();
      }
    });
  return writeChain;
}

function settleScheduledPersist(error?: unknown): void {
  const resolve = resolvePersist;
  const reject = rejectPersist;
  persistPromise = null;
  resolvePersist = null;
  rejectPersist = null;
  if (error === undefined) resolve?.();
  else reject?.(error);
}

export function flushSessionSave(): Promise<void> {
  return hydrateSessionCacheFromDisk().then(() => {
    if (!cached || isFenced()) return Promise.resolve();
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    const pending = persistPromise;
    const resolve = resolvePersist;
    const reject = rejectPersist;
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
    if (!isDurableSession(cached) && hasSavedSessionMarker() && !hasConnectionPreferences(cached)) {
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
  if (isFenced()) return Promise.resolve();
  if (persistPromise) return persistPromise;
  persistPromise = new Promise<void>((resolve, reject) => {
    resolvePersist = resolve;
    rejectPersist = reject;
  });
  void persistPromise.catch(() => {});
  const timer = setTimeout(() => {
    persistTimer = null;
    void flushSessionSave();
  }, PERSIST_DEBOUNCE_MS);
  if (typeof timer === 'object' && 'unref' in timer) timer.unref();
  persistTimer = timer;
  return persistPromise;
}

installStorageCoordination(stopPersistenceForHardReset);

/** @internal — seed the obsolete localStorage payload without decoding it. */
export function _writeRawState(obj: Record<string, unknown>): void {
  writeRawObsoleteState(obj);
}

/**
 * True once we have either confirmed there is no disk identity to restore, or
 * finished merging IndexedDB into the cache. Until then, getSessionId must not
 * mint — a boot-time mint would write a new id into preferences and clobber
 * the durable hub session_id on the next peek/hydrate merge.
 */
let identityDiskChecked = false;

/** @internal — reset module state between test cases */
export function _resetForTests(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  settleScheduledPersist();
  cached = null;
  stagedTerminal = null;
  writeChain = Promise.resolve();
  identityDiskChecked = false;
  resetStorageCoordinationForTests();
}

export function loadState(): SessionSave {
  if (!cached) cached = loadPreferences();
  return cached;
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
export async function hydrateSessionCacheFromDisk(): Promise<boolean> {
  // Memory already holding durable game state must win over IndexedDB. Do not
  // require sessionId here: handshake saves often persist a cradle before any
  // hub identity exists. The old `&& cached.sessionId` guard fell through
  // in that case, re-read the older disk snapshot, and clobbered the newer
  // in-memory cradle on every flush — freezing the first persisted size.
  if (cached && isDurableSession(cached)) {
    identityDiskChecked = true;
    return false;
  }
  if (!hasSavedSessionMarker()) {
    identityDiskChecked = true;
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

  await writeChain;
  const { record, discarded } = await readCompatibleSessionRecord();
  identityDiskChecked = true;
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
    savePreferences(cached);
    return false;
  }

  // Non-resumable record: still pull hub identity if prefs lack it.
  if (
    (!mem.identity.sessionId && record.identity.sessionId) ||
    (!mem.identity.playerId && record.identity.playerId) ||
    (!mem.identity.myHubPlayerId && record.identity.myHubPlayerId)
  ) {
    cached = {
      ...mem,
      identity: {
        sessionId: mem.identity.sessionId || record.identity.sessionId,
        playerId: mem.identity.playerId || record.identity.playerId,
        myHubPlayerId: mem.identity.myHubPlayerId || record.identity.myHubPlayerId,
      },
    };
    savePreferences(cached);
  }
  return false;
}

function mutate(fn: (state: SessionSave) => SessionSave | void): Promise<void> {
  // Fast path: memory already has the resumable session, or there is no
  // marked disk session to protect. Keep this synchronous so preference
  // helpers can read their own writes immediately.
  if ((cached && isDurableSession(cached)) || !hasSavedSessionMarker()) {
    const state = loadState();
    cached = fn(state) ?? state;
    savePreferences(cached);
    return schedulePersist();
  }
  return hydrateSessionCacheFromDisk().then(() => {
    const state = loadState();
    cached = fn(state) ?? state;
    savePreferences(cached);
    return schedulePersist();
  });
}

// --- Convenience accessors ---

export function getPlayerId(): string {
  const state = loadState();
  savePreferences(state);
  return state.identity.playerId;
}

/**
 * Await before identify / hub connect on boot. Restores sessionId from
 * IndexedDB when preferences are empty, then mints only if still missing.
 * Hub player_id is assigned by the hub from this secret — never client-chosen.
 */
export async function ensureHubIdentity(): Promise<string> {
  if (hasSavedSessionMarker() && !identityDiskChecked) {
    await hydrateSessionCacheFromDisk();
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
  savePreferences(state);
  void schedulePersist();
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
  | { scope: 'presentation'; presentation: Partial<SessionPresentationSave> }
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
      case 'presentation':
        if (s.phase !== 'live') {
          throw new Error(`Cannot patch presentation while session phase is ${s.phase}`);
        }
        Object.assign(s.presentation, update.presentation);
        break;
      case 'live': {
        const common = commonFields(s);
        Object.assign(common.history, update.history);
        return {
          schema: SESSION_SAVE_SCHEMA,
          version: SESSION_SAVE_VERSION,
          phase: 'live',
          ...common,
          pairing: structuredClone(update.pairing),
          live: structuredClone(update.live),
          presentation: structuredClone(update.presentation),
        };
      }
    }
    capPersistedHistories(s);
  });
}

export function patchLiveSessionPresentation(
  presentation: Partial<SessionPresentationSave>,
): Promise<void> {
  return mutate((state) => {
    if (state.phase !== 'live') return;
    Object.assign(state.presentation, presentation);
    capPersistedHistories(state);
  });
}

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
  await hydrateSessionCacheFromDisk();
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
  await hydrateSessionCacheFromDisk();
  const current = loadState();
  stagedTerminal = {
    schema: SESSION_SAVE_SCHEMA,
    version: SESSION_SAVE_VERSION,
    phase: 'terminal',
    ...commonFields(current),
    terminal: structuredClone(fields.terminal),
    presentation: structuredClone(fields.presentation),
  };
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
  // Hydrate before any flush so a prefs-only in-memory cache cannot overwrite
  // a durable resumable record that the boot marker is advertising.
  const wipedIncompatible = await hydrateSessionCacheFromDisk();
  if (persistPromise) await flushSessionSave();
  await writeChain;
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
    savePreferences(cached);
    if (isDurableSession(cached)) {
      markSavedSession();
      return cached;
    }
    if (hasConnectionPreferences(cached)) {
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
  const deletePromise = (writeChain = writeChain
    .catch(() => {})
    .then(async () => {
      await deleteSessionRecord();
      if (cached?.preferences.blockchainType || cached?.preferences.hubUrl) {
        markSavedSession();
      } else {
        clearSavedSessionMarker();
      }
    }));
  return deletePromise;
}

export function clearSessionWithInboundRejectionReceipt(
  receipt: Omit<DurableRejectionTombstone, 'kind'>,
): Promise<void> {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  settleScheduledPersist();
  const prev = loadState();
  cached = freshSessionState(prev);
  savePreferences(cached);
  const replacePromise = (writeChain = writeChain
    .catch(() => {})
    .then(async () => {
      await replaceSessionWithInboundRejectionReceipt({
        ...receipt,
        kind: 'inbound-receipt',
      });
      if (cached?.preferences.blockchainType || cached?.preferences.hubUrl) {
        markSavedSession();
      } else {
        clearSavedSessionMarker();
      }
    }));
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

export async function hardReset(): Promise<void> {
  await hardResetStorage(stopPersistenceForHardReset);
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
  savePreferences(state);
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
  return loadState().preferences.defaultFee ?? 0n;
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
