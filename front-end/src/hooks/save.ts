import { ChannelStatusPayload } from '../types/ChiaGaming';
import {
  deleteSessionRecord,
  readSessionRecord,
  SESSION_DB_NAME,
  writeSessionRecord,
} from '../lib/session/indexedDb';
import { isDenseNumericByteObject } from '../lib/reactPropSafe';
import {
  DIAGNOSTIC_LOG_LIMIT,
  HUMAN_HISTORY_LIMIT,
  recentEntries,
  WASM_NOTIFICATION_HISTORY_LIMIT,
} from '../lib/session/historyLimits';

function randomHex(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

interface SavedGame {
  id: string;
  searchParams: Record<string, string>;
  url: string;
  [key: string]: unknown;
}

export interface CalpokerDisplaySnapshot {
  gameState: string;
  winner: string | null;
  playerBestHandCardIds: bigint[];
  opponentBestHandCardIds: bigint[];
  playerHaloCardIds: bigint[];
  opponentHaloCardIds: bigint[];
  playerDisplayText: string;
  opponentDisplayText: string;
}

export interface CalpokerHandState {
  playerHand: bigint[];
  opponentHand: bigint[];
  moveNumber: bigint;
  isPlayerTurn: boolean;
  cardSelections?: bigint[];
  displaySnapshot?: CalpokerDisplaySnapshot;
}

export interface PersistedGameState<T = unknown> {
  gameType: string;
  version: bigint;
  state: T;
}

type BlockchainType = 'simulator' | 'walletconnect';

/**
 * One complete resumable record stored by IndexedDB structured clone.
 * Stale versions are deleted rather than migrated.
 */
export interface SessionState {
  version: bigint;

  // Identity (regenerated on wipe)
  playerId: string;
  sessionId?: string;
  alias?: string;

  // Preferences
  theme?: 'dark' | 'light';
  defaultFee?: bigint;
  feeUnit?: 'mojo' | 'xch';
  trackerUrl?: string;
  savedGames?: SavedGame[];

  // UI state
  activeTab?: string;
  unreadGame?: boolean;
  walletAlert?: boolean;
  trackerAlert?: boolean;

  // Session / game state
  blockchainType?: BlockchainType;
  serializedCradle?: Uint8Array;
  cradleSchemaVersion?: bigint;
  pairingToken?: string;
  sessionPeerId?: string;
  gameSessionId?: string;
  messageNumber?: bigint;
  remoteNumber?: bigint;
  channelReady?: boolean;
  iStarted?: boolean;
  myContribution?: string;
  theirContribution?: string;
  perGameAmount?: string;
  unackedMessages?: Array<{ msgno: bigint; msg: Uint8Array }>;
  humanHistory?: string[];
  wasmNotificationHistory?: string[];
  diagnosticLog?: string[];
  historicalUnrollCount?: bigint;
  durabilityWarning?: string;
  activeGameId?: string | null;
  activeGameIds?: string[];
  currentHandGameIds?: string[];
  gameInstances?: Record<string, {
    id: string;
    amount: string;
    coinHex: string | null;
    turnState: string;
    handStatus: string;
    terminal: {
      type: string;
      label: string | null;
      myReward: string | null;
      rewardCoinHex: string | null;
      cleanEnd?: boolean;
    };
  }>;
  iProposedHand?: boolean;
  activeGameType?: string;
  handState?: PersistedGameState | null;
  channelStatus?: ChannelStatusPayload | null;
  myAlias?: string;
  opponentAlias?: string;
  lastOutcomeWin?: 'win' | 'lose' | 'tie';
  gameCoinHex?: string | null;
  gameTurnState?: string;
  gameHandStatus?: string;
  gameTerminalType?: string;
  gameTerminalLabel?: string | null;
  gameTerminalReward?: string | null;
  gameTerminalRewardCoin?: string | null;
  gameTerminalCleanEnd?: boolean;
  myRunningBalance?: string;
  channelNotifQueue?: Array<{ id: bigint; kind: string; title: string; message: string }>;
  gameNotifQueue?: Array<{ id: bigint; kind: string; title: string; message: string }>;
  dismissedChannelState?: string;
  goOnChainPressed?: boolean;
  cleanShutdownStarted?: boolean;
  betweenHandMode?: string;
  betweenHandComposePerHand?: string;
  betweenHandComposeGameTimeout?: string;
  betweenHandComposeGameType?: string;
  betweenHandLastTerms?: { my_contribution: string; their_contribution: string; game_timeout?: string; game_type?: string; spacepoker_unit_size?: string } | null;
  betweenHandRejectedOnceTerms?: { my_contribution: string; their_contribution: string; game_timeout?: string; game_type?: string; spacepoker_unit_size?: string } | null;
  betweenHandCachedPeerProposal?: { id: string; groupIds?: string[]; my_contribution: string; their_contribution: string; game_timeout?: string; game_type?: string; spacepoker_unit_size?: string } | null;
  betweenHandReviewPeerProposal?: { id: string; groupIds?: string[]; my_contribution: string; their_contribution: string; game_timeout?: string; game_type?: string; spacepoker_unit_size?: string } | null;
  outgoingProposalTerms?: Record<string, { my_contribution: string; their_contribution: string; game_timeout?: string; game_type?: string; spacepoker_unit_size?: string }>;

  // Timer persistence (epoch ms timestamps)
  waitingStateEnteredAt?: bigint;
  cleanShutdownGraceStartedAt?: bigint;
}

/** @deprecated — alias kept for callers that haven't been updated yet */
export type SessionSave = SessionState;

const STATE_KEY = 'appState';
const PREFERENCES_KEY = 'appPreferences';
const SESSION_MARKER_KEY = 'appState_savedSession';
const RESET_KEY = 'appState_hardReset';
export const CURRENT_VERSION = 6n;

// IndexedDB databases to delete when the browser can't enumerate them via
// `indexedDB.databases()` (notably Safari).  These are the databases the app
// and its dependencies are known to create; deleting a nonexistent one is a
// harmless no-op.
const KNOWN_WALLETCONNECT_DB_NAMES = [
  'WALLET_CONNECT_V2_INDEXED_DB',
  'walletconnect',
  'walletconnect-v2',
];
const KNOWN_HARD_RESET_DB_NAMES = [
  SESSION_DB_NAME,
  ...KNOWN_WALLETCONNECT_DB_NAMES,
];

function isWalletConnectStorageKey(key: string): boolean {
  const lower = key.toLowerCase();
  return lower.startsWith('wc@') || lower.includes('walletconnect') || lower.includes('wallet_connect');
}

function deleteIndexedDb(name: string, context = 'IndexedDB cleanup'): Promise<void> {
  return new Promise((resolve) => {
    try {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => {
        console.error(`[save] ${context}: failed to delete IndexedDB database "${name}":`, request.error);
        resolve();
      };
      request.onblocked = () => {
        console.warn(`[save] ${context}: deletion blocked for IndexedDB database "${name}"`);
        resolve();
      };
    } catch (e) {
      console.error(`[save] ${context}: failed to start IndexedDB database deletion for "${name}":`, e);
      resolve();
    }
  });
}

function clearWalletConnectLocalStorageKeys(): void {
  try {
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && isWalletConnectStorageKey(key)) toRemove.push(key);
    }
    for (const key of toRemove) localStorage.removeItem(key);
  } catch { /* ignore */ }
}

export async function clearWalletConnectStorage(): Promise<void> {
  clearWalletConnectLocalStorageKeys();
  await clearWalletConnectIndexedDb();
}

async function clearWalletConnectIndexedDb(): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  const dynamicDatabaseLookup = indexedDB as IDBFactory & { databases?: () => Promise<Array<{ name?: string }>> };

  if (typeof dynamicDatabaseLookup.databases === 'function') {
    try {
      const databases = await dynamicDatabaseLookup.databases();
      const toDelete = databases
        .map((db) => db.name)
        .filter((name): name is string => typeof name === 'string' && isWalletConnectStorageKey(name));
      await Promise.all(toDelete.map((name) => deleteIndexedDb(name, 'WalletConnect IndexedDB cleanup')));
      return;
    } catch {
      // Fall through to known database names.
    }
  }

  await Promise.all(
    KNOWN_WALLETCONNECT_DB_NAMES.map((name) => deleteIndexedDb(name, 'WalletConnect IndexedDB cleanup')),
  );
}

function stopPersistenceForHardReset(): void {
  cached = null;
  fenced = true;
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  settleScheduledPersist();
}

function signalHardResetToOtherTabs(): void {
  try {
    localStorage.setItem(RESET_KEY, `${Date.now()}:${randomHex()}`);
  } catch (e) {
    console.error('[save] failed to signal hard reset to other tabs:', e);
  }
}

/** Cap IndexedDB work so Start Over always reaches reload (open/databases can hang). */
export const HARD_RESET_IDB_TIMEOUT_MS = 2000;

function withTimeout(promise: Promise<void>, ms: number, label: string): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const timer = setTimeout(() => {
      console.warn(`[save] ${label} timed out after ${ms}ms; continuing hard reset`);
      finish();
    }, ms);
    promise.then(finish, (e) => {
      console.error(`[save] ${label} failed:`, e);
      finish();
    }).finally(() => clearTimeout(timer));
  });
}

async function clearAllIndexedDbForHardReset(): Promise<void> {
  try {
    if (typeof indexedDB === 'undefined') return;
    const dynamicDatabaseLookup = indexedDB as IDBFactory & { databases?: () => Promise<Array<{ name?: string }>> };
    if (typeof dynamicDatabaseLookup.databases !== 'function') {
      // Browsers without `indexedDB.databases()` (notably Safari) can't be
      // enumerated, so fall back to deleting the databases we know about (e.g.
      // WalletConnect's) rather than leaving them behind.
      console.error('[save] hard reset cannot enumerate IndexedDB databases: indexedDB.databases unavailable; falling back to known DB names');
      await Promise.all(
        KNOWN_HARD_RESET_DB_NAMES.map((name) => deleteIndexedDb(name, 'hard reset (fallback)')),
      );
      return;
    }

    const databases = await dynamicDatabaseLookup.databases();
    await Promise.all(
      databases
        .map((db) => db.name)
        .filter((name): name is string => typeof name === 'string' && name.length > 0)
        .map((name) => deleteIndexedDb(name, 'hard reset')),
    );
  } catch (e) {
    console.error('[save] failed to clear IndexedDB during hard reset:', e);
  }
}

// --- In-memory cache + debounced persistence ---

let cached: SessionState | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistPromise: Promise<void> | null = null;
let resolvePersist: (() => void) | null = null;
let rejectPersist: ((reason: unknown) => void) | null = null;
let writeChain: Promise<void> = Promise.resolve();
const PERSIST_DEBOUNCE_MS = 300;

// --- Tab lease ---

const LEASE_KEY = 'appState_activeTab';
const TAB_ID_SESSION_KEY = 'appState_tabId';
const tabId: string = (() => {
  if (typeof sessionStorage !== 'undefined') {
    const existing = sessionStorage.getItem(TAB_ID_SESSION_KEY);
    if (existing) return existing;
  }
  const id = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
    ? crypto.randomUUID()
    : randomHex();
  try { sessionStorage.setItem(TAB_ID_SESSION_KEY, id); } catch { /* ignore */ }
  return id;
})();
let fenced = false;
const fencedListeners = new Set<() => void>();

function fireFenced(): void {
  for (const cb of fencedListeners) {
    try { cb(); } catch { /* ignore */ }
  }
}

export function onFenced(cb: () => void): void { fencedListeners.add(cb); }
export function offFenced(cb: () => void): void { fencedListeners.delete(cb); }

export function isLeaseConflict(): boolean {
  try {
    const current = localStorage.getItem(LEASE_KEY);
    return current !== null && current !== tabId;
  } catch { return false; }
}

export function checkLease(): boolean {
  try {
    const current = localStorage.getItem(LEASE_KEY);
    return current === null || current === tabId;
  } catch { return true; }
}

export function claimLease(): void {
  fenced = false;
  try { localStorage.setItem(LEASE_KEY, tabId); } catch { /* ignore */ }
}

export function reclaimLease(): void {
  claimLease();
}

export function clearLease(): void {
  try { localStorage.removeItem(LEASE_KEY); } catch { /* ignore */ }
}

export function isFenced(): boolean {
  return fenced;
}

export function hasSavedSessionMarker(): boolean {
  try {
    return localStorage.getItem(SESSION_MARKER_KEY) !== null;
  } catch {
    return false;
  }
}

/** Force the boot Resume/Start Over dialog on next load. */
export function markSavedSession(): void {
  try {
    localStorage.setItem(SESSION_MARKER_KEY, '1');
  } catch { /* ignore */ }
}

/** Clear the boot Resume/Start Over marker. */
export function clearSavedSessionMarker(): void {
  try {
    localStorage.removeItem(SESSION_MARKER_KEY);
  } catch { /* ignore */ }
}

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

interface StoredPreferences {
  playerId: string;
  sessionId?: string;
  alias?: string;
  theme?: 'dark' | 'light';
  defaultFee?: string;
  feeUnit?: 'mojo' | 'xch';
  trackerUrl?: string;
  savedGames?: SavedGame[];
  activeTab?: string;
  unreadGame?: boolean;
  walletAlert?: boolean;
  trackerAlert?: boolean;
  blockchainType?: BlockchainType;
}

function savePreferences(state: SessionState): void {
  const preferences: StoredPreferences = {
    playerId: state.playerId,
    sessionId: state.sessionId,
    alias: state.alias,
    theme: state.theme,
    defaultFee: state.defaultFee?.toString(),
    feeUnit: state.feeUnit,
    trackerUrl: state.trackerUrl,
    savedGames: state.savedGames,
    activeTab: state.activeTab,
    unreadGame: state.unreadGame,
    walletAlert: state.walletAlert,
    trackerAlert: state.trackerAlert,
    blockchainType: state.blockchainType,
  };
  try {
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
  } catch (e) {
    console.error('[save] failed to persist preferences:', e);
  }
}

function loadPreferences(): SessionState {
  try {
    // The old payload may contain arbitrary stale encoding. Never inspect it.
    localStorage.removeItem(STATE_KEY);
    const raw = localStorage.getItem(PREFERENCES_KEY);
    if (raw) {
      const preferences = JSON.parse(raw) as StoredPreferences;
      if (typeof preferences.playerId === 'string') {
        return {
          version: CURRENT_VERSION,
          ...preferences,
          defaultFee: preferences.defaultFee === undefined
            ? undefined
            : BigInt(preferences.defaultFee),
        };
      }
    }
  } catch (e) {
    console.error('[save] failed to load preferences:', e);
  }
  return { version: CURRENT_VERSION, playerId: randomHex() };
}

function isResumable(state: SessionState): boolean {
  return !!(state.serializedCradle || state.pairingToken);
}

function capPersistedHistories(state: SessionState): void {
  if (state.humanHistory) {
    state.humanHistory = recentEntries(state.humanHistory, HUMAN_HISTORY_LIMIT);
  }
  if (state.wasmNotificationHistory) {
    state.wasmNotificationHistory = recentEntries(
      state.wasmNotificationHistory,
      WASM_NOTIFICATION_HISTORY_LIMIT,
    );
  }
  if (state.diagnosticLog) {
    state.diagnosticLog = recentEntries(state.diagnosticLog, DIAGNOSTIC_LOG_LIMIT);
  }
}

function estimateRecordBytes(value: unknown, seen = new Set<object>()): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'string') return new TextEncoder().encode(value).byteLength;
  if (typeof value === 'bigint') return value.toString().length;
  if (typeof value === 'boolean') return 1;
  if (typeof value !== 'object') return 8;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (seen.has(value)) return 0;
  seen.add(value);
  // Degraded cradles are plain numeric-keyed objects; do not Object.entries them
  // (enumerating hundreds of thousands of keys can OOM).
  if (!Array.isArray(value) && isDenseNumericByteObject(value)) {
    return 4096;
  }
  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + estimateRecordBytes(item, seen), 0);
  }
  return Object.entries(value as Record<string, unknown>).reduce(
    (total, [key, item]) => total + key.length * 2 + estimateRecordBytes(item, seen),
    0,
  );
}

function logPersistenceMetrics(state: SessionState): void {
  const developmentRuntime = typeof window === 'undefined'
    ? process.env.NODE_ENV !== 'production'
    : window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
  if (!developmentRuntime) return;
  console.debug('[save] persistence metrics', {
    rawCradleBytes: state.serializedCradle?.byteLength ?? 0,
    estimatedIndexedDbRecordBytes: estimateRecordBytes(state),
    historicalUnrollCount: state.historicalUnrollCount?.toString() ?? 'unavailable',
    humanHistoryCount: state.humanHistory?.length ?? 0,
    wasmNotificationHistoryCount: state.wasmNotificationHistory?.length ?? 0,
    diagnosticLogCount: state.diagnosticLog?.length ?? 0,
  });
}

function queueWrite(state: SessionState): Promise<void> {
  const snapshot = structuredClone(state);
  capPersistedHistories(snapshot);
  assertNoNumbers(snapshot, 'SessionState');
  logPersistenceMetrics(snapshot);
  writeChain = writeChain.catch(() => {}).then(async () => {
    if (fenced) return;
    await writeSessionRecord(snapshot);
    if (fenced) return;
    // Only *set* the boot marker for a durable game session here. Pre-game
    // wallet connection marks explicitly in Shell; preference-only writes must
    // not clear that marker (previously saveSession({ blockchainType }) wiped
    // it, so reload restored the wallet type with no Resume/Start Over).
    if (isResumable(snapshot)) {
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

export function flushSessionState(): Promise<void> {
  return hydrateSessionCacheFromDisk().then(() => {
    if (!cached || fenced) return Promise.resolve();
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
    if (!isResumable(cached) && hasSavedSessionMarker() && !cached.blockchainType) {
      const error = new Error(
        'Refusing to persist non-resumable in-memory state over a marked saved session',
      );
      console.error('[save]', error.message);
      reject?.(error);
      return Promise.reject(error);
    }
    const write = queueWrite(cached);
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
  if (fenced) return Promise.resolve();
  if (persistPromise) return persistPromise;
  persistPromise = new Promise<void>((resolve, reject) => {
    resolvePersist = resolve;
    rejectPersist = reject;
  });
  void persistPromise.catch(() => {});
  const timer = setTimeout(() => {
    persistTimer = null;
    void flushSessionState();
  }, PERSIST_DEBOUNCE_MS);
  if (typeof timer === 'object' && 'unref' in timer) timer.unref();
  persistTimer = timer;
  return persistPromise;
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e: StorageEvent) => {
    if (e.key === RESET_KEY) {
      stopPersistenceForHardReset();
      window.location.reload();
      return;
    }
    if (e.key === LEASE_KEY && e.newValue !== tabId && !fenced) {
      fenced = true;
      fireFenced();
    }
  });

  setInterval(() => {
    if (fenced) return;
    if (!checkLease()) {
      fenced = true;
      fireFenced();
    }
  }, 3000);
}

/** @internal — seed the obsolete localStorage payload without decoding it. */
export function _writeRawState(obj: Record<string, unknown>): void {
  localStorage.setItem(STATE_KEY, JSON.stringify(obj));
}

/** @internal — reset module state between test cases */
export function _resetForTests(): void {
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
  settleScheduledPersist();
  cached = null;
  writeChain = Promise.resolve();
  fenced = false;
  fencedListeners.clear();
  try { localStorage.removeItem(LEASE_KEY); } catch { /* ignore */ }
  try { localStorage.removeItem(RESET_KEY); } catch { /* ignore */ }
}

export function loadState(): SessionState {
  if (!cached) cached = loadPreferences();
  return cached;
}

/** @deprecated — alias for loadState() */
export function loadAppState(): SessionState { return loadState(); }

/**
 * Ensure in-memory `cached` includes any resumable IndexedDB record before
 * mutating/persisting. Boot can show the resume dialog from the sync marker
 * without reading IndexedDB; without this, preference-only patches (logs,
 * alerts, etc.) would overwrite the durable cradle with a non-resumable
 * record and make Resume report "saved session unavailable".
 */
export async function hydrateSessionCacheFromDisk(): Promise<void> {
  if (cached && isResumable(cached)) return;
  if (!hasSavedSessionMarker()) return;

  // Do not flush a prefs-only cache over disk. Cancel the debounce; the caller
  // will schedule a new persist after merging with the hydrated record.
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (persistPromise && cached && !isResumable(cached)) {
    settleScheduledPersist();
  }

  await writeChain;
  const record = await readSessionRecord();
  if (!record || record.version !== CURRENT_VERSION || !isResumable(record)) return;

  const mem = cached ?? loadPreferences();
  cached = {
    ...record,
    playerId: mem.playerId,
    sessionId: mem.sessionId ?? record.sessionId,
    alias: mem.alias ?? record.alias,
    theme: mem.theme ?? record.theme,
    defaultFee: mem.defaultFee ?? record.defaultFee,
    feeUnit: mem.feeUnit ?? record.feeUnit,
    trackerUrl: mem.trackerUrl ?? record.trackerUrl,
    savedGames: mem.savedGames ?? record.savedGames,
    activeTab: mem.activeTab ?? record.activeTab,
    unreadGame: mem.unreadGame ?? record.unreadGame,
    walletAlert: mem.walletAlert ?? record.walletAlert,
    trackerAlert: mem.trackerAlert ?? record.trackerAlert,
    blockchainType: mem.blockchainType ?? record.blockchainType,
    humanHistory: mem.humanHistory ?? record.humanHistory,
    diagnosticLog: mem.diagnosticLog ?? record.diagnosticLog,
    wasmNotificationHistory: mem.wasmNotificationHistory ?? record.wasmNotificationHistory,
  };
}

function mutate(fn: (state: SessionState) => void): Promise<void> {
  // Fast path: memory already has the resumable session, or there is no
  // marked disk session to protect. Keep this synchronous so preference
  // helpers can read their own writes immediately.
  if ((cached && isResumable(cached)) || !hasSavedSessionMarker()) {
    const state = loadState();
    fn(state);
    savePreferences(state);
    return schedulePersist();
  }
  return hydrateSessionCacheFromDisk().then(() => {
    const state = loadState();
    fn(state);
    savePreferences(state);
    return schedulePersist();
  });
}

// --- Convenience accessors ---

export function getPlayerId(): string {
  const state = loadState();
  savePreferences(state);
  return state.playerId;
}

export function getSessionId(): string {
  const state = loadState();
  if (state.sessionId) return state.sessionId;
  state.sessionId = randomHex();
  savePreferences(state);
  return state.sessionId;
}

export function regenerateSessionId(): string {
  const state = loadState();
  state.sessionId = randomHex();
  savePreferences(state);
  return state.sessionId;
}

export function clearSessionId(): void {
  mutate(s => { s.sessionId = undefined; });
}

export function getBlockchainType(): BlockchainType | undefined {
  return loadState().blockchainType;
}

export function saveSession(fields: Partial<SessionState>): Promise<void> {
  return mutate(s => {
    Object.assign(s, fields);
    capPersistedHistories(s);
  });
}

function hasWalletConnectStorage(): boolean {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && isWalletConnectStorageKey(key)) return true;
    }
  } catch { /* ignore */ }
  return false;
}

/**
 * Returns the current state if there's anything worth resuming — a
 * serialized cradle, pairing token, pre-game wallet choice with an active
 * boot marker, or leftover WalletConnect storage from a partial connection.
 * `blockchainType` alone (preserved across session clears, without a marker)
 * does not count as resumable.
 */
export async function peekSession(): Promise<SessionState | null> {
  // Hydrate before any flush so a prefs-only in-memory cache cannot overwrite
  // a durable resumable record that the boot marker is advertising.
  await hydrateSessionCacheFromDisk();
  if (persistPromise) await flushSessionState();
  await writeChain;
  let record = await readSessionRecord();
  if (record && record.version !== CURRENT_VERSION) {
    // Wipe the unreadable record but keep the boot marker so reload still
    // forces Resume/Start Over instead of silently booting into leftover
    // preference state (e.g. blockchainType).
    await deleteSessionRecord();
    markSavedSession();
    cached = loadPreferences();
    return null;
  }
  if (record) {
    const preferences = loadPreferences();
    cached = { ...preferences, ...record };
    savePreferences(cached);
    if (isResumable(cached)) {
      markSavedSession();
      return cached;
    }
    // Pre-game: wallet type chosen / connected, marker set by Shell.
    if (hasSavedSessionMarker() && cached.blockchainType) {
      return cached;
    }
    clearSavedSessionMarker();
    return null;
  }
  cached = loadPreferences();
  if (hasSavedSessionMarker() && cached.blockchainType) {
    return cached;
  }
  if (hasWalletConnectStorage()) {
    return cached;
  }
  clearSavedSessionMarker();
  return null;
}

export function clearSession(): Promise<void> {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  settleScheduledPersist();
  const prev = loadState();
  cached = {
    version: CURRENT_VERSION,
    playerId: prev.playerId,
    sessionId: prev.sessionId,
    alias: prev.alias,
    theme: prev.theme,
    defaultFee: prev.defaultFee,
    feeUnit: prev.feeUnit,
    trackerUrl: prev.trackerUrl,
    savedGames: prev.savedGames,
    activeTab: prev.activeTab,
    unreadGame: prev.unreadGame,
    walletAlert: prev.walletAlert,
    trackerAlert: prev.trackerAlert,
    blockchainType: prev.blockchainType,
  };
  savePreferences(cached);
  const deletePromise = writeChain = writeChain.catch(() => {}).then(async () => {
    await deleteSessionRecord();
    clearSavedSessionMarker();
  });
  return deletePromise;
}

export async function hardReset(): Promise<void> {
  signalHardResetToOtherTabs();
  stopPersistenceForHardReset();
  // Clear sync storage first so the boot marker is gone even if IndexedDB hangs
  // (open / databases() can stall indefinitely with open WalletConnect connections).
  try {
    localStorage.clear();
  } catch (e) {
    console.error('[save] failed to clear localStorage during hard reset:', e);
  }
  try {
    sessionStorage.clear();
  } catch (e) {
    console.error('[save] failed to clear sessionStorage during hard reset:', e);
  }
  await withTimeout((async () => {
    if (typeof indexedDB !== 'undefined' && typeof indexedDB.open === 'function') {
      try {
        await deleteSessionRecord();
      } catch (e) {
        console.error('[save] failed to delete session record during hard reset:', e);
      }
    }
    await clearAllIndexedDbForHardReset();
  })(), HARD_RESET_IDB_TIMEOUT_MS, 'IndexedDB hard reset cleanup');
}

// --- Alias ---

export function getAlias(): string {
  const state = loadState();
  if (state.alias) return state.alias;
  const generated = `Player_${randomHex().substring(0, 8)}`;
  state.alias = generated;
  savePreferences(state);
  return generated;
}

export function setAlias(alias: string): void {
  mutate(s => { s.alias = alias; });
}

// --- Theme ---

export function getTheme(): 'dark' | 'light' | undefined {
  return loadState().theme;
}

export function setTheme(theme: 'dark' | 'light'): void {
  mutate(s => { s.theme = theme; });
}

// --- Default fee ---

export function getDefaultFee(): bigint {
  return loadState().defaultFee ?? 0n;
}

export function setDefaultFee(fee: bigint): void {
  mutate(s => { s.defaultFee = fee; });
}

export function getFeeUnit(): 'mojo' | 'xch' {
  return loadState().feeUnit ?? 'mojo';
}

export function setFeeUnit(unit: 'mojo' | 'xch'): void {
  mutate(s => { s.feeUnit = unit; });
}

// --- Active tab ---

export function getActiveTab(): string | undefined {
  return loadState().activeTab;
}

export function setActiveTab(tab: string): void {
  mutate(s => { s.activeTab = tab; });
}

// --- Notification badges ---

export function getUnreadGame(): boolean {
  return loadState().unreadGame ?? false;
}

export function setUnreadGame(v: boolean): void {
  mutate(s => { s.unreadGame = v || undefined; });
}

export function getWalletAlert(): boolean {
  return loadState().walletAlert ?? false;
}

export function setWalletAlert(v: boolean): void {
  mutate(s => { s.walletAlert = v || undefined; });
}

export function getTrackerAlert(): boolean {
  return loadState().trackerAlert ?? false;
}

export function setTrackerAlert(v: boolean): void {
  mutate(s => { s.trackerAlert = v || undefined; });
}

// --- Tracker URL ---

export function getTrackerUrl(): string | undefined {
  return loadState().trackerUrl;
}

export function setTrackerUrl(url: string | undefined): void {
  mutate(s => { s.trackerUrl = url || undefined; });
}

// --- Saved games ---

export function getSaveList(): string[] {
  return (loadState().savedGames ?? []).map(g => g.id);
}

export function startNewSession() {
  // Do not set SESSION_MARKER_KEY here. The marker must mean a durable
  // resumable IndexedDB record exists; setting it early makes boot show
  // Resume/Start Over before anything can be resumed.
  mutate(s => { s.savedGames = []; });
}

export function saveGame(g: SavedGame): [string, unknown] | undefined {
  try {
    mutate(s => {
      const games = s.savedGames ?? [];
      if (games.length > 2) games.pop();
      games.unshift(g);
      s.savedGames = games;
    });
    return undefined;
  } catch (e) {
    return ["Error saving game turn", e];
  }
}

export function loadSave(saveId: string): SavedGame | undefined {
  return (loadState().savedGames ?? []).find(g => g.id === saveId);
}
