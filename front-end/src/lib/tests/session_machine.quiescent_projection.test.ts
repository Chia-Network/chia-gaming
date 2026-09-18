import { Program } from 'clvm-lib';
import type { SessionController } from '../../hooks/SessionController';
import { createSessionModel, INITIAL_CHANNEL_STATUS_MODEL } from '../session/model';
import { createSessionMachineState } from '../session/sessionMachine';
import { SessionMachineRuntime } from '../session/sessionMachineRuntime';

const proposal = {
  id: '7',
  handProposal: {
    gameType: 'calpoker' as const,
    senderIsPlayerA: false,
    gameTimeout: 15n,
    parameters: 10n,
  },
  origin: 'peer' as const,
  status: 'incoming-review' as const,
};

function controller(acceptProposal: (id: string) => void): SessionController {
  return {
    acceptProposal,
    clearDerivedGamePresentation: jest.fn(),
  } as unknown as SessionController;
}

function initialState() {
  return createSessionMachineState(
    createSessionModel({
      channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'Active' } },
      betweenHand: {
        mode: 'review-incoming-proposal',
        pendingProposals: [proposal],
      },
    }),
  );
}

describe('SessionMachineRuntime quiescent projection', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('coalesces reentrant local-potato acceptance into one accepted render', () => {
    const runtime = new SessionMachineRuntime(initialState(), {
      controller: controller(() => {
        runtime.dispatch({
          type: 'wasm-notification',
          iStarted: false,
          notification: {
            ProposalAcceptedGroup: {
              id: 7n,
              members: [
                {
                  id: 101n,
                  player_a_contribution: '10',
                  player_b_contribution: '10',
                  our_turn: true,
                  readable_parameters: Program.fromBigInt(10n).serialize(),
                },
              ],
            },
          },
        });
      }),
      iStarted: false,
      restoring: false,
      getRestoreStatus: () => 'idle',
      getRestoreError: () => null,
      onError: (error) => {
        throw error;
      },
      persist: async () => {},
    });
    const rendered: ReturnType<typeof initialState>[] = [];
    runtime.setRender((state) => rendered.push(state));

    runtime.dispatch({ type: 'accept-review', id: '7' });
    expect(rendered).toEqual([]);
    jest.runOnlyPendingTimers();

    expect(rendered).toHaveLength(1);
    expect(rendered[0].model.betweenHand.pendingProposals).toEqual([]);
    expect(rendered[0].model.game.activeIds).toEqual(['101']);
  });

  it('renders accepting when acceptance remains genuinely queued', () => {
    const runtime = new SessionMachineRuntime(initialState(), {
      controller: controller(jest.fn()),
      iStarted: false,
      restoring: false,
      getRestoreStatus: () => 'idle',
      getRestoreError: () => null,
      onError: (error) => {
        throw error;
      },
      persist: async () => {},
    });
    const rendered: ReturnType<typeof initialState>[] = [];
    runtime.setRender((state) => rendered.push(state));

    runtime.dispatch({ type: 'accept-review', id: '7' });
    jest.runOnlyPendingTimers();

    expect(rendered).toHaveLength(1);
    expect(rendered[0].model.betweenHand.pendingProposals[0]?.status).toBe('accepting');
    expect(rendered[0].model.game.activeIds).toEqual([]);
  });

  it('cancels a scheduled projection during teardown', () => {
    const runtime = new SessionMachineRuntime(initialState(), {
      controller: controller(jest.fn()),
      iStarted: false,
      restoring: false,
      getRestoreStatus: () => 'idle',
      getRestoreError: () => null,
      onError: (error) => {
        throw error;
      },
      persist: async () => {},
    });
    const render = jest.fn();
    runtime.setRender(render);
    runtime.dispatch({ type: 'accept-review', id: '7' });
    runtime.clearRender();
    jest.runOnlyPendingTimers();
    expect(render).not.toHaveBeenCalled();
  });
});
