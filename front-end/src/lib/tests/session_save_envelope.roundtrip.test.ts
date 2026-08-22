import { calpokerStateCodec } from '@games/calpoker/ui/serialize';
import { initialKrunkGameState, krunkStateCodec } from '@games/krunk/ui/serialize';
import { spacepokerStateCodec } from '@games/spacepoker/ui/serialize';
import { _resetForTests, flushSessionSave, peekSession, saveSession } from '../../hooks/save';
import { decodePersistedGameState } from '../gameRegistry';
import { protocolIdForCatalog, resetProtocolIds, setProtocolIds } from '../gameIdentities';
import { TEST_PROTOCOL_IDS } from './protocolIdentities';
import { deleteSessionRecord, readSessionRecord, writeSessionRecord } from '../session/indexedDb';
import {
  createSessionModel,
  decodeSessionSaveEnvelope,
  sessionModelFromSave,
  snapshotFromSessionModel,
  updateSelectedComposeDraft,
} from '../session/model';
import {
  ACTIVE_INSTANCE,
  activeSave,
  baseSave,
  installSessionEnvelopeTestSetup,
  liveSave,
} from './session_save_envelope.fixtures';

installSessionEnvelopeTestSetup();

describe('durable game envelope round trips', () => {
  const saveLiveEnvelope = async (save: ReturnType<typeof liveSave>) => {
    if (save.phase !== 'live') throw new Error('test fixture did not produce a live save');
    await saveSession({
      scope: 'live',
      pairing: save.pairing,
      live: save.live,
      presentation: save.presentation,
      history: save.history,
    });
  };

  it('canonical decode preserves a complete snapshot exactly', () => {
    const original = liveSave({
      channelStatus: {
        state: 'Active',
        advisory: null,
        coin: null,
        our_balance: '20',
        their_balance: '20',
        game_allocated: '0',
      },
      waitingStateEnteredAt: null,
      cleanShutdownGraceStartedAt: null,
    });
    const decoded = decodeSessionSaveEnvelope(original);
    expect(decoded.save).toEqual(original);
  });
  it.each([
    ['preferences', baseSave({ blockchainType: 'simulator' }), 'preferences'],
    [
      'pre-handshake',
      baseSave({
        pairingToken: 'pair',
        iStarted: true,
        myContribution: '20',
        theirContribution: '20',
        perGameAmount: '2',
      }),
      'pre-handshake',
    ],
    ['live', liveSave(), 'live'],
    [
      'terminal',
      baseSave({
        channelStatus: { state: 'ResolvedClean' },
        coinsOfInterest: [],
        terminalIStarted: true,
      }),
      'terminal',
    ],
  ] as const)(
    'round-trips a legitimate %s phase through IndexedDB and canonical decode',
    async (_label, save, kind) => {
      await writeSessionRecord(save);
      const restored = await readSessionRecord();
      expect(restored).not.toBeNull();
      expect(decodeSessionSaveEnvelope(restored!).phase).toBe(kind);
      await deleteSessionRecord();
    },
  );

  const cases = [
    {
      gameType: 'calpoker',
      ids: ['game-1'],
      handState: calpokerStateCodec.encode({
        playerHand: [1n, 2n, 3n, 4n],
        opponentHand: [5n, 6n, 7n, 8n],
        moveNumber: 1n,
        isPlayerTurn: true,
        iStarted: true,
        cardSelections: [1n, 2n],
        error: null,
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
        coinTossIOpen: true,
        unitSizeMojos: 10n,
        displayMode: 'mojos',
        error: null,
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
      const save = liveSave({
        activeGameIds: [...ids],
        currentHandGameIds: [...ids],
        currentHandOrigin: 'local',
        lastDisplayedGameId: ids[0],
        activeGameType: gameType,
        gameInstances,
        handState,
        betweenHandLastHandProposal: {
          my_contribution: contribution,
          their_contribution: contribution,
          game_timeout: '15',
          game_type: gameType,
          ...(gameType === 'spacepoker' ? { spacepoker_unit_size: '10' } : {}),
        },
      });
      await saveLiveEnvelope(save);
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
      drafts: {
        calpoker: { amount: 123n },
        krunk: { amount: 800n },
        spacepoker: { unitSize: 987654321n, stackSize: 73n },
      },
    };
    const snapshot = snapshotFromSessionModel(createSessionModel({ betweenHand: { compose } }));
    expect(snapshot.betweenHandCompose).toEqual({
      selected_game: 'spacepoker',
      game_timeout: '47',
      proposal_sent: false,
      drafts: {
        calpoker: { amount: '123' },
        krunk: { amount: '800' },
        spacepoker: { unitSize: '987654321', stackSize: '73' },
      },
    });

    await saveLiveEnvelope(liveSave(snapshot));
    await flushSessionSave();
    _resetForTests();

    const loaded = await peekSession();
    expect(loaded).not.toBeNull();
    expect(sessionModelFromSave(loaded!).betweenHand.compose).toEqual(compose);
  });

  it('round-trips canonical hand state separately from a pending candidate', () => {
    const save = activeSave();
    if (save.phase !== 'live') throw new Error('expected live fixture');
    const canonical = save.presentation.handState;
    const featureState = {
      ...calpokerStateCodec.decode(canonical)!,
      moveNumber: 2n,
      isPlayerTurn: false,
    };
    const restored = sessionModelFromSave(
      activeSave({
        pendingCandidates: [
          { gameType: 'calpoker', id: 'game-1', action: 'make_move', featureState },
        ],
      }),
    );

    expect(restored.game.handState).toEqual(canonical);
    expect(restored.game.pendingCandidates['game-1']).toEqual({
      gameType: 'calpoker',
      id: 'game-1',
      action: 'make_move',
      featureState,
    });
    expect(snapshotFromSessionModel(restored).pendingCandidates).toEqual([
      { gameType: 'calpoker', id: 'game-1', action: 'make_move', featureState },
    ]);
  });

  it('round-trips a session with no lastHandProposal and an unsubmittable compose draft', () => {
    const model = createSessionModel();
    const snapshot = snapshotFromSessionModel(model);
    expect(snapshot.betweenHandLastHandProposal).toBeNull();
    const restored = sessionModelFromSave(liveSave(snapshot));
    expect(restored.betweenHand.lastHandProposal).toBeNull();
    expect(restored.betweenHand.compose).toEqual(model.betweenHand.compose);
  });

  it('keeps lastHandProposal when the compose draft is not currently submittable', () => {
    const lastHandProposal = {
      gameType: 'calpoker' as const,
      myContribution: 25n,
      theirContribution: 25n,
      gameTimeout: 15n,
    };
    const model = createSessionModel({
      betweenHand: {
        lastHandProposal,
        compose: updateSelectedComposeDraft(createSessionModel().betweenHand.compose, {
          amount: 0n,
        }),
      },
    });
    const snapshot = snapshotFromSessionModel(model);
    expect(snapshot.betweenHandLastHandProposal?.game_type).toBe('calpoker');
    const restored = sessionModelFromSave(liveSave(snapshot));
    expect(restored.betweenHand.lastHandProposal).toEqual(lastHandProposal);
    expect(restored.betweenHand.compose.drafts.calpoker.amount).toBe(0n);
  });

  it('keeps timer patches narrow without producing a sparse durable presentation', async () => {
    await saveLiveEnvelope(liveSave());
    await saveSession({
      scope: 'presentation',
      presentation: { waitingStateEnteredAt: 123n },
    });
    await flushSessionSave();
    let loaded = await peekSession();
    expect(loaded?.phase === 'live' && loaded.presentation.waitingStateEnteredAt).toBe(123n);
    expect(() => decodeSessionSaveEnvelope(loaded)).not.toThrow();

    await saveSession({
      scope: 'presentation',
      presentation: { waitingStateEnteredAt: null },
    });
    await flushSessionSave();
    loaded = await peekSession();
    expect(loaded?.phase === 'live' && loaded.presentation).toHaveProperty(
      'waitingStateEnteredAt',
      null,
    );
    expect(loaded?.phase === 'live' && loaded.presentation.currentHandGameIds).toEqual([]);
    expect(loaded?.phase === 'live' && loaded.presentation.gameInstances).toEqual({});
  });

  it('cold-decodes a live save written while protocol identities were bound', () => {
    const hashes = TEST_PROTOCOL_IDS;
    const handState = calpokerStateCodec.encode({
      playerHand: [1n, 2n, 3n, 4n],
      opponentHand: [5n, 6n, 7n, 8n],
      moveNumber: 1n,
      isPlayerTurn: true,
      iStarted: true,
      cardSelections: [1n, 2n],
      error: null,
    });
    setProtocolIds(hashes);
    try {
      const save = liveSave({
        activeGameIds: ['game-1'],
        currentHandGameIds: ['game-1'],
        currentHandOrigin: 'local',
        lastDisplayedGameId: 'game-1',
        activeGameType: 'calpoker',
        gameInstances: { 'game-1': { ...ACTIVE_INSTANCE } },
        handState,
      });
      const snapshot = snapshotFromSessionModel(sessionModelFromSave(save));
      expect(snapshot.activeGameType).toBe('calpoker');
      expect(snapshot.betweenHandLastHandProposal?.game_type).toBe('calpoker');
      expect(snapshot.handState?.gameType).toBe('calpoker');
      expect(protocolIdForCatalog('calpoker')).toBe(hashes[0].id);
      resetProtocolIds();
      expect(decodeSessionSaveEnvelope(liveSave(snapshot)).phase).toBe('live');
    } finally {
      resetProtocolIds();
    }
  });

  it('rejects a hash activeGameType instead of dual-reading it', () => {
    setProtocolIds(TEST_PROTOCOL_IDS);
    try {
      expect(() =>
        decodeSessionSaveEnvelope(
          liveSave({
            activeGameType: TEST_PROTOCOL_IDS[0].id,
          }),
        ),
      ).toThrow(/activeGameType/);
    } finally {
      resetProtocolIds();
    }
  });
});
