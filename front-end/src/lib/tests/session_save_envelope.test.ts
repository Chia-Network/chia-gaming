import 'fake-indexeddb/auto';
import { calpokerStateCodec } from '../../features/calPoker/stateCodec';
import { initialKrunkGameState, krunkStateCodec } from '../../features/krunk/stateCodec';
import { spacepokerStateCodec } from '../../features/spacePoker/stateCodec';
import {
  CURRENT_VERSION,
  _resetForTests,
  flushSessionSave,
  hasSavedSessionMarker,
  markSavedSession,
  peekSession,
  saveSession,
  type SessionSave,
} from '../../hooks/save';
import { decodePersistedGameState } from '../gameRegistry';
import { deleteSessionRecord, readSessionRecord, writeSessionRecord } from '../session/indexedDb';
import { sessionModelFromSave, validateSessionSaveEnvelope } from '../session/persistence';

const ACTIVE_INSTANCE = {
  id: 'game-1',
  amount: '20',
  coinHex: null,
  presentation: 'off-chain-my-turn' as const,
  terminal: {
    type: 'none',
    outcome: null,
    label: null,
    myReward: null,
    rewardCoinHex: null,
  },
};

const TERMINAL_INSTANCE = {
  id: 'game-1',
  amount: '20',
  coinHex: null,
  presentation: 'ended' as const,
  terminal: {
    type: 'settled',
    outcome: 'settled_cleanly',
    label: 'Settled cleanly',
    myReward: '20',
    rewardCoinHex: null,
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

function baseSave(fields: Partial<SessionSave> = {}): SessionSave {
  return {
    version: CURRENT_VERSION,
    playerId: 'player',
    rewardPuzzleHash: null,
    ...fields,
  };
}

function activeSave(fields: Partial<SessionSave> = {}): SessionSave {
  return baseSave({
    activeGameIds: ['game-1'],
    currentHandGameIds: ['game-1'],
    lastDisplayedGameId: 'game-1',
    activeGameType: 'calpoker',
    gameInstances: { 'game-1': ACTIVE_INSTANCE },
    ...fields,
  });
}

beforeEach(async () => {
  _resetForTests();
  setTestGlobal('localStorage', makeStorage());
  setTestGlobal('sessionStorage', makeStorage());
  await deleteSessionRecord();
});

afterEach(() => {
  _resetForTests();
});

describe('validateSessionSaveEnvelope', () => {
  it('accepts empty preference and pre-game records', () => {
    expect(() => validateSessionSaveEnvelope(baseSave())).not.toThrow();
    expect(() =>
      validateSessionSaveEnvelope(baseSave({ blockchainType: 'simulator', pairingToken: 'pair' })),
    ).not.toThrow();
  });

  it.each([
    ['activeGameIds', { activeGameIds: ['game-1', 'game-1'] }],
    ['currentHandGameIds', { currentHandGameIds: ['game-1', 'game-1'] }],
  ])('rejects duplicate %s', (_label, fields) => {
    expect(() => validateSessionSaveEnvelope(activeSave(fields))).toThrow('duplicate');
  });

  it.each([
    ['active', { gameInstances: undefined }],
    ['current', { activeGameIds: [], gameInstances: undefined }],
    ['last display', { activeGameIds: [], currentHandGameIds: [], gameInstances: undefined }],
  ])('rejects a missing %s instance', (_label, fields) => {
    expect(() => validateSessionSaveEnvelope(activeSave(fields))).toThrow('missing its keyed');
  });

  it('retains completed current-hand members but rejects active terminal members', () => {
    expect(() =>
      validateSessionSaveEnvelope(
        activeSave({
          activeGameIds: [],
          gameInstances: { 'game-1': TERMINAL_INSTANCE },
        }),
      ),
    ).not.toThrow();
    expect(() =>
      validateSessionSaveEnvelope(activeSave({ gameInstances: { 'game-1': TERMINAL_INSTANCE } })),
    ).toThrow('active game game-1 is terminal');
  });

  it('requires presentation and terminal state to end together', () => {
    expect(() =>
      validateSessionSaveEnvelope(
        activeSave({
          activeGameIds: [],
          gameInstances: {
            'game-1': { ...TERMINAL_INSTANCE, presentation: 'finishing' },
          },
        }),
      ),
    ).toThrow('presentation and terminal state disagree');
    expect(() =>
      validateSessionSaveEnvelope(
        activeSave({
          activeGameIds: [],
          gameInstances: {
            'game-1': { ...ACTIVE_INSTANCE, presentation: 'ended' },
          },
        }),
      ),
    ).toThrow('presentation and terminal state disagree');
  });

  it('rejects mismatched hand types and unrelated Krunk payload IDs', () => {
    expect(() =>
      validateSessionSaveEnvelope(
        activeSave({
          handState: calpokerStateCodec.encode({
            playerHand: [1n, 2n],
            opponentHand: [3n, 4n],
            moveNumber: 1n,
            isPlayerTurn: true,
          }),
          activeGameType: 'spacepoker',
        }),
      ),
    ).toThrow('activeGameType does not match');

    expect(() =>
      validateSessionSaveEnvelope(
        activeSave({
          handState: krunkStateCodec.encode({
            games: { unrelated: initialKrunkGameState('alice') },
          }),
          activeGameType: 'krunk',
        }),
      ),
    ).toThrow('unrelated game unrelated');
  });

  it.each([
    undefined,
    [{ label: '', id: 'coin' }],
    [{ label: 'Coin', id: '' }],
    [
      { label: 'Coin A', id: 'same' },
      { label: 'Coin B', id: 'same' },
    ],
  ])('rejects invalid terminal coin lists', (coinsOfInterest) => {
    expect(() =>
      validateSessionSaveEnvelope(
        baseSave({
          channelStatus: { state: 'ResolvedClean' },
          coinsOfInterest,
        }),
      ),
    ).toThrow();
  });

  it.each([
    { ...TERMINAL_INSTANCE.terminal, outcome: null },
    {
      type: 'none',
      outcome: null,
      label: 'unexpected',
      myReward: null,
      rewardCoinHex: null,
    },
    {
      type: 'ended-cancelled',
      outcome: 'settled_cleanly',
      label: 'Cancelled',
      myReward: null,
      rewardCoinHex: null,
    },
    { ...TERMINAL_INSTANCE.terminal, myReward: 'not-an-amount' },
    {
      type: 'ended-cancelled',
      outcome: null,
      label: 'Cancelled',
      myReward: '1',
      rewardCoinHex: null,
    },
  ])('rejects malformed cross-field terminal outcomes', (terminal) => {
    expect(() =>
      validateSessionSaveEnvelope(
        activeSave({
          activeGameIds: [],
          gameInstances: {
            'game-1': { ...TERMINAL_INSTANCE, terminal },
          },
        }),
      ),
    ).toThrow();
  });
});

describe('durable game envelope round trips', () => {
  const cases = [
    {
      gameType: 'calpoker',
      ids: ['game-1'],
      handState: calpokerStateCodec.encode({
        playerHand: [1n, 2n, 3n, 4n],
        opponentHand: [5n, 6n, 7n, 8n],
        moveNumber: 1n,
        isPlayerTurn: true,
        cardSelections: [1n, 2n],
      }),
    },
    {
      gameType: 'spacepoker',
      ids: ['game-1'],
      handState: spacepokerStateCodec.encode({
        gameState: { handler: 2n, myTurn: true, N: 4n },
        playerHoleCards: [1n, 2n],
        playerBoost: false,
        opponentHoleCards: null,
        opponentBoost: null,
        communityCards: [null, null, null, null, null],
        halfPot: 1n,
        lastRaise: 0n,
        iRaisedLast: false,
        handHistory: [],
        outcome: null,
        terminalState: 'none',
        terminalRecovery: null,
        coinTossIOpen: true,
        unitSizeMojos: 10n,
        displayMode: 'mojos',
      }),
    },
    {
      gameType: 'krunk',
      ids: ['game-1', 'game-2'],
      handState: krunkStateCodec.encode({
        games: {
          'game-1': initialKrunkGameState('alice'),
          'game-2': initialKrunkGameState('bob'),
        },
      }),
    },
  ] as const;

  it.each(cases)(
    'survives save, flush, peek, model, and $gameType decode',
    async ({ gameType, ids, handState }) => {
      const gameInstances = Object.fromEntries(
        ids.map((id, index) => [
          id,
          {
            ...ACTIVE_INSTANCE,
            id,
            presentation: index === 0 ? 'off-chain-my-turn' : 'off-chain-their-turn',
          },
        ]),
      );
      await saveSession({
        serializedGameSession: new Uint8Array([1, 2, 3]),
        activeGameIds: [...ids],
        currentHandGameIds: [...ids],
        lastDisplayedGameId: ids[0],
        activeGameType: gameType,
        gameInstances,
        handState,
      });
      await flushSessionSave();

      _resetForTests();
      const loaded = await peekSession();
      expect(loaded).not.toBeNull();
      const model = sessionModelFromSave(loaded!);
      expect(model.game.activeIds).toEqual(ids);
      expect(decodePersistedGameState(model.game.handState)).toEqual(handState);
    },
  );
});

describe('save boundary enforcement', () => {
  it('deletes the sole obsolete v10 envelope without migration and keeps the marker', async () => {
    markSavedSession();
    await writeSessionRecord({
      version: 10n,
      playerId: 'old-player',
      serializedGameSession: new Uint8Array([1, 2, 3]),
    });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    expect(await peekSession()).toBeNull();
    expect(await readSessionRecord()).toBeNull();
    expect(hasSavedSessionMarker()).toBe(true);
    errorSpy.mockRestore();
  });

  it('rejects an invalid full envelope before writing it', async () => {
    const scheduled = saveSession({
      serializedGameSession: new Uint8Array([1]),
      activeGameIds: ['game-1', 'game-1'],
      currentHandGameIds: ['game-1'],
      activeGameType: 'calpoker',
      gameInstances: { 'game-1': ACTIVE_INSTANCE },
    });

    await expect(flushSessionSave()).rejects.toThrow('duplicate activeGameIds');
    await expect(scheduled).rejects.toThrow('duplicate activeGameIds');
    expect(await readSessionRecord()).toBeNull();
  });

  it('deletes an invalid current-v11 game envelope while retaining the boot marker', async () => {
    markSavedSession();
    await writeSessionRecord(
      activeSave({
        activeGameIds: ['game-1', 'game-1'],
      }),
    );
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    expect(await peekSession()).toBeNull();
    expect(await readSessionRecord()).toBeNull();
    expect(hasSavedSessionMarker()).toBe(true);
    errorSpy.mockRestore();
  });
});
