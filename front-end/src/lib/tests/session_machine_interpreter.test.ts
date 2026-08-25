import { SessionController } from '../../hooks/SessionController';
import { runLocalGameActionWithReporting } from '../../hooks/useGameSession';
import { expectConsoleError } from '../../../scripts/testSetup';
import type { ChiaGame } from '../../types/ChiaGaming';
import { wasClientErrorReported } from '../clientError';
import { resetProtocolIds, setProtocolIds } from '../gameIdentities';
import { TEST_PROTOCOL_IDS } from './protocolIdentities';
import {
  createSessionModel,
  INITIAL_CHANNEL_STATUS_MODEL,
  INITIAL_GAME_TERMINAL_MODEL,
} from '../session/model';
import { createSessionMachineState, reduceSessionMachine } from '../session/sessionMachine';
import { SessionMachineInterpreter } from '../session/sessionMachineInterpreter';
import { SessionMachineRuntime } from '../session/sessionMachineRuntime';
import type { SessionMachineEvent } from '../session/sessionMachineTypes';
import { krunkStateCodec } from '@games/krunk/ui/serialize';
import { calpokerStateCodec } from '@games/calpoker/ui/serialize';
import { spacepokerStateCodec } from '@games/spacepoker/ui/serialize';
import { createRegisteredGameHand, snapshotRegisteredGameHand } from '../gameRegistry';
import { wasmResult } from './message_protocol.harness';

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
const SPACEPOKER_TERMS = {
  gameType: 'spacepoker' as const,
  myContribution: 100n,
  theirContribution: 100n,
  gameTimeout: 15n,
  unitSizeMojos: 10n,
};

function stateWithProposals(
  groups: Array<{
    memberIds: string[];
    handProposal: typeof TERMS | typeof KRUNK_TERMS | typeof SPACEPOKER_TERMS;
    origin?: 'local' | 'peer';
  }>,
) {
  return createSessionMachineState(
    createSessionModel({
      betweenHand: {
        proposalGroups: groups.map(({ memberIds, handProposal, origin = 'local' }) => ({
          primaryId: memberIds[0],
          memberIds,
          handProposal,
          origin,
          disposition: origin === 'local' ? ('outgoing' as const) : ('incoming-cached' as const),
        })),
      },
    }),
  );
}

function fakeController(overrides: Partial<SessionController> = {}): SessionController {
  return {
    isOffChainActive: () => true,
    proposeGame: () => ['7'],
    acceptProposal: jest.fn(),
    cancel_proposal: jest.fn(),
    cleanShutdown: jest.fn(),
    goOnChain: () => true,
    makeMove: jest.fn(),
    acceptSettlement: jest.fn(),
    cheat: jest.fn(),
    ...overrides,
  } as unknown as SessionController;
}

beforeEach(() => {
  setProtocolIds(TEST_PROTOCOL_IDS);
});
afterEach(() => {
  resetProtocolIds();
});

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
      onError: (error) => {
        throw error;
      },
    });

    interpreter.run({ type: 'persist-session' });
    interpreter.run({ type: 'controller-propose-game', handProposal: TERMS });

    expect(order).toEqual(['persist', 'controller', 'dispatch']);
    expect(events).toEqual([{ type: 'proposal-sent', ids: ['7', '9'], handProposal: TERMS }]);
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

describe('live game action error reporting', () => {
  it('reports an unhandled runtime invariant once and rethrows it', () => {
    const invariant = new Error('Internal local action for game 2 attempted outside our turn');
    const reports: Array<{ gameId: string; action: string; message: string }> = [];
    const request = {
      gameType: 'spacepoker' as const,
      id: '2',
      state: { handler: 'betting' },
      command: { type: 'make-move' as const, readable: null },
    };
    const run = () => {
      throw invariant;
    };

    expect(() =>
      runLocalGameActionWithReporting(request, run, (failure) => reports.push(failure)),
    ).toThrow(invariant);
    expect(reports).toEqual([
      {
        gameId: '2',
        action: 'make-move',
        message: invariant.message,
      },
    ]);
    expect(wasClientErrorReported(invariant)).toBe(true);

    expect(() =>
      runLocalGameActionWithReporting(request, run, (failure) => reports.push(failure)),
    ).toThrow(invariant);
    expect(reports).toHaveLength(1);
  });
});

describe('session machine causal sequences', () => {
  it.each([
    { player: 'proposer', iStarted: true, weProposed: true, pickerId: '1' },
    { player: 'acceptor', iStarted: false, weProposed: false, pickerId: '2' },
  ])(
    'preserves current Krunk authority through unroll for the $player picker',
    ({ iStarted, weProposed, pickerId }) => {
      const runtime = new SessionMachineRuntime(
        stateWithProposals([
          {
            memberIds: ['1', '2'],
            handProposal: KRUNK_TERMS,
            origin: weProposed ? 'local' : 'peer',
          },
        ]),
        {
          controller: fakeController({ clearDerivedGamePresentation: jest.fn() }),
          iStarted,
          restoring: false,
          getRestoreStatus: () => 'idle',
          getRestoreError: () => null,
          onError: (error) => {
            throw error;
          },
          persist: async () => {},
        },
      );
      const ids = ['1', '2'];
      runtime.dispatch({
        type: 'notification-accepted-group',
        id: ids[0],
        amount: '100',
        iStarted,
        isMyTurn: pickerId === ids[0],
      });

      const assertPickerAuthority = () => {
        const game = runtime.getState().model.game;
        const hand = krunkStateCodec.decode(game.handState);
        expect(game.currentHandIds).toEqual(ids);
        expect(game.activeGameType).toBe('krunk');
        expect(game.handState?.gameType).toBe('krunk');
        expect(Object.keys(hand!.games)).toEqual(ids);
        expect(hand!.games[pickerId].role).toBe('alice');
        return hand!;
      };
      const pickWord = () => {
        const hand = assertPickerAuthority();
        const picker = hand.games[pickerId];
        expect(
          runtime.replaceHandState('krunk', pickerId, {
            games: {
              ...hand.games,
              [pickerId]: {
                ...picker,
                handler: 1n,
                myTurn: false,
                secretWord: 'CRANE',
              },
            },
          }),
        ).toBe(true);
        expect(assertPickerAuthority().games[pickerId].secretWord).toBe('CRANE');
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

  it('drops retired replacements while current replacement state remains opaque', () => {
    const runtime = new SessionMachineRuntime(
      stateWithProposals([
        { memberIds: ['1', '2'], handProposal: KRUNK_TERMS },
        { memberIds: ['7'], handProposal: TERMS },
      ]),
      {
        controller: fakeController({ clearDerivedGamePresentation: jest.fn() }),
        iStarted: false,
        restoring: false,
        getRestoreStatus: () => 'idle',
        getRestoreError: () => null,
        onError: (error) => {
          throw error;
        },
        persist: async () => {},
      },
    );
    runtime.dispatch({
      type: 'notification-accepted-group',
      id: '1',
      amount: '100',
      iStarted: false,
      isMyTurn: true,
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
      amount: '20',
      iStarted: false,
      isMyTurn: true,
    });
    const authority = runtime.getState();

    expect(runtime.replaceHandState('calpoker', '2', { stale: true })).toBe(false);
    expect(runtime.replaceHandState('krunk', '7', { stale: true })).toBe(false);
    expect(runtime.getState()).toBe(authority);

    expect(runtime.replaceHandState('calpoker', '7', { malformed: true })).toBe(true);
    expect(runtime.getState().model.game.handState).toEqual({
      gameType: 'calpoker',
      state: { malformed: true },
    });
  });

  it('persists each accepted deferred coin enrichment once and ignores stale generations', async () => {
    const pending: Array<(coinHex: string | null) => void> = [];
    const persisted: ReturnType<typeof createSessionMachineState>[] = [];
    const controller = fakeController({ clearDerivedGamePresentation: jest.fn() });
    const hand = createRegisteredGameHand('calpoker', {
      gameIds: ['7'],
      iStarted: true,
      origin: 'local',
      handProposal: TERMS,
    });
    const handState = snapshotRegisteredGameHand('calpoker', hand);
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
            handState,
          },
          betweenHand: { lastHandProposal: TERMS },
        }),
      ),
      {
        controller,
        iStarted: true,
        restoring: false,
        getRestoreStatus: () => 'idle',
        getRestoreError: () => null,
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

  it('opens compose when there are no lastHandProposal to replay', () => {
    const state = createSessionMachineState(createSessionModel());
    const transition = reduceSessionMachine(state, { type: 'choose-same-terms' });
    expect(transition.state.model.betweenHand.mode).toBe('compose-proposal');
    expect(transition.state.model.betweenHand.lastHandProposal).toBeNull();
    expect(transition.effects).toEqual([{ type: 'persist-session' }]);
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
        betweenHand: { lastHandProposal: TERMS },
      }),
      { firstGameAccepted: true },
    );
    let transition = reduceSessionMachine(state, { type: 'choose-same-terms' });
    state = transition.state;
    expect(transition.effects.map((effect) => effect.type)).toEqual(['controller-propose-game']);
    state = reduceSessionMachine(state, {
      type: 'proposal-sent',
      ids: ['7'],
      handProposal: TERMS,
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

    runtime.dispatch({ type: 'submit-compose', handProposal: TERMS });
    expect(runtime.getState().model.betweenHand.compose.proposalSent).toBe(false);
    expect(runtime.getState().model.channel.queue.at(-1)).toMatchObject({
      kind: 'action-failed',
      message: expect.stringContaining('wallet refused proposal'),
    });
    expect(rendered.at(-1)).toBe(runtime.getState());
    expect(persisted).toHaveLength(1);
    expect(persisted[0].model.betweenHand.compose.proposalSent).toBe(false);

    runtime.dispatch({ type: 'submit-compose', handProposal: TERMS });
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
        wasmResult({
          actionSucceeded: false,
          events: [
            {
              Notification: {
                ActionFailed: { id: 7n, reason: 'proposal no longer exists' },
              },
            },
          ],
        }),
    } as unknown as ChiaGame);
    const initial = createSessionMachineState(
      createSessionModel({
        channel: { status: { ...INITIAL_CHANNEL_STATUS_MODEL, state: 'Active' } },
        betweenHand: {
          mode: 'review-incoming-proposal',
          proposalGroups: [
            {
              primaryId: '7',
              memberIds: ['7'],
              handProposal: TERMS,
              origin: 'peer',
              disposition: 'incoming-review',
            },
          ],
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
      onError: (error) => {
        throw error;
      },
      persist: async () => persisted.push(runtime.getState()),
    });

    runtime.dispatch({ type: 'accept-review' });

    expect(runtime.getState().model.betweenHand.mode).toBe('review-incoming-proposal');
    expect(runtime.getState().model.betweenHand.proposalGroups[0]?.primaryId).toBe('7');
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

    runtime.dispatch({ type: 'submit-compose', handProposal: TERMS });

    expect(runtime.getState().model.betweenHand.compose.proposalSent).toBe(true);
    expect(runtime.getState().model.betweenHand.proposalGroups).toEqual([
      {
        primaryId: '7',
        memberIds: ['7'],
        handProposal: TERMS,
        origin: 'local',
        disposition: 'outgoing',
      },
    ]);
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
    const review = {
      primaryId: '7',
      memberIds: ['7'],
      handProposal: TERMS,
      origin: 'peer' as const,
      disposition: 'incoming-review' as const,
    };
    runtime.dispatch({ type: 'upsert-proposal-group', group: review });
    runtime.dispatch({ type: 'set-between-hand-mode', mode: 'review-incoming-proposal' });
    persisted.length = 0;
    rendered.length = 0;

    runtime.dispatch(event);

    expect(runtime.getState().model.betweenHand.proposalGroups).toContainEqual(review);
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
      type: 'upsert-proposal-group',
      group: {
        primaryId: '7',
        memberIds: ['7'],
        handProposal: TERMS,
        origin: 'peer',
        disposition: 'incoming-review',
      },
    });
    runtime.dispatch({ type: 'set-between-hand-mode', mode: 'review-incoming-proposal' });
    persisted.length = 0;
    rendered.length = 0;

    runtime.dispatch(event);

    expect(runtime.getState().model.betweenHand.mode).toBe(mode);
    if (event.type === 'reject-review') {
      expect(runtime.getState().model.betweenHand.proposalGroups).toEqual([]);
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

describe('session machine local game action boundary', () => {
  function localActionHarness(
    makeMove: SessionController['makeMove'],
    overrides: Partial<SessionController> = {},
  ) {
    const controller = fakeController({ makeMove, ...overrides });
    const initial = stateWithProposals([{ memberIds: ['7'], handProposal: TERMS }]);
    const persisted: ReturnType<typeof createSessionMachineState>[] = [];
    const rendered: ReturnType<typeof createSessionMachineState>[] = [];
    const runtime = new SessionMachineRuntime(initial, {
      controller,
      iStarted: false,
      restoring: false,
      getRestoreStatus: () => 'idle',
      getRestoreError: () => null,
      onError: (error) => {
        throw error;
      },
      persist: async () => persisted.push(runtime.getState()),
    });
    runtime.setRender((state) => rendered.push(state));
    runtime.dispatch({
      type: 'notification-accepted-group',
      id: '7',
      amount: '20',
      iStarted: false,
      isMyTurn: true,
    });
    persisted.length = 0;
    rendered.length = 0;
    return { runtime, persisted, rendered };
  }

  it('uses ordered Rust authority for opposite-turn Krunk members before the first move', () => {
    const makeMove = jest.fn(() => 'queued' as const);
    const runtime = new SessionMachineRuntime(
      stateWithProposals([{ memberIds: ['2', '4'], handProposal: KRUNK_TERMS, origin: 'local' }]),
      {
        controller: fakeController({ makeMove }),
        iStarted: true,
        restoring: false,
        getRestoreStatus: () => 'idle',
        getRestoreError: () => null,
        onError: (error) => {
          throw error;
        },
        persist: async () => {},
      },
    );

    runtime.dispatch({
      type: 'wasm-notification',
      iStarted: true,
      notification: { ProposalAccepted: { id: '2', amount: '100', our_turn: true } },
    });
    runtime.dispatch({
      type: 'wasm-notification',
      iStarted: true,
      notification: { ProposalAccepted: { id: '4', amount: '100', our_turn: false } },
    });

    const hand = krunkStateCodec.decode(runtime.getState().model.game.handState)!;
    expect(hand.games['2']).toMatchObject({ role: 'alice', myTurn: true });
    expect(hand.games['4']).toMatchObject({ role: 'bob', myTurn: false });
    expect(runtime.getState().model.game.instances['2'].presentation).toBe('off-chain-my-turn');
    expect(runtime.getState().model.game.instances['4'].presentation).toBe('off-chain-their-turn');

    expect(() =>
      runtime.commitLocalGameAction({
        gameType: 'krunk',
        id: '2',
        state: {
          ...hand.games['2'],
          handler: 1n,
          myTurn: false,
          secretWord: 'CRANE',
        },
        command: { type: 'make-move', readable: null },
      }),
    ).not.toThrow();
    expect(makeMove).toHaveBeenCalledWith('2', null);
  });

  it('uses Rust acceptance authority for the first Space Poker action', () => {
    const makeMove = jest.fn(() => 'queued' as const);
    const runtime = new SessionMachineRuntime(
      stateWithProposals([{ memberIds: ['7'], handProposal: SPACEPOKER_TERMS, origin: 'local' }]),
      {
        controller: fakeController({ makeMove }),
        iStarted: true,
        restoring: false,
        getRestoreStatus: () => 'idle',
        getRestoreError: () => null,
        onError: (error) => {
          throw error;
        },
        persist: async () => {},
      },
    );

    runtime.dispatch({
      type: 'wasm-notification',
      iStarted: true,
      notification: { ProposalAccepted: { id: '7', amount: '200', our_turn: true } },
    });

    const hand = spacepokerStateCodec.decode(runtime.getState().model.game.handState)!;
    expect(hand.gameState.myTurn).toBe(false);
    expect(runtime.getState().model.game.instances['7'].presentation).toBe('off-chain-my-turn');

    expect(() =>
      runtime.commitLocalGameAction({
        gameType: 'spacepoker',
        id: '7',
        state: { ...hand, gameState: { ...hand.gameState, myTurn: false } },
        command: { type: 'make-move', readable: null },
      }),
    ).not.toThrow();
    expect(makeMove).toHaveBeenCalledWith('7', null);
  });

  it('leaves feature state, history, turn, and saves unchanged when Rust rejects synchronously', () => {
    const makeMove = jest.fn(() => {
      throw new Error('make move failed: rejected');
    });
    const { runtime, persisted, rendered } = localActionHarness(makeMove);
    const before = runtime.getState();
    const current = calpokerStateCodec.decode(before.model.game.handState)!;

    expect(() =>
      runtime.commitLocalGameAction({
        gameType: 'calpoker',
        id: '7',
        state: { ...current, moveNumber: 1n, isPlayerTurn: false },
        command: { type: 'make-move', readable: null },
      }),
    ).toThrow('rejected');

    expect(makeMove).toHaveBeenCalledTimes(1);
    expect(runtime.getState()).toBe(before);
    expect(runtime.getState().model.game.instances['7'].presentation).toBe('off-chain-my-turn');
    expect(persisted).toHaveLength(0);
    expect(rendered).toHaveLength(0);
  });

  it('stages after command success, projects optimistically, and promotes on applied', () => {
    const makeMove = jest.fn(() => 'queued' as const);
    const { runtime, persisted, rendered } = localActionHarness(makeMove);
    const current = calpokerStateCodec.decode(runtime.getState().model.game.handState)!;
    const canonical = runtime.getState().model.game.handState;

    runtime.commitLocalGameAction({
      gameType: 'calpoker',
      id: '7',
      state: { ...current, moveNumber: 1n, isPlayerTurn: false },
      command: { type: 'make-move', readable: null },
    });

    expect(makeMove).toHaveBeenCalledTimes(1);
    expect(rendered).toHaveLength(1);
    expect(rendered[0].model.game.handState).toBe(canonical);
    expect(rendered[0].model.game.pendingCandidates['7']).toMatchObject({
      id: '7',
      action: 'make_move',
    });
    expect(runtime.getGameHand()?.getState()).toMatchObject({
      moveNumber: 1n,
      isPlayerTurn: false,
    });
    expect(rendered[0].model.game.instances['7'].presentation).toBe('off-chain-my-turn');
    expect(persisted).toHaveLength(1);

    runtime.dispatch({
      type: 'wasm-notification',
      iStarted: false,
      notification: { LocalActionApplied: { id: 7n, action: 'make_move' } },
    });
    expect(calpokerStateCodec.decode(runtime.getState().model.game.handState)).toMatchObject({
      moveNumber: 1n,
      isPlayerTurn: false,
    });
    expect(runtime.getState().model.game.pendingCandidates).toEqual({});
    expect(runtime.getState().model.game.instances['7'].presentation).toBe('off-chain-their-turn');
    expect(persisted).toHaveLength(2);
  });

  it('commits an immediately applied candidate without entering pending state or save', () => {
    const makeMove = jest.fn(() => 'applied' as const);
    const { runtime, persisted, rendered } = localActionHarness(makeMove);
    const current = calpokerStateCodec.decode(runtime.getState().model.game.handState)!;

    runtime.commitLocalGameAction({
      gameType: 'calpoker',
      id: '7',
      state: { ...current, moveNumber: 1n, isPlayerTurn: false },
      command: { type: 'make-move', readable: null },
    });

    expect(runtime.getState().model.game.pendingCandidates).toEqual({});
    expect(calpokerStateCodec.decode(runtime.getState().model.game.handState)).toMatchObject({
      moveNumber: 1n,
      isPlayerTurn: false,
    });
    expect(runtime.getState().model.game.instances['7'].presentation).toBe('off-chain-their-turn');
    expect(rendered).toHaveLength(1);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].model.game.pendingCandidates).toEqual({});

    const applied = runtime.getState();
    runtime.dispatch({
      type: 'wasm-notification',
      iStarted: false,
      notification: { LocalActionApplied: { id: 7n, action: 'make_move' } },
    });
    expect(runtime.getState()).toBe(applied);
    expect(persisted).toHaveLength(1);
  });

  it('denies duplicate pending actions and reduces delayed rejection on canonical state', () => {
    const { runtime, persisted } = localActionHarness(jest.fn(() => 'queued' as const));
    const current = calpokerStateCodec.decode(runtime.getState().model.game.handState)!;
    const request = {
      gameType: 'calpoker' as const,
      id: '7',
      state: { ...current, moveNumber: 1n, isPlayerTurn: false },
      command: { type: 'make-move' as const, readable: null },
    };
    runtime.commitLocalGameAction(request);
    expect(() => runtime.commitLocalGameAction(request)).toThrow('already has a pending candidate');

    runtime.dispatch({
      type: 'wasm-notification',
      iStarted: false,
      notification: {
        MoveRejected: { id: 7n, tag: 'invalid', message: 'Try another move' },
      },
    });
    expect(runtime.getState().model.game.pendingCandidates).toEqual({});
    expect(runtime.getState().model.game.handState).toEqual(calpokerStateCodec.encode(current));
    expect(runtime.getGameHand()?.getState()).toEqual(current);
    expect(persisted).toHaveLength(2);
    expect(persisted[1].model.game.pendingCandidates).toEqual({});
    expect(persisted[1].model.game.handState).toEqual(runtime.getState().model.game.handState);
  });

  it('discards a matching delayed cheat failure while retaining shared error UX', () => {
    const { runtime } = localActionHarness(
      jest.fn(() => 'queued' as const),
      {
        cheat: jest.fn(() => 'queued'),
      },
    );
    const current = calpokerStateCodec.decode(runtime.getState().model.game.handState)!;
    runtime.commitLocalGameAction({
      gameType: 'calpoker',
      id: '7',
      state: { ...current, moveNumber: 1n, isPlayerTurn: false },
      command: { type: 'cheat', moverShare: 0n },
    });

    runtime.dispatch({
      type: 'wasm-notification',
      iStarted: false,
      notification: {
        ActionFailed: { id: 7n, action: 'cheat', reason: 'queued cheat became stale' },
      },
    });
    expect(runtime.getState().model.game.pendingCandidates).toEqual({});
    expect(runtime.getGameHand()?.getState()).toEqual(current);
    expect(runtime.getState().model.channel.queue.at(-1)).toMatchObject({
      kind: 'action-failed',
      message: 'queued cheat became stale',
    });
  });

  it('clears pending candidates when a hand is replaced or abandoned', () => {
    const runtime = new SessionMachineRuntime(
      stateWithProposals([
        { memberIds: ['7'], handProposal: TERMS },
        { memberIds: ['9'], handProposal: TERMS, origin: 'peer' },
      ]),
      {
        controller: fakeController({
          makeMove: () => 'queued',
          clearDerivedGamePresentation: jest.fn(),
        }),
        iStarted: false,
        restoring: false,
        getRestoreStatus: () => 'idle',
        getRestoreError: () => null,
        onError: (error) => {
          throw error;
        },
        persist: async () => {},
      },
    );
    runtime.dispatch({
      type: 'notification-accepted-group',
      id: '7',
      amount: '20',
      iStarted: false,
      isMyTurn: true,
    });
    const current = calpokerStateCodec.decode(runtime.getState().model.game.handState)!;
    runtime.commitLocalGameAction({
      gameType: 'calpoker',
      id: '7',
      state: { ...current, moveNumber: 1n, isPlayerTurn: false },
      command: { type: 'make-move', readable: null },
    });
    runtime.dispatch({
      type: 'notification-accepted-group',
      id: '9',
      amount: '20',
      iStarted: false,
      isMyTurn: true,
    });
    expect(runtime.getState().model.game.pendingCandidates).toEqual({});

    const replacement = calpokerStateCodec.decode(runtime.getState().model.game.handState)!;
    runtime.commitLocalGameAction({
      gameType: 'calpoker',
      id: '9',
      state: { ...replacement, moveNumber: 1n, isPlayerTurn: false },
      command: { type: 'make-move', readable: null },
    });
    runtime.dispatch({ type: 'notification-abandoned' });
    expect(runtime.getState().model.game.pendingCandidates).toEqual({});
  });

  it('ignores an unmatched applied signal and fails fast on a mismatched pending action', () => {
    const { runtime } = localActionHarness(jest.fn(() => 'queued' as const));
    const before = runtime.getState();
    runtime.dispatch({
      type: 'wasm-notification',
      iStarted: false,
      notification: { LocalActionApplied: { id: 7n, action: 'make_move' } },
    });
    expect(runtime.getState()).toBe(before);

    const current = calpokerStateCodec.decode(runtime.getState().model.game.handState)!;
    runtime.commitLocalGameAction({
      gameType: 'calpoker',
      id: '7',
      state: { ...current, moveNumber: 1n, isPlayerTurn: false },
      command: { type: 'make-move', readable: null },
    });
    expect(() =>
      runtime.dispatch({
        type: 'wasm-notification',
        iStarted: false,
        notification: { LocalActionApplied: { id: 7n, action: 'accept_settlement' } },
      }),
    ).toThrow('does not match pending');
  });

  it.each([
    ['wrong type', { gameType: 'spacepoker' as const, id: '7' }, 'gameType'],
    ['wrong id', { gameType: 'calpoker' as const, id: '9' }, 'game id'],
  ])('fails fast for an internal %s local action', (_label, identity, message) => {
    const makeMove = jest.fn();
    const { runtime } = localActionHarness(makeMove);
    const current = calpokerStateCodec.decode(runtime.getState().model.game.handState)!;

    expect(() =>
      runtime.commitLocalGameAction({
        ...identity,
        state: { ...current, moveNumber: 1n, isPlayerTurn: false },
        command: { type: 'make-move', readable: null },
      }),
    ).toThrow(message);
    expect(makeMove).not.toHaveBeenCalled();
  });
});
