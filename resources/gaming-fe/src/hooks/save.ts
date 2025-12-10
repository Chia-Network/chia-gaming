const STALE_SAVE_TIME_MS = 60 * 60 * 1000;

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

export function saveGame(g: any): [string, any] | undefined {
  try {
    const saveList = getSaveList();
    if (saveList.length > 2) {
      const saveName = saveList.pop();
      localStorage.removeItem(`save-${saveName}`);
      localStorage.removeItem(`date-${saveName}`);
    }
    saveList.unshift(g.id);
    localStorage.setItem(`save-${g.id}`, JSON.stringify(g));
    localStorage.setItem(`date-${g.id}`, new Date().getTime().toString());
    // We setSaveList last so the save is only included if everything worked.
    setSaveList(saveList);
    return undefined;
  } catch (e) {
    return ["Error saving game turn", e];
  }
}

// Find a compatible save from the set of saves we have if it exists.
export function findMatchingGame(peerSaves: string[]): string | undefined {
  const peerSet = new Set(peerSaves);
  const currentTime = new Date().getTime();
  const mySaves = getSaveList().filter((s) => {
    const saveMillisecondDateStr = localStorage.getItem(`date-${s}`);
    const saveMillisecondDate = saveMillisecondDateStr ? parseInt(saveMillisecondDateStr) : undefined;
    return saveMillisecondDate && (saveMillisecondDate >= currentTime - STALE_SAVE_TIME_MS);
  });
  return mySaves.find(save => peerSet.has(save));
}

export function loadSave(saveId: string): any | undefined {
  const data = localStorage.getItem(`save-${saveId}`);
  if (data) {
    return JSON.parse(data);
  }

  return undefined;
}
