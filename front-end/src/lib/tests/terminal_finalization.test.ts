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
import { storageRepository } from '../session/storageRepository';
import { hasSavedSessionMarker, markSavedSession } from '../../hooks/saveCoordination';
import { createSessionModel } from '../session/model';
import type { SessionModel } from '../session/types';
import {
  readApplicationState,
  SESSION_DB_NAME,
  StorageAuthorityLostError,
  StorageAuthorityRequiredError,
} from '../session/indexedDb';
import { decodeDurableApplicationState } from '../session/persistence';
import { createSessionMachineState } from '../session/sessionMachine';
import {
  captureDurableApplicationState,
  type SessionPersistDependencies,
} from '../session/sessionMachinePersist';
import { selectFinishedSessionDisplay } from '../session/finishedSessionDisplay';
import { renderFrozenGameMount } from '../gameMountRegistry';
import {
  finalizeTerminalSession,
  type TerminalFinalizationDependencies,
} from '../session/terminalFinalization';
import { liveSave } from './session_save_envelope.fixtures';

const testIndexedDb = indexedDB;
const walletProviderScope = { provider: 'simulator' as const, identity: 'player' };
const liveCradle = new Uint8Array([1, 2, 3]);

async function persistCapturedState(dependencies: SessionPersistDependencies) {
  const capture = captureDurableApplicationState({ kind: 'live', ...dependencies });
  if (!capture) throw new Error('expected live capture');
  const state = structuredClone(storageRepository.loadState());
  await capture.write();
  return state;
}

function prepareTerminalCapture(capture: Parameters<typeof captureDurableApplicationState>[0]) {
  const prepared = captureDurableApplicationState(capture);
  if (!prepared) throw new Error('expected terminal capture');
  return prepared;
}

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
    getWalletProviderScope: () => walletProviderScope,
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
  if (live.session?.phase !== 'live') throw new Error('expected live fixture');
  await storageRepository.checkpointApplicationState(live);
  markSavedSession();
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
  await seedLiveSession();
});

afterEach(() => {
  storageRepository._resetForTests();
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
    captureTerminal: (capture) => {
      const prepared = prepareTerminalCapture(capture);
      return {
        write: async () => {
          events.push('stage-terminal', 'write-start');
          await writeGate;
          await prepared.write();
          events.push('write-complete');
        },
      };
    },
    updateMarker: () => events.push('marker'),
    teardown,
  };

  const first = finalizeTerminalSession(finalizationArgs(controller), dependencies);
  const duplicate = finalizeTerminalSession(finalizationArgs(controller), dependencies);
  expect(duplicate).toBe(first);
  await Promise.resolve();
  await Promise.resolve();

  expect(teardown).not.toHaveBeenCalled();
  const liveRecord = await readApplicationState();
  const decodedLiveRecord = liveRecord ? decodeDurableApplicationState(liveRecord).save : null;
  expect(
    decodedLiveRecord?.session?.phase === 'live' &&
      decodedLiveRecord.session.live.serializedGameSession,
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

  storageRepository._resetForTests();
  const restored = await storageRepository.readCurrentState();
  expect(restored).toMatchObject({
    session: {
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
    },
  });
  expect(
    restored?.session?.phase === 'terminal' && restored.session.presentation.handState,
  ).toEqual(handState);
  expect(
    restored?.session?.phase === 'terminal' &&
      restored.session.presentation.gameInstances?.['game-1']?.terminal.label,
  ).toBe('Finished');
  if (restored?.session?.phase !== 'terminal') throw new Error('expected terminal record');
  expect(restored.session).not.toHaveProperty('durabilityWarning');
  expect(restored.session.presentation).not.toHaveProperty('myRunningBalance');
  expect(restored.session.presentation).not.toHaveProperty('channelNotifQueue');
  expect(restored.session.presentation).not.toHaveProperty('gameNotifQueue');
  expect(restored.session.presentation).not.toHaveProperty('dismissedChannelStatus');
  expect(restored.session.presentation.betweenHandCompose).not.toHaveProperty('proposal_sent');
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
    getWalletProviderScope: () => walletProviderScope,
    quiesceForTerminalFinalization: jest.fn(() => quiescenceGate),
  } as unknown as SessionController;
  const captureTerminal = jest.fn(() => ({ write: async () => {} }));
  const teardown = jest.fn();

  const finalization = finalizeTerminalSession(finalizationArgs(controller), {
    captureTerminal,
    updateMarker: () => {},
    teardown,
  });
  await Promise.resolve();

  expect(controller.quiesceForTerminalFinalization).toHaveBeenCalledTimes(1);
  expect(captureTerminal).not.toHaveBeenCalled();
  expect(teardown).not.toHaveBeenCalled();

  releaseQuiescence({
    model: structuredClone(model),
    coinsOfInterest: [{ label: 'Reward coin', id: 'coin-1' }],
  });
  await finalization;

  expect(captureTerminal).toHaveBeenCalledTimes(1);
  expect(teardown).toHaveBeenCalledTimes(1);
});

it('does not stage or tear down while wallet offer cleanup remains unresolved', async () => {
  const controller = {
    getWalletProviderScope: () => walletProviderScope,
    quiesceForTerminalFinalization: jest.fn(async () => {
      throw new WalletOfferCleanupPendingError([
        { tradeId: 'trade-terminal', source: 'fee-finalization-warning' },
      ]);
    }),
  } as unknown as SessionController;
  const captureTerminal = jest.fn(() => ({ write: async () => {} }));
  const teardown = jest.fn();

  await expect(
    finalizeTerminalSession(finalizationArgs(controller), {
      captureTerminal,
      updateMarker: () => {},
      teardown,
    }),
  ).rejects.toMatchObject({ code: 'WALLET_OFFER_CLEANUP_PENDING' });

  expect(captureTerminal).not.toHaveBeenCalled();
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
    getWalletProviderScope: () => walletProviderScope,
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
  const captureTerminal = jest.fn(() => ({ write: async () => {} }));

  const terminal = await finalizeTerminalSession(finalizationArgs(controller), {
    captureTerminal,
    updateMarker: () => {},
    teardown: () => {},
  });

  expect(terminal.model).toEqual(authoritativeModel);
  expect(terminal.model).not.toBe(authoritativeModel);
  expect(captureTerminal).toHaveBeenCalledWith(
    expect.objectContaining({
      model: expect.objectContaining({
        channel: expect.objectContaining({
          status: expect.objectContaining({
            state: 'ResolvedUnrolled',
            ourBalance: '75',
            theirBalance: '25',
          }),
        }),
        game: expect.objectContaining({
          handState: authoritativeModel.game.handState,
          instances: expect.objectContaining({
            'game-1': expect.objectContaining({
              terminal: expect.objectContaining({ label: 'Runtime finished' }),
            }),
          }),
        }),
      }),
      coinsOfInterest: [
        {
          label: 'Hand 1 reward coin',
          id: 'coin-after-drain',
          game_id: 'game-1',
          game_coin_kind: 'reward',
        },
      ],
    }),
  );
});

it('round-trips an explicitly empty local alias without converting it to null', async () => {
  await seedLiveSession();
  const controller = makeController([]);
  const args = finalizationArgs(controller);
  args.identity.myName = '';

  await finalizeTerminalSession(args, {
    captureTerminal: prepareTerminalCapture,
    updateMarker: markSavedSession,
    teardown: jest.fn(),
  });

  storageRepository._resetForTests();
  const restored = await storageRepository.readCurrentState();
  expect(restored?.session?.phase === 'terminal' && restored.session.terminal.myAlias).toBe('');
});

it('keeps a fully resolved live checkpoint until terminal finalization succeeds', async () => {
  const controller = {
    getWalletProviderScope: () => walletProviderScope,
    getWasmFields: () => ({
      serializedGameSession: liveCradle,
      gameSessionSchemaVersion: 3n,
      pairingToken: 'live-token',
      gameSessionId: '10'.repeat(16),
      myContribution: '60',
      theirContribution: '40',
      perGameAmount: '10',
      messageNumber: 2n,
      remoteNumber: 1n,
      unackedMessages: [],
      terminalHandoff: null,
      transportDisposition: 'active',
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

  const saved = await persistCapturedState({
    controller,
    getState: () => createSessionMachineState(model),
    restoring: false,
    getRestoreStatus: () => 'idle',
    getRestoreError: () => null,
  });

  expect(saved).toEqual(
    expect.objectContaining({
      session: expect.objectContaining({
        phase: 'live',
        live: expect.objectContaining({
          serializedGameSession: liveCradle,
        }),
        presentation: expect.objectContaining({
          activeGameIds: [],
          channelStatus: expect.objectContaining({ state: 'ResolvedClean' }),
        }),
      }),
    }),
  );
});

it('keeps a resolved unroll live while an on-chain game is still unresolved', async () => {
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
          terminal: {
            type: 'none',
            label: null,
            outcome: null,
            myReward: null,
            rewardCoinHex: null,
          },
        },
      },
    },
  });
  const controller = {
    getWalletProviderScope: () => walletProviderScope,
    getWasmFields: () => ({
      serializedGameSession: liveCradle,
      gameSessionSchemaVersion: 3n,
      pairingToken: 'live-token',
      gameSessionId: '10'.repeat(16),
      myContribution: '60',
      theirContribution: '40',
      perGameAmount: '10',
      messageNumber: 2n,
      remoteNumber: 1n,
      unackedMessages: [],
      terminalHandoff: null,
      transportDisposition: 'active',
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

  const saved = await persistCapturedState({
    controller,
    getState: () => createSessionMachineState(activeModel),
    restoring: false,
    getRestoreStatus: () => 'idle',
    getRestoreError: () => null,
  });

  expect(saved).toEqual(
    expect.objectContaining({
      session: expect.objectContaining({
        phase: 'live',
        live: expect.objectContaining({ serializedGameSession: liveCradle }),
        presentation: expect.objectContaining({
          channelStatus: expect.objectContaining({ state: 'ResolvedUnrolled' }),
          activeGameIds: ['game-1'],
        }),
      }),
    }),
  );
});

it('persists live machine hand state instead of a former controller bundle value', async () => {
  const liveModel = createSessionModel({
    ...model,
    channel: { ...model.channel, status: { ...model.channel.status, state: 'Active' } },
  });
  const formerControllerHandState = {
    ...handState,
    state: { ...handState.state, moveNumber: 99n },
  };
  const controller = {
    getWalletProviderScope: () => walletProviderScope,
    getWasmFields: () => ({
      serializedGameSession: liveCradle,
      gameSessionSchemaVersion: 3n,
      pairingToken: 'live-token',
      gameSessionId: '10'.repeat(16),
      myContribution: '60',
      theirContribution: '40',
      perGameAmount: '10',
      messageNumber: 2n,
      remoteNumber: 1n,
      unackedMessages: [],
      terminalHandoff: null,
      transportDisposition: 'active',
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

  const saved = await persistCapturedState({
    controller,
    getState: () => createSessionMachineState(liveModel),
    restoring: false,
    getRestoreStatus: () => 'idle',
    getRestoreError: () => null,
  });

  expect(saved).toEqual(
    expect.objectContaining({
      session: expect.objectContaining({
        phase: 'live',
        live: expect.objectContaining({ serializedGameSession: liveCradle }),
        presentation: expect.objectContaining({ handState }),
      }),
    }),
  );
  expect(saved.session?.phase).toBe('live');
  expect(saved.session?.phase === 'live' ? saved.session.presentation.handState : null).not.toEqual(
    formerControllerHandState,
  );
});

it('assembles current timer ownership instead of stale checkpoint timing', () => {
  let waitingStateEnteredAt: bigint | null = 200n;
  const staleMachineCheckpoint = createSessionMachineState(model);
  const controller = {
    getWalletProviderScope: () => walletProviderScope,
    getWasmFields: () => ({
      serializedGameSession: liveCradle,
      gameSessionSchemaVersion: 3n,
      pairingToken: 'live-token',
      gameSessionId: '10'.repeat(16),
      myContribution: '60',
      theirContribution: '40',
      perGameAmount: '10',
      messageNumber: 2n,
      remoteNumber: 1n,
      unackedMessages: [],
      terminalHandoff: null,
      transportDisposition: 'active',
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
  const capture = captureDurableApplicationState({ kind: 'live', ...dependencies });
  const captured = storageRepository.loadState();

  expect(capture).not.toBeNull();
  expect(captured.session?.phase).toBe('live');
  expect(
    captured.session?.phase === 'live' ? captured.session.presentation.waitingStateEnteredAt : null,
  ).toBe(300n);
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
    getWalletProviderScope: () => walletProviderScope,
    quiesceForTerminalFinalization: async () => ({
      model: structuredClone(timeoutModel),
      coinsOfInterest: [],
    }),
  } as unknown as SessionController;
  const captureTerminal = jest.fn(() => ({ write: async () => {} }));

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
      captureTerminal,
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
  expect(captureTerminal).toHaveBeenCalledWith(
    expect.objectContaining({
      model: expect.objectContaining({
        game: expect.objectContaining({
          currentHandIds: ids,
          activeIds: [],
          handState: terminalHandState,
          instances: {
            picker: timeoutModel.game.instances.picker,
            guesser: timeoutModel.game.instances.guesser,
          },
        }),
      }),
    }),
  );
});

it('returns the terminal result and tears down after an ordinary write failure', async () => {
  const events: string[] = [];
  const reportDurabilityError = jest.fn();
  const controller = {
    getWalletProviderScope: () => walletProviderScope,
    quiesceForTerminalFinalization: async () => {
      events.push('controller-quiesce');
      return {
        model: structuredClone(model),
        coinsOfInterest: [{ label: 'Reward coin', id: 'coin-1' }],
      };
    },
    reportDurabilityError,
  } as unknown as SessionController;
  const teardown = jest.fn(() => events.push('teardown'));
  const dependencies: TerminalFinalizationDependencies = {
    captureTerminal: (capture) => {
      prepareTerminalCapture(capture);
      return {
        write: async () => {
          throw new Error('deferred IndexedDB write failed');
        },
      };
    },
    updateMarker: () => events.push('marker'),
    teardown,
  };

  const terminal = await finalizeTerminalSession(finalizationArgs(controller), dependencies);

  expect(terminal.model).toEqual(model);
  expect(events).toEqual(['controller-quiesce', 'marker', 'teardown']);
  expect(teardown).toHaveBeenCalledTimes(1);
  expect(reportDurabilityError).toHaveBeenCalledTimes(1);
  expect(reportDurabilityError).toHaveBeenCalledWith(
    expect.objectContaining({ message: 'deferred IndexedDB write failed' }),
  );
  expect(hasSavedSessionMarker()).toBe(true);
  const cached = storageRepository.loadState();
  expect(cached.session?.phase).toBe('terminal');
  const durable = await readApplicationState();
  const decodedDurable = durable ? decodeDurableApplicationState(durable).save : null;
  expect(
    decodedDurable?.session?.phase === 'live' && decodedDurable.session.live.serializedGameSession,
  ).toEqual(liveCradle);

  await storageRepository.checkpointApplicationState(storageRepository.loadState());

  expect(events).toEqual(['controller-quiesce', 'marker', 'teardown']);
  expect(teardown).toHaveBeenCalledTimes(1);
  expect(reportDurabilityError).toHaveBeenCalledTimes(1);
  storageRepository._resetForTests();
  const restored = await storageRepository.readCurrentState();
  expect(restored?.session).not.toHaveProperty('live');
  expect(
    restored?.session?.phase === 'terminal' && restored.session.presentation.channelStatus?.state,
  ).toBe('ResolvedClean');
  expect(
    restored?.session?.phase === 'terminal' && restored.session.terminal.coinsOfInterest,
  ).toEqual([{ label: 'Reward coin', id: 'coin-1' }]);
});

it.each([
  ['lost', () => new StorageAuthorityLostError()],
  ['required', () => new StorageAuthorityRequiredError()],
])('propagates storage authority %s without publishing a terminal result', async (_kind, error) => {
  const controller = {
    getWalletProviderScope: () => walletProviderScope,
    quiesceForTerminalFinalization: async () => ({
      model: structuredClone(model),
      coinsOfInterest: [],
    }),
    reportDurabilityError: jest.fn(),
  } as unknown as SessionController;
  const updateMarker = jest.fn();
  const teardown = jest.fn();

  await expect(
    finalizeTerminalSession(finalizationArgs(controller), {
      captureTerminal: (capture) => {
        prepareTerminalCapture(capture);
        return { write: async () => Promise.reject(error()) };
      },
      updateMarker,
      teardown,
    }),
  ).rejects.toBeInstanceOf(error().constructor);

  expect(controller.reportDurabilityError).not.toHaveBeenCalled();
  expect(updateMarker).not.toHaveBeenCalled();
  expect(teardown).not.toHaveBeenCalled();
});
