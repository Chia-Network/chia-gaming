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
import {
  createSessionModel,
  sessionModelFromSave,
  snapshotFromSessionModel,
  validateSessionSaveEnvelope,
} from '../session/model';

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
    serializedGameSession: new Uint8Array([1, 2, 3]),
    gameSessionSchemaVersion: 3n,
    pairingToken: 'pair',
    messageNumber: 1n,
    remoteNumber: 0n,
    iStarted: true,
    myContribution: '20',
    theirContribution: '20',
    perGameAmount: '20',
    rewardPuzzleHash: '11'.repeat(32),
    unackedMessages: [],
    activeGameIds: ['game-1'],
    currentHandGameIds: ['game-1'],
    lastDisplayedGameId: 'game-1',
    activeGameType: 'calpoker',
    gameInstances: { 'game-1': ACTIVE_INSTANCE },
    handState: calpokerStateCodec.encode({
      playerHand: [1n, 2n],
      opponentHand: [3n, 4n],
      moveNumber: 1n,
      isPlayerTurn: true,
    }),
    betweenHandLastTerms: {
      my_contribution: '20',
      their_contribution: '20',
      game_timeout: '15',
      game_type: 'calpoker',
    },
    ...fields,
  });
}

function liveSave(fields: Partial<SessionSave> = {}): SessionSave {
  return activeSave({
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
  it('accepts empty preferences and a complete pre-handshake checkpoint', () => {
    expect(() => validateSessionSaveEnvelope(baseSave())).not.toThrow();
    expect(() =>
      validateSessionSaveEnvelope(
        baseSave({
          blockchainType: 'simulator',
          pairingToken: 'pair',
          iStarted: true,
          myContribution: '20',
          theirContribution: '20',
          perGameAmount: '2',
        }),
      ),
    ).not.toThrow();
  });

  it.each([
    ['schema', { gameSessionSchemaVersion: undefined }],
    ['message counter', { messageNumber: undefined }],
    ['remote counter', { remoteNumber: undefined }],
    ['role', { iStarted: undefined }],
    ['pairing token', { pairingToken: undefined }],
    ['unacked messages', { unackedMessages: undefined }],
    ['active IDs', { activeGameIds: undefined }],
    ['my contribution', { myContribution: undefined }],
    ['their contribution', { theirContribution: undefined }],
    ['per-game amount', { perGameAmount: undefined }],
    ['reward puzzle hash', { rewardPuzzleHash: null }],
  ])('rejects a live resumable record missing its %s', (_label, fields) => {
    expect(() => validateSessionSaveEnvelope(liveSave(fields))).toThrow();
  });

  it('rejects a live/current hand without its game-owned payload', () => {
    expect(() => validateSessionSaveEnvelope(liveSave({ handState: undefined }))).toThrow(
      'missing handState',
    );
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
          betweenHandLastTerms: {
            my_contribution: '100',
            their_contribution: '100',
            game_timeout: '15',
            game_type: 'krunk',
          },
        }),
      ),
    ).toThrow('exactly match currentHandGameIds');
  });

  it('rejects a partial Krunk payload for the current pair', () => {
    const ids = ['game-1', 'game-2'];
    expect(() =>
      validateSessionSaveEnvelope(
        liveSave({
          activeGameIds: ids,
          currentHandGameIds: ids,
          lastDisplayedGameId: ids[0],
          activeGameType: 'krunk',
          gameInstances: {
            'game-1': ACTIVE_INSTANCE,
            'game-2': { ...ACTIVE_INSTANCE, id: 'game-2' },
          },
          handState: krunkStateCodec.encode({
            games: { 'game-1': initialKrunkGameState('alice') },
          }),
          betweenHandLastTerms: {
            my_contribution: '100',
            their_contribution: '100',
            game_timeout: '15',
            game_type: 'krunk',
          },
        }),
      ),
    ).toThrow('exactly match currentHandGameIds');
  });

  it('accepts terminal frozen snapshots with or without remount state', () => {
    const terminal = baseSave({
      channelStatus: { state: 'ResolvedClean' },
      coinsOfInterest: [],
      activeGameIds: [],
      currentHandGameIds: ['game-1'],
      lastDisplayedGameId: 'game-1',
      activeGameType: 'calpoker',
      gameInstances: { 'game-1': TERMINAL_INSTANCE },
      betweenHandLastTerms: {
        my_contribution: '20',
        their_contribution: '20',
        game_timeout: '15',
        game_type: 'calpoker',
      },
    });
    expect(() => validateSessionSaveEnvelope(terminal)).not.toThrow();
    expect(() =>
      validateSessionSaveEnvelope({
        ...terminal,
        handState: calpokerStateCodec.encode({
          playerHand: [1n, 2n],
          opponentHand: [3n, 4n],
          moveNumber: 1n,
          isPlayerTurn: false,
        }),
      }),
    ).not.toThrow();
  });

  it('rejects persisted hands without matching game terms', () => {
    expect(() =>
      validateSessionSaveEnvelope(activeSave({ betweenHandLastTerms: undefined })),
    ).toThrow('persisted hand is missing betweenHandLastTerms');
    expect(() =>
      validateSessionSaveEnvelope(
        activeSave({
          activeGameType: 'spacepoker',
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
          betweenHandLastTerms: {
            my_contribution: '20',
            their_contribution: '20',
            game_timeout: '15',
            game_type: 'calpoker',
          },
        }),
      ),
    ).toThrow('activeGameType does not match betweenHandLastTerms.game_type');
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

  it.each([
    ['between-hand mode', { betweenHandMode: 'unknown-mode' }, 'betweenHandMode'],
    [
      'between-hand terms',
      {
        betweenHandLastTerms: {
          my_contribution: 'not-an-amount',
          their_contribution: '10',
          game_type: 'calpoker',
        },
      },
      'betweenHandLastTerms.my_contribution',
    ],
    [
      'peer proposal',
      {
        betweenHandCachedPeerProposal: {
          id: 'proposal-1',
          groupIds: [],
          my_contribution: '10',
          their_contribution: '10',
          game_type: 'calpoker',
        },
      },
      'groupIds',
    ],
    [
      'proposal groups',
      {
        outgoingProposalGroupIds: [['proposal-1', 'proposal-1']],
      },
      'duplicate',
    ],
    [
      'compose amount',
      {
        betweenHandCompose: {
          selected_game: 'calpoker',
          game_timeout: '15',
          proposal_sent: false,
          calpoker: { amount: 'ten' },
          krunk: { amount: '100' },
          spacepoker: { unit_size: '1', stack_size: '10' },
        },
      },
      'betweenHandCompose.calpoker.amount',
    ],
  ])('rejects malformed %s state', (_label, fields, message) => {
    expect(() => validateSessionSaveEnvelope(baseSave(fields as Partial<SessionSave>))).toThrow(
      message,
    );
  });

  it.each([
    ['channel discriminant', { channelStatus: { state: 'Bogus' } }, 'channelStatus.state'],
    [
      'channel balance',
      { channelStatus: { state: 'Active', our_balance: { Amount: 'nope' } } },
      'channelStatus.our_balance',
    ],
    [
      'notification kind',
      {
        channelNotifQueue: [{ id: 1n, kind: 'unknown', title: 'Title', message: 'Message' }],
      },
      'notification[0].kind',
    ],
    [
      'notification id',
      {
        gameNotifQueue: [
          { id: 'not-an-id', kind: 'game-terminal', title: 'Title', message: 'Message' },
        ],
      },
      'notification id',
    ],
    ['transport counter', { messageNumber: '1' }, 'messageNumber'],
    [
      'transport message payload',
      { unackedMessages: [{ msgno: 1n, msg: [1, 2, 3] }] },
      'unackedMessages[0].msg',
    ],
    ['cradle bytes', { serializedGameSession: [1, 2, 3] }, 'serializedGameSession'],
    ['timeout numeric string', { channelTimeout: '0' }, 'channelTimeout'],
  ])('rejects malformed %s metadata', (_label, fields, message) => {
    expect(() =>
      validateSessionSaveEnvelope(baseSave(fields as unknown as Partial<SessionSave>)),
    ).toThrow(message);
  });

  it('guarantees an accepted envelope restores with the same per-game fallback', () => {
    const save = baseSave({
      betweenHandMode: 'decision',
      betweenHandLastTerms: {
        my_contribution: '12',
        their_contribution: '12',
        game_timeout: '20',
        game_type: 'calpoker',
      },
      channelNotifQueue: [{ id: 1n, kind: 'channel-state', title: 'Channel', message: 'Ready' }],
      myRunningBalance: '-3',
    });

    expect(() => validateSessionSaveEnvelope(save)).not.toThrow();
    expect(() => sessionModelFromSave(save, 7n)).not.toThrow();
    expect(sessionModelFromSave(save, 7n).betweenHand.compose.calpoker.amount).toBe(12n);
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
      const contribution = gameType === 'krunk' ? '100' : '20';
      await saveSession({
        ...liveSave(),
        activeGameIds: [...ids],
        currentHandGameIds: [...ids],
        lastDisplayedGameId: ids[0],
        activeGameType: gameType,
        gameInstances,
        handState,
        betweenHandLastTerms: {
          my_contribution: contribution,
          their_contribution: contribution,
          game_timeout: '15',
          game_type: gameType,
          ...(gameType === 'spacepoker' ? { spacepoker_unit_size: '10' } : {}),
        },
      });
      await flushSessionSave();

      _resetForTests();
      const loaded = await peekSession();
      expect(loaded).not.toBeNull();
      const model = sessionModelFromSave(loaded!);
      expect(model.game.activeIds).toEqual(ids);
      expect(decodePersistedGameState(model.game.handState)?.persisted).toEqual(handState);
    },
  );

  it('round-trips every compose draft through the canonical snapshot and IndexedDB', async () => {
    const compose = {
      selectedGame: 'spacepoker' as const,
      gameTimeout: 47n,
      proposalSent: false,
      calpoker: { amount: 123n },
      krunk: { amount: 800n },
      spacepoker: { unitSize: 987654321n, stackSize: 73n },
    };
    const snapshot = snapshotFromSessionModel(createSessionModel({ betweenHand: { compose } }));
    expect(snapshot.betweenHandCompose).toEqual({
      selected_game: 'spacepoker',
      game_timeout: '47',
      proposal_sent: false,
      calpoker: { amount: '123' },
      krunk: { amount: '800' },
      spacepoker: { unit_size: '987654321', stack_size: '73' },
    });

    await saveSession(liveSave(snapshot));
    await flushSessionSave();
    _resetForTests();

    const loaded = await peekSession();
    expect(loaded).not.toBeNull();
    expect(sessionModelFromSave(loaded!).betweenHand.compose).toEqual(compose);
  });
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
      ...liveSave(),
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

  it('deletes a live v11 record that restoreSession cannot consume', async () => {
    markSavedSession();
    await writeSessionRecord(liveSave({ messageNumber: undefined }));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    expect(await peekSession()).toBeNull();
    expect(await readSessionRecord()).toBeNull();
    expect(hasSavedSessionMarker()).toBe(true);
    errorSpy.mockRestore();
  });

  it('deletes a persisted hand whose game type disagrees with its terms', async () => {
    markSavedSession();
    await writeSessionRecord(
      activeSave({
        activeGameType: 'spacepoker',
      }),
    );
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    expect(await peekSession()).toBeNull();
    expect(await readSessionRecord()).toBeNull();
    expect(hasSavedSessionMarker()).toBe(true);
    errorSpy.mockRestore();
  });

  it('deletes a malformed current-v11 metadata envelope read from IndexedDB', async () => {
    markSavedSession();
    await writeSessionRecord(
      baseSave({
        betweenHandCompose: {
          selected_game: 'calpoker',
          game_timeout: 'not-a-timeout',
          proposal_sent: false,
          calpoker: { amount: '10' },
          krunk: { amount: '100' },
          spacepoker: { unit_size: '1', stack_size: '10' },
        },
      }),
    );
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    expect(await peekSession()).toBeNull();
    expect(await readSessionRecord()).toBeNull();
    expect(hasSavedSessionMarker()).toBe(true);
    errorSpy.mockRestore();
  });

  it('catches and deletes malformed raw IndexedDB bytes', async () => {
    const open = indexedDB.open('chia-gaming-session', 1);
    await new Promise<void>((resolve, reject) => {
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction('session', 'readwrite');
        tx.objectStore('session').put(new Uint8Array([1, 2, 3]), 'current');
        tx.onerror = () => reject(tx.error);
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
      };
    });
    markSavedSession();
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    expect(await peekSession()).toBeNull();
    expect(await readSessionRecord()).toBeNull();
    expect(hasSavedSessionMarker()).toBe(true);
    errorSpy.mockRestore();
  });
});
