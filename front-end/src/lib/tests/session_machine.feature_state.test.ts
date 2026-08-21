import { Program } from 'clvm-lib';
import { calpokerStateCodec } from '@games/calpoker/ui/serialize';
import { krunkStateCodec } from '@games/krunk/ui/serialize';
import { spacepokerStateCodec } from '@games/spacepoker/ui/serialize';
import {
  createSessionModel,
  INITIAL_CHANNEL_STATUS_MODEL,
  sessionModelFromSave,
  snapshotFromSessionModel,
} from '../session/model';
import { createSessionMachineState, reduceSessionMachine } from '../session/sessionMachine';
import { reduceSessionNotification } from '../session/sessionMachineNotifications';
import { CALPOKER_TERMS, run, send, trackProposal } from './session_machine.harness';
import { liveSave } from './session_save_envelope.fixtures';

describe('session machine behavior sequences', () => {
  it('resets durable state only when an accepted group starts a new hand', () => {
    let state = createSessionMachineState(createSessionModel());
    state = trackProposal(state, ['7'], CALPOKER_TERMS);

    state = trackProposal(state, ['9'], CALPOKER_TERMS, 'peer');
    state = send(state, {
      type: 'notification-accepted-group',

      id: '7',
      amount: '20',
      iStarted: true,
      isMyTurn: false,
    });

    expect(calpokerStateCodec.decode(state.model.game.handState)).toMatchObject({
      moveNumber: 0n,

      isPlayerTurn: false,
    });

    state = send(state, {
      type: 'feature-state',

      gameType: 'calpoker',

      id: '7',

      state: {
        playerHand: [],

        opponentHand: [],

        cardSelections: [],

        moveNumber: 2n,

        isPlayerTurn: true,

        iStarted: true,
      },
    });

    const progressed = state.model.game.handState;

    const restoredHandKey = state.model.game.handKey;

    state = createSessionMachineState(state.model, {
      firstGameAccepted: true,
    });

    state = send(state, {
      type: 'notification-accepted-group',

      id: '7',
      amount: '20',
      iStarted: true,
      isMyTurn: false,
    });

    expect(state.model.game.handState).toEqual(progressed);

    expect(state.model.game.handKey).toBe(restoredHandKey);

    state = send(state, {
      type: 'notification-accepted-group',

      id: '9',
      amount: '20',
      iStarted: true,
      isMyTurn: false,
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

      id: '7',
      amount: '20',
      iStarted: true,
      isMyTurn: false,
    });

    state = send(state, {
      type: 'feature-state',

      gameType: 'calpoker',

      id: '7',

      state: {
        playerHand,

        opponentHand,

        cardSelections: playerHand.slice(0, 4),

        moveNumber: 2n,

        isPlayerTurn: false,

        iStarted: true,
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

      handProposal: {
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

          id: ids[0],
          amount: '100',
          iStarted: false,
          isMyTurn: true,
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

      const restoredAfterMove = sessionModelFromSave(
        liveSave({
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
        }),
      );

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

        myContribution: 100n,

        theirContribution: 100n,

        gameTimeout: 15n,

        unitSizeMojos: 10n,
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

      id: '7',
      amount: '100',
      iStarted: false,
      isMyTurn: true,
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
    let initial = createSessionMachineState(
      createSessionModel({
        channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'Active' } },
      }),
    );
    initial = trackProposal(initial, ['7'], CALPOKER_TERMS);

    const state = send(initial, {
      type: 'notification-accepted-group',

      id: '7',
      amount: '10',
      iStarted: false,
      isMyTurn: true,
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
