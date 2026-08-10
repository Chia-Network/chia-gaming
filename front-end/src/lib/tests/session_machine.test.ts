import { applyTermsToComposeDraft } from '../session/composeDraft';
import { createSessionMachineState, reduceSessionMachine } from '../session/sessionMachine';
import { runSessionMachineTransition } from '../session/sessionMachineEffects';
import { reduceSessionNotification } from '../session/sessionMachineNotifications';
import {
  createSessionModel,
  INITIAL_CHANNEL_STATUS_MODEL,
  INITIAL_GAME_TERMINAL_MODEL,
  sessionModelFromSave,
  snapshotFromSessionModel,
} from '../session/model';
import { calpokerStateCodec } from '../../features/calPoker/stateCodec';
import { spacepokerStateCodec } from '../../features/spacePoker/stateCodec';
import { krunkStateCodec } from '../../features/krunk/stateCodec';
import { Program } from 'clvm-lib';

const CALPOKER_TERMS = {
  gameType: 'calpoker' as const,
  myContribution: 10n,
  theirContribution: 10n,
  gameTimeout: 15n,
};

const KRUNK_TERMS = {
  gameType: 'krunk' as const,
  myContribution: 100n,
  theirContribution: 100n,
  gameTimeout: 15n,
};

function send(
  state: ReturnType<typeof createSessionMachineState>,
  event: Parameters<typeof reduceSessionMachine>[1],
) {
  return reduceSessionMachine(state, event).state;
}

describe('session machine behavior sequences', () => {
  function run(
    state: ReturnType<typeof createSessionMachineState>,
    event: Parameters<typeof reduceSessionMachine>[1],
    order: string[] = [],
  ) {
    const transition = reduceSessionMachine(state, event);
    let authority = state;
    runSessionMachineTransition(transition, {
      setAuthority: (next) => {
        order.push('authority');
        authority = next;
      },
      getAuthority: () => authority,
      controller: {
        setHandState: () => order.push('controller'),
        clearDerivedGamePresentation: () => order.push('controller-clear'),
      },
      runCommand: () => order.push('command'),
      render: () => order.push('react'),
    });
    return authority;
  }

  it('tracks a grouped proposal through acceptance and insufficient-balance rollback', () => {
    let state = createSessionMachineState(createSessionModel());
    state = send(state, {
      type: 'track-proposal',
      ids: ['11', '13'],
      terms: CALPOKER_TERMS,
      outgoing: true,
    });
    expect(state.model.betweenHand).toMatchObject({
      outgoingProposalIds: ['11', '13'],
      outgoingProposalGroupIds: [['11', '13']],
    });

    state = send(state, { type: 'begin-accepted-group', groupIds: ['11', '13'] });
    state = send(state, {
      type: 'game',
      action: {
        type: 'accepted-group',
        groupIds: ['11', '13'],
        acceptedId: '11',
        amount: '20',
        startTurn: 'my-turn',
        gameType: 'calpoker',
      },
    });
    expect(state.model.game.activeIds).toEqual(['11', '13']);
    expect(state.model.betweenHand.acceptedProposalGroupIds).toEqual([['11', '13']]);
    expect(state.coordination.proposalGroupIdsById['13']).toEqual(['11', '13']);

    state = send(state, {
      type: 'game',
      action: { type: 'remove-group', groupIds: ['11', '13'] },
    });
    state = send(state, { type: 'clear-proposals', ids: ['11', '13'] });
    state = send(state, { type: 'remove-accepted-group', groupIds: ['11', '13'] });
    state = send(state, { type: 'set-cached-proposal', proposal: null });
    state = send(state, { type: 'set-review-proposal', proposal: null });
    state = send(state, { type: 'set-between-hand-mode', mode: 'compose-proposal' });
    expect(state.model.game).toMatchObject({
      activeIds: [],
      currentHandIds: [],
      instances: {},
    });
    expect(state.model.betweenHand).toMatchObject({
      acceptedProposalGroupIds: [],
      mode: 'compose-proposal',
      cachedPeerProposal: null,
      reviewPeerProposal: null,
    });
  });

  it('retains Krunk group terms through each member acceptance notification', () => {
    let state = createSessionMachineState(createSessionModel());
    state = send(state, {
      type: 'track-proposal',
      ids: ['1', '2'],
      terms: KRUNK_TERMS,
      outgoing: true,
    });

    state = reduceSessionNotification(
      state,
      { ProposalAccepted: { id: '1', amount: '200' } },
      true,
      reduceSessionMachine,
    ).state;
    expect(state.coordination.proposalTermsById['2']).toEqual(KRUNK_TERMS);

    expect(() => {
      state = reduceSessionNotification(
        state,
        { ProposalAccepted: { id: '2', amount: '200' } },
        true,
        reduceSessionMachine,
      ).state;
    }).not.toThrow();
    expect(state.model.game.activeIds).toEqual(['1', '2']);

    const restored = createSessionMachineState(state.model);
    expect(restored.coordination.proposalTermsById).toMatchObject({
      '1': KRUNK_TERMS,
      '2': KRUNK_TERMS,
    });
  });

  it('atomically replaces Krunk authority when the next group arrives after one member settles', () => {
    let state = createSessionMachineState(createSessionModel());
    state = send(state, {
      type: 'notification-accepted-group',
      id: '1',
      groupIds: ['1', '2'],
      amount: '100',
      terms: KRUNK_TERMS,
      weProposed: true,
      iStarted: false,
    });
    state = send(state, {
      type: 'notification-game-terminal',
      id: '1',
      terminal: {
        type: 'settled',
        outcome: 'opponent_timed_out',
        label: 'Opponent timed out',
        myReward: '100',
        rewardCoinHex: null,
      },
    });
    const krunkHandKey = state.model.game.handKey;
    expect(state.model.game.activeIds).toEqual(['2']);
    expect(state.model.game.currentHandIds).toEqual(['1', '2']);
    expect(Object.keys(krunkStateCodec.decode(state.model.game.handState)!.games)).toEqual([
      '1',
      '2',
    ]);

    state = send(state, {
      type: 'notification-accepted-group',
      id: '7',
      groupIds: ['7'],
      amount: '20',
      terms: CALPOKER_TERMS,
      weProposed: true,
      iStarted: false,
    });

    expect(state.model.game.activeIds).toEqual(['7']);
    expect(state.model.game.currentHandIds).toEqual(['7']);
    expect(state.model.game.activeGameType).toBe('calpoker');
    expect(state.model.game.handState?.gameType).toBe('calpoker');
    expect(state.model.game.handKey).toBe(krunkHandKey + 1);
    expect(Object.keys(state.model.game.instances)).toEqual(['7']);
  });

  it('ignores replayed readables after one Krunk game settles without suppressing its sibling', () => {
    let state = createSessionMachineState(createSessionModel());
    state = send(state, {
      type: 'notification-accepted-group',
      id: '1',
      groupIds: ['1', '2'],
      amount: '100',
      terms: KRUNK_TERMS,
      weProposed: true,
      iStarted: false,
    });
    state = reduceSessionNotification(
      state,
      {
        GameSettled: {
          id: '1',
          outcome: 'opponent_timed_out',
          our_share: '100',
          coin_id: null,
        },
      },
      false,
      reduceSessionMachine,
    ).state;
    const terminalInstance = state.model.game.instances['1'];
    const terminalPayload = krunkStateCodec.decode(state.model.game.handState)!.games['1'];
    const staleReadable = Program.fromList([
      Program.fromBytes(new TextEncoder().encode('SLATE')),
      Program.fromList([0n, 1n, 0n, 2n, 0n].map(Program.fromBigInt)),
    ]).serialize();

    const stale = reduceSessionNotification(
      state,
      {
        GameStatus: {
          id: '1',
          status: 'my-turn',
          coin_id: null,
          other_params: { readable: staleReadable, mover_share: '100' },
        },
      },
      false,
      reduceSessionMachine,
    );
    expect(stale.state.model.game.instances['1']).toEqual(terminalInstance);
    expect(krunkStateCodec.decode(stale.state.model.game.handState)!.games['1']).toEqual(
      terminalPayload,
    );
    expect(stale.effects.filter((effect) => effect.type === 'emit-gameplay')).toEqual([]);

    const sibling = reduceSessionNotification(
      stale.state,
      {
        GameStatus: {
          id: '2',
          status: 'my-turn',
          coin_id: null,
          other_params: {
            readable: Program.fromBytes(new Uint8Array()).serialize(),
            mover_share: '100',
          },
        },
      },
      false,
      reduceSessionMachine,
    );
    expect(krunkStateCodec.decode(sibling.state.model.game.handState)!.games['2'].handler).toBe(4n);
    expect(sibling.effects).toContainEqual({
      type: 'emit-gameplay',
      event: {
        OpponentMoved: {
          gameId: '2',
          readable: Program.fromBytes(new Uint8Array()).serialize(),
          moverShare: '100',
        },
      },
    });
  });

  it('characterizes incoming proposal review and cancellation cleanup', () => {
    const proposal = { id: '21', groupIds: ['21'], terms: CALPOKER_TERMS };
    let state = createSessionMachineState(createSessionModel({ game: { handKey: 1 } }));
    state = send(state, {
      type: 'track-proposal',
      ids: proposal.groupIds,
      terms: proposal.terms,
      outgoing: false,
    });
    state = send(state, { type: 'set-review-proposal', proposal });
    state = send(state, {
      type: 'set-between-hand-mode',
      mode: 'review-incoming-proposal',
    });
    expect(state.model.betweenHand.reviewPeerProposal).toEqual(proposal);

    state = send(state, { type: 'clear-proposals', ids: ['21'] });
    state = send(state, { type: 'set-review-proposal', proposal: null });
    state = send(state, { type: 'set-between-hand-mode', mode: 'compose-proposal' });
    expect(state.model.betweenHand.reviewPeerProposal).toBeNull();
    expect(state.model.betweenHand.mode).toBe('compose-proposal');
    expect(state.coordination.proposalTermsById).toEqual({});
  });

  it('orders proposal controller commands without mutating presentation', () => {
    const state = createSessionMachineState(createSessionModel());
    expect(
      reduceSessionMachine(state, {
        type: 'request-propose-game',
        terms: CALPOKER_TERMS,
      }),
    ).toEqual({
      state,
      effects: [{ type: 'controller-propose-game', terms: CALPOKER_TERMS }],
    });
    expect(
      reduceSessionMachine(state, { type: 'request-accept-proposal', id: '7' }).effects,
    ).toEqual([{ type: 'controller-accept-proposal', id: '7' }]);
    expect(
      reduceSessionMachine(state, { type: 'request-cancel-proposal', id: '7' }).effects,
    ).toEqual([{ type: 'controller-cancel-proposal', id: '7' }]);
  });

  it('commits controller durability before commands and React regardless of effect order', () => {
    const state = createSessionMachineState(createSessionModel());
    const order: string[] = [];
    runSessionMachineTransition(
      {
        state,
        effects: [
          { type: 'controller-accept-proposal', id: '7' },
          { type: 'set-hand-state', state: null },
        ],
      },
      {
        setAuthority: () => order.push('authority'),
        getAuthority: () => state,
        controller: {
          setHandState: () => order.push('controller'),
          clearDerivedGamePresentation: () => order.push('controller-clear'),
        },
        runCommand: () => order.push('command'),
        render: () => order.push('react'),
      },
    );
    expect(order).toEqual(['authority', 'controller', 'command', 'react']);
  });

  it('projects channel and game status, local turn, and settlement in event order', () => {
    let state = createSessionMachineState(createSessionModel());
    state = send(state, {
      type: 'channel-status',
      status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'Active' },
    });
    state = send(state, { type: 'game', action: { type: 'channel-active' } });
    state = send(state, {
      type: 'game',
      action: {
        type: 'accepted-group',
        groupIds: ['7'],
        acceptedId: '7',
        amount: '20',
        startTurn: 'my-turn',
        gameType: 'calpoker',
      },
    });
    state = send(state, {
      type: 'game',
      action: {
        type: 'status',
        id: '7',
        payload: { id: '7', status: 'on-chain-my-turn', coin_id: [1] },
        channelState: 'ResolvedUnrolled',
      },
    });
    state = send(state, {
      type: 'game',
      action: {
        type: 'local-turn',
        id: '7',
        isMyTurn: false,
        channelState: 'Unrolling',
      },
    });
    expect(state.model.game.instances['7'].presentation).toBe('playing-move');

    state = send(state, {
      type: 'game',
      action: {
        type: 'settled',
        id: '7',
        terminal: {
          type: 'settled',
          outcome: 'settled_cleanly',
          label: 'Settled cleanly',
          myReward: '20',
          rewardCoinHex: null,
        },
      },
    });
    expect(state.model.game.activeIds).toEqual([]);
    expect(state.model.game.instances['7']).toMatchObject({
      presentation: 'ended',
      terminal: { type: 'settled', myReward: '20' },
    });
  });

  it('keeps compose commands in one session-owned draft', () => {
    let state = createSessionMachineState(
      createSessionModel({
        betweenHand: {
          compose: applyTermsToComposeDraft(
            createSessionModel().betweenHand.compose,
            CALPOKER_TERMS,
          ),
        },
      }),
    );
    state = send(state, { type: 'set-compose-amount', gameType: 'calpoker', amount: 37n });
    state = send(state, { type: 'set-compose-amount', gameType: 'krunk', amount: 900n });
    state = send(state, { type: 'select-compose-game', gameType: 'spacepoker' });
    state = send(state, {
      type: 'set-spacepoker-compose',
      draft: { unitSize: 11n, stackSize: 17n },
    });
    state = send(state, { type: 'set-compose-timeout', timeout: 23n });
    state = send(state, { type: 'set-compose-proposal-sent', sent: true });
    expect(state.model.betweenHand.compose).toMatchObject({
      selectedGame: 'spacepoker',
      gameTimeout: 23n,
      proposalSent: true,
      calpoker: { amount: 37n },
      krunk: { amount: 900n },
      spacepoker: { unitSize: 11n, stackSize: 17n },
    });
  });

  it('uses the restored model directly as the machine projection', () => {
    const restored = sessionModelFromSave({
      version: 11n,
      playerId: 'p1',
      serializedGameSession: new Uint8Array([1]),
      gameSessionSchemaVersion: 3n,
      pairingToken: 'pair',
      messageNumber: 1n,
      remoteNumber: 0n,
      iStarted: true,
      myContribution: '100',
      theirContribution: '100',
      perGameAmount: '10',
      rewardPuzzleHash: '11'.repeat(32),
      unackedMessages: [],
      activeGameIds: ['7'],
      currentHandGameIds: ['7'],
      activeGameType: 'calpoker',
      gameInstances: {
        '7': {
          id: '7',
          amount: '20',
          coinHex: null,
          presentation: 'off-chain-their-turn',
          terminal: INITIAL_GAME_TERMINAL_MODEL,
        },
      },
      betweenHandMode: 'compose-proposal',
      betweenHandLastTerms: {
        my_contribution: '20',
        their_contribution: '20',
        game_timeout: '15',
        game_type: 'calpoker',
      },
      handState: calpokerStateCodec.encode({
        playerHand: [],
        opponentHand: [],
        moveNumber: 0n,
        isPlayerTurn: false,
      }),
      outgoingProposalGroupIds: [['11', '13']],
      outgoingProposalTerms: {
        '11': { my_contribution: '10', their_contribution: '10', game_type: 'calpoker' },
        '13': { my_contribution: '10', their_contribution: '10', game_type: 'calpoker' },
      },
    });
    const state = createSessionMachineState(restored, { iProposedHand: true });
    expect(state.model).toBe(restored);
    expect(state.model.game.activeIds).toEqual(['7']);
    expect(state.coordination.proposalGroupIdsById['13']).toEqual(['11', '13']);
    expect(state.coordination.iProposedHand).toBe(true);
  });

  it.each([
    {
      gameType: 'calpoker' as const,
      ids: ['7'],
      terms: CALPOKER_TERMS,
      moved: (state: ReturnType<typeof createSessionMachineState>) =>
        calpokerStateCodec.decode(state.model.game.handState)?.isPlayerTurn,
    },
    {
      gameType: 'spacepoker' as const,
      ids: ['7'],
      terms: {
        gameType: 'spacepoker' as const,
        myContribution: 100n,
        theirContribution: 100n,
        gameTimeout: 15n,
        unitSizeMojos: 10n,
      },
      moved: (state: ReturnType<typeof createSessionMachineState>) =>
        spacepokerStateCodec.decode(state.model.game.handState)?.gameState.handler,
    },
    {
      gameType: 'krunk' as const,
      ids: ['7', '9'],
      terms: {
        gameType: 'krunk' as const,
        myContribution: 100n,
        theirContribution: 100n,
        gameTimeout: 15n,
      },
      moved: (state: ReturnType<typeof createSessionMachineState>) =>
        krunkStateCodec.decode(state.model.game.handState)?.games['9'].handler,
    },
  ])(
    'atomically persists $gameType acceptance, move, settlement, balance failure, and abandonment',
    ({ gameType, ids, terms, moved }) => {
      let state = createSessionMachineState(
        createSessionModel({
          channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'Active' } },
        }),
      );
      const acceptedOrder: string[] = [];
      state = run(
        state,
        {
          type: 'notification-accepted-group',
          id: ids[0],
          groupIds: ids,
          amount: '100',
          terms,
          weProposed: true,
          iStarted: false,
        },
        acceptedOrder,
      );
      expect(acceptedOrder).toEqual(['authority', 'controller', 'react']);
      expect(state.model.game.activeIds).toEqual(ids);
      expect(state.model.game.handState?.gameType).toBe(gameType);

      const decodedAccepted =
        gameType === 'calpoker'
          ? calpokerStateCodec.decode(state.model.game.handState)
          : gameType === 'spacepoker'
            ? spacepokerStateCodec.decode(state.model.game.handState)
            : krunkStateCodec.decode(state.model.game.handState)?.games[ids[0]];
      expect(() =>
        reduceSessionMachine(state, {
          type: 'feature-state',
          gameType,
          id: ids[0],
          state: decodedAccepted,
        }),
      ).not.toThrow();

      const moveId = gameType === 'krunk' ? ids[1] : ids[0];
      state = run(state, {
        type: 'notification-game-status',
        id: moveId,
        payload: { id: moveId, status: 'my-turn', coin_id: null },
        channelState: 'Active',
        readable: gameType === 'calpoker' ? null : new Uint8Array([0x80]),
        moverShare: '100',
        iStarted: false,
      });
      expect(moved(state)).toBe(gameType === 'calpoker' ? true : gameType === 'krunk' ? 4n : 1n);

      const restoredAfterMove = sessionModelFromSave({
        version: 11n,
        playerId: 'p1',
        serializedGameSession: new Uint8Array([1]),
        gameSessionSchemaVersion: 3n,
        pairingToken: 'pair',
        messageNumber: 1n,
        remoteNumber: 0n,
        iStarted: true,
        myContribution: '100',
        theirContribution: '100',
        perGameAmount: '10',
        rewardPuzzleHash: '11'.repeat(32),
        unackedMessages: [],
        ...snapshotFromSessionModel(state.model),
      });
      expect(restoredAfterMove.game.activeIds).toEqual(ids);
      expect(restoredAfterMove.game.handState).toEqual(state.model.game.handState);

      state = run(state, {
        type: 'notification-game-terminal',
        id: ids[0],
        terminal: {
          type: 'settled',
          outcome: 'opponent_timed_out',
          label: 'Opponent timed out',
          myReward: '100',
          rewardCoinHex: null,
        },
      });
      expect(state.model.game.instances[ids[0]].terminal.outcome).toBe('opponent_timed_out');
      if (gameType === 'krunk') {
        expect(krunkStateCodec.decode(state.model.game.handState)?.games[ids[1]]).toBeDefined();
      }

      if (gameType === 'krunk') {
        state = run(state, {
          type: 'notification-insufficient-balance',
          id: ids[1],
          groupIds: ids,
          notification: {
            id: 1n,
            kind: 'insufficient-bal',
            title: 'Notice',
            message: 'Insufficient balance',
          },
        });
        expect(state.model.game.handState).toBeNull();
        expect(state.model.game.activeIds).toEqual([]);
      }

      state = run(state, {
        type: 'channel-status',
        status: {
          ...INITIAL_CHANNEL_STATUS_MODEL,
          state: 'Failed',
          sessionDisposition: 'Abandoned',
        },
      });
      expect(state.model.game.activeIds).toEqual([]);
      expect(state.model.game.handState).toBeNull();
    },
  );

  it('keeps Krunk WaitingCommit durable state valid across post-unroll status projection', () => {
    let state = createSessionMachineState(
      createSessionModel({
        channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'Active' } },
      }),
    );
    state = run(state, {
      type: 'notification-accepted-group',
      id: '7',
      groupIds: ['7', '9'],
      amount: '100',
      terms: KRUNK_TERMS,
      weProposed: true,
      iStarted: false,
    });
    const accepted = state.model.game.handState;
    expect(krunkStateCodec.decode(accepted)?.games['7']).toMatchObject({
      handler: 0n,
      myTurn: true,
      role: 'alice',
    });

    state = {
      ...state,
      model: {
        ...state.model,
        channel: {
          ...state.model.channel,
          status: { ...state.model.channel.status, state: 'GoingOnChain' },
        },
      },
    };
    state = {
      ...state,
      model: {
        ...state.model,
        channel: {
          ...state.model.channel,
          status: { ...state.model.channel.status, state: 'Unrolling' },
        },
      },
    };
    state = run(state, {
      type: 'notification-game-status',
      id: '7',
      payload: {
        id: '7',
        status: 'on-chain-my-turn',
        coin_id: new Uint8Array([1]),
      },
      channelState: 'Unrolling',
      readable: null,
      moverShare: null,
      iStarted: false,
    });

    expect(state.model.game.instances['7'].presentation).toBe('on-chain-my-turn');
    expect(state.model.game.handState).toEqual(accepted);
    const decoded = krunkStateCodec.decode(state.model.game.handState);
    expect(decoded?.games['7']).toMatchObject({
      handler: 0n,
      myTurn: true,
      role: 'alice',
    });
    expect(() =>
      reduceSessionMachine(state, {
        type: 'feature-state',
        gameType: 'krunk',
        id: '7',
        state: {
          ...decoded!.games['7'],
          handler: 1n,
          myTurn: false,
          secretWord: 'CRANE',
        },
      }),
    ).not.toThrow();

    expect(() =>
      sessionModelFromSave({
        version: 11n,
        playerId: 'p1',
        serializedGameSession: new Uint8Array([1]),
        gameSessionSchemaVersion: 3n,
        pairingToken: 'pair',
        messageNumber: 1n,
        remoteNumber: 0n,
        iStarted: false,
        myContribution: '100',
        theirContribution: '100',
        perGameAmount: '100',
        rewardPuzzleHash: '11'.repeat(32),
        unackedMessages: [],
        ...snapshotFromSessionModel(state.model),
      }),
    ).not.toThrow();
  });

  it.each([
    { gameType: 'calpoker' as const, terms: CALPOKER_TERMS },
    {
      gameType: 'spacepoker' as const,
      terms: {
        gameType: 'spacepoker' as const,
        myContribution: 100n,
        theirContribution: 100n,
        gameTimeout: 15n,
        unitSizeMojos: 10n,
      },
    },
  ])('does not invent $gameType durable turns from chain progress statuses', ({ terms }) => {
    let state = createSessionMachineState(
      createSessionModel({
        channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'Unrolling' } },
      }),
    );
    state = run(state, {
      type: 'notification-accepted-group',
      id: '7',
      groupIds: ['7'],
      amount: '100',
      terms,
      weProposed: true,
      iStarted: false,
    });
    const accepted = state.model.game.handState;

    for (const status of [
      'on-chain-my-turn',
      'on-chain-their-turn',
      'playing-move',
      'replaying',
    ] as const) {
      state = run(state, {
        type: 'notification-game-status',
        id: '7',
        payload: { id: '7', status, coin_id: new Uint8Array([1]) },
        channelState: 'Unrolling',
        readable: null,
        moverShare: null,
        iStarted: false,
      });
      expect(state.model.game.handState).toEqual(accepted);
    }
  });

  it('fails fast for mismatched feature-state type, id, and payload', () => {
    const initial = createSessionMachineState(
      createSessionModel({
        channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'Active' } },
      }),
    );
    const state = send(initial, {
      type: 'notification-accepted-group',
      id: '7',
      groupIds: ['7'],
      amount: '10',
      terms: CALPOKER_TERMS,
      weProposed: true,
      iStarted: false,
    });

    expect(() =>
      reduceSessionMachine(state, {
        type: 'feature-state',
        gameType: 'spacepoker',
        id: '7',
        state: {},
      }),
    ).toThrow('feature-state gameType');
    expect(() =>
      reduceSessionMachine(state, {
        type: 'feature-state',
        gameType: 'calpoker',
        id: 'unrelated',
        state: calpokerStateCodec.decode(state.model.game.handState),
      }),
    ).toThrow('feature-state game id');
    expect(() =>
      reduceSessionMachine(state, {
        type: 'feature-state',
        gameType: 'calpoker',
        id: '7',
        state: { malformed: true },
      }),
    ).toThrow('feature-state payload');
  });
});
