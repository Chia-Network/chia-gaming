import { SESSION_SAVE_ENVELOPE_VERSION as CURRENT_VERSION } from '../session/persistence';
import { storageRepository } from '../session/storageRepository';
import { hasSavedSessionMarker, markSavedSession } from '../../hooks/saveCoordination';
import { readSessionRecord, SESSION_DB_NAME } from '../session/indexedDb';
import { decodeSessionSaveEnvelope, sessionAmountsFromSave } from '../session/model';
import { baseSave } from './session_save_envelope.fixtures';
import {
  makeStorage,
  requireLive,
  requirePreHandshake,
  sampleSession,
  saveLiveFields,
  savePreferences,
  setTestGlobal,
} from './save.harness';
import { storageRepository } from '../session/storageRepository';

describe('flat state', () => {
  it('defaults the transaction fee to the effective nonzero floor', () => {
    expect(storageRepository.query('defaultFee')).toBe(100_000_000n);
  });

  it('getPlayerId generates and persists a player ID', () => {
    const id = storageRepository.getPlayerId();
    expect(id).toBeTruthy();
    expect(storageRepository.getPlayerId()).toBe(id);
  });

  it('getSessionId generates and persists a session ID', () => {
    const id = storageRepository.getSessionId();
    expect(id).toBeTruthy();
    expect(storageRepository.getSessionId()).toBe(id);
  });

  it('peekSession keeps preference sessionId when the IndexedDB record omits it', async () => {
    const sid = storageRepository.getSessionId();
    markSavedSession();
    // Durable resumable fields without sessionId (simulates older/partial IDB writes).
    await storageRepository.replaceSession(
      baseSave({
        pairingToken: 'tok-keep-sid',
        iStarted: true,
        myContribution: '100',
        theirContribution: '100',
        perGameAmount: '10',
        blockchainType: 'simulator',
      }),
    );
    await storageRepository.flushSessionSave();

    // Drop sessionId from the IDB record only; preferences still hold sid.
    const rawRecord = await readSessionRecord();
    if (!rawRecord) throw new Error('Expected a persisted session record');
    const record = decodeSessionSaveEnvelope(rawRecord).save;
    delete record.identity.sessionId;
    await storageRepository.persist(storageRepository.mutateRecords('write-session', record));

    storageRepository._resetForTests();
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

    const loaded = requirePreHandshake(await storageRepository.peekSession());
    expect(loaded.pairing.token).toBe('tok-keep-sid');
    expect(storageRepository.getSessionId()).toBe(sid);
  });

  it('ensureHubIdentity restores sessionId from IndexedDB when preferences omit it', async () => {
    const sid = storageRepository.getSessionId();
    markSavedSession();
    await storageRepository.replaceSession(
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
    await storageRepository.flushSessionSave();

    storageRepository._resetForTests();
    setTestGlobal('localStorage', makeStorage());
    // Prefs have no sessionId — the remint-before-hydrate bug would mint here.
    localStorage.setItem(
      'appPreferences',
      JSON.stringify({
        playerId: 'player-idb-sid',
      }),
    );
    localStorage.setItem('appState_savedSession', '1');

    expect(() => storageRepository.getSessionId()).toThrow(/before ensureHubIdentity/);
    const restored = await storageRepository.ensureHubIdentity();
    expect(restored).toBe(sid);
    expect(storageRepository.getSessionId()).toBe(sid);
  });

  it('keeps a regenerated sessionId over a stale IndexedDB identity after reload', async () => {
    const staleSessionId = storageRepository.getSessionId();
    markSavedSession();
    await storageRepository.replaceSession(
      baseSave({
        pairingToken: 'tok-regenerated-sid',
        iStarted: true,
        sessionId: staleSessionId,
        myContribution: '100',
        theirContribution: '100',
        perGameAmount: '10',
        blockchainType: 'simulator',
      }),
    );
    await storageRepository.flushSessionSave();

    const regeneratedSessionId = storageRepository.regenerateSessionId();
    expect(regeneratedSessionId).not.toBe(staleSessionId);

    // Simulate the trust-grant reload before the debounced IndexedDB write.
    storageRepository._resetForTests();

    expect(await storageRepository.ensureHubIdentity()).toBe(regeneratedSessionId);
    expect(storageRepository.getSessionId()).toBe(regeneratedSessionId);
  });

  it('persists myHubPlayerId in preferences and restores it across reload', async () => {
    const sid = storageRepository.getSessionId();
    markSavedSession();
    await storageRepository.replaceSession(
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
    await storageRepository.flushSessionSave();

    const prefs = JSON.parse(localStorage.getItem('appPreferences')!);
    expect(prefs.myHubPlayerId).toBe('p_stable_abc');

    storageRepository._resetForTests();
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

    await storageRepository.ensureHubIdentity();
    expect(storageRepository.query('myHubPlayerId')).toBe('p_stable_abc');
    expect(storageRepository.getSessionId()).toBe(sid);
  });

  it('clearSessionId wipes only the hub session ID', () => {
    const id = storageRepository.getSessionId();
    storageRepository.updatePreference({ key: 'alias', value: 'MyName' });
    storageRepository.saveSession({ scope: 'common', identity: { myHubPlayerId: 'p_to_clear' } });

    storageRepository.clearHubIdentity();

    expect(storageRepository.loadState().identity.sessionId).toBeUndefined();
    expect(storageRepository.loadState().identity.myHubPlayerId).toBeUndefined();
    expect(storageRepository.loadState().preferences.alias).toBe('MyName');
    expect(storageRepository.getSessionId()).toBeTruthy();
    expect(storageRepository.getSessionId()).not.toBe(id);
  });

  it('clearSession preserves playerId', () => {
    const oldId = storageRepository.getPlayerId();
    storageRepository.clearSession();
    const newId = storageRepository.getPlayerId();
    expect(newId).toBeTruthy();
    expect(newId).toBe(oldId);
  });

  it('clears pairing identifiers only from phases that own pairing state', async () => {
    await expect(storageRepository.clearSessionPairing()).resolves.toBeUndefined();
    expect(storageRepository.loadState().phase).toBe('preferences');

    await storageRepository.replaceSession(
      baseSave({
        pairingToken: 'pending-token',
        sessionPeerId: 'pending-peer',
        gameSessionId: '11'.repeat(16),
        iStarted: true,
        myContribution: '100',
        theirContribution: '100',
        perGameAmount: '10',
      }),
    );
    await storageRepository.clearSessionPairing();
    const pending = requirePreHandshake(storageRepository.loadState());
    expect(pending.pairing.peerId).toBeUndefined();
    expect(pending.pairing.gameSessionId).toBe('11'.repeat(16));

    await saveLiveFields({
      ...sampleSession,
      sessionPeerId: 'live-peer',
      gameSessionId: '22'.repeat(16),
    });
    await storageRepository.clearSessionPairing();
    const live = requireLive(storageRepository.loadState());
    expect(live.pairing.peerId).toBeUndefined();
    expect(live.pairing.gameSessionId).toBe('22'.repeat(16));
  });

  it('clearSession wipes game state but preserves identity, preferences, blockchainType, and boot marker', async () => {
    const sid = storageRepository.getSessionId();
    markSavedSession();
    saveLiveFields({ ...sampleSession, blockchainType: 'simulator' });
    storageRepository.updatePreference({ key: 'alias', value: 'MyName' });
    await storageRepository.flushSessionSave();

    await storageRepository.clearSession();

    expect(storageRepository.loadState().identity.sessionId).toBe(sid);
    expect(storageRepository.query('blockchainType')).toBe('simulator');
    expect(hasSavedSessionMarker()).toBe(true);
    const remaining = await storageRepository.peekSession();
    expect(remaining).not.toBeNull();
    expect(remaining?.preferences.blockchainType).toBe('simulator');
    expect(remaining).not.toHaveProperty('pairing');
    expect(storageRepository.loadState().preferences.alias).toBe('MyName');
  });

  it('clearSession drops the boot marker when no blockchainType or hubUrl remains', async () => {
    markSavedSession();
    saveLiveFields();
    await storageRepository.flushSessionSave();
    expect(storageRepository.query('blockchainType')).toBeUndefined();

    await storageRepository.clearSession();

    expect(hasSavedSessionMarker()).toBe(false);
    expect(await storageRepository.peekSession()).toBeNull();
  });

  it('clearSession keeps the boot marker when only hubUrl remains', async () => {
    markSavedSession();
    savePreferences({ hubUrl: 'http://localhost:3003' });
    await storageRepository.flushSessionSave();

    await storageRepository.clearSession();

    expect(hasSavedSessionMarker()).toBe(true);
    expect(await storageRepository.peekSession()).toMatchObject({
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
      gameSessionId: '33'.repeat(16),
      channelTimeout: '100',
      unrollTimeout: '50',
      opponentAlias: 'Opponent',
    });
    await storageRepository.flushSessionSave();

    await storageRepository.clearGameSessionPreservingHistory();

    expect(hasSavedSessionMarker()).toBe(true);
    const remaining = requirePreHandshake(await storageRepository.peekSession());
    expect(remaining.preferences.blockchainType).toBe('simulator');
    expect(remaining.preferences.hubUrl).toBe('http://localhost:3003');
    expect(remaining.history.humanHistory).toEqual(['keep-me']);
    expect(remaining.history.diagnosticLog).toEqual(['diag-keep']);
    expect(remaining).not.toHaveProperty('live');
    // Handshake checkpoint survives so a reload mid-hex-load can Resume.
    expect(remaining.pairing.token).toBe('tok-123');
    expect(remaining.pairing.peerId).toBe('peer-abc');
    expect(remaining.pairing.gameSessionId).toBe('33'.repeat(16));
    expect(remaining.pairing.iStarted).toBe(true);
    expect(remaining.pairing.myContribution).toBe('60');
    expect(remaining.pairing.theirContribution).toBe('40');
    expect(remaining.pairing.perGameAmount).toBe('10');
    expect(remaining.pairing.channelTimeout).toBe('100');
    expect(remaining.pairing.unrollTimeout).toBe('50');
    expect(remaining.pairing.opponentAlias).toBe('Opponent');
  });

  it('pairingToken-only pending handshake is resumable without a cradle', async () => {
    await storageRepository.replaceSession(
      baseSave({
        blockchainType: 'simulator',
        hubUrl: 'http://localhost:3003',
        pairingToken: 'peer_x_1',
        sessionPeerId: 'peer-x',
        gameSessionId: '44'.repeat(16),
        iStarted: false,
        myContribution: '100',
        theirContribution: '100',
        perGameAmount: '10',
        channelTimeout: '200',
        unrollTimeout: '80',
        humanHistory: ['accepted proposal'],
      }),
    );
    await storageRepository.flushSessionSave();

    expect(storageRepository.shouldOfferResumeOrStartOver()).toBe(true);
    const loaded = requirePreHandshake(await storageRepository.peekSession());
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
    expect(storageRepository.query('blockchainType')).toBeUndefined();
    savePreferences({ blockchainType: 'walletconnect' });
    expect(storageRepository.query('blockchainType')).toBe('walletconnect');
  });

  it('getBlockchainType accepts cloud', async () => {
    storageRepository._resetForTests();
    setTestGlobal('localStorage', makeStorage());
    await storageRepository.claimLease();
    expect(storageRepository.query('blockchainType')).toBeUndefined();
    await savePreferences({ blockchainType: 'cloud' });
    expect(storageRepository.query('blockchainType')).toBe('cloud');
    await storageRepository.flushSessionSave();
    expect(
      decodeSessionSaveEnvelope(storageRepository.loadState()).save.preferences.blockchainType,
    ).toBe('cloud');
  });

  it('saveSession replaces the live phase payload', () => {
    saveLiveFields();
    const state = storageRepository.loadState();
    expect(state.phase).toBe('live');
    expect(state.phase === 'live' && state.live.serializedGameSession).toEqual(
      sampleSession.serializedGameSession,
    );
    expect(state.phase === 'live' && state.pairing.token).toBe(sampleSession.pairingToken);
  });

  it('version field is set on fresh state', () => {
    const state = storageRepository.loadState();
    expect(state.version).toBe(CURRENT_VERSION);
  });

  it('clears a saved-session marker when no matching record exists', async () => {
    localStorage.setItem('appState_savedSession', '1');

    expect(await storageRepository.peekSession()).toBeNull();
    expect(localStorage.getItem('appState_savedSession')).toBeNull();
  });

  it('deletes an incompatible IndexedDB schema instead of migrating it', async () => {
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase(SESSION_DB_NAME);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    });
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(SESSION_DB_NAME, 2);
      request.onupgradeneeded = () => request.result.createObjectStore('stale');
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
      request.onerror = () => reject(request.error);
    });

    expect(await storageRepository.peekSession()).toBeNull();
    expect(await storageRepository.peekSession()).toBeNull();
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
        state: {
          perPlayerStake: 20n,
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
          coinTossIOpen: null,
          unitSizeMojos: 10n,
          displayMode: 'mojos',
          settlementOutcome: null,
        },
      },
      activeGameType: 'spacepoker',
      betweenHandLastHandProposal: {
        sender_is_player_a: false,
        game_timeout: '15',
        game_type: 'spacepoker',
        parameters: 10n,
      },
    });
    await storageRepository.flushSessionSave();
    storageRepository._resetForTests();

    const state = requireLive(await storageRepository.peekSession());
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
        state: {
          perPlayerStake: 20n,
          playerHand: [8n, 7n, 6n, 5n],
          opponentHand: [4n, 3n, 2n, 1n],
          moveNumber: 1n,
          isPlayerTurn: true,
          iStarted: false,
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
      },
      activeGameType: 'calpoker',
    });
    await storageRepository.flushSessionSave();
    storageRepository._resetForTests();

    const handState = requireLive(await storageRepository.peekSession()).presentation.handState
      ?.state as any;

    expect(handState.playerHand).toEqual([8n, 7n, 6n, 5n]);
    expect(handState.opponentHand).toEqual([4n, 3n, 2n, 1n]);
    expect(handState.cardSelections).toEqual([8n, 7n]);
  });
});
