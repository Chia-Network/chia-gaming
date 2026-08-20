import { Program } from 'clvm-lib';
import { encodeGameProposalParameters } from '../gameRegistry';
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
        id: 'missing',
        amount: '20',
        iStarted: false,
        isMyTurn: false,
      }),
    ).toThrow('ProposalAccepted missing missing normalized proposal group');
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
      { ProposalAccepted: { id: '7', amount: '20', our_turn: true } },
      true,
      capture,
    );
    reduceSessionNotification(state, { InsufficientBalance: { id: '9' } }, false, capture);

    expect(events[0]).toEqual({
      type: 'notification-accepted-group',
      id: '7',
      amount: '20',
      iStarted: true,
      isMyTurn: true,
    });
    expect(events[1]).toMatchObject({
      type: 'notification-insufficient-balance',
      id: '9',
    });
    expect(events[1]).not.toHaveProperty('groupIds');
  });

  it('tracks a grouped proposal through acceptance and insufficient-balance rollback', () => {
    let state = createSessionMachineState(createSessionModel());

    state = send(state, {
      type: 'upsert-proposal-group',
      group: {
        primaryId: '11',
        memberIds: ['11'],
        terms: CALPOKER_TERMS,
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

        acceptedId: '11',

        amount: '20',

        startTurn: 'my-turn',

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

  it('retains Krunk group terms through each member acceptance notification', () => {
    let state = createSessionMachineState(createSessionModel());

    state = send(state, {
      type: 'upsert-proposal-group',
      group: {
        primaryId: '1',
        memberIds: ['1', '2'],
        terms: KRUNK_TERMS,
        origin: 'local',
        disposition: 'outgoing',
      },
    });

    state = reduceSessionNotification(
      state,

      { ProposalAccepted: { id: '1', amount: '200', our_turn: false } },

      true,

      reduceSessionMachine,
    ).state;

    expect(state.model.betweenHand.proposalGroups[0]?.terms).toEqual(KRUNK_TERMS);

    expect(() => {
      state = reduceSessionNotification(
        state,

        { ProposalAccepted: { id: '2', amount: '200', our_turn: true } },

        true,

        reduceSessionMachine,
      ).state;
    }).not.toThrow();

    expect(state.model.game.activeIds).toEqual(['1', '2']);

    const restored = createSessionMachineState(state.model);

    expect(restored.model.betweenHand.proposalGroups[0]).toMatchObject({
      memberIds: ['1', '2'],
      terms: KRUNK_TERMS,
      disposition: 'accepted',
    });
  });

  it('characterizes incoming proposal review and cancellation cleanup', () => {
    const proposal = {
      primaryId: '21',
      memberIds: ['21'],
      terms: CALPOKER_TERMS,
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

  it('reviews a Space Poker proposal after Calpoker hands instead of going on-chain', () => {
    setProtocolIds(TEST_PROTOCOL_IDS);
    try {
      const terms = {
        gameType: 'spacepoker' as const,
        myContribution: 100n,
        theirContribution: 100n,
        gameTimeout: 15n,
        unitSizeMojos: 10n,
      };
      const state = createSessionMachineState(
        createSessionModel({
          game: { handKey: 1 },
          betweenHand: { mode: 'compose-proposal', lastTerms: CALPOKER_TERMS },
        }),
      );
      const unreadable = reduceSessionMachine(state, {
        type: 'wasm-notification',
        notification: {
          ProposalMade: {
            id: '9',
            group_ids: ['9'],
            my_contribution: '100',
            their_contribution: '100',
            timeout: '15',
            game_type: testProtocolId('spacepoker'),
            parameters: Program.fromList([]).serialize(),
          },
        },
        iStarted: false,
      });
      expect(unreadable.effects.map((effect) => effect.type)).toContain('controller-go-on-chain');

      const readable = reduceSessionMachine(state, {
        type: 'wasm-notification',
        notification: {
          ProposalMade: {
            id: '9',
            group_ids: ['9'],
            my_contribution: '100',
            their_contribution: '100',
            timeout: '15',
            game_type: testProtocolId('spacepoker'),
            parameters: encodeGameProposalParameters(terms, true).serialize(),
          },
        },
        iStarted: false,
      });
      expect(readable.effects.map((effect) => effect.type)).not.toContain('controller-go-on-chain');
      expect(readable.state.model.betweenHand.mode).toBe('review-incoming-proposal');
      expect(readable.state.model.betweenHand.proposalGroups[0]?.terms).toEqual(terms);
    } finally {
      resetProtocolIds();
    }
  });
});
