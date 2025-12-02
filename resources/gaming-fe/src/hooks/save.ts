export function getSaveList(): string[] {
  const result = localStorage.getItem('saveNames');
  if (result) {
    console.log('getSaveList', result);
    return result.split(',');
  }
  console.log('getSaveList: empty');
  return [];
}

function setSaveList(saveList: string[]) {
  console.log('setSaveList', saveList);
  localStorage.setItem('saveNames', saveList.join(','));
}

export function startNewSession() {
  const names = getSaveList();
  for (let n of names) {
    localStorage.removeItem(`save-${n}`);
  }
  setSaveList([]);
}

export function saveGame(g: any) {
  const saveList = getSaveList();
  saveList.unshift(g.id);
  localStorage.setItem(`save-${g.id}`, JSON.stringify(g));
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
  const data = localStorage.getItem(`save-${saveId}`);
  if (data) {
    return JSON.parse(data);
  }

  return undefined;
}
