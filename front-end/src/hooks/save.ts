import { ChannelStatusPayload } from '../types/ChiaGaming';
import { jsonParse, jsonStringify } from '../util/jsonSafe';

export function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function randomHex(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// --- Save-state obfuscation ---

const OBFUSCATION_KEY = new Uint8Array([
  0x4a, 0x7f, 0x2c, 0x91, 0xd3, 0x56, 0xe8, 0x1b,
  0xa0, 0x63, 0xf5, 0x38, 0xc4, 0x87, 0x0e, 0x6d,
]);
const SALT_LEN = 16;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array {
  const result = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < hex.length; i += 2) {
    result[i >> 1] = parseInt(hex.slice(i, i + 2), 16);
  }
  return result;
}

function rc4Keystream(key: Uint8Array, length: number): Uint8Array {
  const S = new Uint8Array(256);
  for (let i = 0; i < 256; i++) S[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + S[i] + key[i % key.length]) & 0xff;
    [S[i], S[j]] = [S[j], S[i]];
  }
  const stream = new Uint8Array(length);
  let a = 0;
  j = 0;
  for (let k = 0; k < length; k++) {
    a = (a + 1) & 0xff;
    j = (j + S[a]) & 0xff;
    [S[a], S[j]] = [S[j], S[a]];
    stream[k] = S[(S[a] + S[j]) & 0xff];
  }
  return stream;
}

function obfuscate(json: string): string {
  const plaintext = new TextEncoder().encode(json);
  const salt = new Uint8Array(SALT_LEN);
  crypto.getRandomValues(salt);
  const key = new Uint8Array(SALT_LEN + OBFUSCATION_KEY.length);
  key.set(salt);
  key.set(OBFUSCATION_KEY, SALT_LEN);
  const stream = rc4Keystream(key, plaintext.length);
  const out = new Uint8Array(SALT_LEN + plaintext.length);
  out.set(salt);
  for (let i = 0; i < plaintext.length; i++) {
    out[SALT_LEN + i] = plaintext[i] ^ stream[i];
  }
  return bytesToHex(out);
}

function deobfuscate(hex: string): string {
  const bytes = hexToBytes(hex);
  const salt = bytes.slice(0, SALT_LEN);
  const ciphertext = bytes.slice(SALT_LEN);
  const key = new Uint8Array(SALT_LEN + OBFUSCATION_KEY.length);
  key.set(salt);
  key.set(OBFUSCATION_KEY, SALT_LEN);
  const stream = rc4Keystream(key, ciphertext.length);
  const plaintext = new Uint8Array(ciphertext.length);
  for (let i = 0; i < ciphertext.length; i++) {
    plaintext[i] = ciphertext[i] ^ stream[i];
  }
  return new TextDecoder().decode(plaintext);
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
  defaultFee?: bigint;
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
  gameTerminalCleanEnd?: boolean;
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

export function clearWalletConnectStorage(): void {
  clearWalletConnectLocalStorageKeys();
  void clearWalletConnectIndexedDb();
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
    localStorage.setItem(STATE_KEY, obfuscate(jsonStringify(cached)));
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

/** @internal — write obfuscated JSON to STATE_KEY (for tests that need to seed localStorage) */
export function _writeRawState(obj: Record<string, unknown>): void {
  localStorage.setItem(STATE_KEY, obfuscate(jsonStringify(obj)));
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
      const json = deobfuscate(raw);
      const parsed = jsonParse(json);
      if (parsed.version == CURRENT_VERSION) {
        cached = parsed as SessionState;
        return cached;
      }
    }
  } catch (e) {
    console.error('[save] failed to load state:', e);
  }
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
 * does not count as resumable. Callers check buildNonce themselves.
 */
export function peekSession(): SessionState | null {
  const state = loadState();
  if (state.blockchainType || state.serializedCradle || state.pairingToken) return state;
  if (hasWalletConnectStorage()) return state;
  return null;
}

export function clearSession(): void {
  const prev = loadState();
  cached = {
    version: prev.version,
    buildNonce: prev.buildNonce,
    playerId: prev.playerId,
    sessionId: prev.sessionId,
    alias: prev.alias,
    theme: prev.theme,
    defaultFee: prev.defaultFee,
    feeUnit: prev.feeUnit,
    trackerUrl: prev.trackerUrl,
    savedGames: prev.savedGames,
    activeTab: prev.activeTab,
    unreadChat: prev.unreadChat,
    unreadGame: prev.unreadGame,
    walletAlert: prev.walletAlert,
    trackerAlert: prev.trackerAlert,
    blockchainType: prev.blockchainType,
  };
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
