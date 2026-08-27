import { Program } from 'clvm-lib';
import { calpokerStateCodec } from '@games/calpoker/ui/serialize';
import { krunkStateCodec } from '@games/krunk/ui/serialize';
import { spacepokerStateCodec } from '@games/spacepoker/ui/serialize';
import { createSessionModel, INITIAL_CHANNEL_STATUS_MODEL } from '../session/model';
import { createSessionMachineState, reduceSessionMachine } from '../session/sessionMachine';
import { reduceSessionNotification } from '../session/sessionMachineNotifications';
import { CALPOKER_TERMS, run, send, trackProposal } from './session_machine.harness';

describe('session machine behavior sequences', () => {
  it('rejects an inbound protocol ID outside the accepted hand', () => {
    let state = createSessionMachineState(createSessionModel());
    state = trackProposal(state, ['7'], CALPOKER_TERMS);
    state = send(state, {
      type: 'notification-accepted-group',
      members: [{ id: '7', playerAContribution: 10n, playerBContribution: 10n, ourTurn: false }],
    });

    expect(() =>
      reduceSessionMachine(state, {
        type: 'notification-game-status',
        id: '9',
        payload: { id: '9', status: 'my-turn', coin_id: null },
        channelState: 'Active',
        readable: new Uint8Array([0x80]),
        moverShare: 10n,
        iStarted: false,
      }),
    ).toThrow('Game slice invariant broken: missing instance 9');
  });

  it('resets durable state only when an accepted group starts a new hand', () => {
    let state = createSessionMachineState(createSessionModel());
    state = trackProposal(state, ['7'], CALPOKER_TERMS);

    state = trackProposal(state, ['9'], CALPOKER_TERMS, 'peer');
    state = send(state, {
      type: 'notification-accepted-group',
      members: [{ id: '7', playerAContribution: 10n, playerBContribution: 10n, ourTurn: false }],
    });

    expect(calpokerStateCodec.decode(state.model.game.handState)).toMatchObject({
      moveNumber: 0n,

      isPlayerTurn: false,
    });

    const changed = reduceSessionMachine(state, {
      type: 'hand-state-changed',

      gameType: 'calpoker',

      state: {
        playerHand: [],

        opponentHand: [],

        cardSelections: [],

        moveNumber: 2n,

        isPlayerTurn: true,

        iStarted: true,
        error: null,
      },
    });
    expect(changed.effects).toEqual([{ type: 'persist-session' }]);
    state = changed.state;

    const progressed = state.model.game.handState;

    const restoredHandKey = state.model.game.handKey;

    state = createSessionMachineState(state.model, {
      firstGameAccepted: true,
    });

    state = send(state, {
      type: 'notification-accepted-group',
      members: [{ id: '7', playerAContribution: 10n, playerBContribution: 10n, ourTurn: false }],
    });

    expect(state.model.game.handState).toEqual(progressed);

    expect(state.model.game.handKey).toBe(restoredHandKey);

    state = send(state, {
      type: 'notification-accepted-group',
      members: [{ id: '9', playerAContribution: 10n, playerBContribution: 10n, ourTurn: false }],
    });

    expect(calpokerStateCodec.decode(state.model.game.handState)).toMatchObject({
      moveNumber: 0n,

      isPlayerTurn: false,
    });

    expect(state.model.game.currentHandIds).toEqual(['9']);

    expect(state.model.game.handKey).toBe(restoredHandKey + 1);
  });

  it('projects a Calpoker final readable before the following loss terminal', () => {
    const playerHand = [32n, 36n, 41n, 49n, 33n, 37n, 42n, 50n];

    const opponentHand = [2n, 6n, 9n, 13n, 3n, 7n, 10n, 14n];

    const finalReadable = Program.fromList([
      Program.fromBigInt(15n),

      Program.fromBigInt(31n),

      Program.fromBigInt(31n),

      Program.fromList([1n, 1n, 1n, 1n, 1n, 14n, 13n, 12n, 11n, 10n].map(Program.fromBigInt)),

      Program.fromList([1n, 1n, 1n, 1n, 1n, 10n, 9n, 8n, 7n, 6n].map(Program.fromBigInt)),

      Program.fromBigInt(-1n),
    ]).serialize();

    let state = createSessionMachineState(createSessionModel());
    state = trackProposal(state, ['7'], CALPOKER_TERMS, 'peer');

    state = send(state, {
      type: 'notification-accepted-group',
      members: [{ id: '7', playerAContribution: 10n, playerBContribution: 10n, ourTurn: false }],
    });

    state = send(state, {
      type: 'hand-state-changed',

      gameType: 'calpoker',

      state: {
        perPlayerStake: 10n,

        playerHand,

        opponentHand,

        cardSelections: playerHand.slice(0, 4),

        moveNumber: 2n,

        isPlayerTurn: false,

        iStarted: true,

        settlementOutcome: null,
      },
    });

    const readableTransition = reduceSessionNotification(
      state,

      {
        GameStatus: {
          id: '7',

          status: 'my-turn',

          coin_id: null,

          other_params: {
            readable: finalReadable,

            mover_share: '0',

            game_finished: true,
          },
        },
      },

      true,

      reduceSessionMachine,
    );

    const readableState = calpokerStateCodec.decode(readableTransition.state.model.game.handState);

    expect(readableState?.displaySnapshot).toMatchObject({
      gameState: 'final',

      winner: 'ai',

      playerDisplayText: expect.stringMatching(/\S/),

      opponentDisplayText: expect.stringMatching(/\S/),
    });

    expect(readableTransition.effects.some((effect) => effect.type === 'emit-gameplay')).toBe(
      false,
    );

    expect(readableTransition.state.model.game.instances['7'].terminal.type).toBe('none');

    const terminalTransition = reduceSessionNotification(
      readableTransition.state,

      {
        GameSettled: {
          id: '7',

          outcome: 'lost',

          our_share: '0',

          coin_id: null,
        },
      },

      true,

      reduceSessionMachine,
    );

    expect(terminalTransition.effects.some((effect) => effect.type === 'emit-gameplay')).toBe(
      false,
    );

    expect(
      calpokerStateCodec.decode(terminalTransition.state.model.game.handState)?.displaySnapshot,
    ).toEqual(readableState?.displaySnapshot);
  });

  it.each([
    {
      gameType: 'calpoker' as const,

      ids: ['7'],

      handProposal: CALPOKER_TERMS,

      moved: (state: ReturnType<typeof createSessionMachineState>) =>
        calpokerStateCodec.decode(state.model.game.handState)?.isPlayerTurn,
    },

    {
      gameType: 'spacepoker' as const,

      ids: ['7'],

      handProposal: {
        gameType: 'spacepoker' as const,

        playerAContribution: 100n,
        playerBContribution: 100n,
        senderIsPlayerA: false,

        gameTimeout: 15n,

        parameters: 10n,
      },

      moved: (state: ReturnType<typeof createSessionMachineState>) =>
        spacepokerStateCodec.decode(state.model.game.handState)?.gameState.handler,
    },

    {
      gameType: 'krunk' as const,

      ids: ['7', '9'],

      handProposal: {
        gameType: 'krunk' as const,

        playerAContribution: 100n,
        playerBContribution: 100n,
        senderIsPlayerA: true,

        gameTimeout: 15n,
        parameters: null,
      },

      moved: (state: ReturnType<typeof createSessionMachineState>) =>
        krunkStateCodec.decode(state.model.game.handState)?.members[1].handler,
    },
  ])(
    'atomically persists $gameType acceptance, move, settlement, balance failure, and abandonment',

    ({ gameType, ids, handProposal, moved }) => {
      let state = createSessionMachineState(
        createSessionModel({
          channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'Active' } },
        }),
      );
      state = trackProposal(state, ids, handProposal);

      const acceptedOrder: string[] = [];

      state = run(
        state,

        {
          type: 'notification-accepted-group',
          members: ids.map((id, index) => ({
            id,
            playerAContribution: gameType === 'krunk' ? (index === 0 ? 100n : 0n) : 50n,
            playerBContribution: gameType === 'krunk' ? (index === 0 ? 0n : 100n) : 50n,
            ourTurn: gameType === 'krunk' ? index === 0 : true,
          })),
        },

        acceptedOrder,
      );

      expect(acceptedOrder).toEqual(['authority', 'react']);

      expect(state.model.game.activeIds).toEqual(ids);

      expect(state.model.game.handState?.gameType).toBe(gameType);

      const decodedAccepted =
        gameType === 'calpoker'
          ? calpokerStateCodec.decode(state.model.game.handState)
          : gameType === 'spacepoker'
            ? spacepokerStateCodec.decode(state.model.game.handState)
            : krunkStateCodec.decode(state.model.game.handState)?.members[0];

      expect(() =>
        reduceSessionMachine(state, {
          type: 'hand-state-changed',

          gameType,

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

        moverShare: 100n,

        iStarted: false,
      });

      expect(moved(state)).toBe(gameType === 'calpoker' ? true : gameType === 'krunk' ? 4n : 1n);

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
        expect(krunkStateCodec.decode(state.model.game.handState)?.members[1]).toBeDefined();
      }

      if (gameType === 'krunk') {
        state = run(state, {
          type: 'notification-insufficient-balance',

          id: ids[1],
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

  it.each([
    { gameType: 'calpoker' as const, handProposal: CALPOKER_TERMS },

    {
      gameType: 'spacepoker' as const,

      handProposal: {
        gameType: 'spacepoker' as const,

        playerAContribution: 100n,
        playerBContribution: 100n,
        senderIsPlayerA: false,

        gameTimeout: 15n,

        parameters: 10n,
      },
    },
  ])('does not invent $gameType durable turns from chain progress statuses', ({ handProposal }) => {
    let state = createSessionMachineState(
      createSessionModel({
        channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'Unrolling' } },
      }),
    );
    state = trackProposal(state, ['7'], handProposal);

    state = run(state, {
      type: 'notification-accepted-group',
      members: [{ id: '7', playerAContribution: 50n, playerBContribution: 50n, ourTurn: true }],
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

  it('rejects a mismatched game type while keeping changed hand state opaque', () => {
    let initial = createSessionMachineState(
      createSessionModel({
        channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'Active' } },
      }),
    );
    initial = trackProposal(initial, ['7'], CALPOKER_TERMS);

    const state = send(initial, {
      type: 'notification-accepted-group',
      members: [{ id: '7', playerAContribution: 5n, playerBContribution: 5n, ourTurn: true }],
    });

    expect(() =>
      reduceSessionMachine(state, {
        type: 'hand-state-changed',

        gameType: 'spacepoker',

        state: {},
      }),
    ).toThrow('gameType');

    const replaced = reduceSessionMachine(state, {
      type: 'hand-state-changed',

      gameType: 'calpoker',

      state: { malformed: true },
    });
    expect(replaced.state.model.game.handState).toEqual({
      gameType: 'calpoker',
      state: { malformed: true },
    });
  });
});
