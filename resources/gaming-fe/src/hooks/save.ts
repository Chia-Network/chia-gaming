import { randomHex } from '../util';

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
}

export interface PersistedState {
  playerId: string;
  sessionId?: string;
  blockchainType?: BlockchainType;
  gameSave?: SessionSave;
}

const PERSISTED_KEY = 'persistedState';

function migrateOldKeys(): PersistedState | null {
  const oldPlayerId = localStorage.getItem('playerId');
  const oldSessionId = localStorage.getItem('sessionId');
  const oldSaveRaw = localStorage.getItem('sessionSave');
  if (!oldPlayerId && !oldSessionId && !oldSaveRaw) return null;

  let oldSave: (SessionSave & { uniqueId?: string; blockchainType?: BlockchainType }) | null = null;
  if (oldSaveRaw) {
    try { oldSave = JSON.parse(oldSaveRaw); } catch { /* ignore */ }
  }

  const state: PersistedState = {
    playerId: oldPlayerId ?? oldSave?.uniqueId ?? randomHex(),
  };
  if (oldSessionId) state.sessionId = oldSessionId;
  if (oldSave) {
    state.blockchainType = oldSave.blockchainType;
    const { uniqueId: _u, blockchainType: _b, ...rest } = oldSave;
    state.gameSave = rest;
  }

  localStorage.removeItem('playerId');
  localStorage.removeItem('sessionId');
  localStorage.removeItem('sessionSave');
  localStorage.setItem(PERSISTED_KEY, JSON.stringify(state));
  return state;
}

export function loadPersistedState(): PersistedState {
  try {
    const raw = localStorage.getItem(PERSISTED_KEY);
    if (raw) return JSON.parse(raw) as PersistedState;
  } catch (e) {
    console.error('[save] failed to load persisted state:', e);
  }
  const migrated = migrateOldKeys();
  if (migrated) return migrated;
  return { playerId: randomHex() };
}

function savePersistedState(state: PersistedState): void {
  try {
    localStorage.setItem(PERSISTED_KEY, JSON.stringify(state));
  } catch (e) {
    console.error('[save] failed to persist state:', e);
  }
}

export function getPlayerId(): string {
  const state = loadPersistedState();
  if (!localStorage.getItem(PERSISTED_KEY)) {
    savePersistedState(state);
  }
  return state.playerId;
}

export function getSessionId(): string {
  const state = loadPersistedState();
  if (state.sessionId) return state.sessionId;
  state.sessionId = randomHex();
  savePersistedState(state);
  return state.sessionId;
}

export function setBlockchainType(bcType: BlockchainType): void {
  const state = loadPersistedState();
  state.blockchainType = bcType;
  savePersistedState(state);
}

export function getBlockchainType(): BlockchainType | undefined {
  return loadPersistedState().blockchainType;
}

export function saveSession(save: SessionSave): void {
  const state = loadPersistedState();
  state.gameSave = save;
  savePersistedState(state);
}

export function loadSession(): SessionSave | null {
  return loadPersistedState().gameSave ?? null;
}

export function clearSession(): void {
  const state = loadPersistedState();
  const cleared: PersistedState = { playerId: state.playerId };
  savePersistedState(cleared);
}

export function getSaveList(): string[] {
  const result = localStorage.getItem('saveNames');
  if (result) {
    return result.split(',');
  }
  return [];
}

function setSaveList(saveList: string[]) {
  localStorage.setItem('saveNames', saveList.join(','));
}

export function startNewSession() {
  const names = getSaveList();
  for (let n of names) {
    localStorage.removeItem(`save-${n}`);
  }
  setSaveList([]);
}

export function saveGame(g: SavedGame): [string, unknown] | undefined {
  try {
    const saveList = getSaveList();
    if (saveList.length > 2) {
      localStorage.removeItem(`save-${saveList.pop()}`);
    }
    saveList.unshift(g.id);
    localStorage.setItem(`save-${g.id}`, JSON.stringify(g));
    setSaveList(saveList);
    return undefined;
  } catch (e) {
    return ["Error saving game turn", e];
  }
}

export function findMatchingGame(peerSaves: string[]): string | undefined {
  const peerSet = new Set(peerSaves);
  const mySaves = getSaveList();
  return mySaves.find(save => peerSet.has(save));
}

export function loadSave(saveId: string): SavedGame | undefined {
  const data = localStorage.getItem(`save-${saveId}`);
  if (data) {
    return JSON.parse(data) as SavedGame;
  }

  return undefined;
}
