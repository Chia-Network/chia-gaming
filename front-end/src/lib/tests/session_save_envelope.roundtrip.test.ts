import { initialKrunkGameState } from '@games/krunk/ui/serialize';
import { calpokerStateCodec, krunkStateCodec, spacepokerStateCodec } from './game_state_helpers';
import { storageRepository } from '../session/storageRepository';
import { decodePersistedGameState } from '../gameRegistry';
import { protocolIdForCatalog, resetProtocolIds, setProtocolIds } from '../gameIdentities';
import { TEST_PROTOCOL_IDS } from './protocolIdentities';
import { readApplicationState } from '../session/indexedDb';
import { rehydrateDurableApplicationState } from '../session/persistence';
import {
  createSessionModel,
  decodeDurableApplicationState,
  snapshotFromSessionModel,
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
    if (save.session?.phase !== 'live') throw new Error('test fixture did not produce a live save');
    await storageRepository.write(storageRepository.patchApplicationState(() => save));
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
        have_potato: undefined,
        zero_payout: undefined,
        session_disposition: undefined,
        semantic_phase: undefined,
        state_number: 4n,
        unrolling_state_number: 3n,
        preempting_state_number: 5n,
        unroll_initiator: undefined,
      },
      waitingStateEnteredAt: null,
      cleanShutdownGraceStartedAt: null,
    });
    const decoded = decodeDurableApplicationState(original);
    expect(decoded.save).toEqual(original);
  });

  it('rehydrates model, controller, wallet, and rejection projections once', () => {
    const rejection = {
      kind: 'outbound-reject' as const,
      peerId: 'peer',
      sessionId: 'ab'.repeat(16),
      messageNumber: 2n,
      remoteNumber: 1n,
      unackedMessages: [{ msgno: 1n, msg: new Uint8Array([1, 2]) }],
      createdAt: 1,
    };
    const original = liveSave({ rejectionTransports: [rejection] });
    const restored = rehydrateDurableApplicationState(original);

    expect(restored.state.session?.phase).toBe('live');
    expect(restored.state.session).toEqual(original.session);
    expect(restored.model.game.activeIds).toEqual(
      original.session?.phase === 'live' ? original.session.presentation.activeGameIds : [],
    );
    expect(restored.state.walletContext).toEqual(original.walletContext);
    expect(restored.state.channelFundingOperations).toEqual(original.channelFundingOperations);
    expect(restored.state.feeAttachments).toEqual(original.feeAttachments);
    expect(restored.state.rejectionTransports).toEqual([rejection]);
    restored.state.rejectionTransports[0]!.unackedMessages[0]!.msg[0] = 9;
    expect(original.rejectionTransports[0]!.unackedMessages[0]!.msg[0]).toBe(1);
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
      await storageRepository.write(storageRepository.patchApplicationState(() => save));
      const restored = await readApplicationState();
      expect(restored).not.toBeNull();
      const decoded = decodeDurableApplicationState(restored!);
      expect(decoded.save.session?.phase ?? 'preferences').toBe(kind);
      expect(decoded.save).toEqual(save);
      await storageRepository.clearSession();
    },
  );

  const cases = [
    {
      gameType: 'calpoker',
      ids: ['game-1'],
      handState: calpokerStateCodec.encode({
        perPlayerStake: 20n,
        playerHand: [1n, 2n, 3n, 4n],
        opponentHand: [5n, 6n, 7n, 8n],
        moveNumber: 1n,
        isPlayerTurn: true,
        iStarted: true,
        cardSelections: [1n, 2n],
        settlementOutcome: null,
      }),
    },
    {
      gameType: 'spacepoker',
      ids: ['game-1'],
      handState: spacepokerStateCodec.encode({
        perPlayerStake: 20n,
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
        settlementOutcome: null,
      }),
    },
    {
      gameType: 'krunk',
      ids: ['game-1', 'game-2'],
      handState: krunkStateCodec.encode({
        perPlayerStake: 100n,
        members: [initialKrunkGameState('alice'), initialKrunkGameState('bob')],
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
          senderIsPlayerA: gameType === 'krunk',
          gameTimeout: 15n,
          gameType,
          parameters:
            gameType === 'spacepoker' ? [BigInt(contribution) / 10n, 10n] : BigInt(contribution),
        },
      });
      await saveLiveEnvelope(save);
      await storageRepository.checkpointDomainMutations();

      storageRepository._resetForTests();
      const loaded = await storageRepository.readCurrentState();
      expect(loaded).not.toBeNull();
      const model = decodeDurableApplicationState(loaded!).model;
      expect(model.game.activeIds).toEqual(ids);
      expect(decodePersistedGameState(model.game.handState)).toEqual(handState);
    },
  );

  it('round-trips only host-owned compose state through IndexedDB', async () => {
    const compose = {
      selectedGame: 'spacepoker' as const,
      gameTimeout: 47n,
      proposalSent: false,
    };
    const snapshot = snapshotFromSessionModel(createSessionModel({ betweenHand: { compose } }));
    expect(snapshot.betweenHandCompose).toEqual({
      selectedGame: 'spacepoker',
      gameTimeout: 47n,
    });

    await saveLiveEnvelope(liveSave(snapshot));
    await storageRepository.checkpointDomainMutations();
    storageRepository._resetForTests();

    const loaded = await storageRepository.readCurrentState();
    expect(loaded).not.toBeNull();
    expect(decodeDurableApplicationState(loaded!).model.betweenHand.compose).toEqual(compose);
  });

  it('round-trips canonical hand state without candidate state', () => {
    const save = activeSave();
    if (save.session?.phase !== 'live') throw new Error('expected live fixture');
    const canonical = save.session.presentation.handState;
    const restored = decodeDurableApplicationState(save).model;

    expect(restored.game.handState).toEqual(canonical);
    expect(snapshotFromSessionModel(restored).handState).toEqual(canonical);
  });

  it('round-trips a session with no lastHandProposal and an unsubmittable compose draft', () => {
    const model = createSessionModel();
    const snapshot = snapshotFromSessionModel(model);
    expect(snapshot.betweenHandLastHandProposal).toBeNull();
    const restored = decodeDurableApplicationState(liveSave(snapshot)).model;
    expect(restored.betweenHand.lastHandProposal).toBeNull();
    expect(restored.betweenHand.compose).toEqual(model.betweenHand.compose);
  });

  it('preserves opaque parameter types including Uint8Array', () => {
    const parameters = [
      null,
      false,
      7n,
      'é🙂',
      Uint8Array.of(0, 127, 255),
      [true, Uint8Array.of(1, 2)],
    ] as const;
    const model = createSessionModel({
      betweenHand: {
        lastHandProposal: {
          gameType: 'calpoker',
          senderIsPlayerA: false,
          gameTimeout: 15n,
          parameters,
        },
      },
    });
    const restored = decodeDurableApplicationState(liveSave(snapshotFromSessionModel(model))).model;
    expect(restored.betweenHand.lastHandProposal?.parameters).toEqual(parameters);
    expect(
      (restored.betweenHand.lastHandProposal?.parameters as readonly unknown[])[4],
    ).toBeInstanceOf(Uint8Array);
  });

  it('keeps lastHandProposal independently of transient package controls', () => {
    const lastHandProposal = {
      gameType: 'calpoker' as const,
      senderIsPlayerA: false,
      gameTimeout: 15n,
      parameters: 25n,
    };
    const model = createSessionModel({
      betweenHand: {
        lastHandProposal,
      },
    });
    const snapshot = snapshotFromSessionModel(model);
    expect(snapshot.betweenHandLastHandProposal?.gameType).toBe('calpoker');
    const restored = decodeDurableApplicationState(liveSave(snapshot)).model;
    expect(restored.betweenHand.lastHandProposal).toEqual(lastHandProposal);
    expect(Object.hasOwn(restored.betweenHand.compose, 'drafts')).toBe(false);
  });

  it('round-trips multi-hand identity and same-terms intent', () => {
    const save = liveSave({
      handKey: 4n,
      newHandRequested: true,
      pendingProposals: [
        {
          id: 'next-hand',
          lifecycle: 'local-outgoing',
          handProposal: {
            senderIsPlayerA: false,
            gameTimeout: 15n,
            gameType: 'calpoker',
            parameters: 20n,
          },
        },
      ],
    });
    const decoded = decodeDurableApplicationState(save);
    expect(decoded.model.game.handKey).toBe(4);
    expect(decoded.model.betweenHand.newHandRequested).toBe(true);
    expect(decoded.model.betweenHand.compose.proposalSent).toBe(true);
    expect(
      snapshotFromSessionModel(decoded.model, {
        channelStatus: save.session.presentation.channelStatus,
        waitingStateEnteredAt: save.session.presentation.waitingStateEnteredAt,
        cleanShutdownGraceStartedAt: save.session.presentation.cleanShutdownGraceStartedAt,
      }),
    ).toEqual(save.session.presentation);
  });

  it.each(['local-outgoing', 'local-cancel-queued'] as const)(
    'derives sent compose state from unresolved %s proposal intent',
    (lifecycle) => {
      const restored = decodeDurableApplicationState(
        liveSave({
          betweenHandCompose: {
            selectedGame: 'spacepoker',
            gameTimeout: 47n,
          },
          pendingProposals: [
            {
              id: 'next-hand',
              lifecycle,
              handProposal: {
                senderIsPlayerA: true,
                gameTimeout: 47n,
                gameType: 'spacepoker',
                parameters: [10n, 1n],
              },
            },
          ],
        }),
      ).model;

      expect(restored.betweenHand.compose).toEqual({
        selectedGame: 'spacepoker',
        gameTimeout: 47n,
        proposalSent: true,
      });
      expect(snapshotFromSessionModel(restored).betweenHandCompose).not.toHaveProperty(
        'proposal_sent',
      );
    },
  );

  it('cold-decodes a live save written while protocol identities were bound', () => {
    const hashes = TEST_PROTOCOL_IDS;
    const handState = calpokerStateCodec.encode({
      perPlayerStake: 20n,
      playerHand: [1n, 2n, 3n, 4n],
      opponentHand: [5n, 6n, 7n, 8n],
      moveNumber: 1n,
      isPlayerTurn: true,
      iStarted: true,
      cardSelections: [1n, 2n],
      settlementOutcome: null,
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
      const snapshot = snapshotFromSessionModel(decodeDurableApplicationState(save).model);
      expect(snapshot.activeGameType).toBe('calpoker');
      expect(snapshot.betweenHandLastHandProposal?.gameType).toBe('calpoker');
      expect(snapshot.handState?.gameType).toBe('calpoker');
      expect(protocolIdForCatalog('calpoker')).toBe(hashes[0].id);
      resetProtocolIds();
      expect(decodeDurableApplicationState(liveSave(snapshot)).save.session?.phase).toBe('live');
    } finally {
      resetProtocolIds();
    }
  });

  it('rejects a hash activeGameType instead of dual-reading it', () => {
    setProtocolIds(TEST_PROTOCOL_IDS);
    try {
      expect(() =>
        decodeDurableApplicationState(
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
