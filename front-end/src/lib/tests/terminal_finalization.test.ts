import 'fake-indexeddb/auto';

import type { SessionController } from '../../hooks/SessionController';
import {
  _resetForTests,
  discardStagedTerminalSession,
  flushSessionSave,
  hasSavedSessionMarker,
  loadState,
  markSavedSession,
  peekSession,
  saveSession,
  stageTerminalSession,
} from '../../hooks/save';
import { createSessionModel } from '../session/model';
import { readSessionRecord, SESSION_DB_NAME } from '../session/indexedDb';
import {
  finalizeTerminalSession,
  type TerminalFinalizationDependencies,
} from '../session/terminalFinalization';

const testIndexedDb = indexedDB;
const liveCradle = new Uint8Array([1, 2, 3]);
const handState = {
  gameType: 'calpoker',
  version: 1n,
  state: {
    playerHand: [8n, 7n, 6n, 5n],
    opponentHand: [4n, 3n, 2n, 1n],
    moveNumber: 1n,
    isPlayerTurn: true,
    cardSelections: [8n, 7n],
    displaySnapshot: {
      gameState: 'selecting',
      winner: null,
      playerBestHandCardIds: [],
      opponentBestHandCardIds: [],
      playerHaloCardIds: [],
      opponentHaloCardIds: [],
      playerDisplayText: '',
      opponentDisplayText: '',
    },
  },
};

function makeStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => void store.set(key, value),
    removeItem: (key) => void store.delete(key),
    clear: () => store.clear(),
    get length() {
      return store.size;
    },
    key: (index) => [...store.keys()][index] ?? null,
  };
}

function setTestGlobal(key: string, value: unknown): void {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

const model = createSessionModel({
  channel: {
    status: {
      state: 'ResolvedClean',
      sessionDisposition: null,
      advisory: null,
      coin: null,
      coinHex: null,
      coinAmount: null,
      ourBalance: '60',
      theirBalance: '40',
      gameAllocated: '0',
      havePotato: false,
      zeroPayout: null,
      unrollInitiator: null,
      semanticPhase: null,
    },
  },
  game: {
    activeIds: [],
    currentHandIds: ['game-1'],
    lastDisplayedId: 'game-1',
    activeGameType: 'calpoker',
    handState,
    instances: {
      'game-1': {
        id: 'game-1',
        amount: '10',
        coinHex: 'aa',
        presentation: 'ended',
        terminal: {
          type: 'settled',
          outcome: 'accept_settlement',
          label: 'Finished',
          myReward: '10',
          rewardCoinHex: 'bb',
        },
      },
    },
  },
});

function makeController(events: string[]): SessionController {
  return {
    handState,
    flushPendingSave: async () => {
      events.push('controller-flush');
    },
  } as unknown as SessionController;
}

async function seedLiveSession(): Promise<void> {
  saveSession({
    serializedGameSession: liveCradle,
    gameSessionSchemaVersion: 3n,
    pairingToken: 'live-token',
    sessionPeerId: 'peer',
    gameSessionId: 'game-session',
    messageNumber: 2n,
    remoteNumber: 1n,
    iStarted: true,
    myContribution: '60',
    theirContribution: '40',
    perGameAmount: '10',
    rewardPuzzleHash: '11'.repeat(32),
    unackedMessages: [],
    activeGameIds: [],
  });
  await flushSessionSave();
  markSavedSession();
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
  await seedLiveSession();
});

afterEach(() => {
  _resetForTests();
});

function finalizationArgs(controller: SessionController) {
  return {
    controller,
    model,
    identity: {
      myName: 'Alice',
      opponentName: 'Bob',
      iStarted: true,
      iProposedHand: true,
    },
    coins: [{ label: 'Reward coin', id: 'coin-1' }],
  };
}

it('blocks teardown on a deferred IndexedDB write and coalesces duplicate finalization', async () => {
  const events: string[] = [];
  const controller = makeController(events);
  let releaseWrite!: () => void;
  const writeGate = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  const teardown = jest.fn(() => events.push('teardown'));
  const dependencies: TerminalFinalizationDependencies = {
    stageTerminal: async (fields) => {
      events.push('stage-terminal');
      await stageTerminalSession(fields);
    },
    flushSave: async () => {
      events.push('write-start');
      await writeGate;
      await flushSessionSave();
      events.push('write-complete');
    },
    discardTerminal: discardStagedTerminalSession,
    updateMarker: () => events.push('marker'),
    teardown,
  };

  const first = finalizeTerminalSession(finalizationArgs(controller), dependencies);
  const duplicate = finalizeTerminalSession(finalizationArgs(controller), dependencies);
  expect(duplicate).toBe(first);
  await Promise.resolve();
  await Promise.resolve();

  expect(teardown).not.toHaveBeenCalled();
  expect((await readSessionRecord())?.serializedGameSession).toEqual(liveCradle);

  releaseWrite();
  await first;

  expect(events).toEqual([
    'controller-flush',
    'stage-terminal',
    'write-start',
    'write-complete',
    'marker',
    'teardown',
  ]);
  expect(teardown).toHaveBeenCalledTimes(1);

  _resetForTests();
  const restored = await peekSession();
  expect(restored).toMatchObject({
    terminalIStarted: true,
    iProposedHand: true,
    myAlias: 'Alice',
    opponentAlias: 'Bob',
    coinsOfInterest: [{ label: 'Reward coin', id: 'coin-1' }],
    activeGameIds: [],
    currentHandGameIds: ['game-1'],
    lastDisplayedGameId: 'game-1',
  });
  expect(restored?.handState).toEqual(handState);
  expect(restored?.gameInstances?.['game-1']?.terminal.label).toBe('Finished');
  expect(restored?.serializedGameSession).toBeUndefined();
  expect(restored?.pairingToken).toBeUndefined();
});

it('keeps live state and ownership after failure, then retries without teardown durability', async () => {
  const events: string[] = [];
  const controller = makeController(events);
  const teardown = jest.fn();
  let failWrite = true;
  const dependencies: TerminalFinalizationDependencies = {
    stageTerminal: stageTerminalSession,
    flushSave: async () => {
      if (failWrite) throw new Error('deferred IndexedDB write failed');
      await flushSessionSave();
    },
    discardTerminal: discardStagedTerminalSession,
    updateMarker: markSavedSession,
    teardown,
  };

  await expect(finalizeTerminalSession(finalizationArgs(controller), dependencies)).rejects.toThrow(
    'deferred IndexedDB write failed',
  );

  expect(teardown).not.toHaveBeenCalled();
  expect(hasSavedSessionMarker()).toBe(true);
  expect(loadState().serializedGameSession).toEqual(liveCradle);
  expect((await readSessionRecord())?.serializedGameSession).toEqual(liveCradle);

  failWrite = false;
  await finalizeTerminalSession(finalizationArgs(controller), dependencies);

  expect(events).toEqual(['controller-flush', 'controller-flush']);
  expect(teardown).toHaveBeenCalledTimes(1);
  _resetForTests();
  const restored = await peekSession();
  expect(restored?.serializedGameSession).toBeUndefined();
  expect(restored?.channelStatus?.state).toBe('ResolvedClean');
});
