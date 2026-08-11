import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Subject } from 'rxjs';
import { Program } from 'clvm-lib';
import { SessionController } from '../../hooks/SessionController';
import { calpokerStateCodec } from '../../features/calPoker/stateCodec';
import { CalpokerOutcome } from '../../features/calPoker/outcome';
import {
  shouldAutoFireCalpokerMove,
  useCalpokerHand,
  type UseCalpokerHandResult,
} from '../../features/calPoker/useCalpokerHand';
import {
  channelStatusModelFromPayload,
  createSessionModel,
  INITIAL_GAME_TERMINAL_MODEL,
} from '../session/model';
import { createSessionMachineState } from '../session/sessionMachine';
import { SessionMachineRuntime } from '../session/sessionMachineRuntime';
import type { HandTermsModel } from '../session/types';
import type { GameplayEvent } from '../session/gameSessionEvents';
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
  const terms: HandTermsModel = {
    gameType: 'calpoker',
    myContribution: 20n,
    theirContribution: 20n,
    gameTimeout: 15n,
  };
  const runtimes: SessionMachineRuntime[] = [];
  const errors: unknown[] = [];
  const gameplayEvents: GameplayEvent[][] = [[], []];
  const gameplaySubjects = [new Subject<GameplayEvent>(), new Subject<GameplayEvent>()];
  const statuses: Array<Array<{ id: string; moverShare: unknown }>> = [[], []];
  const stageTrace: Array<Array<{ runtime: bigint; controller: bigint }>> = [[], []];
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
          betweenHand: { mode: 'compose-proposal', lastTerms: terms },
        }),
      ),
      {
        controller,
        iStarted: index === 0,
        restoring: false,
        getRestoreStatus: () => 'idle',
        getRestoreError: () => null,
        emitGameplay: (event) => {
          gameplayEvents[index].push(event);
          gameplaySubjects[index].next(event);
        },
        onError: (error) => errors.push(error),
        persist: async () => {},
      },
    );
    runtime.setRender((state) => {
      const runtimeHand = calpokerStateCodec.decode(state.model.game.handState);
      const controllerHand = calpokerStateCodec.decode(controller.handState);
      if (runtimeHand && controllerHand) {
        stageTrace[index].push({
          runtime: runtimeHand.moveNumber,
          controller: controllerHand.moveNumber,
        });
      }
    });
    runtimes.push(runtime);
    controller.onFeatureStateTransition = (gameType, id, state) =>
      runtime.transitionFeatureState(gameType, id, state);
    controller.onLocalGameAction = (request) => runtime.commitLocalGameAction(request);
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
  const latestOpponentMove = (index: number) => {
    const event = [...gameplayEvents[index]]
      .reverse()
      .find((candidate) => 'OpponentMoved' in candidate);
    assert.ok(event && 'OpponentMoved' in event);
    return event.OpponentMoved;
  };
  const submitSelections = (index: number, gameId: string, selections: bigint[]) => {
    assert.equal(
      runtimes[index].transitionFeatureState('calpoker', gameId, {
        ...hand(index),
        cardSelections: selections,
        moveNumber: 2n,
        isPlayerTurn: false,
      }),
      true,
    );
    submittedMoves[index] += 1;
    controllers[index].makeMove(
      gameId,
      Program.fromList(selections.map((card) => Program.fromBigInt(card))),
    );
  };
  const submitNil = (index: number, gameId: string, moveNumber: bigint) => {
    assert.equal(
      runtimes[index].transitionFeatureState('calpoker', gameId, {
        ...hand(index),
        moveNumber,
        isPlayerTurn: false,
      }),
      true,
    );
    submittedMoves[index] += 1;
    controllers[index].makeMove(gameId, null);
  };
  const autofireOpening = (index: number, gameId: string) => {
    const state = hand(index);
    if (!shouldAutoFireCalpokerMove(false, state.isPlayerTurn, state.moveNumber)) return;
    submitNil(index, gameId, state.moveNumber + 1n);
  };

  try {
    runtimes[0].dispatch({ type: 'submit-compose', terms });
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
    const aliceOutcome = new CalpokerOutcome(
      false,
      15n,
      hand(1).playerHand,
      hand(1).opponentHand,
      latestOpponentMove(1).readable,
    );

    submitNil(1, gameId, 3n);
    await exchange();
    const bobOutcome = new CalpokerOutcome(
      true,
      15n,
      hand(0).opponentHand,
      hand(0).playerHand,
      latestOpponentMove(0).readable,
    );

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
    assert.deepEqual(
      gameplayEvents.map((events) => events.filter((event) => 'OpponentMoved' in event).length),
      [3, 2],
      'the five-step hand must emit exactly one authoritative event per move',
    );
    for (const [index, runtime] of runtimes.entries()) {
      assert.ok(
        calpokerStateCodec.decode(runtime.getState().model.game.handState),
        `calpoker completion player ${index}: durable state must remain valid`,
      );
    }

    controllers[0].acceptSettlement(gameId);
    await exchange();
    for (const runtime of runtimes) {
      assert.deepEqual(runtime.getState().model.game.activeIds, []);
    }

    assert.equal(
      runtimes[0].transitionFeatureState('calpoker', gameId, {
        ...hand(0),
        moveNumber: 2n,
        isPlayerTurn: true,
      }),
      true,
      'a late terminal mount projection must still belong to the completed hand',
    );
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
    const hookOutcomes: Array<CalpokerOutcome | undefined> = [undefined, undefined];
    function HookHarness({ index }: { index: number }) {
      hookHands[index] = useCalpokerHand(
        { interactionMode: 'live', controller: controllers[index] },
        secondGameId,
        index === 0,
        gameplaySubjects[index],
        (outcome) => {
          hookOutcomes[index] = outcome;
          runtimes[index].dispatch({
            type: 'hand-outcome',
            outcomeWin: outcome.my_win_outcome,
          });
        },
        (isMyTurn) =>
          runtimes[index].dispatch({
            type: 'durable-local-turn',
            id: secondGameId,
            isMyTurn,
          }),
        INITIAL_GAME_TERMINAL_MODEL,
        controllers[index].handState ?? undefined,
        'restored',
      );
      return null;
    }
    act(() => {
      hookRenderer = create(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(HookHarness, { index: 0 }),
          React.createElement(HookHarness, { index: 1 }),
        ),
      );
    });

    const stages = (index: number) => {
      const runtimeHand = hand(index);
      const controllerHand = calpokerStateCodec.decode(controllers[index].handState);
      assert.ok(controllerHand);
      assert.ok(hookHands[index]);
      return {
        runtime: runtimeHand.moveNumber,
        controller: controllerHand.moveNumber,
        hook: hookHands[index].moveNumber,
      };
    };
    assert.deepEqual(stages(0), { runtime: 1n, controller: 1n, hook: 1n });
    assert.deepEqual(stages(1), { runtime: 1n, controller: 1n, hook: 1n });

    act(() => {
      hookHands[1]!.setCardSelections(secondAlice.playerHand.slice(0, 4));
      hookHands[1]!.handleMakeMove();
    });
    assert.deepEqual(stages(1), { runtime: 2n, controller: 2n, hook: 2n });
    await act(async () => {
      await exchange();
    });

    act(() => {
      hookHands[0]!.setCardSelections(hand(0).playerHand.slice(0, 4));
      hookHands[0]!.handleMakeMove();
    });
    assert.deepEqual(stages(0), { runtime: 2n, controller: 2n, hook: 2n });

    await act(async () => {
      await exchange();
    });
    await act(async () => {
      await exchange();
    });

    assert.ok(hookOutcomes[0], 'Bob must receive Alice’s final move readable');
    assert.ok(hookOutcomes[1], 'Alice must receive Bob’s final-result readable');
    assert.ok(
      stages(1).runtime >= 2n && stages(1).controller >= 2n && stages(1).hook >= 2n,
      'Alice selection stage must remain submitted through final-result delivery',
    );
    for (const trace of stageTrace) {
      const submittedIndex = trace.findIndex((entry) => entry.runtime >= 2n);
      if (submittedIndex >= 0) {
        assert.ok(
          trace
            .slice(submittedIndex)
            .every((entry) => entry.runtime >= 2n && entry.controller >= 2n),
          `Calpoker durable stage regressed after selection submission: ${JSON.stringify(
            trace.map((entry) => ({
              runtime: String(entry.runtime),
              controller: String(entry.controller),
            })),
          )}`,
        );
      }
    }

    controllers[0].acceptSettlement(secondGameId);
    await act(async () => {
      await exchange();
    });
    for (const runtime of runtimes) {
      assert.deepEqual(runtime.getState().model.game.activeIds, []);
    }
  } finally {
    if (hookRenderer) act(() => hookRenderer?.unmount());
    runtimes.forEach((runtime) => runtime.dispose());
    controllers.forEach((controller) => {
      controller.onFeatureStateTransition = null;
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
