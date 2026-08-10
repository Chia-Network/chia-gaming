import 'fake-indexeddb/auto';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { SessionController } from '../../hooks/SessionController';
import {
  initialKrunkGameState,
  krunkStateCodec,
  KrunkHandler,
} from '../../features/krunk/stateCodec';
import { reduceKrunkDurableState } from '../../features/krunk/adapter';
import { krunkBoardNotice } from '../../features/krunk/useKrunkHand';
import FinishedSessionGameView from '../../components/FinishedSessionGameView';
import {
  _resetForTests,
  discardStagedTerminalSession,
  flushSessionSave,
  hasSavedSessionMarker,
  loadState,
  markSavedSession,
  peekSession,
  saveSession,
  saveTerminalSession,
  stageTerminalSession,
} from '../../hooks/save';
import { createSessionModel } from '../session/model';
import { readSessionRecord, SESSION_DB_NAME } from '../session/indexedDb';
import { decodeSessionSaveEnvelope } from '../session/persistence';
import { createSessionMachineState } from '../session/sessionMachine';
import { persistSessionSnapshot } from '../session/sessionMachinePersist';
import { selectFinishedSessionDisplay } from '../session/finishedSessionDisplay';
import { renderFrozenGameMount } from '../gameMountRegistry';
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
  betweenHand: {
    lastTerms: {
      gameType: 'calpoker',
      myContribution: 10n,
      theirContribution: 10n,
      gameTimeout: 15n,
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

it('atomically removes live restart fields through the real mutation queue', async () => {
  const terminalWrite = saveTerminalSession({
    channelStatus: { state: 'ResolvedClean' },
    coinsOfInterest: [{ label: 'Reward coin', id: 'coin-1' }],
  });

  for (const field of [
    'serializedGameSession',
    'gameSessionSchemaVersion',
    'pairingToken',
    'sessionPeerId',
    'gameSessionId',
    'messageNumber',
    'remoteNumber',
    'iStarted',
    'myContribution',
    'theirContribution',
    'perGameAmount',
    'channelTimeout',
    'unrollTimeout',
    'unackedMessages',
  ]) {
    expect(loadState()).not.toHaveProperty(field);
  }

  await flushSessionSave();
  await terminalWrite;
  const stored = await readSessionRecord();
  expect(stored).not.toBeNull();
  expect(decodeSessionSaveEnvelope(stored!).kind).toBe('terminal-frozen');
  expect(stored).not.toHaveProperty('serializedGameSession');
  expect(stored).not.toHaveProperty('messageNumber');
  expect(stored).not.toHaveProperty('unackedMessages');
});

it('routes a normally resolved on-chain snapshot through terminal persistence', async () => {
  const save = jest.fn(async () => {});
  const saveTerminal = jest.fn(async () => {});
  const controller = {
    getWasmFields: () => ({
      serializedGameSession: liveCradle,
      gameSessionSchemaVersion: 3n,
      pairingToken: 'live-token',
      messageNumber: 2n,
      remoteNumber: 1n,
      iStarted: true,
      handState,
      channelStatus: { state: 'ResolvedClean' },
      wasmNotificationHistory: [],
      diagnosticLog: [],
    }),
    getCoinsOfInterest: () => [{ label: 'Reward coin', id: 'coin-1' }],
  } as unknown as SessionController;

  await persistSessionSnapshot({
    controller,
    getState: () => createSessionMachineState(model),
    restoring: false,
    getRestoreStatus: () => 'idle',
    getRestoreError: () => null,
    save,
    saveTerminal,
  });

  expect(save).not.toHaveBeenCalled();
  expect(saveTerminal).toHaveBeenCalledTimes(1);
  expect(saveTerminal).toHaveBeenCalledWith(
    expect.objectContaining({
      channelStatus: { state: 'ResolvedClean' },
      serializedGameSession: liveCradle,
      coinsOfInterest: [{ label: 'Reward coin', id: 'coin-1' }],
    }),
  );
});

it('freezes both role-aware Krunk timeout boards after queued terminal reductions', async () => {
  const ids = ['picker', 'guesser'];
  const pickerBeforeTimeout = {
    ...initialKrunkGameState('alice'),
    handler: KrunkHandler.AliceWaiting,
    myTurn: false,
    secretWord: 'CRANE',
  };
  const acceptedHandState = krunkStateCodec.encode({
    games: {
      picker: pickerBeforeTimeout,
      guesser: initialKrunkGameState('bob'),
    },
  });
  const timeoutModel = createSessionModel({
    channel: {
      status: {
        state: 'ResolvedUnrolled',
        ourBalance: '100',
        theirBalance: '100',
      },
    },
    game: {
      activeIds: [],
      currentHandIds: ids,
      activeGameType: 'krunk',
      lastDisplayedId: 'picker',
      handState: acceptedHandState,
      instances: {
        picker: {
          id: 'picker',
          amount: '100',
          coinHex: null,
          presentation: 'ended',
          terminal: {
            type: 'settled',
            outcome: 'opponent_timed_out',
            label: 'Opponent timed out',
            myReward: '100',
            rewardCoinHex: null,
          },
        },
        guesser: {
          id: 'guesser',
          amount: '100',
          coinHex: null,
          presentation: 'ended',
          terminal: {
            type: 'settled',
            outcome: 'opponent_timed_out',
            label: 'Opponent timed out',
            myReward: '100',
            rewardCoinHex: null,
          },
        },
      },
    },
    betweenHand: {
      lastTerms: {
        gameType: 'krunk',
        myContribution: 100n,
        theirContribution: 100n,
        gameTimeout: 15n,
      },
    },
  });
  const transitions: Array<{
    settledId: string;
    payloadIds: string[];
    terminalIds: string[];
  }> = [];
  const controller = {
    handState: acceptedHandState,
    flushPendingSave: async () => {
      for (const settledId of ids) {
        const current = krunkStateCodec.decode(controller.handState);
        expect(current).not.toBeNull();
        const next = reduceKrunkDurableState(current, { type: 'settled', id: settledId });
        expect(next).not.toBeNull();
        controller.handState = krunkStateCodec.encode(next!);
        const decoded = krunkStateCodec.decode(controller.handState);
        expect(decoded).not.toBeNull();
        transitions.push({
          settledId,
          payloadIds: Object.keys(decoded!.games),
          terminalIds: Object.entries(decoded!.games)
            .filter(([, state]) => state.handler === KrunkHandler.Terminal)
            .map(([id]) => id),
        });
      }
    },
  } as unknown as SessionController;
  const stageTerminal = jest.fn(async () => {});

  const terminal = await finalizeTerminalSession(
    {
      controller,
      model: timeoutModel,
      identity: {
        myName: 'Alice',
        opponentName: 'Bob',
        iStarted: false,
        iProposedHand: true,
      },
      coins: [],
    },
    {
      stageTerminal,
      flushSave: async () => {},
      discardTerminal: () => {},
      updateMarker: () => {},
      teardown: () => {},
    },
  );

  expect(selectFinishedSessionDisplay(terminal.model)).toEqual({
    canRemountHand: true,
    terminalLabel: 'Opponent timed out',
  });
  expect(transitions).toEqual([
    {
      settledId: 'picker',
      payloadIds: ids,
      terminalIds: ['picker'],
    },
    {
      settledId: 'guesser',
      payloadIds: ids,
      terminalIds: ids,
    },
  ]);
  const frozenHand = krunkStateCodec.decode(terminal.model.game.handState);
  expect(frozenHand).not.toBeNull();
  expect(Object.keys(frozenHand!.games)).toEqual(ids);
  expect(
    Object.values(frozenHand!.games).every((state) => state.handler === KrunkHandler.Terminal),
  ).toBe(true);
  expect(
    krunkBoardNotice(
      frozenHand!.games.picker,
      'Bob',
      timeoutModel.game.instances.picker.terminal,
      '100',
    ),
  ).toEqual({
    text: 'Bob got nothing due to timeout.',
    kind: 'info',
  });
  expect(
    krunkBoardNotice(
      frozenHand!.games.guesser,
      'Bob',
      timeoutModel.game.instances.guesser.terminal,
      '100',
    ),
  ).toEqual({
    text: 'You got 100 mojo due to timeout.',
    kind: 'info',
  });
  const frozen = renderFrozenGameMount(terminal.model, controller, {
    iStarted: false,
    iProposedHand: true,
  });
  expect(frozen.props).toMatchObject({
    currentHandGameIds: ids,
    activeGameIds: [],
    interactionMode: 'terminal',
  });
  const markup = renderToStaticMarkup(
    React.createElement(FinishedSessionGameView, {
      model: terminal.model,
      myName: 'Alice',
      opponentName: 'Bob',
      iStarted: false,
      iProposedHand: true,
    }),
  );
  expect(markup).toContain('data-testid="finished-session-game-view"');
  expect(markup).not.toContain('Game details unavailable');
  expect(stageTerminal).toHaveBeenCalledWith(
    expect.objectContaining({
      currentHandGameIds: ids,
      activeGameIds: [],
      handState: controller.handState,
      gameInstances: {
        picker: timeoutModel.game.instances.picker,
        guesser: timeoutModel.game.instances.guesser,
      },
    }),
  );
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
