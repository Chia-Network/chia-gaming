import { ChannelStatusPayload } from '../types/ChiaGaming';

function randomHex(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface SavedGame {
  id: string;
  searchParams: Record<string, string>;
  url: string;
  [key: string]: unknown;
}

export interface CalpokerHandState {
  playerHand: number[];
  opponentHand: number[];
  moveNumber: number;
  isPlayerTurn: boolean;
}

export type BlockchainType = 'simulator' | 'walletconnect';

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
}

export interface AppState {
  version: number;
  playerId: string;
  sessionId?: string;
  blockchainType?: BlockchainType;
  gameSave?: SessionSave;
  alias?: string;
  theme?: 'dark' | 'light';
  savedGames?: SavedGame[];
}

const APP_STATE_KEY = 'appState';
const CURRENT_VERSION = 2;
const LEGACY_STORAGE_KEYS = ['persistedState', 'playerId', 'sessionId', 'sessionSave', 'alias', 'theme', 'saveNames'];

function isWalletConnectStorageKey(key: string): boolean {
  const lower = key.toLowerCase();
  return lower.startsWith('wc@') || lower.includes('walletconnect');
}

function clearLegacySaveEntries(): void {
  const saveNamesRaw = localStorage.getItem('saveNames');
  if (!saveNamesRaw) return;
  for (const name of saveNamesRaw.split(',').filter(Boolean)) {
    localStorage.removeItem(`save-${name}`);
  }
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

export function loadAppState(): AppState {
  try {
    const raw = localStorage.getItem(APP_STATE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.version === CURRENT_VERSION) return parsed as AppState;
    }
  } catch (e) {
    console.error('[save] failed to load app state:', e);
  }
  const migrated = migrateToV2();
  if (migrated) return migrated;
  return { version: CURRENT_VERSION, playerId: randomHex() };
}

export function saveAppState(state: AppState): void {
  try {
    localStorage.setItem(APP_STATE_KEY, JSON.stringify(state));
  } catch (e) {
    console.error('[save] failed to persist app state:', e);
  }
}

// --- Convenience accessors (all route through AppState) ---

export function getPlayerId(): string {
  const state = loadAppState();
  if (!localStorage.getItem(APP_STATE_KEY)) {
    saveAppState(state);
  }
  return state.playerId;
}

export function getSessionId(): string {
  const state = loadAppState();
  if (state.sessionId) return state.sessionId;
  state.sessionId = randomHex();
  saveAppState(state);
  return state.sessionId;
}

export function setBlockchainType(bcType: BlockchainType): void {
  const state = loadAppState();
  state.blockchainType = bcType;
  saveAppState(state);
}

export function getBlockchainType(): BlockchainType | undefined {
  return loadAppState().blockchainType;
}

export function saveSession(save: SessionSave): void {
  const state = loadAppState();
  state.gameSave = save;
  saveAppState(state);
}

export function loadSession(): SessionSave | null {
  return loadAppState().gameSave ?? null;
}

export function clearSession(): void {
  const state = loadAppState();
  const cleared: AppState = {
    version: CURRENT_VERSION,
    playerId: state.playerId,
    alias: state.alias,
    theme: state.theme,
  };
  saveAppState(cleared);
}

export async function hardReset(): Promise<void> {
  try {
    clearLegacySaveEntries();
    localStorage.removeItem(APP_STATE_KEY);
    for (const key of LEGACY_STORAGE_KEYS) {
      localStorage.removeItem(key);
    }

    for (let i = localStorage.length - 1; i >= 0; i -= 1) {
      const key = localStorage.key(i);
      if (key && isWalletConnectStorageKey(key)) {
        localStorage.removeItem(key);
      }
    }

    for (let i = sessionStorage.length - 1; i >= 0; i -= 1) {
      const key = sessionStorage.key(i);
      if (key && isWalletConnectStorageKey(key)) {
        sessionStorage.removeItem(key);
      }
    }
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
  saveAppState(state);
  return generated;
}

export function setAlias(alias: string): void {
  const state = loadAppState();
  state.alias = alias;
  saveAppState(state);
}

// --- Theme ---

export function getTheme(): 'dark' | 'light' | undefined {
  return loadAppState().theme;
}

export function setTheme(theme: 'dark' | 'light'): void {
  const state = loadAppState();
  state.theme = theme;
  saveAppState(state);
}

// --- Saved games ---

export function getSaveList(): string[] {
  const state = loadAppState();
  return (state.savedGames ?? []).map(g => g.id);
}

export function startNewSession() {
  const state = loadAppState();
  state.savedGames = [];
  saveAppState(state);
}

export function saveGame(g: SavedGame): [string, unknown] | undefined {
  try {
    const state = loadAppState();
    const games = state.savedGames ?? [];
    if (games.length > 2) {
      games.pop();
    }
    games.unshift(g);
    state.savedGames = games;
    saveAppState(state);
    return undefined;
  } catch (e) {
    return ["Error saving game turn", e];
  }
}

export function findMatchingGame(peerSaves: string[]): string | undefined {
  const peerSet = new Set(peerSaves);
  return getSaveList().find(save => peerSet.has(save));
}

export function loadSave(saveId: string): SavedGame | undefined {
  const state = loadAppState();
  return (state.savedGames ?? []).find(g => g.id === saveId);
}

// Keep old name exported for back-compat during transition
export { loadAppState as loadPersistedState };
export type { AppState as PersistedState };
