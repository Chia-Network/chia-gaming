import { applyTermsToComposeDraft } from '../session/composeDraft';
import { createSessionMachineState, reduceSessionMachine } from '../session/sessionMachine';
import { runSessionMachineTransition } from '../session/sessionMachineEffects';
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

const CALPOKER_TERMS = {
  gameType: 'calpoker' as const,
  myContribution: 10n,
  theirContribution: 10n,
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
});
