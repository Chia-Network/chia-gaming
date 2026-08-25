import 'fake-indexeddb/auto';
import { saveSession, type SessionSave, _resetForTests } from '../../hooks/save';
import { SESSION_DB_NAME } from '../session/indexedDb';
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
    my_contribution: '10',
    their_contribution: '10',
    game_timeout: '15',
    game_type: 'calpoker',
    parameters: [10n, true],
  },
  unackedMessages: [{ msgno: 4n, msg: new Uint8Array([3, 4, 5]) }],
  humanHistory: ['human1'],
  wasmNotificationHistory: ['notification1'],
  diagnosticLog: ['dbg1'],
};

export function saveLiveFields(fields: Record<string, unknown> = sampleSession): Promise<void> {
  const save = liveSave(fields);
  if (save.phase !== 'live') throw new Error('expected live fixture');
  if (
    fields.blockchainType !== undefined ||
    fields.defaultFee !== undefined ||
    fields.hubUrl !== undefined
  ) {
    void saveSession({
      scope: 'common',
      preferences: {
        blockchainType: fields.blockchainType as 'simulator' | 'walletconnect' | undefined,
        defaultFee: fields.defaultFee as bigint | undefined,
        hubUrl: fields.hubUrl as string | undefined,
      },
    });
  }
  return saveSession({
    scope: 'live',
    pairing: save.pairing,
    live: save.live,
    presentation: save.presentation,
    history: save.history,
  });
}

export function savePreferences(fields: {
  blockchainType?: 'simulator' | 'walletconnect';
  hubUrl?: string;
}): Promise<void> {
  return saveSession({ scope: 'common', preferences: fields });
}

export function saveHistory(fields: {
  humanHistory?: string[];
  wasmNotificationHistory?: string[];
  diagnosticLog?: string[];
}): Promise<void> {
  return saveSession({ scope: 'common', history: fields });
}

export function requireLive(save: SessionSave | null): Extract<SessionSave, { phase: 'live' }> {
  if (save?.phase !== 'live') throw new Error('expected live save');
  return save;
}

export function requirePreHandshake(
  save: SessionSave | null,
): Extract<SessionSave, { phase: 'pre-handshake' }> {
  if (save?.phase !== 'pre-handshake') throw new Error('expected pre-handshake save');
  return save;
}

beforeEach(async () => {
  _resetForTests();
  setTestGlobal('localStorage', makeStorage());
  setTestGlobal('sessionStorage', makeStorage());
  setTestGlobal('indexedDB', testIndexedDb);
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(SESSION_DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
});

afterEach(() => {
  // Cancel debounced flushes so a late queueWrite cannot run after the suite.
  _resetForTests();
  clearTestGlobal('localStorage');
  clearTestGlobal('sessionStorage');
});
