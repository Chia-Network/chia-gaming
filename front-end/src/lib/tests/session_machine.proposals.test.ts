import { resetProtocolIds, setProtocolIds } from '../gameIdentities';
import { createSessionModel } from '../session/model';
import { createSessionMachineState, reduceSessionMachine } from '../session/sessionMachine';
import { reduceSessionNotification } from '../session/sessionMachineNotifications';
import { CALPOKER_TERMS, KRUNK_TERMS, send } from './session_machine.harness';
import { TEST_PROTOCOL_IDS, testProtocolId } from './protocolIdentities';

describe('session machine behavior sequences', () => {
  it('fails fast when acceptance or balance failure has no normalized proposal group', () => {
    const state = createSessionMachineState(createSessionModel());

    expect(() =>
      reduceSessionMachine(state, {
        type: 'notification-accepted-group',
        members: [
          {
            id: 'missing',
            playerAContribution: 10n,
            playerBContribution: 10n,
            ourTurn: false,
          },
        ],
      }),
    ).toThrow('ProposalAcceptedGroup missing missing normalized proposal group');
    expect(() =>
      reduceSessionMachine(state, {
        type: 'notification-insufficient-balance',
        id: 'missing',
        notification: {
          id: 1n,
          kind: 'insufficient-bal',
          title: 'Notice',
          message: 'Insufficient balance',
        },
      }),
    ).toThrow('InsufficientBalance missing missing normalized proposal group');
  });

  it('emits notification-owned acceptance and balance facts without proposal metadata fallbacks', () => {
    const state = createSessionMachineState(createSessionModel());
    const events: unknown[] = [];
    const capture = (current: typeof state, event: Parameters<typeof reduceSessionMachine>[1]) => {
      events.push(event);
      return { state: current, effects: [] };
    };

    reduceSessionNotification(
      state,
      {
        ProposalAcceptedGroup: {
          members: [
            {
              id: '7',
              player_a_contribution: '10',
              player_b_contribution: '10',
              our_turn: true,
            },
          ],
        },
      },
      true,
      capture,
    );
    reduceSessionNotification(state, { InsufficientBalance: { id: '9' } }, false, capture);

    expect(events[0]).toEqual({
      type: 'notification-accepted-group',
      members: [
        {
          id: '7',
          playerAContribution: 10n,
          playerBContribution: 10n,
          ourTurn: true,
        },
      ],
    });
    expect(events[1]).toEqual({
      type: 'remove-game-notifications',
      kind: 'proposal-rejected',
    });
    expect(events[2]).toMatchObject({
      type: 'notification-insufficient-balance',
      id: '9',
    });
    expect(events[2]).not.toHaveProperty('groupIds');
  });

  it('tracks a grouped proposal through acceptance and insufficient-balance rollback', () => {
    let state = createSessionMachineState(createSessionModel());

    state = send(state, {
      type: 'upsert-proposal-group',
      group: {
        primaryId: '11',
        memberIds: ['11'],
        handProposal: CALPOKER_TERMS,
        origin: 'local',
        disposition: 'outgoing',
      },
    });

    expect(state.model.betweenHand.proposalGroups[0]).toMatchObject({
      primaryId: '11',
      memberIds: ['11'],
      disposition: 'outgoing',
    });

    state = send(state, {
      type: 'set-proposal-disposition',
      primaryId: '11',
      disposition: 'accepted',
    });

    state = send(state, {
      type: 'game',

      action: {
        type: 'accepted-group',

        groupIds: ['11'],

        members: [{ amount: '20', startTurn: 'my-turn' }],

        origin: 'local',

        gameType: 'calpoker',
      },
    });

    expect(state.model.game.activeIds).toEqual(['11']);

    expect(state.model.betweenHand.proposalGroups[0]?.disposition).toBe('accepted');

    state = send(state, {
      type: 'game',

      action: { type: 'remove-group', groupIds: ['11'] },
    });

    state = send(state, { type: 'clear-proposals', ids: ['11'] });

    state = send(state, { type: 'set-between-hand-mode', mode: 'compose-proposal' });

    expect(state.model.game).toMatchObject({
      activeIds: [],

      currentHandIds: [],

      currentHandOrigin: null,

      instances: {},
    });

    expect(state.model.betweenHand).toMatchObject({
      proposalGroups: [],

      mode: 'compose-proposal',
    });
  });

  it('retains Krunk group terms through one ordered group acceptance notification', () => {
    let state = createSessionMachineState(createSessionModel());

    state = send(state, {
      type: 'upsert-proposal-group',
      group: {
        primaryId: '1',
        memberIds: ['1', '2'],
        handProposal: KRUNK_TERMS,
        origin: 'local',
        disposition: 'outgoing',
      },
    });

    state = reduceSessionNotification(
      state,

      {
        ProposalAcceptedGroup: {
          members: [
            {
              id: '1',
              player_a_contribution: '100',
              player_b_contribution: '0',
              our_turn: false,
            },
            {
              id: '2',
              player_a_contribution: '0',
              player_b_contribution: '100',
              our_turn: true,
            },
          ],
        },
      },

      true,

      reduceSessionMachine,
    ).state;

    expect(state.model.betweenHand.proposalGroups[0]?.handProposal).toEqual(KRUNK_TERMS);

    expect(state.model.game.activeIds).toEqual(['1', '2']);

    const restored = createSessionMachineState(state.model);

    expect(restored.model.betweenHand.proposalGroups[0]).toMatchObject({
      memberIds: ['1', '2'],
      handProposal: KRUNK_TERMS,
      disposition: 'accepted',
    });
  });

  it('characterizes incoming proposal review and cancellation cleanup', () => {
    const proposal = {
      primaryId: '21',
      memberIds: ['21'],
      handProposal: CALPOKER_TERMS,
      origin: 'peer' as const,
      disposition: 'incoming-review' as const,
    };

    let state = createSessionMachineState(createSessionModel({ game: { handKey: 1 } }));

    state = send(state, {
      type: 'upsert-proposal-group',
      group: proposal,
    });

    state = send(state, {
      type: 'set-between-hand-mode',

      mode: 'review-incoming-proposal',
    });

    expect(state.model.betweenHand.proposalGroups).toEqual([proposal]);

    state = send(state, { type: 'clear-proposals', ids: ['21'] });

    state = send(state, { type: 'set-between-hand-mode', mode: 'compose-proposal' });

    expect(state.model.betweenHand.proposalGroups).toEqual([]);

    expect(state.model.betweenHand.mode).toBe('compose-proposal');
  });

  it('orders proposal controller commands without mutating presentation', () => {
    const state = createSessionMachineState(createSessionModel());

    expect(
      reduceSessionMachine(state, {
        type: 'request-propose-game',

        handProposal: CALPOKER_TERMS,
      }),
    ).toEqual({
      state,

      effects: [{ type: 'controller-propose-game', handProposal: CALPOKER_TERMS }],
    });

    expect(
      reduceSessionMachine(state, { type: 'request-accept-proposal', id: '7' }).effects,
    ).toEqual([{ type: 'controller-accept-proposal', id: '7' }]);

    expect(
      reduceSessionMachine(state, { type: 'request-cancel-proposal', id: '7' }).effects,
    ).toEqual([{ type: 'controller-cancel-proposal', id: '7' }]);
  });

  it('reviews a Space Poker proposal after Calpoker hands instead of going on-chain', () => {
    setProtocolIds(TEST_PROTOCOL_IDS);
    try {
      const terms = {
        gameType: 'spacepoker' as const,
        playerAContribution: 100n,
        playerBContribution: 100n,
        senderIsPlayerA: false,
        gameTimeout: 15n,
        parameters: 10n,
      };
      const state = createSessionMachineState(
        createSessionModel({
          game: { handKey: 1 },
          betweenHand: { mode: 'compose-proposal', lastHandProposal: CALPOKER_TERMS },
        }),
      );
      const unreadable = reduceSessionMachine(state, {
        type: 'wasm-notification',
        notification: {
          ProposalMade: {
            id: '9',
            group_ids: ['9'],
            player_a_contribution: '100',
            player_b_contribution: '100',
            sender_is_player_a: false,
            timeout: '15',
            game_type: testProtocolId('spacepoker'),
            parameters: [],
          },
        },
        iStarted: false,
      });
      expect(unreadable.effects.map((effect) => effect.type)).not.toContain(
        'controller-go-on-chain',
      );
      expect(unreadable.state.model.channel.queue[0]?.kind).toBe('action-failed');
      expect(unreadable.state.model.channel.queue[0]?.message).toBe(
        'The peer sent an invalid game proposal.',
      );

      const missingParameters = reduceSessionMachine(state, {
        type: 'wasm-notification',
        notification: {
          ProposalMade: {
            id: '9',
            group_ids: ['9'],
            player_a_contribution: '100',
            player_b_contribution: '100',
            sender_is_player_a: false,
            timeout: '15',
            game_type: testProtocolId('spacepoker'),
            parameters: undefined as never,
          },
        },
        iStarted: false,
      });
      expect(missingParameters.effects.map((effect) => effect.type)).not.toContain(
        'controller-go-on-chain',
      );
      expect(missingParameters.state.model.channel.queue[0]?.kind).toBe('action-failed');
      expect(missingParameters.state.model.channel.queue[0]?.message).toBe(
        'The peer sent an invalid game proposal.',
      );

      const readable = reduceSessionMachine(state, {
        type: 'wasm-notification',
        notification: {
          ProposalMade: {
            id: '9',
            group_ids: ['9'],
            player_a_contribution: '100',
            player_b_contribution: '100',
            sender_is_player_a: false,
            timeout: '15',
            game_type: testProtocolId('spacepoker'),
            parameters: terms.parameters,
          },
        },
        iStarted: false,
      });
      expect(readable.effects.map((effect) => effect.type)).not.toContain('controller-go-on-chain');
      expect(readable.state.model.betweenHand.mode).toBe('review-incoming-proposal');
      expect(readable.state.model.betweenHand.proposalGroups[0]?.handProposal).toEqual(terms);
    } finally {
      resetProtocolIds();
    }
  });
});
