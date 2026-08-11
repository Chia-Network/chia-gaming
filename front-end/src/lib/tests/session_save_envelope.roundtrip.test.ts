import { calpokerStateCodec } from '../../features/calPoker/stateCodec';
import { initialKrunkGameState, krunkStateCodec } from '../../features/krunk/stateCodec';
import { spacepokerStateCodec } from '../../features/spacePoker/stateCodec';
import { _resetForTests, flushSessionSave, peekSession, saveSession } from '../../hooks/save';
import { decodePersistedGameState } from '../gameRegistry';
import { deleteSessionRecord, readSessionRecord, writeSessionRecord } from '../session/indexedDb';
import {
  createSessionModel,
  decodeSessionSaveEnvelope,
  sessionModelFromSave,
  snapshotFromSessionModel,
} from '../session/model';
import {
  ACTIVE_INSTANCE,
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
        pendingTerminalAction: null,
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
      const save = liveSave({
        activeGameIds: [...ids],
        currentHandGameIds: [...ids],
        currentHandOrigin: 'local',
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

    await saveLiveEnvelope(liveSave(snapshot));
    await flushSessionSave();
    _resetForTests();

    const loaded = await peekSession();
    expect(loaded).not.toBeNull();
    expect(sessionModelFromSave(loaded!).betweenHand.compose).toEqual(compose);
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
});
