import { Program } from 'clvm-lib';
import { krunkStateCodec } from '@games/krunk/ui/serialize';
import { createSessionModel, INITIAL_CHANNEL_STATUS_MODEL } from '../session/model';
import { createSessionMachineState, reduceSessionMachine } from '../session/sessionMachine';
import { reduceSessionNotification } from '../session/sessionMachineNotifications';
import { CALPOKER_TERMS, KRUNK_TERMS, run, send, trackProposal } from './session_machine.harness';

describe('session machine behavior sequences', () => {
  it('atomically replaces Krunk authority when the next group arrives after one member settles', () => {
    let state = createSessionMachineState(createSessionModel());
    state = trackProposal(state, ['1', '2'], KRUNK_TERMS, 'peer');

    state = send(state, {
      type: 'notification-accepted-group',
      members: [
        { id: '1', amount: '100', ourTurn: false },
        { id: '2', amount: '100', ourTurn: true },
      ],
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

    expect(krunkStateCodec.decode(state.model.game.handState)!.members).toHaveLength(2);

    state = send(state, {
      type: 'notification-accepted-group',
      members: [{ id: '7', amount: '20', ourTurn: true }],
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
      members: [
        { id: '1', amount: '100', ourTurn: true },
        { id: '2', amount: '100', ourTurn: false },
      ],
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

    const terminalPayload = krunkStateCodec.decode(state.model.game.handState)!.members[0];

    expect(state.model.game.activeIds).toEqual(['2']);
    expect(state.model.game.currentHandIds).toEqual(['1', '2']);
    expect(Object.keys(state.model.game.instances)).toEqual(['1', '2']);
    expect(state.model.game.instances['1'].presentation).toBe('ended');
    expect(state.model.game.instances['2'].presentation).not.toBe('ended');

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

    expect(krunkStateCodec.decode(stale.state.model.game.handState)!.members[0]).toEqual(
      terminalPayload,
    );

    expect(stale.effects).toEqual([]);

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

    expect(krunkStateCodec.decode(sibling.state.model.game.handState)!.members[1].handler).toBe(4n);

    expect(sibling.state.model.game.activeIds).toEqual(['2']);
    expect(sibling.state.model.game.currentHandIds).toEqual(['1', '2']);
    expect(krunkStateCodec.decode(sibling.state.model.game.handState)!.members).toHaveLength(2);
    expect(sibling.state.model.game.instances['1']).toEqual(terminalInstance);
    expect(sibling.state.model.game.instances['2'].presentation).toBe('off-chain-my-turn');
    expect(sibling.effects).toEqual([
      {
        type: 'request-coin-enrichment',
        target: 'game',
        id: '2',
        coin: null,
        generation: 1,
      },
    ]);
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
      members: [
        { id: '7', amount: '100', ourTurn: true },
        { id: '9', amount: '100', ourTurn: false },
      ],
    });

    const accepted = state.model.game.handState;

    expect(krunkStateCodec.decode(accepted)?.members[0]).toMatchObject({
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

    expect(decoded?.members[0]).toMatchObject({
      handler: 0n,

      myTurn: true,

      role: 'alice',
    });

    expect(() =>
      reduceSessionMachine(state, {
        type: 'hand-state-changed',

        gameType: 'krunk',

        state: {
          members: [
            {
              ...decoded!.members[0],
              handler: 1n,
              myTurn: false,
              secretWord: 'CRANE',
            },
            decoded!.members[1],
          ],
        },
      }),
    ).not.toThrow();
  });

  it('stores complete independent Krunk hand candidates without merging siblings', () => {
    let state = createSessionMachineState(createSessionModel());
    state = trackProposal(state, ['1', '2'], KRUNK_TERMS);
    state = send(state, {
      type: 'notification-accepted-group',
      members: [
        { id: '1', amount: '100', ourTurn: true },
        { id: '2', amount: '100', ourTurn: false },
      ],
    });
    const canonical = state.model.game.handState;
    const hand = krunkStateCodec.decode(canonical)!;

    state = send(state, {
      type: 'local-game-action-staged',
      gameType: 'krunk',
      id: '2',
      action: 'make_move',
      state: {
        ...hand,
        members: [hand.members[0], { ...hand.members[1], handler: 4n, myTurn: true }],
      },
    });
    state = send(state, {
      type: 'local-game-action-staged',
      gameType: 'krunk',
      id: '1',
      action: 'make_move',
      state: {
        ...hand,
        members: [
          { ...hand.members[0], handler: 1n, myTurn: false, secretWord: 'CRANE' },
          hand.members[1],
        ],
      },
    });

    expect(state.model.game.handState).toBe(canonical);
    const projected = state.model.game.pendingCandidates['1'].state as NonNullable<
      ReturnType<typeof krunkStateCodec.decode>
    >;
    expect(projected.members).toHaveLength(2);
    expect(projected.members[0].secretWord).toBe('CRANE');
    expect(projected.members[1].handler).toBe(3n);

    state = send(state, { type: 'local-action-applied', id: '1', action: 'make_move' });
    expect(krunkStateCodec.decode(state.model.game.handState)!.members[0].secretWord).toBe('CRANE');
    expect(krunkStateCodec.decode(state.model.game.handState)!.members[1].handler).toBe(3n);
    expect(Object.keys(state.model.game.pendingCandidates)).toEqual(['2']);
  });
});
