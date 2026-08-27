import { Program } from 'clvm-lib';
import { SessionController } from '../../hooks/SessionController';
import { runWithRuntimeErrorReporting } from '../../hooks/useGameSession';
import { expectConsoleError } from '../../../scripts/testSetup';
import type { ChiaGame } from '../../types/ChiaGaming';
import { wasClientErrorReported } from '../clientError';
import { resetProtocolIds, setProtocolIds } from '../gameIdentities';
import { TEST_PROTOCOL_IDS, testProtocolId } from './protocolIdentities';
import {
  createSessionModel,
  INITIAL_CHANNEL_STATUS_MODEL,
  INITIAL_GAME_TERMINAL_MODEL,
} from '../session/model';
import { createSessionMachineState, reduceSessionMachine } from '../session/sessionMachine';
import { SessionMachineInterpreter } from '../session/sessionMachineInterpreter';
import { SessionMachineRuntime } from '../session/sessionMachineRuntime';
import type { SessionMachineEvent } from '../session/sessionMachineTypes';
import { KrunkHandler, krunkStateCodec, type KrunkHand } from '@games/krunk/ui/serialize';
import {
  calpokerStateCodec,
  type CalpokerHand,
  type CalpokerHandState,
} from '@games/calpoker/ui/serialize';
import { spacepokerStateCodec, type SpacepokerHand } from '@games/spacepoker/ui/serialize';
import { createRegisteredGameHand, snapshotRegisteredGameHand } from '../gameRegistry';
import { wasmResult } from './message_protocol.harness';

const TERMS = {
  gameType: 'calpoker' as const,
  playerAContribution: 10n,
  playerBContribution: 10n,
  senderIsPlayerA: false,
  gameTimeout: 15n,
  parameters: null,
};
const KRUNK_TERMS = {
  gameType: 'krunk' as const,
  playerAContribution: 100n,
  playerBContribution: 100n,
  senderIsPlayerA: true,
  gameTimeout: 15n,
  parameters: null,
};
const SPACEPOKER_TERMS = {
  gameType: 'spacepoker' as const,
  playerAContribution: 100n,
  playerBContribution: 100n,
  senderIsPlayerA: false,
  gameTimeout: 15n,
  parameters: 10n,
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
});

describe('live game action error reporting', () => {
  it('reports an unhandled runtime invariant once and rethrows it', () => {
    const invariant = new Error('Internal local action for game 2 attempted outside our turn');
    const reports: string[] = [];
    const run = () => {
      throw invariant;
    };

    expect(() => runWithRuntimeErrorReporting(run, (message) => reports.push(message))).toThrow(
      invariant,
    );
    expect(reports).toEqual([invariant.message]);
    expect(wasClientErrorReported(invariant)).toBe(true);

    expect(() => runWithRuntimeErrorReporting(run, (message) => reports.push(message))).toThrow(
      invariant,
    );
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
        members: ids.map((id, index) => ({
          id,
          playerAContribution: index === 0 ? 100n : 0n,
          playerBContribution: index === 0 ? 0n : 100n,
          ourTurn: id === pickerId,
        })),
      });

      const assertPickerAuthority = () => {
        const game = runtime.getState().model.game;
        const hand = krunkStateCodec.decode(game.handState);
        expect(game.currentHandIds).toEqual(ids);
        expect(game.activeGameType).toBe('krunk');
        expect(game.handState?.gameType).toBe('krunk');
        expect(hand!.members).toHaveLength(2);
        expect(hand!.members[ids.indexOf(pickerId)].role).toBe('alice');
        return hand!;
      };
      const pickWord = () => {
        const hand = assertPickerAuthority();
        const pickerIndex = ids.indexOf(pickerId);
        const picker = hand.members[pickerIndex];
        (runtime.getGameHand() as KrunkHand).updateGame(pickerIndex, () => ({
          ...picker,
          handler: 1n,
          myTurn: false,
          secretWord: 'CRANE',
        }));
        runtime.commitHandStateChanged('krunk');
        expect(assertPickerAuthority().members[pickerIndex].secretWord).toBe('CRANE');
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

  it('rejects stale hand notifications after a replacement hand starts', () => {
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
      members: [
        { id: '1', playerAContribution: 100n, playerBContribution: 0n, ourTurn: true },
        { id: '2', playerAContribution: 0n, playerBContribution: 100n, ourTurn: false },
      ],
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
      members: [{ id: '7', playerAContribution: 10n, playerBContribution: 10n, ourTurn: true }],
    });
    const authority = runtime.getState();
    expect(() => runtime.commitHandStateChanged('krunk')).toThrow('gameType');
    expect(runtime.getState()).toBe(authority);
  });

  it('persists each accepted deferred coin enrichment once and ignores stale generations', async () => {
    const pending: Array<(coinHex: string | null) => void> = [];
    const persisted: ReturnType<typeof createSessionMachineState>[] = [];
    const controller = fakeController({ clearDerivedGamePresentation: jest.fn() });
    const hand = createRegisteredGameHand('calpoker', {
      parameters: TERMS.parameters,
      members: [{ playerAContribution: 10n, playerBContribution: 10n, ourTurn: true }],
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

  function sameTermsProposalState() {
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
        game: { handKey: 1, currentHandOrigin: 'local' },
        betweenHand: { lastHandProposal: TERMS },
      }),
      { firstGameAccepted: true },
    );
    const transition = reduceSessionMachine(state, { type: 'choose-same-terms' });
    state = transition.state;
    expect(transition.effects.map((effect) => effect.type)).toEqual(['controller-propose-game']);
    state = reduceSessionMachine(state, {
      type: 'proposal-sent',
      ids: ['7'],
      handProposal: TERMS,
    }).state;
    return state;
  }

  function matchingIncomingProposal() {
    return {
      ProposalMade: {
        id: '9',
        group_ids: ['9'],
        player_a_contribution: '10',
        player_b_contribution: '10',
        sender_is_player_a: true,
        timeout: '15',
        game_type: testProtocolId('calpoker'),
        parameters: null,
      },
    };
  }

  it('returns a rejected same-terms proposal immediately to seeded compose without timers', () => {
    const transition = reduceSessionMachine(sameTermsProposalState(), {
      type: 'wasm-notification',
      iStarted: true,
      notification: { ProposalCancelled: { id: '7', reason: 'CancelledByPeer' } },
    });
    expect(transition.state.model.betweenHand).toMatchObject({
      mode: 'compose-proposal',
      newHandRequested: false,
      compose: {
        selectedGame: TERMS.gameType,
        gameTimeout: TERMS.gameTimeout,
        proposalSent: false,
      },
    });
    expect(transition.state.coordination.sameTermsRequested).toBe(false);
    expect(transition.effects.map((effect) => effect.type)).toEqual(['persist-session']);
  });

  it('reviews a crossed incoming proposal that arrives after immediate fallback', () => {
    let state = reduceSessionMachine(sameTermsProposalState(), {
      type: 'wasm-notification',
      iStarted: true,
      notification: { ProposalCancelled: { id: '7', reason: 'CancelledByPeer' } },
    }).state;
    state = reduceSessionMachine(state, {
      type: 'wasm-notification',
      iStarted: true,
      notification: matchingIncomingProposal(),
    }).state;

    expect(state.model.betweenHand.mode).toBe('review-incoming-proposal');
    expect(state.model.betweenHand.proposalGroups).toEqual([
      expect.objectContaining({ primaryId: '9', disposition: 'incoming-review' }),
    ]);
  });

  it('keeps the direct same-terms short circuit for a normally arriving match', () => {
    const transition = reduceSessionMachine(sameTermsProposalState(), {
      type: 'wasm-notification',
      iStarted: true,
      notification: matchingIncomingProposal(),
    });

    expect(transition.state.model.betweenHand.mode).toBe('decision');
    expect(transition.effects).toContainEqual({
      type: 'controller-accept-proposal',
      id: '9',
    });
  });

  it('clears every stale rejection notice after proposal acceptance', () => {
    const base = stateWithProposals([{ memberIds: ['7'], handProposal: TERMS }]);
    const state = {
      ...base,
      model: {
        ...base.model,
        game: {
          ...base.model.game,
          queue: [
            { id: 1n, kind: 'proposal-rejected' as const, title: 'Notice', message: 'Rejected' },
            { id: 2n, kind: 'action-failed' as const, title: 'Error', message: 'Keep me' },
            {
              id: 3n,
              kind: 'proposal-rejected' as const,
              title: 'Notice',
              message: 'Also rejected',
            },
          ],
        },
      },
    };
    const transition = reduceSessionMachine(state, {
      type: 'wasm-notification',
      iStarted: true,
      notification: {
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
    });

    expect(transition.state.model.game.queue).toEqual([
      expect.objectContaining({ id: 2n, kind: 'action-failed' }),
    ]);
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
      members: [{ id: '7', playerAContribution: 10n, playerBContribution: 10n, ourTurn: true }],
    });
    persisted.length = 0;
    rendered.length = 0;
    return { runtime, persisted, rendered };
  }

  function updateCalpoker(
    runtime: SessionMachineRuntime,
    reducer: (state: CalpokerHandState) => CalpokerHandState,
  ): void {
    (runtime.getGameHand() as CalpokerHand).update(reducer);
  }

  function stagedKrunkRuntime(
    makeMove: SessionController['makeMove'] = () => 'queued',
  ): SessionMachineRuntime {
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
      type: 'notification-accepted-group',
      members: [
        { id: '2', playerAContribution: 100n, playerBContribution: 0n, ourTurn: true },
        { id: '4', playerAContribution: 0n, playerBContribution: 100n, ourTurn: false },
      ],
    });
    (runtime.getGameHand() as KrunkHand).updateGame(0, (game) => ({
      ...game,
      handler: KrunkHandler.AliceWaiting,
      myTurn: false,
      secretWord: 'CRANE',
    }));
    runtime.commitLocalGameAction({
      gameType: 'krunk',
      id: '2',
      command: { type: 'make-move', readable: null },
    });
    return runtime;
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
      notification: {
        ProposalAcceptedGroup: {
          members: [
            {
              id: '2',
              player_a_contribution: '100',
              player_b_contribution: '0',
              our_turn: true,
            },
            {
              id: '4',
              player_a_contribution: '0',
              player_b_contribution: '100',
              our_turn: false,
            },
          ],
        },
      },
    });

    const hand = krunkStateCodec.decode(runtime.getState().model.game.handState)!;
    expect(hand.members[0]).toMatchObject({ role: 'alice', myTurn: true });
    expect(hand.members[1]).toMatchObject({ role: 'bob', myTurn: false });
    expect(runtime.getState().model.game.instances['2'].presentation).toBe('off-chain-my-turn');
    expect(runtime.getState().model.game.instances['4'].presentation).toBe('off-chain-their-turn');

    (runtime.getGameHand() as KrunkHand).updateGame(0, (game) => ({
      ...game,
      handler: 1n,
      myTurn: false,
      secretWord: 'CRANE',
    }));
    expect(() =>
      runtime.commitLocalGameAction({
        gameType: 'krunk',
        id: '2',
        command: { type: 'make-move', readable: null },
      }),
    ).not.toThrow();
    expect(makeMove).toHaveBeenCalledWith('2', null);
  });

  it('preserves an accepted Krunk member while updating its sibling', () => {
    const runtime = stagedKrunkRuntime();

    runtime.dispatch({
      type: 'wasm-notification',
      iStarted: true,
      notification: {
        GameStatus: {
          id: '4',
          status: 'my-turn',
          coin_id: null,
          other_params: {
            readable: Program.fromBytes(new Uint8Array()).serialize(),
            mover_share: '100',
          },
        },
      },
    });

    const game = runtime.getState().model.game;
    const canonical = krunkStateCodec.decode(game.handState)!;
    expect(canonical.members[0].secretWord).toBe('CRANE');
    expect(canonical.members[1].handler).toBe(4n);
    expect(runtime.getGameHand()!.getState()).toEqual(canonical);
  });

  it('preserves an accepted Krunk member while its sibling settles', () => {
    const runtime = stagedKrunkRuntime();

    runtime.dispatch({
      type: 'wasm-notification',
      iStarted: true,
      notification: {
        GameSettled: {
          id: 4n,
          outcome: 'opponent_timed_out',
          our_share: '100',
          coin_id: null,
        },
      },
    });

    const game = runtime.getState().model.game;
    const canonical = krunkStateCodec.decode(game.handState)!;
    expect(game.activeIds).toEqual(['2']);
    expect(game.instances['4'].presentation).toBe('ended');
    expect(canonical.members[0].secretWord).toBe('CRANE');
    expect(canonical.members[1]).toMatchObject({
      handler: KrunkHandler.Terminal,
      settlementOutcome: 'opponent_timed_out',
    });
    expect(runtime.getGameHand()!.getState()).toEqual(canonical);
  });

  it('restores the whole Krunk checkpoint on immediate sibling rejection', () => {
    const makeMove = jest
      .fn<ReturnType<SessionController['makeMove']>, Parameters<SessionController['makeMove']>>()
      .mockReturnValueOnce('queued')
      .mockReturnValueOnce('rejected');
    const runtime = stagedKrunkRuntime(makeMove);
    runtime.dispatch({
      type: 'wasm-notification',
      iStarted: true,
      notification: {
        GameStatus: {
          id: '4',
          status: 'my-turn',
          coin_id: null,
          other_params: {
            readable: Program.fromBytes(new Uint8Array()).serialize(),
            mover_share: '100',
          },
        },
      },
    });
    const checkpoint = krunkStateCodec.decode(runtime.getState().model.game.handState)!;
    (runtime.getGameHand() as KrunkHand).updateGame(1, (game) => ({
      ...game,
      handler: KrunkHandler.BobWaiting,
      myTurn: false,
    }));
    runtime.commitLocalGameAction({
      gameType: 'krunk',
      id: '4',
      command: { type: 'make-move', readable: null },
    });

    expect(krunkStateCodec.decode(runtime.getState().model.game.handState)).toEqual(checkpoint);
    expect(runtime.getGameHand()!.getState()).toEqual(checkpoint);
    expect(checkpoint.members[0].secretWord).toBe('CRANE');
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
      notification: {
        ProposalAcceptedGroup: {
          members: [
            {
              id: '7',
              player_a_contribution: '100',
              player_b_contribution: '100',
              our_turn: true,
            },
          ],
        },
      },
    });

    const hand = spacepokerStateCodec.decode(runtime.getState().model.game.handState)!;
    expect(hand.gameState.myTurn).toBe(true);
    expect(runtime.getState().model.game.instances['7'].presentation).toBe('off-chain-my-turn');

    (runtime.getGameHand() as SpacepokerHand).update((state) => ({
      ...state,
      gameState: { ...state.gameState, myTurn: false },
    }));
    expect(() =>
      runtime.commitLocalGameAction({
        gameType: 'spacepoker',
        id: '7',
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

    updateCalpoker(runtime, (state) => ({ ...state, moveNumber: 1n, isPlayerTurn: false }));
    expect(() =>
      runtime.commitLocalGameAction({
        gameType: 'calpoker',
        id: '7',
        command: { type: 'make-move', readable: null },
      }),
    ).toThrow('rejected');

    expect(makeMove).toHaveBeenCalledTimes(1);
    expect(runtime.getState()).toBe(before);
    expect(runtime.getState().model.game.instances['7'].presentation).toBe('off-chain-my-turn');
    expect(persisted).toHaveLength(0);
    expect(rendered).toHaveLength(1);
    expect(rendered[0]).not.toBe(before);
    expect(runtime.getGameHand()?.getState()).toEqual(current);
  });

  it('rolls back an immediate tagged rejection without persisting rejected state', () => {
    const makeMove = jest.fn(() => 'rejected' as const);
    const { runtime, persisted } = localActionHarness(makeMove);
    const canonical = runtime.getState().model.game.handState;
    const checkpoint = calpokerStateCodec.decode(canonical)!;

    updateCalpoker(runtime, (state) => ({ ...state, moveNumber: 1n, isPlayerTurn: false }));
    runtime.commitLocalGameAction({
      gameType: 'calpoker',
      id: '7',
      command: { type: 'make-move', readable: null },
    });

    expect(runtime.getState().model.game.handState).toBe(canonical);
    expect(runtime.getGameHand()?.getState()).toEqual(checkpoint);
    expect(persisted).toHaveLength(0);
  });

  it('commits queued success as canonical and persists it immediately', () => {
    const makeMove = jest.fn(() => 'queued' as const);
    const { runtime, persisted, rendered } = localActionHarness(makeMove);

    updateCalpoker(runtime, (state) => ({ ...state, moveNumber: 1n, isPlayerTurn: false }));
    runtime.commitLocalGameAction({
      gameType: 'calpoker',
      id: '7',
      command: { type: 'make-move', readable: null },
    });

    expect(makeMove).toHaveBeenCalledTimes(1);
    expect(rendered).toHaveLength(1);
    expect(calpokerStateCodec.decode(rendered[0].model.game.handState)).toMatchObject({
      moveNumber: 1n,
      isPlayerTurn: false,
    });
    expect(rendered[0].model.game.instances['7'].presentation).toBe('off-chain-my-turn');
    expect(persisted).toHaveLength(1);
    expect(persisted[0].model.game.handState).toEqual(runtime.getState().model.game.handState);

    const canonical = runtime.getState().model.game.handState;
    runtime.dispatch({
      type: 'wasm-notification',
      iStarted: false,
      notification: { LocalActionApplied: { id: 7n, action: 'make_move' } },
    });
    expect(runtime.getState().model.game.instances['7'].presentation).toBe('off-chain-their-turn');
    expect(runtime.getState().model.game.handState).toBe(canonical);
    expect(runtime.getGameHand()?.getState()).toEqual(calpokerStateCodec.decode(canonical));
    expect(persisted).toHaveLength(2);
  });

  it('ends an immediately applied action with Rust-reported presentation', () => {
    const context: { runtime?: SessionMachineRuntime } = {};
    const makeMove = jest.fn(() => {
      context.runtime!.dispatch({
        type: 'wasm-notification',
        iStarted: false,
        notification: { LocalActionApplied: { id: 7n, action: 'make_move' } },
      });
      return 'applied' as const;
    });
    const harness = localActionHarness(makeMove);
    const runtime = harness.runtime;
    context.runtime = runtime;

    updateCalpoker(runtime, (state) => ({ ...state, moveNumber: 1n, isPlayerTurn: false }));
    runtime.commitLocalGameAction({
      gameType: 'calpoker',
      id: '7',
      command: { type: 'make-move', readable: null },
    });

    expect(calpokerStateCodec.decode(runtime.getState().model.game.handState)).toMatchObject({
      moveNumber: 1n,
      isPlayerTurn: false,
    });
    expect(runtime.getState().model.game.instances['7'].presentation).toBe('off-chain-their-turn');
    expect(harness.rendered).toHaveLength(2);
    expect(harness.persisted).toHaveLength(2);
  });

  it('retains accepted state when later action failure UX is reported', () => {
    const { runtime } = localActionHarness(
      jest.fn(() => 'queued' as const),
      {
        cheat: jest.fn(() => 'queued'),
      },
    );
    updateCalpoker(runtime, (state) => ({ ...state, moveNumber: 1n, isPlayerTurn: false }));
    runtime.commitLocalGameAction({
      gameType: 'calpoker',
      id: '7',
      command: { type: 'cheat', moverShare: 0n },
    });

    runtime.dispatch({
      type: 'wasm-notification',
      iStarted: false,
      notification: {
        ActionFailed: { id: 7n, action: 'cheat', reason: 'queued cheat became stale' },
      },
    });
    expect(runtime.getGameHand()?.getState()).toMatchObject({
      moveNumber: 1n,
      isPlayerTurn: false,
    });
    expect(runtime.getState().model.channel.queue.at(-1)).toMatchObject({
      kind: 'action-failed',
      message: 'queued cheat became stale',
    });
  });

  it('applies LocalActionApplied only to host protocol presentation', () => {
    const { runtime } = localActionHarness(jest.fn(() => 'queued' as const));
    const handState = runtime.getState().model.game.handState;
    runtime.dispatch({
      type: 'wasm-notification',
      iStarted: false,
      notification: { LocalActionApplied: { id: 7n, action: 'make_move' } },
    });
    expect(runtime.getState().model.game.instances['7'].presentation).toBe('off-chain-their-turn');
    expect(runtime.getState().model.game.handState).toBe(handState);
  });

  it.each([
    ['wrong type', { gameType: 'spacepoker' as const, id: '7' }, 'gameType'],
    ['wrong id', { gameType: 'calpoker' as const, id: '9' }, 'game id'],
  ])('fails fast for an internal %s local action', (_label, identity, message) => {
    const makeMove = jest.fn();
    const { runtime } = localActionHarness(makeMove);
    updateCalpoker(runtime, (state) => ({ ...state, moveNumber: 1n, isPlayerTurn: false }));
    expect(() =>
      runtime.commitLocalGameAction({
        ...identity,
        command: { type: 'make-move', readable: null },
      }),
    ).toThrow(message);
    expect(makeMove).not.toHaveBeenCalled();
  });
});
