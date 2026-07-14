import { ChannelStatusPayload } from '../types/ChiaGaming';
import {
  deleteSessionRecord,
  readSessionRecord,
  SESSION_DB_NAME,
  writeSessionRecord,
} from '../lib/session/indexedDb';
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
export const CURRENT_VERSION = 5n;

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

function clearAllIndexedDbForHardReset(): void {
  try {
    if (typeof indexedDB === 'undefined') return;
    const dynamicDatabaseLookup = indexedDB as IDBFactory & { databases?: () => Promise<Array<{ name?: string }>> };
    if (typeof dynamicDatabaseLookup.databases !== 'function') {
      // Browsers without `indexedDB.databases()` (notably Safari) can't be
      // enumerated, so fall back to deleting the databases we know about (e.g.
      // WalletConnect's) rather than leaving them behind.
      console.error('[save] hard reset cannot enumerate IndexedDB databases: indexedDB.databases unavailable; falling back to known DB names');
      void Promise.all(
        KNOWN_HARD_RESET_DB_NAMES.map((name) => deleteIndexedDb(name, 'hard reset (fallback)')),
      );
      return;
    }

    void dynamicDatabaseLookup.databases()
      .then((databases) => Promise.all(
        databases
          .map((db) => db.name)
          .filter((name): name is string => typeof name === 'string' && name.length > 0)
          .map((name) => deleteIndexedDb(name, 'hard reset')),
      ))
      .catch((e) => {
        console.error('[save] failed to enumerate IndexedDB databases during hard reset:', e);
      });
  } catch (e) {
    console.error('[save] failed to start IndexedDB cleanup during hard reset:', e);
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
    if (isResumable(snapshot)) {
      localStorage.setItem(SESSION_MARKER_KEY, '1');
    } else {
      localStorage.removeItem(SESSION_MARKER_KEY);
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
  const write = queueWrite(cached);
  void write.then(
    () => resolve?.(),
    (error) => {
      console.error('[save] failed to persist session state:', error);
      reject?.(error);
    },
  );
  return pending ?? write;
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

function mutate(fn: (state: SessionState) => void): Promise<void> {
  const state = loadState();
  fn(state);
  savePreferences(state);
  return schedulePersist();
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
 * serialized cradle or leftover WalletConnect storage from a partial
 * connection. `blockchainType` alone (preserved across session clears)
 * does not count as resumable.
 */
export async function peekSession(): Promise<SessionState | null> {
  const preferences = loadState();
  if (persistPromise) await flushSessionState();
  await writeChain;
  let record = await readSessionRecord();
  if (record && record.version !== CURRENT_VERSION) {
    await deleteSessionRecord();
    localStorage.removeItem(SESSION_MARKER_KEY);
    record = null;
  }
  if (record) {
    cached = { ...preferences, ...record };
    savePreferences(cached);
    return isResumable(cached) ? cached : null;
  }
  localStorage.removeItem(SESSION_MARKER_KEY);
  cached = preferences;
  if (hasWalletConnectStorage()) return cached;
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
    if (isResumable(cached!)) {
      await writeSessionRecord(structuredClone(cached!));
      localStorage.setItem(SESSION_MARKER_KEY, '1');
    } else {
      await deleteSessionRecord();
      localStorage.removeItem(SESSION_MARKER_KEY);
    }
  });
  return deletePromise;
}

export function hardReset(): void {
  signalHardResetToOtherTabs();
  stopPersistenceForHardReset();
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
  clearAllIndexedDbForHardReset();
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
