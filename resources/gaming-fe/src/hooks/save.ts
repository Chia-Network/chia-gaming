export interface SavedGame {
  id: string;
  searchParams: Record<string, string>;
  url: string;
  [key: string]: unknown;
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
