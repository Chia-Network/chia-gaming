export function getSaveList(): string[] {
  return localStorage.get('saveNames').split(',');
}

function setSaveList(saveList: string[]) {
  localStorage.set('saveNames', saveList.join(','));
}

export function startNewSession() {
  const names = getSaveList();
  for (let n of names) {
    localStorage.remove(`save-${n}`);
  }
  setSaveList([]);
}

export function saveGame(g: any) {
  const saveList = getSaveList();
  saveList.push(g.id);
  localStorage.set(`save-${g.id}`, JSON.stringify(g));
  setSaveList(saveList);
}

// Find a compatible save from the set of saves we have if it exists.
export function findMatchingGame(peerSaves: string[]): string | undefined {
  const mySaves = getSaveList();
  for (let p of peerSaves) {
    for (let m of mySaves) {
      if (m === p) {
        return m;
      }
    }
  }

  return undefined;
}

export function loadSave(saveId: string): any | undefined {
  const data = localStorage.get(`save-${saveId}`);
  if (data) {
    return JSON.parse(data);
  }

  return undefined;
}
