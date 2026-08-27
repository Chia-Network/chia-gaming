import type { SessionController } from '../../hooks/SessionController';
import { createSessionModel, INITIAL_CHANNEL_STATUS_MODEL } from '../session/model';
import { createSessionMachineState } from '../session/sessionMachine';
import { runSessionMachineTransition } from '../session/sessionMachineEffects';
import { SessionMachineRuntime } from '../session/sessionMachineRuntime';
import { send } from './session_machine.harness';

describe('session machine behavior sequences', () => {
  it('queues dispatches requested during a React projection instead of re-entering it', () => {
    const controller = {
      clearDerivedGamePresentation: () => {},
    } as unknown as SessionController;

    const runtime = new SessionMachineRuntime(createSessionMachineState(createSessionModel()), {
      controller,

      iStarted: false,

      restoring: false,

      getRestoreStatus: () => 'idle',

      getRestoreError: () => null,

      onError: () => {},

      persist: async () => {},
    });

    let renderDepth = 0;

    let maxRenderDepth = 0;

    let renderCount = 0;

    runtime.setRender(() => {
      renderDepth += 1;

      maxRenderDepth = Math.max(maxRenderDepth, renderDepth);

      renderCount += 1;

      if (renderCount === 1) {
        runtime.dispatch({ type: 'set-same-terms-requested', requested: true });
      }

      renderDepth -= 1;
    });

    runtime.dispatch({ type: 'set-first-game-accepted', accepted: true });

    expect(maxRenderDepth).toBe(1);

    expect(renderCount).toBe(2);

    expect(runtime.getState().coordination).toMatchObject({
      firstGameAccepted: true,

      sameTermsRequested: true,
    });
  });

  it('publishes machine authority before commands and React', () => {
    const state = createSessionMachineState(createSessionModel());

    const order: string[] = [];

    runSessionMachineTransition(
      {
        state,

        effects: [{ type: 'controller-accept-proposal', id: '7' }],
      },

      {
        setAuthority: () => order.push('authority'),

        getAuthority: () => state,

        controller: {
          clearDerivedGamePresentation: () => order.push('controller-clear'),
        },

        runCommand: () => order.push('command'),

        render: () => order.push('react'),
      },
    );

    expect(order).toEqual(['authority', 'command', 'react']);
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

        origin: 'local',

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

    expect(state.model.game.instances['7'].presentation).toBe('on-chain-my-turn');

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
});
