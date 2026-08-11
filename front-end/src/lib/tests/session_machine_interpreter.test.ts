import { SessionController } from '../../hooks/SessionController';
import { expectConsoleError } from '../../../scripts/testSetup';
import type { ChiaGame, WasmResult } from '../../types/ChiaGaming';
import {
  createSessionModel,
  INITIAL_CHANNEL_STATUS_MODEL,
  INITIAL_GAME_TERMINAL_MODEL,
} from '../session/model';
import { createSessionMachineState, reduceSessionMachine } from '../session/sessionMachine';
import { SessionMachineInterpreter } from '../session/sessionMachineInterpreter';
import { SessionMachineRuntime } from '../session/sessionMachineRuntime';
import type { SessionMachineEvent } from '../session/sessionMachineTypes';
import { krunkStateCodec } from '../../features/krunk/stateCodec';

const TERMS = {
  gameType: 'calpoker' as const,
  myContribution: 10n,
  theirContribution: 10n,
  gameTimeout: 15n,
};
const KRUNK_TERMS = {
  gameType: 'krunk' as const,
  myContribution: 100n,
  theirContribution: 100n,
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
  it.each([
    { player: 'proposer', iStarted: true, weProposed: true, pickerId: '1' },
    { player: 'acceptor', iStarted: false, weProposed: false, pickerId: '2' },
  ])(
    'preserves current Krunk authority through unroll for the $player picker',
    ({ iStarted, weProposed, pickerId }) => {
      const runtime = new SessionMachineRuntime(createSessionMachineState(createSessionModel()), {
        controller: fakeController({
          setHandState: jest.fn(),
          clearDerivedGamePresentation: jest.fn(),
        }),
        iStarted,
        restoring: false,
        getRestoreStatus: () => 'idle',
        getRestoreError: () => null,
        emitGameplay: () => {},
        onError: (error) => {
          throw error;
        },
        persist: async () => {},
      });
      const ids = ['1', '2'];
      runtime.dispatch({
        type: 'notification-accepted-group',
        id: ids[0],
        groupIds: ids,
        amount: '100',
        terms: KRUNK_TERMS,
        weProposed,
        iStarted,
      });

      const assertPickerAuthority = () => {
        const game = runtime.getState().model.game;
        const hand = krunkStateCodec.decode(game.handState);
        expect(game.currentHandIds).toEqual(ids);
        expect(game.activeGameType).toBe('krunk');
        expect(game.handState?.gameType).toBe('krunk');
        expect(Object.keys(hand!.games)).toEqual(ids);
        expect(hand!.games[pickerId].role).toBe('alice');
        return hand!.games[pickerId];
      };
      const pickWord = () => {
        const picker = assertPickerAuthority();
        expect(
          runtime.transitionFeatureState('krunk', pickerId, {
            ...picker,
            handler: 1n,
            myTurn: false,
            secretWord: 'CRANE',
          }),
        ).toBe(true);
        expect(assertPickerAuthority().secretWord).toBe('CRANE');
      };

      assertPickerAuthority();
      runtime.dispatch({
        type: 'wasm-notification',
        iStarted,
        notification: { ChannelStatus: { state: 'GoingOnChain' } },
      });
      pickWord();
      runtime.dispatch({
        type: 'wasm-notification',
        iStarted,
        notification: { ChannelStatus: { state: 'Unrolling' } },
      });
      assertPickerAuthority();
      runtime.dispatch({
        type: 'wasm-notification',
        iStarted,
        notification: {
          GameStatus: { id: pickerId, status: 'on-chain-my-turn', coin_id: null },
        },
      });
      assertPickerAuthority();
    },
  );

  it('drops a retired feature callback while current malformed callbacks still fail fast', () => {
    const setHandState = jest.fn();
    const runtime = new SessionMachineRuntime(createSessionMachineState(createSessionModel()), {
      controller: fakeController({
        setHandState,
        clearDerivedGamePresentation: jest.fn(),
      }),
      iStarted: false,
      restoring: false,
      getRestoreStatus: () => 'idle',
      getRestoreError: () => null,
      emitGameplay: () => {},
      onError: (error) => {
        throw error;
      },
      persist: async () => {},
    });
    runtime.dispatch({
      type: 'notification-accepted-group',
      id: '1',
      groupIds: ['1', '2'],
      amount: '100',
      terms: KRUNK_TERMS,
      weProposed: true,
      iStarted: false,
    });
    runtime.dispatch({
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
    runtime.dispatch({
      type: 'notification-accepted-group',
      id: '7',
      groupIds: ['7'],
      amount: '20',
      terms: TERMS,
      weProposed: true,
      iStarted: false,
    });
    const authority = runtime.getState();
    const durableCommits = setHandState.mock.calls.length;

    expect(runtime.transitionFeatureState('calpoker', '2', { stale: true })).toBe(false);
    expect(runtime.transitionFeatureState('krunk', '7', { stale: true })).toBe(false);
    expect(runtime.getState()).toBe(authority);
    expect(setHandState).toHaveBeenCalledTimes(durableCommits);

    expect(() => runtime.transitionFeatureState('calpoker', '7', { malformed: true })).toThrow(
      'Internal feature-state payload is invalid for calpoker',
    );
    expect(runtime.getState()).toBe(authority);
  });

  it('persists each accepted deferred coin enrichment once and ignores stale generations', async () => {
    const pending: Array<(coinHex: string | null) => void> = [];
    const persisted: ReturnType<typeof createSessionMachineState>[] = [];
    const controller = fakeController({
      setHandState: jest.fn(),
      clearDerivedGamePresentation: jest.fn(),
    });
    const runtime = new SessionMachineRuntime(
      createSessionMachineState(
        createSessionModel({
          channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'Active' } },
          game: {
            handKey: 1,
            activeIds: ['7'],
            currentHandIds: ['7'],
            lastDisplayedId: '7',
            activeGameType: 'calpoker',
            instances: {
              '7': {
                id: '7',
                amount: '20',
                coinHex: null,
                presentation: 'off-chain-my-turn',
                terminal: INITIAL_GAME_TERMINAL_MODEL,
              },
            },
            handState: {
              gameType: 'calpoker',
              version: 1n,
              state: {
                playerHand: [],
                opponentHand: [],
                cardSelections: [],
                moveNumber: 0n,
                isPlayerTurn: true,
              },
            },
          },
          betweenHand: { lastTerms: TERMS },
        }),
      ),
      {
        controller,
        iStarted: true,
        restoring: false,
        getRestoreStatus: () => 'idle',
        getRestoreError: () => null,
        emitGameplay: () => {},
        onError: (error) => {
          throw error;
        },
        enrichCoin: () =>
          new Promise<string | null>((resolve) => {
            pending.push(resolve);
          }),
        persist: async () => {
          persisted.push(structuredClone(runtime.getState()));
        },
      },
    );

    runtime.dispatch({
      type: 'wasm-notification',
      iStarted: true,
      notification: { ChannelStatus: { state: 'Active', coin: new Uint8Array([1]) } },
    });
    runtime.dispatch({
      type: 'wasm-notification',
      iStarted: true,
      notification: { ChannelStatus: { state: 'Active', coin: new Uint8Array([2]) } },
    });
    persisted.length = 0;

    pending[0]('stale-channel');
    await Promise.resolve();
    expect(persisted).toHaveLength(0);
    expect(runtime.getState().model.channel.status.coinHex).toBeNull();

    pending[1]('channel-coin');
    await Promise.resolve();
    expect(persisted).toHaveLength(1);
    expect(persisted[0].model.channel.status.coinHex).toBe('channel-coin');

    runtime.dispatch({
      type: 'wasm-notification',
      iStarted: true,
      notification: {
        GameStatus: { id: '7', status: 'my-turn', coin_id: new Uint8Array([3]) },
      },
    });
    persisted.length = 0;
    pending[2]('game-coin');
    await Promise.resolve();
    expect(persisted).toHaveLength(1);
    expect(persisted[0].model.game.instances['7'].coinHex).toBe('game-coin');

    runtime.dispatch({
      type: 'wasm-notification',
      iStarted: true,
      notification: {
        GameSettled: {
          id: '7',
          outcome: 'settled_cleanly',
          our_share: '20',
          coin_id: new Uint8Array([4]),
        },
      },
    });
    persisted.length = 0;
    pending[3]('reward-coin');
    await Promise.resolve();
    expect(persisted).toHaveLength(1);
    expect(persisted[0].model.game.instances['7'].terminal.rewardCoinHex).toBe('reward-coin');
  });

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
    expect(transition.effects.map((effect) => effect.type)).toEqual(['controller-propose-game']);
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

describe('session machine controller command failures', () => {
  function runtimeHarness(overrides: Partial<SessionController>) {
    const controller = fakeController(overrides);
    const initial = createSessionMachineState(
      createSessionModel({
        channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'Active' } },
      }),
    );
    const persisted: ReturnType<typeof createSessionMachineState>[] = [];
    const rendered: ReturnType<typeof createSessionMachineState>[] = [];
    const runtime = new SessionMachineRuntime(initial, {
      controller,
      iStarted: true,
      restoring: false,
      getRestoreStatus: () => 'idle',
      getRestoreError: () => null,
      emitGameplay: () => {},
      onError: (error) => {
        throw error;
      },
      persist: async () => {
        persisted.push(runtime.getState());
      },
    });
    runtime.setRender((state) => rendered.push(state));
    return { controller, initial, persisted, rendered, runtime };
  }

  it('keeps a thrown proposal retryable without confirming or persisting proposalSent', () => {
    const proposeGame = jest.fn(() => {
      throw new Error('wallet refused proposal');
    });
    const { persisted, rendered, runtime } = runtimeHarness({ proposeGame });

    runtime.dispatch({ type: 'submit-compose', terms: TERMS });
    expect(runtime.getState().model.betweenHand.compose.proposalSent).toBe(false);
    expect(runtime.getState().model.channel.queue.at(-1)).toMatchObject({
      kind: 'action-failed',
      message: expect.stringContaining('wallet refused proposal'),
    });
    expect(rendered.at(-1)).toBe(runtime.getState());
    expect(persisted).toHaveLength(1);
    expect(persisted[0].model.betweenHand.compose.proposalSent).toBe(false);

    runtime.dispatch({ type: 'submit-compose', terms: TERMS });
    expect(proposeGame).toHaveBeenCalledTimes(2);
  });

  it('keeps review retryable when the actual controller receives actionSucceeded=false', async () => {
    expectConsoleError('proposal no longer exists');
    const controller = new SessionController(null, 'actual-false-result', 100n, 100n, {
      sendMessage: () => true,
      sendAck: () => true,
      sendKeepalive: () => true,
      hostLog: () => {},
      close: () => {},
    });
    controller.setGameSession({
      pendingTerminalHandoff: () => null,
      snapshot_watched_coins: () => [],
      drain_submissions: () => [],
      accept_proposal: () =>
        ({
          actionSucceeded: false,
          events: [
            {
              Notification: {
                ActionFailed: { id: '7', reason: 'proposal no longer exists' },
              },
            },
          ],
        }) as WasmResult,
    } as unknown as ChiaGame);
    const initial = createSessionMachineState(
      createSessionModel({
        channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'Active' } },
        betweenHand: {
          mode: 'review-incoming-proposal',
          reviewPeerProposal: { id: '7', groupIds: ['7'], terms: TERMS },
        },
      }),
    );
    const persisted: ReturnType<typeof createSessionMachineState>[] = [];
    const runtime = new SessionMachineRuntime(initial, {
      controller,
      iStarted: true,
      restoring: false,
      getRestoreStatus: () => 'idle',
      getRestoreError: () => null,
      emitGameplay: () => {},
      onError: (error) => {
        throw error;
      },
      persist: async () => persisted.push(runtime.getState()),
    });

    runtime.dispatch({ type: 'accept-review' });

    expect(runtime.getState().model.betweenHand.mode).toBe('review-incoming-proposal');
    expect(runtime.getState().model.betweenHand.reviewPeerProposal?.id).toBe('7');
    expect(runtime.getState().model.channel.queue.at(-1)).toMatchObject({
      kind: 'action-failed',
      message: expect.stringContaining('proposal no longer exists'),
    });
    expect(persisted).toHaveLength(1);
    expect(persisted[0].model.betweenHand.mode).toBe('review-incoming-proposal');
    await controller.flushPendingWork();
    expect(persisted).toHaveLength(1);
    controller.cleanupAfterTerminalFlush();
  });

  it('confirms and persists a successful proposal exactly once', () => {
    const { persisted, rendered, runtime } = runtimeHarness({
      proposeGame: jest.fn(() => ['7']),
    });

    runtime.dispatch({ type: 'submit-compose', terms: TERMS });

    expect(runtime.getState().model.betweenHand.compose.proposalSent).toBe(true);
    expect(runtime.getState().model.betweenHand.outgoingProposalIds).toEqual(['7']);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toBe(runtime.getState());
    expect(rendered.at(-1)).toBe(runtime.getState());
  });

  it.each([
    [
      'accept',
      {
        acceptProposal: () => {
          throw new Error('accept failed');
        },
      },
      { type: 'accept-review' } as const,
    ],
    [
      'cancel',
      {
        cancel_proposal: () => {
          throw new Error('cancel failed');
        },
      },
      { type: 'reject-review' } as const,
    ],
  ])('keeps review state retryable when %s throws', (_name, override, event) => {
    const { persisted, rendered, runtime } = runtimeHarness(override);
    const review = { id: '7', groupIds: ['7'], terms: TERMS };
    runtime.dispatch({ type: 'set-review-proposal', proposal: review });
    runtime.dispatch({ type: 'set-between-hand-mode', mode: 'review-incoming-proposal' });
    persisted.length = 0;
    rendered.length = 0;

    runtime.dispatch(event);

    expect(runtime.getState().model.betweenHand.reviewPeerProposal).toEqual(review);
    expect(runtime.getState().model.betweenHand.mode).toBe('review-incoming-proposal');
    expect(runtime.getState().model.channel.queue.at(-1)).toMatchObject({
      kind: 'action-failed',
      message: expect.stringContaining('failed'),
    });
    expect(persisted).toHaveLength(1);
    expect(rendered.at(-1)).toBe(runtime.getState());
  });

  it.each([
    ['accept', { acceptProposal: jest.fn() }, { type: 'accept-review' } as const, 'decision'],
    [
      'cancel',
      { cancel_proposal: jest.fn() },
      { type: 'reject-review' } as const,
      'compose-proposal',
    ],
  ])('persists successful %s confirmation exactly once', (_name, override, event, mode) => {
    const { persisted, rendered, runtime } = runtimeHarness(override);
    runtime.dispatch({
      type: 'set-review-proposal',
      proposal: { id: '7', groupIds: ['7'], terms: TERMS },
    });
    runtime.dispatch({ type: 'set-between-hand-mode', mode: 'review-incoming-proposal' });
    persisted.length = 0;
    rendered.length = 0;

    runtime.dispatch(event);

    expect(runtime.getState().model.betweenHand.mode).toBe(mode);
    if (event.type === 'reject-review') {
      expect(runtime.getState().model.betweenHand.reviewPeerProposal).toBeNull();
    }
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toBe(runtime.getState());
    expect(rendered.at(-1)).toBe(runtime.getState());
  });

  it('queues an actionable error and renders authority when go-on-chain throws', () => {
    const { persisted, rendered, runtime } = runtimeHarness({
      goOnChain: () => {
        throw new Error('chain failed');
      },
    });

    runtime.dispatch({ type: 'go-on-chain' });

    expect(runtime.getState().coordination.hostOnChain).toBe(false);
    expect(runtime.getState().model.channel.queue.at(-1)).toMatchObject({
      kind: 'action-failed',
      message: expect.stringContaining('chain failed'),
    });
    expect(persisted).toHaveLength(1);
    expect(rendered.at(-1)).toBe(runtime.getState());
  });

  it('does not confirm clean shutdown on throw and persists success exactly once', () => {
    const failed = runtimeHarness({
      cleanShutdown: () => {
        throw new Error('shutdown failed');
      },
    });
    failed.runtime.dispatch({ type: 'start-clean-shutdown' });
    expect(failed.runtime.getState().model.channel.cleanShutdownStarted).toBe(false);
    expect(failed.persisted).toHaveLength(1);
    expect(failed.persisted[0].model.channel.cleanShutdownStarted).toBe(false);
    expect(failed.rendered.at(-1)).toBe(failed.runtime.getState());

    const succeeded = runtimeHarness({ cleanShutdown: jest.fn() });
    succeeded.runtime.dispatch({ type: 'start-clean-shutdown' });
    expect(succeeded.runtime.getState().model.channel.cleanShutdownStarted).toBe(true);
    expect(succeeded.persisted).toHaveLength(1);
    expect(succeeded.persisted[0].model.channel.cleanShutdownStarted).toBe(true);
    expect(succeeded.rendered.at(-1)).toBe(succeeded.runtime.getState());
  });
});
