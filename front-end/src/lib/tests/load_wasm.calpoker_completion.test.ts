import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Program } from 'clvm-lib';
import { SessionController } from '../../hooks/SessionController';
import { calpokerStateCodec, type CalpokerHand } from '@games/calpoker/ui/serialize';
import {
  shouldAutoFireCalpokerMove,
  useCalpokerHand,
  type UseCalpokerHandResult,
} from '@games/calpoker/ui/useCalpokerHand';
import { channelStatusModelFromPayload, createSessionModel } from '../session/model';
import { createSessionMachineState } from '../session/sessionMachine';
import { SessionMachineRuntime } from '../session/sessionMachineRuntime';
import type { HandProposal } from '../session/types';
import type { GameIntent, LiveGamePort } from '@games/host';
import {
  addActiveSubscription,
  createActivePair,
  exchangeUntilIdle,
  flushWrapperDrain,
  startSimulator,
} from './load_wasm.harness';
// @ts-expect-error Node.js types are not included in the frontend TypeScript configuration.
import * as assert from 'assert';

async function runRealCalpokerCompletionCase(poller: BlockchainPoller): Promise<void> {
  const cradles = await createActivePair(poller, 4);
  const controllers = cradles.map((cradle) => cradle.blob!) as [
    SessionController,
    SessionController,
  ];
  const handProposal: HandProposal = {
    gameType: 'calpoker',
    myContribution: 20n,
    theirContribution: 20n,
    gameTimeout: 15n,
  };
  const runtimes: SessionMachineRuntime[] = [];
  const ports: LiveGamePort[] = [];
  const errors: unknown[] = [];
  const statuses: Array<Array<{ id: string; moverShare: unknown }>> = [[], []];
  const stageTrace: bigint[][] = [[], []];
  const submittedMoves = [0, 0];
  let hookRenderer: ReactTestRenderer | null = null;

  for (const [index, controller] of controllers.entries()) {
    const status = controller.lastChannelStatus;
    assert.ok(status, `calpoker initial deal player ${index}: missing active channel status`);
    const runtime = new SessionMachineRuntime(
      createSessionMachineState(
        createSessionModel({
          channel: { status: channelStatusModelFromPayload(status) },
          game: { handKey: 1 },
          betweenHand: { mode: 'compose-proposal', lastHandProposal: handProposal },
        }),
      ),
      {
        controller,
        iStarted: index === 0,
        restoring: false,
        getRestoreStatus: () => 'idle',
        getRestoreError: () => null,
        onError: (error) => errors.push(error),
        persist: async () => {},
      },
    );
    runtime.setRender((state) => {
      const runtimeHand = calpokerStateCodec.decode(state.model.game.handState);
      if (runtimeHand) stageTrace[index].push(runtimeHand.moveNumber);
    });
    runtimes.push(runtime);
    ports.push({
      isChannelReady: () => controller.isChannelReady(),
      dispatch: (intent: GameIntent) => {
        const game = runtime.getState().model.game;
        assert.equal(game.activeGameType, 'calpoker');
        if (intent.type === 'state-changed') {
          runtime.commitHandStateChanged('calpoker');
          return;
        }
        submittedMoves[index] += intent.type === 'make-move' ? 1 : 0;
        runtime.commitLocalGameAction({
          gameType: 'calpoker',
          id: intent.gameId,
          command:
            intent.type === 'make-move'
              ? { type: 'make-move', readable: intent.readable }
              : intent.type === 'accept-settlement'
                ? { type: 'accept-settlement' }
                : { type: 'cheat', moverShare: intent.moverShare },
        });
      },
    });
    controller.onSaveNeeded = () => Promise.resolve();
    addActiveSubscription(
      controller.getObservable().subscribe((event) => {
        if (event.type !== 'notification') return;
        const gameStatus = event.data.GameStatus;
        if (gameStatus) {
          statuses[index].push({
            id: String(gameStatus.id),
            moverShare: gameStatus.other_params?.mover_share,
          });
        }
        runtime.dispatch({
          type: 'wasm-notification',
          notification: event.data,
          iStarted: index === 0,
        });
      }),
    );
  }

  const exchange = async () => {
    await exchangeUntilIdle(cradles);
    await flushWrapperDrain(cradles);
    assert.deepEqual(errors, []);
  };
  const hand = (index: number) => {
    const state = calpokerStateCodec.decode(runtimes[index].getState().model.game.handState);
    assert.ok(state, `calpoker initial deal player ${index}: missing hand state`);
    return state;
  };
  const submitSelections = (index: number, gameId: string, selections: bigint[]) => {
    (runtimes[index].getGameHand() as CalpokerHand).update((state) => ({
      ...state,
      cardSelections: selections,
      moveNumber: 2n,
      isPlayerTurn: false,
    }));
    ports[index].dispatch({
      type: 'make-move',
      gameId,
      readable: Program.fromList(selections.map((card) => Program.fromBigInt(card))),
    });
  };
  const submitNil = (index: number, gameId: string, moveNumber: bigint) => {
    (runtimes[index].getGameHand() as CalpokerHand).update((state) => ({
      ...state,
      moveNumber,
      isPlayerTurn: false,
    }));
    ports[index].dispatch({
      type: 'make-move',
      gameId,
      readable: null,
    });
  };
  const autofireOpening = (index: number, gameId: string) => {
    const state = hand(index);
    if (!shouldAutoFireCalpokerMove(false, state.isPlayerTurn, state.moveNumber)) return;
    submitNil(index, gameId, state.moveNumber + 1n);
  };

  try {
    runtimes[0].dispatch({ type: 'submit-compose', handProposal });
    await exchange();
    const review = runtimes[1]
      .getState()
      .model.betweenHand.proposalGroups.find((group) => group.disposition === 'incoming-review');
    assert.ok(review, 'calpoker initial deal receiver must observe the real proposal');
    const gameId = review.memberIds[0];

    runtimes[1].dispatch({ type: 'accept-review' });
    await exchange();
    assert.deepEqual(hand(0).playerHand, []);
    assert.deepEqual(hand(1).playerHand, []);

    submitNil(1, gameId, 1n);
    await exchange();
    assert.deepEqual(hand(0).playerHand, []);
    assert.deepEqual(hand(1).playerHand, []);

    submitNil(0, gameId, 1n);
    await exchange();

    const bob = hand(0);
    const alice = hand(1);
    assert.equal(alice.playerHand.length, 8);
    assert.equal(alice.opponentHand.length, 8);
    assert.equal(bob.playerHand.length, 8);
    assert.equal(bob.opponentHand.length, 8);
    assert.deepEqual(alice.playerHand, bob.opponentHand);
    assert.deepEqual(alice.opponentHand, bob.playerHand);
    assert.ok(
      statuses[0].some((entry) => entry.id === gameId && entry.moverShare == null),
      'Bob must receive the initial deal as an advisory GameMessage',
    );
    assert.ok(
      statuses[1].some((entry) => entry.id === gameId && entry.moverShare != null),
      'Alice must derive the initial deal from Bob’s authoritative move',
    );

    const aliceSelections = alice.playerHand.slice(0, 4);
    submitSelections(1, gameId, aliceSelections);
    await exchange();

    const bobSelections = hand(0).playerHand.slice(0, 4);
    submitSelections(0, gameId, bobSelections);
    await exchange();
    const aliceOutcome = hand(1).outcome;
    assert.ok(aliceOutcome, 'Alice must derive the outcome from Bob’s final readable');

    submitNil(1, gameId, 3n);
    await exchange();
    const bobOutcome = hand(0).outcome;
    assert.ok(bobOutcome, 'Bob must derive the outcome from Alice’s terminal readable');

    assert.deepEqual(aliceOutcome.my_cards, bobOutcome.their_cards);
    assert.deepEqual(aliceOutcome.their_cards, bobOutcome.my_cards);
    assert.deepEqual(aliceOutcome.my_final_hand, bobOutcome.their_final_hand);
    assert.deepEqual(aliceOutcome.their_final_hand, bobOutcome.my_final_hand);
    assert.equal(
      aliceOutcome.my_win_outcome === 'tie'
        ? bobOutcome.my_win_outcome
        : aliceOutcome.my_win_outcome === 'win'
          ? 'lose'
          : 'win',
      bobOutcome.my_win_outcome,
    );
    for (const [index, runtime] of runtimes.entries()) {
      assert.ok(
        calpokerStateCodec.decode(runtime.getState().model.game.handState),
        `calpoker completion player ${index}: durable state must remain valid`,
      );
    }

    for (const [index, runtime] of runtimes.entries()) {
      const game = runtime.getState().model.game;
      assert.deepEqual(game.activeIds, []);
      assert.equal(game.instances[gameId]?.terminal.type, 'settled');
      assert.notEqual(game.instances[gameId]?.terminal.outcome, null);
      assert.ok(
        calpokerStateCodec.decode(game.handState),
        `calpoker completion player ${index}: terminal hand state must remain valid`,
      );
    }

    const firstHandKeys = runtimes.map((runtime) => runtime.getState().model.game.handKey);
    runtimes[0].dispatch({ type: 'choose-same-terms' });
    await exchange();
    const secondProposal = runtimes[1]
      .getState()
      .model.betweenHand.proposalGroups.find((group) => group.disposition === 'incoming-cached');
    assert.ok(secondProposal, 'second Calpoker hand receiver must cache the same-terms proposal');
    const secondGameId = secondProposal.memberIds[0];
    assert.notEqual(secondGameId, gameId);
    runtimes[1].dispatch({ type: 'choose-same-terms' });
    await exchange();

    assert.deepEqual(
      runtimes.map((runtime) => runtime.getState().model.game.handKey),
      firstHandKeys.map((key) => key + 1),
      'second hand must receive a fresh mount key on both players',
    );
    assert.deepEqual(
      runtimes.map((runtime) => runtime.getState().model.game.currentHandOrigin),
      ['local', 'peer'],
      'proposal ownership must describe the current hand, not channel initiation',
    );
    assert.deepEqual(
      runtimes.map((runtime) => runtime.getState().model.game.currentHandIds),
      [[secondGameId], [secondGameId]],
    );
    stageTrace.forEach((trace) => {
      trace.length = 0;
    });
    const secondStartup = [hand(0), hand(1)].map((state) => ({
      moveNumber: state.moveNumber,
      isPlayerTurn: state.isPlayerTurn,
    }));
    autofireOpening(0, secondGameId);
    autofireOpening(1, secondGameId);
    await exchange();
    assert.deepEqual(
      secondStartup,
      [
        { moveNumber: 0n, isPlayerTurn: false },
        { moveNumber: 0n, isPlayerTurn: true },
      ],
      'fresh durable state must agree with the new Rust referee turn',
    );
    assert.deepEqual(submittedMoves, [2, 4], 'only Alice must autofire the second opening');

    submitNil(0, secondGameId, 1n);
    await exchange();
    const secondAlice = hand(1);
    const secondBob = hand(0);
    assert.deepEqual(secondAlice.playerHand, secondBob.opponentHand);
    assert.deepEqual(secondAlice.opponentHand, secondBob.playerHand);

    const hookHands: Array<UseCalpokerHandResult | undefined> = [undefined, undefined];
    function HookHarness({ index }: { index: number }) {
      const runtime = runtimes[index];
      hookHands[index] = useCalpokerHand(
        {
          interactionMode: 'live',
          hand: runtime.getGameHand(),
          port: ports[index],
        },
        'restored',
      );
      return null;
    }
    const hookTree = () =>
      React.createElement(
        React.Fragment,
        null,
        React.createElement(HookHarness, { index: 0 }),
        React.createElement(HookHarness, { index: 1 }),
      );
    const renderHooks = () => {
      if (hookRenderer) {
        hookRenderer.update(hookTree());
      } else {
        hookRenderer = create(hookTree());
      }
    };
    act(renderHooks);

    const stages = (index: number) => {
      const runtimeHand = hand(index);
      assert.ok(hookHands[index]);
      return {
        runtime: runtimeHand.moveNumber,
        hook: hookHands[index].moveNumber,
      };
    };
    assert.deepEqual(stages(0), { runtime: 1n, hook: 1n });
    assert.deepEqual(stages(1), { runtime: 1n, hook: 1n });

    act(() => {
      hookHands[1]!.setCardSelections(secondAlice.playerHand.slice(0, 4));
    });
    act(renderHooks);
    act(() => {
      hookHands[1]!.handleMakeMove();
    });
    act(renderHooks);
    assert.deepEqual(stages(1), { runtime: 2n, hook: 2n });
    await act(async () => {
      await exchange();
    });
    act(renderHooks);

    act(() => {
      hookHands[0]!.setCardSelections(hand(0).playerHand.slice(0, 4));
    });
    act(renderHooks);
    act(() => {
      hookHands[0]!.handleMakeMove();
    });
    act(renderHooks);
    assert.deepEqual(stages(0), { runtime: 2n, hook: 2n });

    await act(async () => {
      await exchange();
    });
    act(renderHooks);
    await act(async () => {
      await exchange();
    });
    act(renderHooks);

    assert.ok(hookHands[0]!.outcome, 'Bob must receive Alice’s final move readable');
    assert.ok(hookHands[1]!.outcome, 'Alice must receive Bob’s final-result readable');
    assert.ok(
      stages(1).runtime >= 2n && stages(1).hook >= 2n,
      'Alice selection stage must remain submitted through final-result delivery',
    );
    for (const trace of stageTrace) {
      const submittedIndex = trace.findIndex((moveNumber) => moveNumber >= 2n);
      if (submittedIndex >= 0) {
        assert.ok(
          trace.slice(submittedIndex).every((moveNumber) => moveNumber >= 2n),
          `Calpoker durable stage regressed after selection submission: ${JSON.stringify(
            trace.map(String),
          )}`,
        );
      }
    }

    for (const runtime of runtimes) {
      const game = runtime.getState().model.game;
      assert.deepEqual(game.activeIds, []);
      assert.equal(game.instances[secondGameId]?.terminal.type, 'settled');
      assert.notEqual(game.instances[secondGameId]?.terminal.outcome, null);
    }
  } finally {
    if (hookRenderer) act(() => hookRenderer?.unmount());
    runtimes.forEach((runtime) => runtime.dispose());
    controllers.forEach((controller) => {
      controller.onSaveNeeded = null;
    });
  }
}

it(
  'completes real Cal Poker hands through durable runtime and hook state',
  async () => {
    try {
      const poller = await startSimulator(['cafe0004', 'dead0004']);
      if (!poller) return;
      await runRealCalpokerCompletionCase(poller);
    } catch (e) {
      throw new Error(`[load_wasm Cal Poker completion failed]\n${String(e)}`, { cause: e });
    }
  },
  300 * 1000,
);
