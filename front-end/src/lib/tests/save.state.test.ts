import { DURABLE_APPLICATION_STATE_VERSION as CURRENT_VERSION } from '../session/saveEnvelope';
import { storageRepository } from '../session/storageRepository';
import { hasSavedSessionMarker, markSavedSession } from '../../hooks/saveCoordination';
import { readApplicationState, SESSION_DB_NAME } from '../session/indexedDb';
import { decodeDurableApplicationState, sessionAmountsFromSave } from '../session/model';
import { preHandshakeReplacement } from './session_save_envelope.fixtures';
import { applyFreshStartCheckpoint } from '../session/acceptLifecycle';
import { captureDurableApplicationState } from '../session/sessionMachinePersist';
import { clearGameSessionState } from '../session/sessionStateTransitions';
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

async function capturePreHandshake(
  checkpoint: ReturnType<typeof preHandshakeReplacement>,
): Promise<void> {
  await captureDurableApplicationState({
    kind: 'transform',
    transform: (state) => applyFreshStartCheckpoint(state, checkpoint),
  })?.write();
}

function clearGameSession(): Promise<void> {
  return captureDurableApplicationState({
    kind: 'transform',
    transform: clearGameSessionState,
  })!.write();
}

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

  it('ensureHubIdentity restores sessionId from the claimed aggregate', async () => {
    const sid = storageRepository.getSessionId();
    markSavedSession();
    await capturePreHandshake(
      preHandshakeReplacement({
        pairingToken: 'tok-idb-sid',
        iStarted: true,
        sessionId: sid,
        myContribution: '100',
        theirContribution: '100',
        perGameAmount: '10',
        blockchainType: 'simulator',
      }),
    );
    await storageRepository.flushAggregate();

    storageRepository._resetForTests();
    await storageRepository.claimApplicationState();
    const restored = await storageRepository.ensureHubIdentity();
    expect(restored).toBe(sid);
    expect(storageRepository.getSessionId()).toBe(sid);
  });

  it('applies a preauthority regenerated identity once to the claimed root', async () => {
    const staleSessionId = storageRepository.getSessionId();
    markSavedSession();
    await capturePreHandshake(
      preHandshakeReplacement({
        pairingToken: 'tok-regenerated-sid',
        iStarted: true,
        sessionId: staleSessionId,
        myContribution: '100',
        theirContribution: '100',
        perGameAmount: '10',
        blockchainType: 'simulator',
      }),
    );
    await storageRepository.flushAggregate();

    storageRepository._resetForTests();
    const regeneratedSessionId = storageRepository.regenerateSessionId();
    expect(regeneratedSessionId).not.toBe(staleSessionId);
    await storageRepository.claimApplicationState();
    expect(await storageRepository.ensureHubIdentity()).toBe(regeneratedSessionId);
    expect(storageRepository.getSessionId()).toBe(regeneratedSessionId);
  });

  it('persists myHubPlayerId in the aggregate and restores it across reload', async () => {
    const sid = storageRepository.getSessionId();
    markSavedSession();
    await capturePreHandshake(
      preHandshakeReplacement({
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
    await storageRepository.flushAggregate();

    storageRepository._resetForTests();
    await storageRepository.claimApplicationState();
    await storageRepository.ensureHubIdentity();
    expect(storageRepository.query('myHubPlayerId')).toBe('p_stable_abc');
    expect(storageRepository.getSessionId()).toBe(sid);
  });

  it('clearSessionId wipes only the hub session ID', () => {
    const id = storageRepository.getSessionId();
    storageRepository.updatePreference({ key: 'alias', value: 'MyName' });
    storageRepository.updateCommon({ identity: { myHubPlayerId: 'p_to_clear' } });

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
    expect(storageRepository.loadState().session).toBeNull();

    await capturePreHandshake(
      preHandshakeReplacement({
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
    await storageRepository.flushAggregate();

    await storageRepository.clearSession();

    expect(storageRepository.loadState().identity.sessionId).toBe(sid);
    expect(storageRepository.query('blockchainType')).toBe('simulator');
    expect(hasSavedSessionMarker()).toBe(true);
    const remaining = await storageRepository.readCurrentState();
    expect(remaining).not.toBeNull();
    expect(remaining?.preferences.blockchainType).toBe('simulator');
    expect(remaining).not.toHaveProperty('pairing');
    expect(storageRepository.loadState().preferences.alias).toBe('MyName');
  });

  it('clearSession drops the boot marker when no blockchainType or hubUrl remains', async () => {
    markSavedSession();
    saveLiveFields();
    await storageRepository.flushAggregate();
    expect(storageRepository.query('blockchainType')).toBeUndefined();

    await storageRepository.clearSession();

    expect(hasSavedSessionMarker()).toBe(false);
    expect(await storageRepository.readCurrentState()).toBeNull();
  });

  it('clearSession keeps the boot marker when only hubUrl remains', async () => {
    markSavedSession();
    savePreferences({ hubUrl: 'http://localhost:3003' });
    await storageRepository.flushAggregate();

    await storageRepository.clearSession();

    expect(hasSavedSessionMarker()).toBe(true);
    expect(await storageRepository.readCurrentState()).toMatchObject({
      preferences: { hubUrl: 'http://localhost:3003' },
    });
  });

  it('aggregate clear keeps logs, connection prefs, and pre-cradle handshake', async () => {
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
    await storageRepository.flushAggregate();

    await clearGameSession();

    expect(hasSavedSessionMarker()).toBe(true);
    const remaining = await storageRepository.readCurrentState();
    const session = requirePreHandshake(remaining);
    expect(remaining?.preferences.blockchainType).toBe('simulator');
    expect(remaining?.preferences.hubUrl).toBe('http://localhost:3003');
    expect(remaining?.history.humanHistory).toEqual(['keep-me']);
    expect(remaining?.history.diagnosticLog).toEqual(['diag-keep']);
    expect(session).not.toHaveProperty('live');
    // Handshake checkpoint survives so a reload mid-hex-load can Resume.
    expect(session.pairing.token).toBe('tok-123');
    expect(session.pairing.peerId).toBe('peer-abc');
    expect(session.pairing.gameSessionId).toBe('33'.repeat(16));
    expect(session.pairing.iStarted).toBe(true);
    expect(session.pairing.myContribution).toBe('60');
    expect(session.pairing.theirContribution).toBe('40');
    expect(session.pairing.perGameAmount).toBe('10');
    expect(session.pairing.channelTimeout).toBe('100');
    expect(session.pairing.unrollTimeout).toBe('50');
    expect(session.pairing.opponentAlias).toBe('Opponent');
  });

  it('never exposes an empty record while preserving a resumable reset', async () => {
    saveLiveFields({
      ...sampleSession,
      blockchainType: 'simulator',
      humanHistory: ['preserved'],
    });
    await storageRepository.flushAggregate();
    let release!: () => void;
    let committed!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reachedCommit = new Promise<void>((resolve) => {
      committed = resolve;
    });
    storageRepository.holdNextCheckpointAfterCommitForTests(barrier, committed);

    const reset = clearGameSession();
    await reachedCommit;
    const duringReset = await readApplicationState();
    expect(duringReset).toMatchObject({
      session: { phase: 'pre-handshake' },
      history: { humanHistory: ['preserved'] },
    });
    release();
    await reset;
  });

  it('pairingToken-only pending handshake is resumable without a cradle', async () => {
    await capturePreHandshake(
      preHandshakeReplacement({
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
    await storageRepository.flushAggregate();

    expect(storageRepository.shouldOfferResumeOrStartOver()).toBe(true);
    const loaded = await storageRepository.readCurrentState();
    const session = requirePreHandshake(loaded);
    expect(session).not.toHaveProperty('live');
    expect(session.pairing.token).toBe('peer_x_1');
    expect(session.pairing.myContribution).toBe('100');
    expect(session.pairing.peerId).toBe('peer-x');
    expect(sessionAmountsFromSave(loaded!)).toEqual({
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
    await storageRepository.claimApplicationState();
    expect(storageRepository.query('blockchainType')).toBeUndefined();
    await savePreferences({ blockchainType: 'cloud' });
    expect(storageRepository.query('blockchainType')).toBe('cloud');
    await storageRepository.flushAggregate();
    expect(
      decodeDurableApplicationState(storageRepository.loadState()).save.preferences.blockchainType,
    ).toBe('cloud');
  });

  it('aggregate capture replaces the live phase payload', () => {
    saveLiveFields();
    const state = storageRepository.loadState();
    expect(state.session?.phase).toBe('live');
    expect(state.session?.phase === 'live' && state.session.live.serializedGameSession).toEqual(
      sampleSession.serializedGameSession,
    );
    expect(state.session?.phase === 'live' && state.session.pairing.token).toBe(
      sampleSession.pairingToken,
    );
  });

  it('version field is set on fresh state', () => {
    const state = storageRepository.loadState();
    expect(state.version).toBe(CURRENT_VERSION);
  });

  it('clears a saved-session marker when no matching record exists', async () => {
    localStorage.setItem('appState_savedSession', '1');

    expect(await storageRepository.readCurrentState()).toBeNull();
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

    expect(await storageRepository.readCurrentState()).toBeNull();
    expect(await storageRepository.readCurrentState()).toBeNull();
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
    await storageRepository.flushAggregate();
    storageRepository._resetForTests();

    const state = await storageRepository.readCurrentState();
    const handState = requireLive(state).presentation.handState?.state as any;

    expect(state?.preferences.defaultFee).toBe(huge);
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
    await storageRepository.flushAggregate();
    storageRepository._resetForTests();

    const handState = requireLive(await storageRepository.readCurrentState()).presentation.handState
      ?.state as any;

    expect(handState.playerHand).toEqual([8n, 7n, 6n, 5n]);
    expect(handState.opponentHand).toEqual([4n, 3n, 2n, 1n]);
    expect(handState.cardSelections).toEqual([8n, 7n]);
  });
});
