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
  uniqueId: string;
  pendingTransactions: string[];
  unackedMessages: Array<{ msgno: number; msg: string }>;
  gameLog: string[];
  debugLog: string[];
  blockchainType?: BlockchainType;
  activeGameId?: string | null;
  handState?: CalpokerHandState | null;
}

const SESSION_SAVE_KEY = 'sessionSave';

export function saveSession(save: SessionSave): void {
  try {
    localStorage.setItem(SESSION_SAVE_KEY, JSON.stringify(save));
  } catch (e) {
    console.error('[save] failed to persist session:', e);
  }
}

export function loadSession(): SessionSave | null {
  try {
    const data = localStorage.getItem(SESSION_SAVE_KEY);
    if (data) {
      return JSON.parse(data) as SessionSave;
    }
  } catch (e) {
    console.error('[save] failed to load session:', e);
  }
  return null;
}

export function clearSession(): void {
  localStorage.removeItem(SESSION_SAVE_KEY);
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
