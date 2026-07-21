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
export interface SessionSave {
  version: bigint;

  // Identity (regenerated on wipe)
  playerId: string;
  sessionId?: string;
  alias?: string;

  // Preferences
  theme?: 'dark' | 'light';
  defaultFee?: bigint;
  feeUnit?: 'mojo' | 'xch';
  hubUrl?: string;

  // UI state
  activeTab?: string;
  unreadGame?: boolean;
  walletAlert?: boolean;
  hubAlert?: boolean;

  // Session / game state
  blockchainType?: BlockchainType;
  serializedGameSession?: Uint8Array;
  gameSessionSchemaVersion?: bigint;
  pairingToken?: string;
  sessionPeerId?: string;
  /** Last player_id from hub `registered`. Remap during pre-cradle resume means rematch. */
  myHubPlayerId?: string;
  gameSessionId?: string;
  messageNumber?: bigint;
  remoteNumber?: bigint;
  channelReady?: boolean;
  iStarted?: boolean;
  myContribution?: string;
  theirContribution?: string;
  perGameAmount?: string;
  /** Blocks; persisted so a deploy-stale reload can resume pre-cradle handshake. */
  channelTimeout?: string;
  unrollTimeout?: string;
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
      outcome?: string | null;
      label: string | null;
      myReward: string | null;
      rewardCoinHex: string | null;
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
  gameTerminalOutcome?: string;
  gameTerminalLabel?: string | null;
  gameTerminalReward?: string | null;
  gameTerminalRewardCoin?: string | null;
  myRunningBalance?: string;
  channelNotifQueue?: Array<{ id: bigint; kind: string; title: string; message: string }>;
  gameNotifQueue?: Array<{ id: bigint; kind: string; title: string; message: string }>;
  dismissedChannelStatus?: string;
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
const STATE_KEY = 'appState';
const PREFERENCES_KEY = 'appPreferences';
const SESSION_MARKER_KEY = 'appState_savedSession';
/** One-shot: stale-deploy reload should auto-resume without the prompt. */
const AUTO_RESUME_ONCE_KEY = 'appState_autoResumeOnce';
/**
 * In-memory latch so a remount (React Strict Mode) after sessionStorage was
 * cleared mid-resume cannot fall through to the Resume/Start Over dialog.
 */
let autoResumeLatch = false;
const RESET_KEY = 'appState_hardReset';
export const CURRENT_VERSION = 8n;

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
      // Blocked means another connection is still open. Keep waiting for
      // onsuccess/onerror — resolving early would let hardReset claim a wipe
      // that has not happened yet.
      request.onblocked = () => {
        console.warn(`[save] ${context}: deletion blocked for IndexedDB database "${name}"; waiting for other connections to close`);
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

async function clearAllIndexedDbForHardReset(): Promise<void> {
  if (typeof indexedDB === 'undefined') return;

  // Always wipe known databases first. Enumeration can hang while WalletConnect
  // (or other) connections are still open; known deletes must not wait on that.
  await Promise.all(
    KNOWN_HARD_RESET_DB_NAMES.map((name) => deleteIndexedDb(name, 'hard reset')),
  );

  const dynamicDatabaseLookup = indexedDB as IDBFactory & { databases?: () => Promise<Array<{ name?: string }>> };
  if (typeof dynamicDatabaseLookup.databases !== 'function') {
    console.error('[save] hard reset cannot enumerate IndexedDB databases: indexedDB.databases unavailable; known DB names already deleted');
    return;
  }

  try {
    const databases = await dynamicDatabaseLookup.databases();
    const known = new Set(KNOWN_HARD_RESET_DB_NAMES);
    await Promise.all(
      databases
        .map((db) => db.name)
        .filter((name): name is string => typeof name === 'string' && name.length > 0 && !known.has(name))
        .map((name) => deleteIndexedDb(name, 'hard reset')),
    );
  } catch (e) {
    console.error('[save] failed to enumerate IndexedDB during hard reset:', e);
  }
}

// --- In-memory cache + debounced persistence ---

let cached: SessionSave | null = null;
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

/**
 * True when prefs remember a wallet choice and/or hub, or WC left storage.
 * Independent of whether a game session / cradle exists.
 */
export function hasConnectionPreferences(
  state: SessionSave = loadPreferences(),
): boolean {
  return !!(
    state.blockchainType
    || state.hubUrl
    || hasWalletConnectStorage()
  );
}

/**
 * True when boot should offer Resume / Start Over.
 * Connection prefs count even with no game session; the session marker
 * covers durable cradles / prior explicit save intent.
 */
export function shouldOfferResumeOrStartOver(
  state: SessionSave = loadPreferences(),
): boolean {
  return hasConnectionPreferences(state) || hasSavedSessionMarker();
}

/** Force the boot Resume/Start Over dialog on next load. */
export function markSavedSession(): void {
  try {
    localStorage.setItem(SESSION_MARKER_KEY, '1');
  } catch { /* ignore */ }
}

/**
 * Mark the next boot to skip Resume/Start Over and resume automatically.
 * Used only for the stale-deploy asset 404 → reload path.
 * Stored in sessionStorage so it survives reload of the same tab/origin.
 */
export function markAutoResumeOnce(): void {
  try {
    sessionStorage.setItem(AUTO_RESUME_ONCE_KEY, '1');
  } catch { /* ignore */ }
}

/**
 * True when this boot should auto-resume. Also latches in memory so clearing
 * sessionStorage mid-resume cannot re-show the resume dialog on remount.
 */
export function peekAutoResumeOnce(): boolean {
  if (autoResumeLatch) return true;
  try {
    if (sessionStorage.getItem(AUTO_RESUME_ONCE_KEY) !== null) {
      autoResumeLatch = true;
      return true;
    }
  } catch { /* ignore */ }
  return false;
}

/**
 * Drop the one-shot auto-resume flag after resume has committed (or failed
 * into an explicit dialog). Safe to call multiple times.
 */
export function clearAutoResumeOnce(): void {
  autoResumeLatch = false;
  try {
    sessionStorage.removeItem(AUTO_RESUME_ONCE_KEY);
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
  /** Last hub-assigned player_id (public). For remap detection only — never sent to claim identity. */
  myHubPlayerId?: string;
  alias?: string;
  theme?: 'dark' | 'light';
  defaultFee?: string;
  feeUnit?: 'mojo' | 'xch';
  hubUrl?: string;
  activeTab?: string;
  unreadGame?: boolean;
  walletAlert?: boolean;
  hubAlert?: boolean;
  blockchainType?: BlockchainType;
}

function savePreferences(state: SessionSave): void {
  const preferences: StoredPreferences = {
    playerId: state.playerId,
    sessionId: state.sessionId,
    myHubPlayerId: state.myHubPlayerId,
    alias: state.alias,
    theme: state.theme,
    defaultFee: state.defaultFee?.toString(),
    feeUnit: state.feeUnit,
    hubUrl: state.hubUrl,
    activeTab: state.activeTab,
    unreadGame: state.unreadGame,
    walletAlert: state.walletAlert,
    hubAlert: state.hubAlert,
    blockchainType: state.blockchainType,
  };
  try {
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
  } catch (e) {
    console.error('[save] failed to persist preferences:', e);
  }
}

function loadPreferences(): SessionSave {
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

function isTerminalFinishedChannel(state: string | null | undefined): boolean {
  return state === 'ResolvedClean'
    || state === 'ResolvedUnrolled'
    || state === 'ResolvedStale'
    || state === 'Failed';
}

/**
 * True when disk state should keep the boot Resume/Start Over marker.
 * Includes finished/terminal channel snapshots (no live cradle) so a clean
 * shutdown does not silently boot into leftover hub prefs with no dialog.
 */
function isResumable(state: SessionSave): boolean {
  return !!(
    state.serializedGameSession
    || state.pairingToken
    || (state.channelStatus && isTerminalFinishedChannel(state.channelStatus.state))
  );
}

function capPersistedHistories(state: SessionSave): void {
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

function queueWrite(state: SessionSave): Promise<void> {
  const snapshot = structuredClone(state);
  capPersistedHistories(snapshot);
  assertNoNumbers(snapshot, 'SessionSave');
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

export function flushSessionSave(): Promise<void> {
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
    if (!isResumable(cached) && hasSavedSessionMarker() && !hasConnectionPreferences(cached)) {
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
    void flushSessionSave();
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

/**
 * True once we have either confirmed there is no disk identity to restore, or
 * finished merging IndexedDB into the cache. Until then, getSessionId must not
 * mint — a boot-time mint would write a new id into preferences and clobber
 * the durable hub session_id on the next peek/hydrate merge.
 */
let identityDiskChecked = false;

/** @internal — reset module state between test cases */
export function _resetForTests(): void {
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
  settleScheduledPersist();
  cached = null;
  writeChain = Promise.resolve();
  fenced = false;
  fencedListeners.clear();
  identityDiskChecked = false;
  autoResumeLatch = false;
  try { localStorage.removeItem(LEASE_KEY); } catch { /* ignore */ }
  try { localStorage.removeItem(RESET_KEY); } catch { /* ignore */ }
  try { sessionStorage.removeItem(AUTO_RESUME_ONCE_KEY); } catch { /* ignore */ }
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
export async function hydrateSessionCacheFromDisk(): Promise<void> {
  // Memory already holding durable game state must win over IndexedDB. Do not
  // require sessionId here: handshake saves often persist a cradle before any
  // hub identity exists. The old `&& cached.sessionId` guard fell through
  // in that case, re-read the older disk snapshot, and clobbered the newer
  // in-memory cradle on every flush — freezing the first persisted size.
  if (cached && isResumable(cached)) {
    identityDiskChecked = true;
    return;
  }
  if (!hasSavedSessionMarker()) {
    identityDiskChecked = true;
    return;
  }

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
  identityDiskChecked = true;
  if (!record || record.version !== CURRENT_VERSION) return;

  const mem = cached ?? loadPreferences();
  if (isResumable(record)) {
    cached = {
      ...record,
      playerId: mem.playerId || record.playerId,
      // Prefer disk when prefs are empty so a pre-hydrate remint cannot win.
      sessionId: mem.sessionId || record.sessionId,
      myHubPlayerId: mem.myHubPlayerId || record.myHubPlayerId,
      alias: mem.alias ?? record.alias,
      theme: mem.theme ?? record.theme,
      defaultFee: mem.defaultFee ?? record.defaultFee,
      feeUnit: mem.feeUnit ?? record.feeUnit,
      hubUrl: mem.hubUrl ?? record.hubUrl,
      activeTab: mem.activeTab ?? record.activeTab,
      unreadGame: mem.unreadGame ?? record.unreadGame,
      walletAlert: mem.walletAlert ?? record.walletAlert,
      hubAlert: mem.hubAlert ?? record.hubAlert,
      blockchainType: mem.blockchainType ?? record.blockchainType,
      humanHistory: mem.humanHistory ?? record.humanHistory,
      diagnosticLog: mem.diagnosticLog ?? record.diagnosticLog,
      wasmNotificationHistory: mem.wasmNotificationHistory ?? record.wasmNotificationHistory,
    };
    savePreferences(cached);
    return;
  }

  // Non-resumable record: still pull hub identity if prefs lack it.
  if (
    (!mem.sessionId && record.sessionId)
    || (!mem.playerId && record.playerId)
    || (!mem.myHubPlayerId && record.myHubPlayerId)
  ) {
    cached = {
      ...mem,
      sessionId: mem.sessionId || record.sessionId,
      playerId: mem.playerId || record.playerId,
      myHubPlayerId: mem.myHubPlayerId || record.myHubPlayerId,
    };
    savePreferences(cached);
  }
}

function mutate(fn: (state: SessionSave) => void): Promise<void> {
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
  return loadState().myHubPlayerId;
}

export function getSessionId(): string {
  const state = loadState();
  if (state.sessionId) return state.sessionId;
  // A saved-session marker means disk may still hold the real hub
  // session_id. Minting here would poison preferences and win the merge.
  if (hasSavedSessionMarker() && !identityDiskChecked) {
    throw new Error(
      'getSessionId called before ensureHubIdentity/hydrate with a saved session marker',
    );
  }
  state.sessionId = randomHex();
  savePreferences(state);
  // Also land in IndexedDB so a later hydrate cannot "lose" the id that only
  // lived in localStorage preferences.
  void schedulePersist();
  return state.sessionId;
}

export function regenerateSessionId(): string {
  identityDiskChecked = true;
  const state = loadState();
  state.sessionId = randomHex();
  state.myHubPlayerId = undefined;
  savePreferences(state);
  void schedulePersist();
  return state.sessionId;
}

export function clearSessionId(): void {
  // Intentional clear — next getSessionId may mint a replacement.
  identityDiskChecked = true;
  mutate(s => {
    s.sessionId = undefined;
    s.myHubPlayerId = undefined;
  });
}

export function getBlockchainType(): BlockchainType | undefined {
  return loadState().blockchainType;
}

export function saveSession(fields: Partial<SessionSave>): Promise<void> {
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
 * serialized cradle, pairing token, finished/terminal channel snapshot,
 * remembered wallet and/or hub choice, or leftover WalletConnect storage.
 */
export async function peekSession(): Promise<SessionSave | null> {
  // Hydrate before any flush so a prefs-only in-memory cache cannot overwrite
  // a durable resumable record that the boot marker is advertising.
  await hydrateSessionCacheFromDisk();
  if (persistPromise) await flushSessionSave();
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
    // Never let a disk record clobber stable local identity. Hub player_id
    // is keyed by session_id; reminting on reload breaks pre-cradle routing.
    cached = {
      ...preferences,
      ...record,
      playerId: preferences.playerId || record.playerId,
      sessionId: preferences.sessionId || record.sessionId,
      myHubPlayerId: preferences.myHubPlayerId || record.myHubPlayerId,
    };
    savePreferences(cached);
    if (isResumable(cached)) {
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
    myHubPlayerId: prev.myHubPlayerId,
    alias: prev.alias,
    theme: prev.theme,
    defaultFee: prev.defaultFee,
    feeUnit: prev.feeUnit,
    hubUrl: prev.hubUrl,
    activeTab: prev.activeTab,
    unreadGame: prev.unreadGame,
    walletAlert: prev.walletAlert,
    hubAlert: prev.hubAlert,
    blockchainType: prev.blockchainType,
  };
  savePreferences(cached);
  const deletePromise = writeChain = writeChain.catch(() => {}).then(async () => {
    await deleteSessionRecord();
    if (cached?.blockchainType || cached?.hubUrl) {
      markSavedSession();
    } else {
      clearSavedSessionMarker();
    }
  });
  return deletePromise;
}

/**
 * Drop durable cradle/game state only after we know a new session can start
 * (e.g. deploy assets loaded). Keeps connection prefs, history/logs, and any
 * pre-cradle handshake fields (pairingToken, amounts, peer ids, timeouts).
 */
export async function clearGameSessionPreservingHistory(): Promise<void> {
  const prev = loadState();
  const preserved = {
    humanHistory: prev.humanHistory,
    diagnosticLog: prev.diagnosticLog,
    wasmNotificationHistory: prev.wasmNotificationHistory,
    sessionPeerId: prev.sessionPeerId,
    myHubPlayerId: prev.myHubPlayerId,
    gameSessionId: prev.gameSessionId,
    pairingToken: prev.pairingToken,
    iStarted: prev.iStarted,
    myContribution: prev.myContribution,
    theirContribution: prev.theirContribution,
    perGameAmount: prev.perGameAmount,
    channelTimeout: prev.channelTimeout,
    unrollTimeout: prev.unrollTimeout,
    myAlias: prev.myAlias,
    opponentAlias: prev.opponentAlias,
  };
  await clearSession();
  const toSave: Partial<SessionSave> = {};
  if (preserved.humanHistory && preserved.humanHistory.length > 0) {
    toSave.humanHistory = preserved.humanHistory;
  }
  if (preserved.diagnosticLog && preserved.diagnosticLog.length > 0) {
    toSave.diagnosticLog = preserved.diagnosticLog;
  }
  if (preserved.wasmNotificationHistory && preserved.wasmNotificationHistory.length > 0) {
    toSave.wasmNotificationHistory = preserved.wasmNotificationHistory;
  }
  if (preserved.sessionPeerId) toSave.sessionPeerId = preserved.sessionPeerId;
  if (preserved.myHubPlayerId) toSave.myHubPlayerId = preserved.myHubPlayerId;
  if (preserved.gameSessionId) toSave.gameSessionId = preserved.gameSessionId;
  if (preserved.pairingToken) toSave.pairingToken = preserved.pairingToken;
  if (preserved.iStarted !== undefined) toSave.iStarted = preserved.iStarted;
  if (preserved.myContribution) toSave.myContribution = preserved.myContribution;
  if (preserved.theirContribution) toSave.theirContribution = preserved.theirContribution;
  if (preserved.perGameAmount) toSave.perGameAmount = preserved.perGameAmount;
  if (preserved.channelTimeout) toSave.channelTimeout = preserved.channelTimeout;
  if (preserved.unrollTimeout) toSave.unrollTimeout = preserved.unrollTimeout;
  if (preserved.myAlias) toSave.myAlias = preserved.myAlias;
  if (preserved.opponentAlias) toSave.opponentAlias = preserved.opponentAlias;
  if (Object.keys(toSave).length === 0) return;
  saveSession(toSave);
  await flushSessionSave();
}

export async function hardReset(): Promise<void> {
  signalHardResetToOtherTabs();
  stopPersistenceForHardReset();
  // Sync storage first so a later IndexedDB hang cannot leave the boot marker
  // or preferences behind after the caller reloads. IndexedDB wipe still runs
  // to completion below — hardReset must obliterate, not time out.
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
  await clearAllIndexedDbForHardReset();
}

// --- Alias ---

/** Return the stored hub alias without inventing a fallback. */
export function peekAlias(): string | undefined {
  return loadState().alias;
}

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

export function getHubAlert(): boolean {
  return loadState().hubAlert ?? false;
}

export function setHubAlert(v: boolean): void {
  mutate(s => { s.hubAlert = v || undefined; });
}

// --- Hub URL ---

export function getHubUrl(): string | undefined {
  return loadState().hubUrl;
}

export function setHubUrl(url: string | undefined): void {
  mutate(s => { s.hubUrl = url || undefined; });
  if (url) markSavedSession();
}

