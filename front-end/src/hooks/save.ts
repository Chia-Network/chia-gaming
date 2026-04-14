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

export interface SessionSave {
  serializedCradle: string;
  pairingToken: string;
  messageNumber: number;
  remoteNumber: number;
  channelReady: boolean;
  iStarted: boolean;
  amount: string;
  perGameAmount: string;
  pendingTransactions: string[];
  unackedMessages: Array<{ msgno: number; msg: string }>;
  gameLog: string[];
  debugLog: string[];
  activeGameId?: string | null;
  handState?: CalpokerHandState | null;
  channelStatus?: ChannelStatusPayload | null;
  myAlias?: string;
  opponentAlias?: string;
  showBetweenHandOverlay?: boolean;
  lastOutcomeWin?: 'win' | 'lose' | 'tie';
  chatMessages?: Array<{ text: string; fromAlias: string; timestamp: number; isMine: boolean }>;
  gameCoinHex?: string | null;
  gameTurnState?: string;
  gameTerminalType?: string;
  gameTerminalLabel?: string | null;
  gameTerminalReward?: string | null;
  gameTerminalRewardCoin?: string | null;
  myRunningBalance?: string;
  channelAttentionActive?: boolean;
  gameTerminalAttentionActive?: boolean;
}

interface AppState {
  version: number;
  playerId: string;
  sessionId?: string;
  blockchainType?: BlockchainType;
  gameSave?: SessionSave;
  alias?: string;
  theme?: 'dark' | 'light';
  savedGames?: SavedGame[];
  defaultFee?: number;
  feeUnit?: 'mojo' | 'xch';
  activeTab?: string;
  connecting?: boolean;
  unreadChat?: boolean;
  unreadSession?: boolean;
  walletAlert?: boolean;
  trackerUrl?: string;
}

const APP_STATE_KEY = 'appState';
const CURRENT_VERSION = 2;
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

/**
 * Migrate from v1 (persistedState + scattered keys) to v2 (appState).
 * Returns null if there's nothing to migrate.
 */
function migrateToV2(): AppState | null {
  // v1: single 'persistedState' key
  const v1Raw = localStorage.getItem('persistedState');
  // Pre-v1: individual keys
  const oldPlayerId = localStorage.getItem('playerId');
  const oldSessionId = localStorage.getItem('sessionId');
  const oldSaveRaw = localStorage.getItem('sessionSave');
  const oldAlias = localStorage.getItem('alias');
  const oldTheme = localStorage.getItem('theme') as 'dark' | 'light' | null;

  // Saved games (saveNames + save-{id})
  const saveNamesRaw = localStorage.getItem('saveNames');
  const savedGames: SavedGame[] = [];
  if (saveNamesRaw) {
    for (const name of saveNamesRaw.split(',').filter(Boolean)) {
      const raw = localStorage.getItem(`save-${name}`);
      if (raw) {
        try { savedGames.push(JSON.parse(raw)); } catch { /* skip */ }
      }
    }
  }

  let base: Partial<AppState> = {};

  if (v1Raw) {
    try {
      const v1 = JSON.parse(v1Raw);
      base = {
        playerId: v1.playerId,
        sessionId: v1.sessionId,
        blockchainType: v1.blockchainType,
        gameSave: v1.gameSave,
      };
    } catch { /* ignore corrupt data */ }
  }

  if (!base.playerId && oldPlayerId) base.playerId = oldPlayerId;
  if (!base.sessionId && oldSessionId) base.sessionId = oldSessionId;

  if (!base.gameSave && oldSaveRaw) {
    try {
      const oldSave = JSON.parse(oldSaveRaw);
      if (!base.playerId && oldSave.uniqueId) base.playerId = oldSave.uniqueId;
      if (!base.blockchainType && oldSave.blockchainType) base.blockchainType = oldSave.blockchainType;
      const { uniqueId: _u, blockchainType: _b, ...rest } = oldSave;
      base.gameSave = rest;
    } catch { /* ignore */ }
  }

  const hasAnything = base.playerId || base.sessionId || base.gameSave
    || oldAlias || oldTheme || savedGames.length > 0;
  if (!hasAnything) return null;

  const state: AppState = {
    version: CURRENT_VERSION,
    playerId: base.playerId ?? randomHex(),
    sessionId: base.sessionId,
    blockchainType: base.blockchainType,
    gameSave: base.gameSave,
    alias: oldAlias ?? undefined,
    theme: oldTheme ?? undefined,
    savedGames: savedGames.length > 0 ? savedGames : undefined,
  };

  // Clean up old keys
  localStorage.removeItem('persistedState');
  localStorage.removeItem('playerId');
  localStorage.removeItem('sessionId');
  localStorage.removeItem('sessionSave');
  localStorage.removeItem('alias');
  localStorage.removeItem('theme');
  if (saveNamesRaw) {
    for (const name of saveNamesRaw.split(',').filter(Boolean)) {
      localStorage.removeItem(`save-${name}`);
    }
    localStorage.removeItem('saveNames');
  }

  localStorage.setItem(APP_STATE_KEY, JSON.stringify(state));
  return state;
}

// --- In-memory cache + debounced persistence ---

let cached: AppState | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
const PERSIST_DEBOUNCE_MS = 300;

function flushToLocalStorage(): void {
  if (!cached) return;
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  try {
    localStorage.setItem(APP_STATE_KEY, JSON.stringify(cached));
  } catch (e) {
    console.error('[save] failed to persist app state:', e);
  }
}

function schedulePersist(): void {
  if (persistTimer) return;
  const timer = setTimeout(() => {
    persistTimer = null;
    flushToLocalStorage();
  }, PERSIST_DEBOUNCE_MS);
  if (typeof timer === 'object' && 'unref' in timer) timer.unref();
  persistTimer = timer;
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', flushToLocalStorage);
}

/** @internal — reset module state between test cases */
export function _resetForTests(): void {
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
  cached = null;
}

export function loadAppState(): AppState {
  if (cached) return cached;
  try {
    const raw = localStorage.getItem(APP_STATE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.version === CURRENT_VERSION) {
        console.log('[save] loadAppState: hasGameSave=%s bcType=%s', !!parsed.gameSave, parsed.blockchainType ?? 'none');
        cached = parsed as AppState;
        return cached;
      }
    }
  } catch (e) {
    console.error('[save] failed to load app state:', e);
  }
  const migrated = migrateToV2();
  if (migrated) { cached = migrated; return cached; }
  console.log('[save] loadAppState: fresh state (nothing persisted)');
  cached = { version: CURRENT_VERSION, playerId: randomHex() };
  return cached;
}

function mutate(fn: (state: AppState) => void): void {
  const state = loadAppState();
  fn(state);
  schedulePersist();
}

// --- Convenience accessors ---

export function getPlayerId(): string {
  const state = loadAppState();
  if (!cached) schedulePersist();
  return state.playerId;
}

export function getSessionId(): string {
  const state = loadAppState();
  if (state.sessionId) return state.sessionId;
  state.sessionId = randomHex();
  schedulePersist();
  return state.sessionId;
}

export function setBlockchainType(bcType: BlockchainType): void {
  mutate(s => { s.blockchainType = bcType; });
}

export function getBlockchainType(): BlockchainType | undefined {
  return loadAppState().blockchainType;
}

export function saveSession(save: SessionSave): void {
  mutate(s => { s.gameSave = save; });
}

export function loadSession(): SessionSave | null {
  const save = loadAppState().gameSave ?? null;
  console.log('[save] loadSession: %s (token=%s)', save ? 'found' : 'null', save?.pairingToken ?? 'n/a');
  return save;
}

export function hasAnySessionInfo(): boolean {
  const state = loadAppState();
  return state.blockchainType !== undefined || state.gameSave !== undefined;
}

export function clearSession(): void {
  const state = loadAppState();
  cached = {
    version: CURRENT_VERSION,
    playerId: state.playerId,
    alias: state.alias,
    theme: state.theme,
    activeTab: state.activeTab,
    defaultFee: state.defaultFee,
    feeUnit: state.feeUnit,
  };
  flushToLocalStorage();
}

export async function hardReset(): Promise<void> {
  cached = null;
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
  const state = loadAppState();
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
  return loadAppState().theme;
}

export function setTheme(theme: 'dark' | 'light'): void {
  mutate(s => { s.theme = theme; });
}

// --- Default fee ---

export function getDefaultFee(): number {
  return loadAppState().defaultFee ?? 0;
}

export function setDefaultFee(fee: number): void {
  mutate(s => { s.defaultFee = fee; });
}

export function getFeeUnit(): 'mojo' | 'xch' {
  return loadAppState().feeUnit ?? 'mojo';
}

export function setFeeUnit(unit: 'mojo' | 'xch'): void {
  mutate(s => { s.feeUnit = unit; });
}

// --- Active tab ---

export function getActiveTab(): string | undefined {
  return loadAppState().activeTab;
}

export function setActiveTab(tab: string): void {
  mutate(s => { s.activeTab = tab; });
}

// --- Connecting flag ---

export function getConnecting(): boolean {
  return loadAppState().connecting ?? false;
}

export function setConnecting(v: boolean): void {
  mutate(s => { s.connecting = v || undefined; });
}

// --- Notification badges ---

export function getUnreadChat(): boolean {
  return loadAppState().unreadChat ?? false;
}

export function setUnreadChat(v: boolean): void {
  mutate(s => { s.unreadChat = v || undefined; });
}

export function getUnreadSession(): boolean {
  return loadAppState().unreadSession ?? false;
}

export function setUnreadSession(v: boolean): void {
  mutate(s => { s.unreadSession = v || undefined; });
}

export function getWalletAlert(): boolean {
  return loadAppState().walletAlert ?? false;
}

export function setWalletAlert(v: boolean): void {
  mutate(s => { s.walletAlert = v || undefined; });
}

// --- Tracker URL ---

export function getTrackerUrl(): string | undefined {
  return loadAppState().trackerUrl;
}

export function setTrackerUrl(url: string | undefined): void {
  mutate(s => { s.trackerUrl = url || undefined; });
}

// --- Saved games ---

export function getSaveList(): string[] {
  return (loadAppState().savedGames ?? []).map(g => g.id);
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
  return (loadAppState().savedGames ?? []).find(g => g.id === saveId);
}

