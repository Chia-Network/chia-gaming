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
  clearSession,
  discardStagedTerminalSession,
  flushSessionSave,
  hasSavedSessionMarker,
  loadState,
  markSavedSession,
  peekSession,
  replaceSession,
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
import { transitionToFreshSession } from '../restoreLifecycle';
import {
  finalizeTerminalSession,
  type TerminalFinalizationDependencies,
} from '../session/terminalFinalization';
import { baseSave, liveSave } from './session_save_envelope.fixtures';

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
    currentHandOrigin: 'local',
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
    handState: { ...handState, state: { ...handState.state, moveNumber: 99n } },
    flushPendingSave: async () => {
      events.push('controller-flush');
    },
  } as unknown as SessionController;
}

async function seedLiveSession(): Promise<void> {
  const live = liveSave({
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
  if (live.phase !== 'live') throw new Error('expected live fixture');
  saveSession({
    scope: 'live',
    pairing: live.pairing,
    live: live.live,
    presentation: live.presentation,
    history: live.history,
  });
  await flushSessionSave();
  markSavedSession();
}

function terminalUpdate(fields: {
  channelStatus: { state: string };
  coinsOfInterest: Array<{ label: string; id: string }>;
}) {
  const complete = baseSave({
    channelStatus: fields.channelStatus,
    coinsOfInterest: fields.coinsOfInterest,
    terminalIStarted: false,
  });
  if (complete.phase !== 'terminal') throw new Error('expected terminal fixture');
  return {
    terminal: complete.terminal,
    presentation: complete.presentation,
  };
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
  const liveRecord = await readSessionRecord();
  const decodedLiveRecord = liveRecord ? decodeSessionSaveEnvelope(liveRecord).save : null;
  expect(
    decodedLiveRecord?.phase === 'live' && decodedLiveRecord.live.serializedGameSession,
  ).toEqual(liveCradle);

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
    phase: 'terminal',
    terminal: {
      iStarted: true,
      myAlias: 'Alice',
      opponentAlias: 'Bob',
      coinsOfInterest: [{ label: 'Reward coin', id: 'coin-1' }],
    },
    presentation: {
      currentHandOrigin: 'local',
      activeGameIds: [],
      currentHandGameIds: ['game-1'],
      lastDisplayedGameId: 'game-1',
    },
  });
  expect(restored?.phase === 'terminal' && restored.presentation.handState).toEqual(handState);
  expect(
    restored?.phase === 'terminal' &&
      restored.presentation.gameInstances?.['game-1']?.terminal.label,
  ).toBe('Finished');
  expect(restored).not.toHaveProperty('live');
  expect(restored).not.toHaveProperty('pairing');
});

it('round-trips an explicitly empty local alias without converting it to null', async () => {
  await seedLiveSession();
  const controller = makeController([]);
  const args = finalizationArgs(controller);
  args.identity.myName = '';

  await finalizeTerminalSession(args, {
    stageTerminal: stageTerminalSession,
    flushSave: flushSessionSave,
    discardTerminal: discardStagedTerminalSession,
    updateMarker: markSavedSession,
    teardown: jest.fn(),
  });

  _resetForTests();
  const restored = await peekSession();
  expect(restored?.phase === 'terminal' && restored.terminal.myAlias).toBe('');
});

it('atomically removes live restart fields through the real mutation queue', async () => {
  const terminalWrite = saveTerminalSession(
    terminalUpdate({
      channelStatus: { state: 'ResolvedClean' },
      coinsOfInterest: [{ label: 'Reward coin', id: 'coin-1' }],
    }),
  );

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
  expect(decodeSessionSaveEnvelope(stored!).phase).toBe('terminal');
  expect(stored).not.toHaveProperty('serializedGameSession');
  expect(stored).not.toHaveProperty('messageNumber');
  expect(stored).not.toHaveProperty('unackedMessages');
});

it('retires a resolved display before accepting a fresh live session', async () => {
  await saveTerminalSession(
    terminalUpdate({
      channelStatus: { state: 'ResolvedClean' },
      coinsOfInterest: [{ label: 'Reward coin', id: 'coin-1' }],
    }),
  );
  await flushSessionSave();

  let displayedSession = 'resolved';
  let mountedPairingToken: string | null = null;
  let hubBusy = false;
  const pairingToken = 'fresh-live-token';

  const outcome = await transitionToFreshSession({
    retireTerminalDisplay: () => {
      displayedSession = 'none';
    },
    persistLiveCheckpoint: async () => {
      await replaceSession(
        baseSave({
          pairingToken,
          sessionPeerId: 'new-peer',
          gameSessionId: 'new-session',
          iStarted: false,
          myContribution: '60',
          theirContribution: '40',
          perGameAmount: '4',
        }),
      );
    },
    mountLiveSession: () => {
      mountedPairingToken = pairingToken;
      displayedSession = 'live';
    },
    reportBusy: () => {
      hubBusy = true;
    },
  });

  expect(outcome).toBe('completed');
  expect(displayedSession).toBe('live');
  expect(mountedPairingToken).toBe(pairingToken);
  expect(hubBusy).toBe(true);
  expect(decodeSessionSaveEnvelope((await readSessionRecord())!).phase).toBe('pre-handshake');
});

it('aborts after persist when the start epoch advances during replaceSession', async () => {
  await saveTerminalSession(
    terminalUpdate({
      channelStatus: { state: 'ResolvedClean' },
      coinsOfInterest: [{ label: 'Reward coin', id: 'coin-1' }],
    }),
  );
  await flushSessionSave();

  let displayedSession = 'resolved';
  let mounted = false;
  let startEpoch = 1;
  const capturedEpoch = startEpoch;

  const outcome = await transitionToFreshSession({
    reportBusy: () => {},
    shouldAbort: () => capturedEpoch !== startEpoch,
    persistLiveCheckpoint: async () => {
      await replaceSession(
        baseSave({
          pairingToken: 'cancelled-token',
          sessionPeerId: 'peer',
          gameSessionId: 'session',
          iStarted: true,
          myContribution: '10',
          theirContribution: '10',
          perGameAmount: '1',
        }),
      );
      // Simulate dashboard Cancel bumping the epoch and clearing storage after
      // replaceSession's awaits — the write must not survive as a resume target.
      startEpoch += 1;
      const humanHistory = loadState().history.humanHistory;
      await clearSession();
      if (humanHistory?.length) {
        await saveSession({ scope: 'common', history: { humanHistory } });
      }
    },
    retireTerminalDisplay: () => {
      displayedSession = 'none';
    },
    mountLiveSession: () => {
      mounted = true;
      displayedSession = 'live';
    },
  });

  expect(outcome).toBe('aborted');
  expect(displayedSession).toBe('resolved');
  expect(mounted).toBe(false);
  await flushSessionSave();
  const record = await readSessionRecord();
  expect(record == null || decodeSessionSaveEnvelope(record).phase === 'preferences').toBe(true);
});

it('keeps the resolved display and terminal checkpoint when fresh persistence fails', async () => {
  await saveTerminalSession(
    terminalUpdate({
      channelStatus: { state: 'ResolvedClean' },
      coinsOfInterest: [{ label: 'Reward coin', id: 'coin-1' }],
    }),
  );
  await flushSessionSave();

  let displayedSession = 'resolved';
  let mounted = false;

  await expect(
    transitionToFreshSession({
      reportBusy: () => {},
      persistLiveCheckpoint: async () => {
        throw new Error('checkpoint failed');
      },
      retireTerminalDisplay: () => {
        displayedSession = 'none';
      },
      mountLiveSession: () => {
        mounted = true;
      },
    }),
  ).rejects.toThrow('checkpoint failed');

  expect(displayedSession).toBe('resolved');
  expect(mounted).toBe(false);
  expect(decodeSessionSaveEnvelope((await readSessionRecord())!).phase).toBe('terminal');
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
      rewardPuzzleHash: '11'.repeat(32),
      handState: { ...handState, state: { ...handState.state, moveNumber: 99n } },
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
      terminal: expect.objectContaining({
        coinsOfInterest: [{ label: 'Reward coin', id: 'coin-1' }],
      }),
      presentation: expect.objectContaining({
        channelStatus: { state: 'ResolvedClean' },
        handState,
      }),
    }),
  );
});

it('persists live machine hand state instead of a former controller bundle value', async () => {
  const save = jest.fn(async () => {});
  const liveModel = createSessionModel({
    ...model,
    channel: { ...model.channel, status: { ...model.channel.status, state: 'Active' } },
  });
  const formerControllerHandState = {
    ...handState,
    state: { ...handState.state, moveNumber: 99n },
  };
  const controller = {
    getWasmFields: () => ({
      serializedGameSession: liveCradle,
      gameSessionSchemaVersion: 3n,
      pairingToken: 'live-token',
      messageNumber: 2n,
      remoteNumber: 1n,
      iStarted: true,
      rewardPuzzleHash: '11'.repeat(32),
      handState: formerControllerHandState,
      channelStatus: { state: 'Active' },
      wasmNotificationHistory: [],
      diagnosticLog: [],
    }),
  } as unknown as SessionController;

  await persistSessionSnapshot({
    controller,
    getState: () => createSessionMachineState(liveModel),
    restoring: false,
    getRestoreStatus: () => 'idle',
    getRestoreError: () => null,
    save,
  });

  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({
      scope: 'live',
      live: expect.objectContaining({ serializedGameSession: liveCradle }),
      presentation: expect.objectContaining({ handState }),
    }),
  );
  expect(save.mock.calls[0][0].presentation.handState).not.toEqual(formerControllerHandState);
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
  let terminalHand = krunkStateCodec.decode(acceptedHandState)!;
  for (const settledId of ids) {
    terminalHand = reduceKrunkDurableState(terminalHand, { type: 'settled', id: settledId })!;
  }
  const terminalHandState = krunkStateCodec.encode(terminalHand);
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
      currentHandOrigin: 'local',
      activeGameType: 'krunk',
      lastDisplayedId: 'picker',
      handState: terminalHandState,
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
  const controller = {
    handState: acceptedHandState,
    flushPendingSave: async () => {},
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
  const frozen = renderFrozenGameMount(terminal.model, {
    iStarted: false,
  });
  expect(frozen.props).toMatchObject({
    currentHandGameIds: ids,
    activeGameIds: [],
    handSource: {
      interactionMode: 'terminal',
      handState: terminal.model.game.handState,
    },
  });
  expect(frozen.props).not.toHaveProperty('gameObject');
  const markup = renderToStaticMarkup(
    React.createElement(FinishedSessionGameView, {
      model: terminal.model,
      myName: 'Alice',
      opponentName: 'Bob',
      iStarted: false,
    }),
  );
  expect(markup).toContain('data-testid="finished-session-game-view"');
  expect(markup).not.toContain('Game details unavailable');
  expect(stageTerminal).toHaveBeenCalledWith(
    expect.objectContaining({
      presentation: expect.objectContaining({
        currentHandGameIds: ids,
        activeGameIds: [],
        handState: terminalHandState,
        gameInstances: {
          picker: timeoutModel.game.instances.picker,
          guesser: timeoutModel.game.instances.guesser,
        },
      }),
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
  const cached = loadState();
  expect(cached.phase === 'live' && cached.live.serializedGameSession).toEqual(liveCradle);
  const durable = await readSessionRecord();
  const decodedDurable = durable ? decodeSessionSaveEnvelope(durable).save : null;
  expect(decodedDurable?.phase === 'live' && decodedDurable.live.serializedGameSession).toEqual(
    liveCradle,
  );

  failWrite = false;
  await finalizeTerminalSession(finalizationArgs(controller), dependencies);

  expect(events).toEqual(['controller-flush', 'controller-flush']);
  expect(teardown).toHaveBeenCalledTimes(1);
  _resetForTests();
  const restored = await peekSession();
  expect(restored).not.toHaveProperty('live');
  expect(restored?.phase === 'terminal' && restored.presentation.channelStatus?.state).toBe(
    'ResolvedClean',
  );
});
