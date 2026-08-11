import {
  saveSession,
  patchLiveSessionPresentation,
  saveTerminalSession,
  peekSession,
  clearSession,
  clearSessionPairing,
  clearGameSessionPreservingHistory,
  getPlayerId,
  getSessionId,
  ensureHubIdentity,
  getMyHubPlayerId,
  clearSessionId,
  getBlockchainType,
  loadState,
  setAlias,
  flushSessionSave,
  hasSavedSessionMarker,
  shouldOfferResumeOrStartOver,
  markSavedSession,
  replaceSession,
  CURRENT_VERSION,
  _resetForTests,
} from '../../hooks/save';
import { readSessionRecord, SESSION_DB_NAME, writeSessionRecord } from '../session/indexedDb';
import { decodeSessionSaveEnvelope, sessionAmountsFromSave } from '../session/model';
import { baseSave } from './session_save_envelope.fixtures';
import { channelStatus } from './message_protocol.harness';
import {
  makeStorage,
  requireLive,
  requirePreHandshake,
  sampleSession,
  saveLiveFields,
  savePreferences,
  setTestGlobal,
} from './save.harness';

describe('flat state', () => {
  it('getPlayerId generates and persists a player ID', () => {
    const id = getPlayerId();
    expect(id).toBeTruthy();
    expect(getPlayerId()).toBe(id);
  });

  it('getSessionId generates and persists a session ID', () => {
    const id = getSessionId();
    expect(id).toBeTruthy();
    expect(getSessionId()).toBe(id);
  });

  it('peekSession keeps preference sessionId when the IndexedDB record omits it', async () => {
    const sid = getSessionId();
    markSavedSession();
    // Durable resumable fields without sessionId (simulates older/partial IDB writes).
    await replaceSession(
      baseSave({
        pairingToken: 'tok-keep-sid',
        iStarted: true,
        myContribution: '100',
        theirContribution: '100',
        perGameAmount: '10',
        blockchainType: 'simulator',
      }),
    );
    await flushSessionSave();

    // Drop sessionId from the IDB record only; preferences still hold sid.
    const rawRecord = await readSessionRecord();
    if (!rawRecord) throw new Error('Expected a persisted session record');
    const record = decodeSessionSaveEnvelope(rawRecord).save;
    delete record.identity.sessionId;
    await writeSessionRecord(record);

    _resetForTests();
    setTestGlobal('localStorage', makeStorage());
    // Re-seed preferences with the original sid (reset cleared module cache;
    // localStorage mock is fresh — write prefs as boot would see them).
    localStorage.setItem(
      'appPreferences',
      JSON.stringify({
        playerId: 'player-keep-sid',
        sessionId: sid,
      }),
    );
    localStorage.setItem('appState_savedSession', '1');

    const loaded = requirePreHandshake(await peekSession());
    expect(loaded.pairing.token).toBe('tok-keep-sid');
    expect(getSessionId()).toBe(sid);
  });

  it('ensureHubIdentity restores sessionId from IndexedDB when preferences omit it', async () => {
    const sid = getSessionId();
    markSavedSession();
    await replaceSession(
      baseSave({
        pairingToken: 'tok-idb-sid',
        iStarted: true,
        sessionId: sid,
        myContribution: '100',
        theirContribution: '100',
        perGameAmount: '10',
        blockchainType: 'simulator',
      }),
    );
    await flushSessionSave();

    _resetForTests();
    setTestGlobal('localStorage', makeStorage());
    // Prefs have no sessionId — the remint-before-hydrate bug would mint here.
    localStorage.setItem(
      'appPreferences',
      JSON.stringify({
        playerId: 'player-idb-sid',
      }),
    );
    localStorage.setItem('appState_savedSession', '1');

    expect(() => getSessionId()).toThrow(/before ensureHubIdentity/);
    const restored = await ensureHubIdentity();
    expect(restored).toBe(sid);
    expect(getSessionId()).toBe(sid);
  });

  it('persists myHubPlayerId in preferences and restores it across reload', async () => {
    const sid = getSessionId();
    markSavedSession();
    await replaceSession(
      baseSave({
        pairingToken: 'tok-pid',
        iStarted: true,
        sessionId: sid,
        myHubPlayerId: 'p_stable_abc',
        myContribution: '100',
        theirContribution: '100',
        perGameAmount: '10',
        blockchainType: 'simulator',
      }),
    );
    await flushSessionSave();

    const prefs = JSON.parse(localStorage.getItem('appPreferences')!);
    expect(prefs.myHubPlayerId).toBe('p_stable_abc');

    _resetForTests();
    setTestGlobal('localStorage', makeStorage());
    localStorage.setItem(
      'appPreferences',
      JSON.stringify({
        playerId: 'player-local',
        sessionId: sid,
        myHubPlayerId: 'p_stable_abc',
      }),
    );
    localStorage.setItem('appState_savedSession', '1');

    await ensureHubIdentity();
    expect(getMyHubPlayerId()).toBe('p_stable_abc');
    expect(getSessionId()).toBe(sid);
  });

  it('clearSessionId wipes only the hub session ID', () => {
    const id = getSessionId();
    setAlias('MyName');
    saveSession({ scope: 'common', identity: { myHubPlayerId: 'p_to_clear' } });

    clearSessionId();

    expect(loadState().identity.sessionId).toBeUndefined();
    expect(loadState().identity.myHubPlayerId).toBeUndefined();
    expect(loadState().preferences.alias).toBe('MyName');
    expect(getSessionId()).toBeTruthy();
    expect(getSessionId()).not.toBe(id);
  });

  it('clearSession preserves playerId', () => {
    const oldId = getPlayerId();
    clearSession();
    const newId = getPlayerId();
    expect(newId).toBeTruthy();
    expect(newId).toBe(oldId);
  });

  it('clears pairing identifiers only from phases that own pairing state', async () => {
    await expect(clearSessionPairing()).resolves.toBeUndefined();
    expect(loadState().phase).toBe('preferences');

    await replaceSession(
      baseSave({
        pairingToken: 'pending-token',
        sessionPeerId: 'pending-peer',
        gameSessionId: 'pending-game',
        iStarted: true,
        myContribution: '100',
        theirContribution: '100',
        perGameAmount: '10',
      }),
    );
    await clearSessionPairing();
    const pending = requirePreHandshake(loadState());
    expect(pending.pairing.peerId).toBeUndefined();
    expect(pending.pairing.gameSessionId).toBeUndefined();

    await saveLiveFields({
      ...sampleSession,
      sessionPeerId: 'live-peer',
      gameSessionId: 'live-game',
    });
    await clearSessionPairing();
    const live = requireLive(loadState());
    expect(live.pairing.peerId).toBeUndefined();
    expect(live.pairing.gameSessionId).toBeUndefined();
  });

  it('ignores late live-presentation cleanup after terminal replacement', async () => {
    await saveLiveFields(sampleSession);
    const presentation = {
      ...requireLive(loadState()).presentation,
      channelStatus: channelStatus({ state: 'ResolvedClean' }),
      waitingStateEnteredAt: 42n,
    };
    await saveTerminalSession({
      terminal: {
        iStarted: true,
        coinsOfInterest: [],
        myAlias: null,
        opponentAlias: null,
      },
      presentation,
    });

    await expect(
      patchLiveSessionPresentation({ waitingStateEnteredAt: null }),
    ).resolves.toBeUndefined();
    const terminal = loadState();
    if (terminal.phase !== 'terminal') throw new Error('expected terminal session');
    expect(terminal.presentation.waitingStateEnteredAt).toBe(42n);
  });

  it('clearSession wipes game state but preserves identity, preferences, blockchainType, and boot marker', async () => {
    const sid = getSessionId();
    markSavedSession();
    saveLiveFields({ ...sampleSession, blockchainType: 'simulator' });
    setAlias('MyName');
    await flushSessionSave();

    await clearSession();

    expect(loadState().identity.sessionId).toBe(sid);
    expect(getBlockchainType()).toBe('simulator');
    expect(hasSavedSessionMarker()).toBe(true);
    const remaining = await peekSession();
    expect(remaining).not.toBeNull();
    expect(remaining?.preferences.blockchainType).toBe('simulator');
    expect(remaining).not.toHaveProperty('pairing');
    expect(loadState().preferences.alias).toBe('MyName');
  });

  it('clearSession drops the boot marker when no blockchainType or hubUrl remains', async () => {
    markSavedSession();
    saveLiveFields();
    await flushSessionSave();
    expect(getBlockchainType()).toBeUndefined();

    await clearSession();

    expect(hasSavedSessionMarker()).toBe(false);
    expect(await peekSession()).toBeNull();
  });

  it('clearSession keeps the boot marker when only hubUrl remains', async () => {
    markSavedSession();
    savePreferences({ hubUrl: 'http://localhost:3003' });
    await flushSessionSave();

    await clearSession();

    expect(hasSavedSessionMarker()).toBe(true);
    expect(await peekSession()).toMatchObject({
      preferences: { hubUrl: 'http://localhost:3003' },
    });
  });

  it('clearGameSessionPreservingHistory keeps logs, connection prefs, and pre-cradle handshake', async () => {
    markSavedSession();
    saveLiveFields({
      ...sampleSession,
      blockchainType: 'simulator',
      hubUrl: 'http://localhost:3003',
      humanHistory: ['keep-me'],
      diagnosticLog: ['diag-keep'],
      sessionPeerId: 'peer-abc',
      gameSessionId: 'gs-1',
      channelTimeout: '100',
      unrollTimeout: '50',
      opponentAlias: 'Opponent',
    });
    await flushSessionSave();

    await clearGameSessionPreservingHistory();

    expect(hasSavedSessionMarker()).toBe(true);
    const remaining = requirePreHandshake(await peekSession());
    expect(remaining.preferences.blockchainType).toBe('simulator');
    expect(remaining.preferences.hubUrl).toBe('http://localhost:3003');
    expect(remaining.history.humanHistory).toEqual(['keep-me']);
    expect(remaining.history.diagnosticLog).toEqual(['diag-keep']);
    expect(remaining).not.toHaveProperty('live');
    // Handshake checkpoint survives so a reload mid-hex-load can Resume.
    expect(remaining.pairing.token).toBe('tok-123');
    expect(remaining.pairing.peerId).toBe('peer-abc');
    expect(remaining.pairing.gameSessionId).toBe('gs-1');
    expect(remaining.pairing.iStarted).toBe(true);
    expect(remaining.pairing.myContribution).toBe('60');
    expect(remaining.pairing.theirContribution).toBe('40');
    expect(remaining.pairing.perGameAmount).toBe('10');
    expect(remaining.pairing.channelTimeout).toBe('100');
    expect(remaining.pairing.unrollTimeout).toBe('50');
    expect(remaining.pairing.opponentAlias).toBe('Opponent');
  });

  it('pairingToken-only pending handshake is resumable without a cradle', async () => {
    await replaceSession(
      baseSave({
        blockchainType: 'simulator',
        hubUrl: 'http://localhost:3003',
        pairingToken: 'peer_x_1',
        sessionPeerId: 'peer-x',
        gameSessionId: 'gs-pending',
        iStarted: false,
        myContribution: '100',
        theirContribution: '100',
        perGameAmount: '10',
        channelTimeout: '200',
        unrollTimeout: '80',
        humanHistory: ['accepted proposal'],
      }),
    );
    await flushSessionSave();

    expect(shouldOfferResumeOrStartOver()).toBe(true);
    const loaded = requirePreHandshake(await peekSession());
    expect(loaded).not.toHaveProperty('live');
    expect(loaded.pairing.token).toBe('peer_x_1');
    expect(loaded.pairing.myContribution).toBe('100');
    expect(loaded.pairing.peerId).toBe('peer-x');
    expect(sessionAmountsFromSave(loaded)).toEqual({
      myContribution: 100n,
      theirContribution: 100n,
      perGameAmount: 10n,
    });
  });

  it('getBlockchainType reads from preferences', () => {
    expect(getBlockchainType()).toBeUndefined();
    savePreferences({ blockchainType: 'walletconnect' });
    expect(getBlockchainType()).toBe('walletconnect');
  });

  it('saveSession replaces the live phase payload', () => {
    saveLiveFields();
    const state = loadState();
    expect(state.phase).toBe('live');
    expect(state.phase === 'live' && state.live.serializedGameSession).toEqual(
      sampleSession.serializedGameSession,
    );
    expect(state.phase === 'live' && state.pairing.token).toBe(sampleSession.pairingToken);
  });

  it('version field is set on fresh state', () => {
    const state = loadState();
    expect(state.version).toBe(CURRENT_VERSION);
  });

  it('clears a saved-session marker when no matching record exists', async () => {
    localStorage.setItem('appState_savedSession', '1');

    expect(await peekSession()).toBeNull();
    expect(localStorage.getItem('appState_savedSession')).toBeNull();
  });

  it('deletes an incompatible IndexedDB schema instead of migrating it', async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(SESSION_DB_NAME, 2);
      request.onupgradeneeded = () => request.result.createObjectStore('stale');
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
      request.onerror = () => reject(request.error);
    });

    expect(await peekSession()).toBeNull();
    expect(await peekSession()).toBeNull();
  });

  it('round-trips large bigint values through persisted state without precision loss', async () => {
    const huge = 9_007_199_254_740_993n;
    saveLiveFields({
      ...sampleSession,
      blockchainType: 'simulator',
      defaultFee: huge,
      activeGameIds: ['game-1'],
      currentHandGameIds: ['game-1'],
      currentHandOrigin: 'local',
      gameInstances: {
        'game-1': {
          id: 'game-1',
          amount: '20',
          coinHex: null,
          presentation: 'off-chain-my-turn',
          terminal: {
            type: 'none',
            outcome: null,
            label: null,
            myReward: null,
            rewardCoinHex: null,
          },
        },
      },
      handState: {
        gameType: 'spacepoker',
        version: 2n,
        state: {
          gameState: { handler: 2n, myTurn: true, N: 4n },
          playerHoleCards: [1n, 2n],
          playerBoost: false,
          opponentHoleCards: null,
          opponentBoost: null,
          communityCards: [null, null, null, null, null],
          halfPot: huge + 2n,
          lastRaise: 0n,
          iRaisedLast: false,
          handHistory: [],
          outcome: null,
          terminalState: 'none',
          terminalRecovery: null,
          pendingTerminalAction: null,
          coinTossIOpen: null,
          unitSizeMojos: 10n,
          displayMode: 'mojos',
        },
      },
      activeGameType: 'spacepoker',
      betweenHandLastTerms: {
        my_contribution: '10',
        their_contribution: '10',
        game_timeout: '15',
        game_type: 'spacepoker',
        spacepoker_unit_size: '10',
      },
    });
    await flushSessionSave();
    _resetForTests();

    const state = requireLive(await peekSession());
    const handState = state.presentation.handState?.state as any;

    expect(state.preferences.defaultFee).toBe(huge);
    expect(handState.gameState.N).toBe(4n);
    expect(handState.playerHoleCards[1]).toBe(2n);
    expect(handState.halfPot).toBe(huge + 2n);
  });

  it('preserves Calpoker hand arrays as bigint through round-trip', async () => {
    saveLiveFields({
      ...sampleSession,
      blockchainType: 'simulator',
      activeGameIds: ['game-1'],
      currentHandGameIds: ['game-1'],
      currentHandOrigin: 'peer',
      gameInstances: {
        'game-1': {
          id: 'game-1',
          amount: '20',
          coinHex: null,
          presentation: 'off-chain-my-turn',
          terminal: {
            type: 'none',
            outcome: null,
            label: null,
            myReward: null,
            rewardCoinHex: null,
          },
        },
      },
      handState: {
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
      },
      activeGameType: 'calpoker',
    });
    await flushSessionSave();
    _resetForTests();

    const handState = requireLive(await peekSession()).presentation.handState?.state as any;

    expect(handState.playerHand).toEqual([8n, 7n, 6n, 5n]);
    expect(handState.opponentHand).toEqual([4n, 3n, 2n, 1n]);
    expect(handState.cardSelections).toEqual([8n, 7n]);
  });
});
