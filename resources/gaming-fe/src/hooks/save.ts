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
    saveList.unshift(g.id);
    localStorage.setItem(`save-${g.id}`, JSON.stringify(g));
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
  const mySaves = getSaveList();
  return mySaves.find(save => peerSet.has(save));
}

export function loadSave(saveId: string): any | undefined {
  const data = localStorage.getItem(`save-${saveId}`);
  if (data) {
    return JSON.parse(data);
  }

  return undefined;
}
