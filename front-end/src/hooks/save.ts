import { ChannelStatusPayload } from '../types/ChiaGaming';

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
  playerCardIds: number[];
  opponentCardIds: number[];
  cardSelections: number[];
  winner: string | null;
  playerBestHandCardIds: number[];
  opponentBestHandCardIds: number[];
  playerHaloCardIds: number[];
  opponentHaloCardIds: number[];
  playerDisplayText: string;
  opponentDisplayText: string;
}

export interface CalpokerHandState {
  playerHand: number[];
  opponentHand: number[];
  moveNumber: number;
  isPlayerTurn: boolean;
  cardSelections?: number[];
  displaySnapshot?: CalpokerDisplaySnapshot;
}

type BlockchainType = 'simulator' | 'walletconnect';

/**
 * Single flat state object stored in localStorage. Stale nonce = wipe
 * everything. No nesting, no migration — alpha-mode simplicity.
 */
export interface SessionState {
  version: number;
  buildNonce?: string;

  // Identity (regenerated on wipe)
  playerId: string;
  sessionId?: string;
  alias?: string;

  // Preferences
  theme?: 'dark' | 'light';
  defaultFee?: number;
  feeUnit?: 'mojo' | 'xch';
  trackerUrl?: string;
  savedGames?: SavedGame[];

  // UI state
  activeTab?: string;
  unreadChat?: boolean;
  unreadGame?: boolean;
  walletAlert?: boolean;
  trackerAlert?: boolean;

  // Session / game state
  blockchainType?: BlockchainType;
  serializedCradle?: string;
  pairingToken?: string;
  messageNumber?: number;
  remoteNumber?: number;
  channelReady?: boolean;
  iStarted?: boolean;
  amount?: string;
  perGameAmount?: string;
  pendingTransactions?: string[];
  unackedMessages?: Array<{ msgno: number; msg: string }>;
  history?: string[];
  log?: string[];
  activeGameId?: string | null;
  handState?: CalpokerHandState | null;
  channelStatus?: ChannelStatusPayload | null;
  myAlias?: string;
  opponentAlias?: string;
  lastOutcomeWin?: 'win' | 'lose' | 'tie';
  chatMessages?: Array<{ text: string; fromAlias: string; timestamp: number; isMine: boolean }>;
  gameCoinHex?: string | null;
  gameTurnState?: string;
  gameTerminalType?: string;
  gameTerminalLabel?: string | null;
  gameTerminalReward?: string | null;
  gameTerminalRewardCoin?: string | null;
  myRunningBalance?: string;
  channelNotifQueue?: Array<{ id: number; kind: string; title: string; message: string }>;
  gameNotifQueue?: Array<{ id: number; kind: string; title: string; message: string }>;
  dismissedChannelState?: string;
  betweenHandMode?: string;
  betweenHandComposePerHand?: string;
  betweenHandLastTerms?: { my_contribution: string; their_contribution: string } | null;
  betweenHandRejectedOnceTerms?: { my_contribution: string; their_contribution: string } | null;
  betweenHandCachedPeerProposal?: { id: string; my_contribution: string; their_contribution: string } | null;
  betweenHandReviewPeerProposal?: { id: string; my_contribution: string; their_contribution: string } | null;
}

/** @deprecated — alias kept for callers that haven't been updated yet */
export type SessionSave = SessionState;

const STATE_KEY = 'appState';
const CURRENT_VERSION = 3;

function isWalletConnectStorageKey(key: string): boolean {
  const lower = key.toLowerCase();
  return lower.startsWith('wc@') || lower.includes('walletconnect') || lower.includes('wallet_connect');
}

function deleteIndexedDb(name: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
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
      await Promise.all(toDelete.map((name) => deleteIndexedDb(name)));
      return;
    } catch {
      // Fall through to known database names.
    }
  }

  const knownDbNames = [
    'WALLET_CONNECT_V2_INDEXED_DB',
    'walletconnect',
    'walletconnect-v2',
  ];
  await Promise.all(knownDbNames.map((name) => deleteIndexedDb(name)));
}

// --- In-memory cache + debounced persistence ---

let cached: SessionState | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
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

function flushToLocalStorage(): void {
  if (!cached || fenced) return;
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(cached));
  } catch (e) {
    console.error('[save] failed to persist state:', e);
  }
}

function schedulePersist(): void {
  if (persistTimer || fenced) return;
  const timer = setTimeout(() => {
    persistTimer = null;
    flushToLocalStorage();
  }, PERSIST_DEBOUNCE_MS);
  if (typeof timer === 'object' && 'unref' in timer) timer.unref();
  persistTimer = timer;
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    if (!fenced) flushToLocalStorage();
  });

  window.addEventListener('storage', (e: StorageEvent) => {
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

/** @internal — reset module state between test cases */
export function _resetForTests(): void {
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
  cached = null;
  fenced = false;
  fencedListeners.clear();
  try { localStorage.removeItem(LEASE_KEY); } catch { /* ignore */ }
}

function freshState(): SessionState {
  return { version: CURRENT_VERSION, playerId: randomHex() };
}

export function loadState(): SessionState {
  if (cached) return cached;
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.version === CURRENT_VERSION) {
        cached = parsed as SessionState;
        return cached;
      }
    }
  } catch (e) {
    console.error('[save] failed to load state:', e);
  }
  // Any old version or corrupt data → fresh start
  cached = freshState();
  return cached;
}

/** @deprecated — alias for loadState() */
export function loadAppState(): SessionState { return loadState(); }

function mutate(fn: (state: SessionState) => void): void {
  const state = loadState();
  fn(state);
  schedulePersist();
}

// --- Convenience accessors ---

export function getPlayerId(): string {
  const state = loadState();
  if (!cached) schedulePersist();
  return state.playerId;
}

export function getSessionId(): string {
  const state = loadState();
  if (state.sessionId) return state.sessionId;
  state.sessionId = randomHex();
  schedulePersist();
  return state.sessionId;
}

export function getBlockchainType(): BlockchainType | undefined {
  return loadState().blockchainType;
}

export function getBuildNonce(): string | undefined {
  if (typeof window !== 'undefined') return window.__buildNonce;
  if (typeof globalThis !== 'undefined') return (globalThis as any).__buildNonce;
  return undefined;
}

export function saveSession(fields: Partial<SessionState>): void {
  mutate(s => {
    Object.assign(s, fields);
    s.buildNonce = getBuildNonce();
  });
}

/**
 * Returns the current state if it has game-related content (blockchainType
 * or serializedCradle), null otherwise. Callers check buildNonce themselves.
 */
export function peekSession(): SessionState | null {
  const state = loadState();
  if (state.blockchainType || state.serializedCradle) return state;
  return null;
}

export function clearSession(): void {
  cached = freshState();
  flushToLocalStorage();
}

export async function hardReset(): Promise<void> {
  cached = null;
  fenced = false;
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
  try {
    localStorage.clear();
    sessionStorage.clear();
  } catch (e) {
    console.error('[save] failed to clear browser storage during hard reset:', e);
  }
  await clearWalletConnectIndexedDb();
}

// --- Alias ---

export function getAlias(): string {
  const state = loadState();
  if (state.alias) return state.alias;
  const generated = `Player_${randomHex().substring(0, 8)}`;
  state.alias = generated;
  schedulePersist();
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

export function getDefaultFee(): number {
  return loadState().defaultFee ?? 0;
}

export function setDefaultFee(fee: number): void {
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

export function getUnreadChat(): boolean {
  return loadState().unreadChat ?? false;
}

export function setUnreadChat(v: boolean): void {
  mutate(s => { s.unreadChat = v || undefined; });
}

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
