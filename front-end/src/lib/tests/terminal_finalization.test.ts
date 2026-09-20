import 'fake-indexeddb/auto';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  WalletOfferCleanupPendingError,
  type SessionController,
} from '../../hooks/SessionController';
import {
  initialKrunkGameState,
  krunkStateCodec,
  KrunkHandler,
  restoreKrunkHand,
} from '@games/krunk/ui/serialize';
import { krunkBoardNotice } from '@games/krunk/ui/useKrunkHand';
import FinishedSessionGameView from '../../components/FinishedSessionGameView';
import {
  _resetForTests,
  claimLease,
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
import type { SessionModel } from '../session/types';
import { readSessionRecord, SESSION_DB_NAME } from '../session/indexedDb';
import { decodeSessionSaveEnvelope } from '../session/persistence';
import { createSessionMachineState } from '../session/sessionMachine';
import { assembleSessionSave, persistSessionSnapshot } from '../session/sessionMachinePersist';
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
  state: {
    perPlayerStake: 10n,
    playerHand: [8n, 7n, 6n, 5n],
    opponentHand: [4n, 3n, 2n, 1n],
    moveNumber: 1n,
    isPlayerTurn: true,
    iStarted: true,
    cardSelections: [8n, 7n],
    settlementOutcome: null,
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
      stateNumber: null,
      unrollingStateNumber: null,
      preemptingStateNumber: null,
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
    lastHandProposal: {
      gameType: 'calpoker',
      senderIsPlayerA: false,
      gameTimeout: 15n,
      parameters: 10n,
    },
  },
});

function makeController(events: string[]): SessionController {
  return {
    handState: { ...handState, state: { ...handState.state, moveNumber: 99n } },
    quiesceForTerminalFinalization: async () => {
      events.push('controller-quiesce');
      return {
        model: structuredClone(model),
        coinsOfInterest: [{ label: 'Reward coin', id: 'coin-1' }],
      };
    },
  } as unknown as SessionController;
}

async function seedLiveSession(): Promise<void> {
  const live = liveSave({
    serializedGameSession: liveCradle,
    gameSessionSchemaVersion: 3n,
    pairingToken: 'live-token',
    sessionPeerId: 'peer',
    gameSessionId: '10'.repeat(16),
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
  await claimLease();
  await seedLiveSession();
});

afterEach(() => {
  _resetForTests();
});

function finalizationArgs(controller: SessionController) {
  return {
    controller,
    identity: {
      myName: 'Alice',
      opponentName: 'Bob',
      iStarted: true,
    },
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
    'controller-quiesce',
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

it('does not stage or tear down before controller terminal quiescence', async () => {
  let releaseQuiescence!: (snapshot: {
    model: SessionModel;
    coinsOfInterest: Array<{ label: string; id: string }>;
  }) => void;
  const quiescenceGate = new Promise<{
    model: SessionModel;
    coinsOfInterest: Array<{ label: string; id: string }>;
  }>((resolve) => {
    releaseQuiescence = resolve;
  });
  const controller = {
    quiesceForTerminalFinalization: jest.fn(() => quiescenceGate),
  } as unknown as SessionController;
  const stageTerminal = jest.fn(async () => {});
  const teardown = jest.fn();

  const finalization = finalizeTerminalSession(finalizationArgs(controller), {
    stageTerminal,
    flushSave: async () => {},
    discardTerminal: () => {},
    updateMarker: () => {},
    teardown,
  });
  await Promise.resolve();

  expect(controller.quiesceForTerminalFinalization).toHaveBeenCalledTimes(1);
  expect(stageTerminal).not.toHaveBeenCalled();
  expect(teardown).not.toHaveBeenCalled();

  releaseQuiescence({
    model: structuredClone(model),
    coinsOfInterest: [{ label: 'Reward coin', id: 'coin-1' }],
  });
  await finalization;

  expect(stageTerminal).toHaveBeenCalledTimes(1);
  expect(teardown).toHaveBeenCalledTimes(1);
});

it('does not stage or tear down while wallet offer cleanup remains unresolved', async () => {
  const controller = {
    quiesceForTerminalFinalization: jest.fn(async () => {
      throw new WalletOfferCleanupPendingError([
        { tradeId: 'trade-terminal', source: 'fee-finalization-warning' },
      ]);
    }),
  } as unknown as SessionController;
  const stageTerminal = jest.fn(async () => {});
  const teardown = jest.fn();

  await expect(
    finalizeTerminalSession(finalizationArgs(controller), {
      stageTerminal,
      flushSave: async () => {},
      discardTerminal: () => {},
      updateMarker: () => {},
      teardown,
    }),
  ).rejects.toMatchObject({ code: 'WALLET_OFFER_CLEANUP_PENDING' });

  expect(stageTerminal).not.toHaveBeenCalled();
  expect(teardown).not.toHaveBeenCalled();
});

it('stages and returns the model produced after terminal quiescence', async () => {
  const authoritativeModel = createSessionModel({
    channel: {
      ...model.channel,
      status: {
        ...model.channel.status,
        state: 'ResolvedUnrolled',
        ourBalance: '75',
        theirBalance: '25',
      },
    },
    game: {
      ...model.game,
      handState: {
        ...handState,
        state: {
          ...handState.state,
          moveNumber: 42n,
          displaySnapshot: {
            ...handState.state.displaySnapshot,
            gameState: 'finished',
            winner: 'player',
          },
        },
      },
      instances: {
        ...model.game.instances,
        'game-1': {
          ...model.game.instances['game-1'],
          terminal: {
            ...model.game.instances['game-1'].terminal,
            label: 'Runtime finished',
          },
        },
      },
    },
    betweenHand: model.betweenHand,
  });
  const controller = {
    quiesceForTerminalFinalization: jest.fn(async () => ({
      model: structuredClone(authoritativeModel),
      coinsOfInterest: [
        {
          label: 'Game 1 reward coin',
          id: 'coin-after-drain',
          game_id: 'game-1',
          game_coin_kind: 'reward' as const,
        },
      ],
    })),
  } as unknown as SessionController;
  const stageTerminal = jest.fn(async () => {});

  const terminal = await finalizeTerminalSession(finalizationArgs(controller), {
    stageTerminal,
    flushSave: async () => {},
    discardTerminal: () => {},
    updateMarker: () => {},
    teardown: () => {},
  });

  expect(terminal.model).toEqual(authoritativeModel);
  expect(terminal.model).not.toBe(authoritativeModel);
  expect(stageTerminal).toHaveBeenCalledWith(
    expect.objectContaining({
      presentation: expect.objectContaining({
        channelStatus: expect.objectContaining({
          state: 'ResolvedUnrolled',
          our_balance: '75',
          their_balance: '25',
        }),
        handState: authoritativeModel.game.handState,
        gameInstances: expect.objectContaining({
          'game-1': expect.objectContaining({
            terminal: expect.objectContaining({ label: 'Runtime finished' }),
          }),
        }),
      }),
      terminal: expect.objectContaining({
        coinsOfInterest: [
          {
            label: 'Hand 1 reward coin',
            id: 'coin-after-drain',
            game_id: 'game-1',
            game_coin_kind: 'reward',
          },
        ],
      }),
    }),
  );
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
          gameSessionId: '20'.repeat(16),
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
      const prior = loadState();
      const terminalBackup =
        prior.phase === 'terminal'
          ? {
              terminal: structuredClone(prior.terminal),
              presentation: structuredClone(prior.presentation),
            }
          : null;
      await replaceSession(
        baseSave({
          pairingToken: 'cancelled-token',
          sessionPeerId: 'peer',
          gameSessionId: '30'.repeat(16),
          iStarted: true,
          myContribution: '10',
          theirContribution: '10',
          perGameAmount: '1',
        }),
      );
      // Simulate dashboard Cancel bumping the epoch during replaceSession's
      // awaits — restore the finished freeze rather than wiping IndexedDB.
      startEpoch += 1;
      if (capturedEpoch !== startEpoch) {
        if (terminalBackup) {
          await saveTerminalSession(terminalBackup);
        }
        return;
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
  expect(decodeSessionSaveEnvelope((await readSessionRecord())!).phase).toBe('terminal');
});

it('keeps the terminal checkpoint when Cancel aborts before replaceSession', async () => {
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
  let replaceCalled = false;

  // Simulate dashboard Cancel before persist begins.
  startEpoch += 1;

  const outcome = await transitionToFreshSession({
    reportBusy: () => {},
    shouldAbort: () => capturedEpoch !== startEpoch,
    persistLiveCheckpoint: async () => {
      if (capturedEpoch !== startEpoch) return;
      replaceCalled = true;
      await replaceSession(
        baseSave({
          pairingToken: 'should-not-write',
          sessionPeerId: 'peer',
          gameSessionId: '40'.repeat(16),
          iStarted: true,
          myContribution: '10',
          theirContribution: '10',
          perGameAmount: '1',
        }),
      );
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
  expect(replaceCalled).toBe(false);
  expect(displayedSession).toBe('resolved');
  expect(mounted).toBe(false);
  expect(decodeSessionSaveEnvelope((await readSessionRecord())!).phase).toBe('terminal');
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

it('keeps a fully resolved live checkpoint until terminal finalization succeeds', async () => {
  const save = jest.fn(async () => {});
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
      waitingStateEnteredAt: null,
      cleanShutdownGraceStartedAt: null,
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
  });

  expect(save).toHaveBeenCalledTimes(1);
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({
      scope: 'live',
      live: expect.objectContaining({
        serializedGameSession: liveCradle,
      }),
      presentation: expect.objectContaining({
        activeGameIds: [],
        channelStatus: { state: 'ResolvedClean' },
      }),
    }),
  );
});

it('keeps a resolved unroll live while an on-chain game is still unresolved', async () => {
  const save = jest.fn(async () => {});
  const activeModel = createSessionModel({
    ...model,
    channel: { ...model.channel, status: { ...model.channel.status, state: 'ResolvedUnrolled' } },
    game: {
      ...model.game,
      activeIds: ['game-1'],
      instances: {
        'game-1': {
          id: 'game-1',
          amount: '10',
          coinHex: 'aa',
          presentation: 'on-chain-their-turn',
          terminal: { type: 'none' },
        },
      },
    },
  });
  const controller = {
    getWasmFields: () => ({
      serializedGameSession: liveCradle,
      gameSessionSchemaVersion: 3n,
      pairingToken: 'live-token',
      messageNumber: 2n,
      remoteNumber: 1n,
      iStarted: true,
      rewardPuzzleHash: '11'.repeat(32),
      handState,
      channelStatus: { state: 'ResolvedUnrolled' },
      wasmNotificationHistory: [],
      diagnosticLog: [],
      waitingStateEnteredAt: null,
      cleanShutdownGraceStartedAt: null,
    }),
  } as unknown as SessionController;

  await persistSessionSnapshot({
    controller,
    getState: () => createSessionMachineState(activeModel),
    restoring: false,
    getRestoreStatus: () => 'idle',
    getRestoreError: () => null,
    save,
  });

  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({
      scope: 'live',
      live: expect.objectContaining({ serializedGameSession: liveCradle }),
      presentation: expect.objectContaining({
        channelStatus: { state: 'ResolvedUnrolled' },
        activeGameIds: ['game-1'],
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
      waitingStateEnteredAt: null,
      cleanShutdownGraceStartedAt: null,
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

it('assembles current timer ownership instead of stale checkpoint timing', () => {
  let waitingStateEnteredAt: bigint | null = 200n;
  const staleMachineCheckpoint = createSessionMachineState(model);
  const controller = {
    getWasmFields: () => ({
      serializedGameSession: liveCradle,
      gameSessionSchemaVersion: 3n,
      pairingToken: 'live-token',
      messageNumber: 2n,
      remoteNumber: 1n,
      iStarted: true,
      rewardPuzzleHash: '11'.repeat(32),
      channelStatus: { state: 'Active' },
      wasmNotificationHistory: [],
      diagnosticLog: [],
      waitingStateEnteredAt,
      cleanShutdownGraceStartedAt: null,
    }),
  } as unknown as SessionController;
  const dependencies = {
    controller,
    getState: () => staleMachineCheckpoint,
    restoring: false,
    getRestoreStatus: () => 'idle' as const,
    getRestoreError: () => null,
  };

  waitingStateEnteredAt = 300n;
  const assembledFromStaleMachine = assembleSessionSave(dependencies);

  expect(assembledFromStaleMachine?.live.presentation.waitingStateEnteredAt).toBe(300n);
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
    perPlayerStake: 100n,
    members: [pickerBeforeTimeout, initialKrunkGameState('bob')],
  });
  const gameHand = restoreKrunkHand(krunkStateCodec.decode(acceptedHandState)!);
  for (const memberIndex of ids.keys()) {
    gameHand.receive({
      type: 'hand-ended',
      memberIndex,
      outcome: 'opponent_timed_out',
    });
  }
  const terminalHand = gameHand.getState();
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
      lastHandProposal: {
        gameType: 'krunk',
        senderIsPlayerA: true,
        gameTimeout: 15n,
        parameters: 100n,
      },
    },
  });
  const controller = {
    handState: acceptedHandState,
    quiesceForTerminalFinalization: async () => ({
      model: structuredClone(timeoutModel),
      coinsOfInterest: [],
    }),
  } as unknown as SessionController;
  const stageTerminal = jest.fn(async () => {});

  const terminal = await finalizeTerminalSession(
    {
      controller,
      identity: {
        myName: 'Alice',
        opponentName: 'Bob',
        iStarted: false,
      },
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
    hasSavedHand: true,
    terminalLabel: 'Opponent timed out',
  });
  const frozenHand = krunkStateCodec.decode(terminal.model.game.handState);
  expect(frozenHand).not.toBeNull();
  expect(frozenHand!.members).toHaveLength(ids.length);
  expect(frozenHand!.members.every((state) => state.handler === KrunkHandler.Terminal)).toBe(true);
  expect(krunkBoardNotice(frozenHand!.members[0], 'Bob', frozenHand!.perPlayerStake)).toEqual({
    text: 'Bob got nothing due to timeout.',
    kind: 'info',
  });
  expect(krunkBoardNotice(frozenHand!.members[1], 'Bob', frozenHand!.perPlayerStake)).toEqual({
    text: 'You got 100 mojo due to timeout.',
    kind: 'info',
  });
  const frozen = renderFrozenGameMount(terminal.model, {});
  expect(frozen.props).toMatchObject({
    view: {
      frozen: true,
    },
  });
  expect(frozen.props.view.hand.getState()).toEqual(terminal.model.game.handState?.state);
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
  let latestModel = structuredClone(model);
  let latestCoins = [{ label: 'Reward coin', id: 'coin-1' }];
  const controller = {
    quiesceForTerminalFinalization: async () => {
      events.push('controller-quiesce');
      return {
        model: structuredClone(latestModel),
        coinsOfInterest: structuredClone(latestCoins),
      };
    },
  } as unknown as SessionController;
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
  latestModel = createSessionModel({
    channel: {
      ...model.channel,
      status: {
        ...model.channel.status,
        state: 'ResolvedUnrolled',
        ourBalance: '70',
        theirBalance: '30',
      },
    },
    game: {
      ...model.game,
      handState: {
        ...handState,
        state: { ...handState.state, moveNumber: 2n },
      },
    },
    betweenHand: model.betweenHand,
  });
  latestCoins = [{ label: 'Fresh reward coin', id: 'coin-after-retry' }];
  await finalizeTerminalSession(finalizationArgs(controller), dependencies);

  expect(events).toEqual(['controller-quiesce', 'controller-quiesce']);
  expect(teardown).toHaveBeenCalledTimes(1);
  _resetForTests();
  const restored = await peekSession();
  expect(restored).not.toHaveProperty('live');
  expect(restored?.phase === 'terminal' && restored.presentation.channelStatus?.state).toBe(
    'ResolvedUnrolled',
  );
  expect(
    restored?.phase === 'terminal' &&
      (
        restored.presentation.handState as {
          state: { moveNumber: bigint };
        }
      ).state.moveNumber,
  ).toBe(2n);
  expect(restored?.phase === 'terminal' && restored.terminal.coinsOfInterest).toEqual(latestCoins);
});
