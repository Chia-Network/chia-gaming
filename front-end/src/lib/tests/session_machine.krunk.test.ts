import { Program } from 'clvm-lib';
import { krunkStateCodec } from '../../features/krunk/stateCodec';
import {
  createSessionModel,
  INITIAL_CHANNEL_STATUS_MODEL,
  sessionModelFromSave,
  snapshotFromSessionModel,
} from '../session/model';
import { createSessionMachineState, reduceSessionMachine } from '../session/sessionMachine';
import { reduceSessionNotification } from '../session/sessionMachineNotifications';
import { CALPOKER_TERMS, KRUNK_TERMS, run, send, trackProposal } from './session_machine.harness';
import { liveSave } from './session_save_envelope.fixtures';

describe('session machine behavior sequences', () => {
  it('atomically replaces Krunk authority when the next group arrives after one member settles', () => {
    let state = createSessionMachineState(createSessionModel());
    state = trackProposal(state, ['1', '2'], KRUNK_TERMS, 'peer');

    state = send(state, {
      type: 'notification-accepted-group',

      id: '1',
      amount: '100',
      iStarted: false,
    });

    state = trackProposal(state, ['7'], CALPOKER_TERMS);
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
    expect(state.model.game.currentHandOrigin).toBe('peer');

    expect(Object.keys(krunkStateCodec.decode(state.model.game.handState)!.games)).toEqual([
      '1',

      '2',
    ]);

    state = send(state, {
      type: 'notification-accepted-group',

      id: '7',
      amount: '20',
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
    state = trackProposal(state, ['1', '2'], KRUNK_TERMS);

    state = send(state, {
      type: 'notification-accepted-group',

      id: '1',
      amount: '100',
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

  it('keeps Krunk WaitingCommit durable state valid across post-unroll status projection', () => {
    let state = createSessionMachineState(
      createSessionModel({
        channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'Active' } },
      }),
    );
    state = trackProposal(state, ['7', '9'], KRUNK_TERMS);

    state = run(state, {
      type: 'notification-accepted-group',

      id: '7',
      amount: '100',
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
      sessionModelFromSave(
        liveSave({
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
      ),
    ).not.toThrow();
  });
});
