import type { SessionController } from '../../hooks/SessionController';
import { createSessionModel, INITIAL_CHANNEL_STATUS_MODEL } from '../session/model';
import { createSessionMachineState, reduceSessionMachine } from '../session/sessionMachine';
import { SessionMachineInterpreter } from '../session/sessionMachineInterpreter';
import type { SessionMachineEvent } from '../session/sessionMachineTypes';

const TERMS = {
  gameType: 'calpoker' as const,
  myContribution: 10n,
  theirContribution: 10n,
  gameTimeout: 15n,
};

function fakeController(overrides: Partial<SessionController> = {}): SessionController {
  return {
    isOffChainActive: () => true,
    proposeGame: () => ['7'],
    acceptProposal: jest.fn(),
    cancel_proposal: jest.fn(),
    cleanShutdown: jest.fn(),
    goOnChain: () => true,
    ...overrides,
  } as unknown as SessionController;
}

describe('session machine effect interpreter', () => {
  it('preserves controller command order and feeds proposal results back to authority', () => {
    const order: string[] = [];
    const events: SessionMachineEvent[] = [];
    const controller = fakeController({
      proposeGame: () => {
        order.push('controller');
        return ['7', '9'];
      },
    });
    const state = createSessionMachineState(
      createSessionModel({
        channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'Active' } },
      }),
    );
    const interpreter = new SessionMachineInterpreter({
      controller,
      iStarted: true,
      getState: () => state,
      dispatch: (event) => {
        order.push('dispatch');
        events.push(event);
      },
      persist: async () => {
        order.push('persist');
      },
      emitGameplay: () => order.push('gameplay'),
      onError: (error) => {
        throw error;
      },
    });

    interpreter.run({ type: 'persist-session' });
    interpreter.run({ type: 'controller-propose-game', terms: TERMS });

    expect(order).toEqual(['persist', 'controller', 'dispatch']);
    expect(events).toEqual([{ type: 'proposal-sent', ids: ['7', '9'], terms: TERMS }]);
  });

  it('cancels and replaces the rejection timer', () => {
    const callbacks = new Map<number, () => void>();
    const cleared: number[] = [];
    const events: SessionMachineEvent[] = [];
    let timerId = 0;
    const interpreter = new SessionMachineInterpreter({
      controller: fakeController(),
      iStarted: true,
      getState: () => createSessionMachineState(createSessionModel()),
      dispatch: (event) => events.push(event),
      persist: async () => {},
      emitGameplay: () => {},
      onError: (error) => {
        throw error;
      },
      setTimer: ((callback: () => void) => {
        const id = ++timerId;
        callbacks.set(id, callback);
        return id;
      }) as typeof setTimeout,
      clearTimer: ((id: number) => {
        cleared.push(id);
        callbacks.delete(id);
      }) as typeof clearTimeout,
    });

    interpreter.run({
      type: 'timer-schedule',
      key: 'rejection-fallback',
      generation: 1,
      delayMs: 300,
    });
    interpreter.run({
      type: 'timer-schedule',
      key: 'rejection-fallback',
      generation: 2,
      delayMs: 300,
    });
    callbacks.get(2)?.();

    expect(cleared).toEqual([1]);
    expect(events).toEqual([{ type: 'rejection-fallback-fired', generation: 2 }]);
  });
});

describe('session machine causal sequences', () => {
  it('ignores stale async enrichment generations', () => {
    let state = createSessionMachineState(
      createSessionModel({
        channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'Active' } },
      }),
    );
    state = {
      ...state,
      coordination: { ...state.coordination, channelEnrichmentGeneration: 2 },
    };
    const stale = reduceSessionMachine(state, {
      type: 'coin-enrichment-completed',
      target: 'channel',
      id: 'Active',
      generation: 1,
      coinHex: 'stale',
      channelState: 'Active',
    });
    expect(stale.state).toBe(state);
    const current = reduceSessionMachine(state, {
      type: 'coin-enrichment-completed',
      target: 'channel',
      id: 'Active',
      generation: 2,
      coinHex: 'current',
      channelState: 'Active',
    });
    expect(current.state.model.channel.status.coinHex).toBe('current');
  });

  it('does not persist from host projection or rendering', () => {
    const state = createSessionMachineState(createSessionModel());
    const transition = reduceSessionMachine(state, {
      type: 'host-projection',
      restore: { restoring: false, status: 'idle', error: null, hubReconciled: false },
      wasmNotificationHistory: ['notification'],
      diagnosticLog: ['line'],
      lastOutcomeWin: undefined,
    });
    expect(transition.effects).toEqual([]);
    expect(transition.state.model.history.wasmNotificationHistory).toEqual(['notification']);
  });

  it('runs choose, rejection, counterproposal, review, and acceptance as typed events', () => {
    let state = createSessionMachineState(
      createSessionModel({
        channel: {
          status: {
            ...INITIAL_CHANNEL_STATUS_MODEL,
            state: 'Active',
            ourBalance: '100',
            theirBalance: '100',
          },
        },
        game: { handKey: 1 },
        betweenHand: { lastTerms: TERMS },
      }),
      { firstGameAccepted: true },
    );
    let transition = reduceSessionMachine(state, { type: 'choose-same-terms' });
    state = transition.state;
    expect(transition.effects.map((effect) => effect.type)).toEqual([
      'persist-session',
      'controller-propose-game',
    ]);
    state = reduceSessionMachine(state, {
      type: 'proposal-sent',
      ids: ['7'],
      terms: TERMS,
    }).state;
    transition = reduceSessionMachine(state, {
      type: 'wasm-notification',
      iStarted: true,
      notification: { ProposalCancelled: { id: '7', reason: 'CancelledByPeer' } },
    });
    state = transition.state;
    expect(state.coordination.expectingCounterProposal).toBe(true);
    expect(transition.effects.some((effect) => effect.type === 'timer-schedule')).toBe(true);
  });
});
