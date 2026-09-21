import 'fake-indexeddb/auto';
import { type DurableApplicationState } from '../session/saveEnvelope';
import { storageRepository } from '../session/storageRepository';
import { SESSION_DB_NAME } from '../session/indexedDb';
import type { BlockchainType } from '../session/saveEnvelope';
import { liveSave } from './session_save_envelope.fixtures';
export const testIndexedDb = indexedDB;

export function makeStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    get length() {
      return store.size;
    },
    key: (i: number) => [...store.keys()][i] ?? null,
  };
}

export function setTestGlobal(key: string, value: unknown) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value,
  });
}

export function clearTestGlobal(key: string) {
  Reflect.deleteProperty(globalThis, key);
}

export const sampleSession = {
  serializedGameSession: new Uint8Array([0, 1, 2, 255]),
  gameSessionSchemaVersion: 3n,
  pairingToken: 'tok-123',
  messageNumber: 5n,
  remoteNumber: 3n,
  iStarted: true,
  activeGameIds: [],
  myContribution: '60',
  theirContribution: '40',
  perGameAmount: '10',
  rewardPuzzleHash: '11'.repeat(32),
  betweenHandLastHandProposal: {
    sender_is_player_a: false,
    game_timeout: '15',
    game_type: 'calpoker',
    parameters: null,
  },
  unackedMessages: [{ msgno: 4n, msg: new Uint8Array([3, 4, 5]) }],
  humanHistory: ['human1'],
  wasmNotificationHistory: ['notification1'],
  diagnosticLog: ['dbg1'],
};

export function saveLiveFields(fields: Record<string, unknown> = sampleSession): Promise<void> {
  const save = liveSave(fields);
  if (save.session?.phase !== 'live') throw new Error('expected live fixture');
  const current = storageRepository.loadState();
  storageRepository._replaceApplicationStateForTests({
    ...current,
    identity: {
      ...current.identity,
      ...Object.fromEntries(
        Object.entries(save.identity).filter(([, value]) => value !== undefined),
      ),
    },
    preferences: { ...current.preferences, ...save.preferences },
    history: save.history,
    walletContext: save.walletContext,
    session: save.session,
  });
  return storageRepository.updateCommon({});
}

export function savePreferences(fields: {
  blockchainType?: BlockchainType;
  hubUrl?: string;
}): Promise<void> {
  return storageRepository.updateCommon({ preferences: fields });
}

export function saveHistory(fields: {
  humanHistory?: string[];
  wasmNotificationHistory?: string[];
  diagnosticLog?: string[];
}): Promise<void> {
  return storageRepository.updateCommon({ history: fields });
}

export function requireLive(
  save: DurableApplicationState | null,
): Extract<DurableApplicationState['session'], { phase: 'live' }> {
  if (save?.session?.phase !== 'live') throw new Error('expected live save');
  return save.session;
}

export function requirePreHandshake(
  save: DurableApplicationState | null,
): Extract<DurableApplicationState['session'], { phase: 'pre-handshake' }> {
  if (save?.session?.phase !== 'pre-handshake') throw new Error('expected pre-handshake save');
  return save.session;
}

beforeEach(async () => {
  storageRepository._resetForTests();
  setTestGlobal('localStorage', makeStorage());
  setTestGlobal('sessionStorage', makeStorage());
  setTestGlobal('indexedDB', testIndexedDb);
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(SESSION_DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
  await storageRepository.claimApplicationState();
});

afterEach(() => {
  // Cancel debounced flushes so a late queueWrite cannot run after the suite.
  storageRepository._resetForTests();
  clearTestGlobal('localStorage');
  clearTestGlobal('sessionStorage');
});
