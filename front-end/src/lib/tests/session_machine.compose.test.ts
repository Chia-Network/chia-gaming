import { calpokerStateCodec } from '@games/calpoker/ui/serialize';
import { applyHandProposalToComposeDraft } from '../session/composeDraft';
import {
  createSessionModel,
  INITIAL_GAME_TERMINAL_MODEL,
  sessionModelFromSave,
} from '../session/model';
import { createSessionMachineState } from '../session/sessionMachine';
import { CALPOKER_TERMS, send } from './session_machine.harness';
import { liveSave } from './session_save_envelope.fixtures';

describe('session machine behavior sequences', () => {
  it('keeps compose commands in one session-owned draft', () => {
    let state = createSessionMachineState(
      createSessionModel({
        betweenHand: {
          compose: applyHandProposalToComposeDraft(
            createSessionModel().betweenHand.compose,

            CALPOKER_TERMS,
          ),
        },
      }),
    );

    state = send(state, { type: 'select-compose-game', gameType: 'calpoker' });
    state = send(state, { type: 'update-selected-compose-draft', draft: { amount: 37n } });

    state = send(state, { type: 'select-compose-game', gameType: 'krunk' });
    state = send(state, { type: 'update-selected-compose-draft', draft: { amount: 900n } });

    state = send(state, { type: 'select-compose-game', gameType: 'spacepoker' });
    state = send(state, {
      type: 'update-selected-compose-draft',
      draft: { unitSize: 11n, stackSize: 17n },
    });

    state = send(state, { type: 'set-compose-timeout', timeout: 23n });

    state = send(state, { type: 'set-compose-proposal-sent', sent: true });

    expect(state.model.betweenHand.compose).toMatchObject({
      selectedGame: 'spacepoker',

      gameTimeout: 23n,

      proposalSent: true,

      drafts: {
        calpoker: { amount: 37n },
        krunk: { amount: 900n },
        spacepoker: { unitSize: 11n, stackSize: 17n },
      },
    });
  });

  it('uses the restored model directly as the machine projection', () => {
    const restored = sessionModelFromSave(
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

        activeGameIds: ['7'],

        currentHandGameIds: ['7'],
        currentHandOrigin: 'local',

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

        betweenHandLastHandProposal: {
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

        proposalGroups: [
          {
            primary_id: '11',
            member_ids: ['11'],
            origin: 'local',
            disposition: 'outgoing',
            hand_proposal: {
              my_contribution: '10',
              their_contribution: '10',
              game_timeout: '15',
              game_type: 'calpoker',
            },
          },
        ],
      }),
    );

    const state = createSessionMachineState(restored);

    expect(state.model).toBe(restored);

    expect(state.model.game.activeIds).toEqual(['7']);

    expect(state.model.betweenHand.proposalGroups[0]?.memberIds).toEqual(['11']);

    expect(state.model.game.currentHandOrigin).toBe('local');
  });
});
