import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { CalpokerHand } from '@games/calpoker/ui/serialize';
import { useCalpokerHand, type UseCalpokerHandResult } from '@games/calpoker/ui/useCalpokerHand';
import type { GameIntent, LiveGamePort } from '@games/host';
import { WasmStateInit } from '../../hooks/WasmStateInit';
import { fakeBlockchainInfo } from '../../hooks/FakeBlockchainInterface';
import type { BlockchainPoller } from '../../hooks/BlockchainPoller';
import { flushSessionSave, peekSession } from '../../hooks/save';
import {
  channelStatusModelFromPayload,
  createSessionModel,
  sessionModelFromSave,
} from '../session/model';
import type { HandProposal } from '../session/types';
import {
  action_with_messages,
  addActiveCradle,
  createActivePair,
  exchangeUntilIdle,
  fetchPreset,
  flushWrapperDrain,
  initSessionController,
  pollOnce,
  SessionControllerAdapter,
  startSimulator,
} from './load_wasm.harness';
import {
  createReloadableSessionLane,
  injectSessionReload,
  type ReloadableSessionLane,
} from './reload_injection.harness';
// @ts-expect-error Node.js types are not included in the frontend TypeScript configuration.
import * as assert from 'assert';

async function runCalpokerReloadAndAdvance(poller: BlockchainPoller): Promise<void> {
  const adapters = await createActivePair(poller, 5);
  const handProposal: HandProposal = {
    gameType: 'calpoker',
    playerAContribution: 20n,
    playerBContribution: 20n,
    senderIsPlayerA: false,
    gameTimeout: 15n,
    parameters: null,
  };
  const lanes = adapters.map((adapter) => {
    const controller = adapter.blob!;
    const status = controller.lastChannelStatus;
    assert.ok(status, 'Calpoker reload lane must begin with an active channel status');
    return createReloadableSessionLane(
      adapter,
      controller,
      createSessionModel({
        channel: { status: channelStatusModelFromPayload(status) },
        game: { handKey: 1 },
        betweenHand: { mode: 'compose-proposal', lastHandProposal: handProposal },
      }),
    );
  }) as [ReloadableSessionLane, ReloadableSessionLane];
  const hookHands: Array<UseCalpokerHandResult | undefined> = [undefined, undefined];
  const submittedMoves = [0, 0];
  const durableStages: bigint[][] = [[], []];
  let hookRenderer: ReactTestRenderer | null = null;

  const hand = (index: number) => {
    const current = (lanes[index].runtime.getGameHand() as CalpokerHand | null)?.getState();
    assert.ok(current, `Calpoker reload player ${index}: missing live hand`);
    return current;
  };
  const recordStages = () => {
    for (let index = 0; index < lanes.length; index += 1) {
      const active = lanes[index].runtime.getState().model.game.currentHandIds[0];
      if (active) durableStages[index].push(hand(index).moveNumber);
    }
  };
  const ports = lanes.map(
    (_, index): LiveGamePort => ({
      isChannelReady: () => lanes[index].controller.isChannelReady(),
      dispatch: (intent: GameIntent) => {
        if (intent.type === 'state-changed') {
          lanes[index].runtime.commitHandStateChanged('calpoker');
          return;
        }
        assert.equal(intent.type, 'make-move', 'Calpoker reload only submits game moves');
        const id = lanes[index].runtime.getState().model.game.currentHandIds[intent.memberIndex];
        assert.ok(id, `Calpoker reload player ${index}: invalid member ${intent.memberIndex}`);
        submittedMoves[index] += 1;
        lanes[index].runtime.commitLocalGameAction({
          gameType: 'calpoker',
          id,
          command: { type: 'make-move', readable: intent.readable },
        });
      },
    }),
  );
  function HookHarness({ index }: { index: number }) {
    hookHands[index] = useCalpokerHand({
      frozen: false,
      hand: lanes[index].runtime.getGameHand() as CalpokerHand,
      port: ports[index],
      appendGameLog: () => {},
    });
    return null;
  }
  const hookTree = () =>
    React.createElement(
      React.Fragment,
      null,
      React.createElement(HookHarness, { index: 0 }),
      React.createElement(HookHarness, { index: 1 }),
    );
  const remountHooks = () => {
    act(() => {
      hookRenderer?.unmount();
      hookRenderer = create(hookTree());
    });
    recordStages();
  };
  const renderHooks = () => {
    act(() => hookRenderer?.update(hookTree()));
    recordStages();
  };
  const wasmCheckpoint = (index: number) =>
    Uint8Array.from(lanes[index].controller.getWasmFields()!.serializedGameSession);
  const reloadAt = async (index: number, stage: string, expectedMove?: bigint) => {
    const savedHand = structuredClone(lanes[index].runtime.getState().model.game.handState);
    const restored = await injectSessionReload(lanes[index], poller);
    lanes[index] = restored.lane;
    assert.equal(
      lanes[index].controller.getRestoreStatus(),
      'restored',
      `${stage}: restore status`,
    );
    assert.deepEqual(
      lanes[index].runtime.getState().model.game.handState,
      savedHand,
      `${stage}: durable hand state`,
    );
    assert.equal(adapters[index].blob, lanes[index].controller, `${stage}: active controller`);
    if (expectedMove !== undefined) {
      assert.equal(hand(index).moveNumber, expectedMove, `${stage}: move number`);
    }
    recordStages();
    return wasmCheckpoint(index);
  };
  const assertAdvanced = (index: number, checkpoint: Uint8Array, stage: string) => {
    assert.notDeepEqual(
      lanes[index].controller.getWasmFields()!.serializedGameSession,
      checkpoint,
      `${stage}: restored live session must advance`,
    );
  };
  const exchange = async () => {
    await exchangeUntilIdle(adapters);
    await flushWrapperDrain(adapters);
    recordStages();
  };

  try {
    const activeCheckpoint = wasmCheckpoint(0);
    lanes[0] = (await injectSessionReload(lanes[0], poller)).lane;
    assert.deepEqual(
      lanes[0].controller.getWasmFields()!.serializedGameSession,
      activeCheckpoint,
      'between-hand Active reload must restore the same real WASM state',
    );

    lanes[0].runtime.dispatch({ type: 'submit-compose', handProposal });
    await flushWrapperDrain(adapters);
    const outgoingProposal = lanes[0].runtime
      .getState()
      .model.betweenHand.proposalGroups.find((group) => group.disposition === 'outgoing');
    assert.ok(outgoingProposal, 'reload proposer must retain its outgoing proposal');
    const queuedProposalMessages = adapters[0].outbound_messages();
    assert.ok(queuedProposalMessages.length > 0, 'real proposal must reach the transport boundary');
    const proposalReload = await injectSessionReload(lanes[0], poller);
    lanes[0] = proposalReload.lane;
    assert.ok(
      proposalReload.save.live.unackedMessages.length > 0,
      'proposal checkpoint must durably retain unacknowledged transport bytes',
    );
    assert.ok(
      adapters[0].waiting_messages.length > 0,
      'restored transport must replay its unacknowledged proposal',
    );
    await exchange();
    const review = lanes[1].runtime
      .getState()
      .model.betweenHand.proposalGroups.find((group) => group.disposition === 'incoming-review');
    assert.ok(review, 'Calpoker reload receiver must observe the real proposal');
    const gameId = review.memberIds[0];

    const incomingReviewCheckpoint = structuredClone(lanes[1].runtime.getState().model.betweenHand);
    lanes[1] = (await injectSessionReload(lanes[1], poller)).lane;
    assert.deepEqual(
      lanes[1].runtime.getState().model.betweenHand,
      incomingReviewCheckpoint,
      'incoming proposal review must survive reload',
    );
    lanes[1].runtime.dispatch({ type: 'accept-review' });
    await exchange();

    const openingCheckpoints = [
      await reloadAt(0, 'move 0 opening player 0', 0n),
      await reloadAt(1, 'move 0 opening player 1', 0n),
    ];
    assert.deepEqual(
      [hand(0).isPlayerTurn, hand(1).isPlayerTurn],
      [false, true],
      'move 0 restore must preserve the opening turn',
    );
    remountHooks();
    assert.deepEqual(submittedMoves, [0, 1], 'only the opening mover may autofire after restore');
    remountHooks();
    assert.deepEqual(submittedMoves, [0, 1], 'opening autofire must not duplicate after remount');
    await exchange();
    renderHooks();
    assert.deepEqual(submittedMoves, [1, 1], 'the peer must autofire exactly one opening move');
    await exchange();
    openingCheckpoints.forEach((checkpoint, index) =>
      assertAdvanced(index, checkpoint, `move 0 opening player ${index}`),
    );

    assert.deepEqual(
      [hand(0).moveNumber, hand(1).moveNumber],
      [1n, 1n],
      'both players must naturally reach selection',
    );
    assert.equal(hand(1).isPlayerTurn, true, 'Alice must select first');
    const selectionCheckpoints = [
      await reloadAt(0, 'move 1 selection player 0', 1n),
      await reloadAt(1, 'move 1 selection player 1', 1n),
    ];
    remountHooks();
    assert.deepEqual(submittedMoves, [1, 1], 'selection restore must not autofire without input');
    act(() => hookHands[1]!.setCardSelections(hand(1).playerHand.slice(0, 4)));
    renderHooks();
    act(() => hookHands[1]!.handleMakeMove());
    recordStages();
    assert.equal(hand(1).moveNumber, 2n, 'Alice selection must durably project move 2');

    const alicePostSelection = await reloadAt(1, 'move 2 post-selection player 1', 2n);
    remountHooks();
    assert.deepEqual(submittedMoves, [1, 2], 'post-selection restore must not duplicate the move');
    await exchange();
    renderHooks();
    assert.equal(hand(0).isPlayerTurn, true, 'Bob must receive the selection turn');
    act(() => hookHands[0]!.setCardSelections(hand(0).playerHand.slice(0, 4)));
    renderHooks();
    act(() => hookHands[0]!.handleMakeMove());
    recordStages();
    assert.equal(hand(0).moveNumber, 2n, 'Bob selection must durably project move 2');
    const bobPostSelection = await reloadAt(0, 'move 2 post-selection player 0', 2n);
    remountHooks();
    assert.deepEqual(
      submittedMoves,
      [2, 2],
      'Bob post-selection restore must not duplicate the move',
    );
    await exchange();
    selectionCheckpoints.forEach((checkpoint, index) =>
      assertAdvanced(index, checkpoint, `move 1 selection player ${index}`),
    );
    assertAdvanced(1, alicePostSelection, 'move 2 post-selection player 1');

    assert.ok(hand(1).outcome, 'Alice must naturally reach the final projection');
    assert.equal(hand(1).moveNumber, 2n, 'final projection must retain the submitted stage');
    const beforeFinalAutofire = submittedMoves[1];
    const finalProjection = await reloadAt(1, 'final projection player 1', 2n);
    assert.ok(hand(1).outcome, 'final projection must survive reload');
    remountHooks();
    assert.equal(
      submittedMoves[1],
      beforeFinalAutofire + 1,
      'restored final projection must autofire exactly once',
    );
    remountHooks();
    assert.equal(
      submittedMoves[1],
      beforeFinalAutofire + 1,
      'terminal autofire must not duplicate after remount',
    );
    await exchange();
    assertAdvanced(0, bobPostSelection, 'move 2 post-selection player 0');
    assertAdvanced(1, finalProjection, 'final projection player 1');

    for (const [index, lane] of lanes.entries()) {
      const game = lane.runtime.getState().model.game;
      assert.deepEqual(game.activeIds, [], `terminal player ${index}: no active game`);
      assert.equal(game.instances[gameId]?.terminal.type, 'settled');
      assert.ok(hand(index).outcome, `terminal player ${index}: final outcome`);
    }
    const terminalCheckpoints = [
      await reloadAt(0, 'terminal player 0'),
      await reloadAt(1, 'terminal player 1'),
    ];
    remountHooks();
    assert.deepEqual(submittedMoves, [2, 3], 'terminal restore must not submit another move');

    const firstHandKeys = lanes.map((lane) => lane.runtime.getState().model.game.handKey);
    lanes[0].runtime.dispatch({ type: 'choose-same-terms' });
    await exchange();
    const secondProposal = lanes[1].runtime
      .getState()
      .model.betweenHand.proposalGroups.find((group) => group.disposition === 'incoming-cached');
    assert.ok(secondProposal, 'terminal reload must advance to a cached same-terms proposal');
    const secondGameId = secondProposal.memberIds[0];
    lanes[1].runtime.dispatch({ type: 'choose-same-terms' });
    await exchange();
    terminalCheckpoints.forEach((checkpoint, index) =>
      assertAdvanced(index, checkpoint, `terminal player ${index}`),
    );

    assert.deepEqual(
      lanes.map((lane) => lane.runtime.getState().model.game.handKey),
      firstHandKeys.map((key) => key + 1),
      'same-terms startup must mount a fresh hand',
    );
    assert.deepEqual(
      lanes.map((lane) => lane.runtime.getState().model.game.currentHandIds),
      [[secondGameId], [secondGameId]],
    );
    assert.deepEqual(
      [hand(0).moveNumber, hand(1).moveNumber],
      [0n, 0n],
      'same-terms next hand must naturally restart at move 0',
    );
    const startupCheckpoints = [
      await reloadAt(0, 'terminal to same-terms startup player 0', 0n),
      await reloadAt(1, 'terminal to same-terms startup player 1', 0n),
    ];
    remountHooks();
    assert.deepEqual(submittedMoves, [2, 4], 'next-hand opening must autofire exactly once');
    remountHooks();
    assert.deepEqual(submittedMoves, [2, 4], 'next-hand opening autofire must not duplicate');
    await exchange();
    renderHooks();
    await exchange();
    startupCheckpoints.forEach((checkpoint, index) =>
      assertAdvanced(index, checkpoint, `terminal to same-terms startup player ${index}`),
    );
    assert.deepEqual(
      [hand(0).moveNumber, hand(1).moveNumber],
      [1n, 1n],
      'restored next hand must advance to selection',
    );

    for (const [index, trace] of durableStages.entries()) {
      const submitted = trace.findIndex((move) => move >= 2n);
      assert.ok(submitted >= 0, `player ${index} must record a submitted selection stage`);
      const nextHand = trace.findIndex((move, stageIndex) => stageIndex > submitted && move === 0n);
      assert.ok(nextHand > submitted, `player ${index} must record the next hand boundary`);
      const firstHandTrace = trace.slice(submitted, nextHand);
      assert.ok(
        firstHandTrace.every((move) => move >= 2n),
        `Calpoker durable stage regressed after selection: ${trace.map(String).join(',')}`,
      );
    }
  } finally {
    if (hookRenderer) act(() => hookRenderer?.unmount());
  }
}

async function createAsymmetricActivePair(
  poller: BlockchainPoller,
  suffix: number,
  firstContribution = 100n,
  secondContribution = 101n,
): Promise<[SessionControllerAdapter, SessionControllerAdapter]> {
  const adapters = [
    addActiveCradle(new SessionControllerAdapter()),
    addActiveCradle(new SessionControllerAdapter()),
  ] as [SessionControllerAdapter, SessionControllerAdapter];
  const controllers = await Promise.all([
    initSessionController(
      poller,
      `cafe000${suffix}`,
      true,
      adapters[0].peerConnection,
      new WasmStateInit(fetchPreset),
      firstContribution,
      secondContribution,
    ),
    initSessionController(
      poller,
      `dead000${suffix}`,
      false,
      adapters[1].peerConnection,
      new WasmStateInit(fetchPreset),
      secondContribution,
      firstContribution,
    ),
  ]);
  controllers.forEach((activeController, index) => {
    activeController.pairingToken = `reload-asymmetric-${suffix}-${index}`;
    activeController.perGameAmount = 100n;
    activeController.onSaveNeeded = () => Promise.resolve();
    adapters[index].set_blob(activeController);
  });
  await action_with_messages(poller, adapters[0], adapters[1]);
  return adapters;
}

async function runUnrollReloadAndAdvance(poller: BlockchainPoller): Promise<void> {
  const adapters = await createAsymmetricActivePair(poller, 10);
  const controller = adapters[0].blob!;
  const status = controller.lastChannelStatus;
  assert.ok(status, 'unroll reload lane must begin Active');
  const handProposal: HandProposal = {
    gameType: 'calpoker',
    playerAContribution: 20n,
    playerBContribution: 20n,
    senderIsPlayerA: true,
    gameTimeout: 15n,
    parameters: null,
  };
  let lane = createReloadableSessionLane(
    adapters[0],
    controller,
    createSessionModel({
      channel: { status: channelStatusModelFromPayload(status) },
      game: { handKey: 1 },
      betweenHand: { mode: 'compose-proposal', lastHandProposal: handProposal },
    }),
  );

  lane.runtime.dispatch({ type: 'submit-compose', handProposal });
  const outgoing = lane.runtime
    .getState()
    .model.betweenHand.proposalGroups.find((group) => group.disposition === 'outgoing');
  assert.ok(outgoing);
  const ids = outgoing.memberIds;
  await exchangeUntilIdle(adapters);
  adapters[1].blob!.acceptProposal(ids[0]);
  await exchangeUntilIdle(adapters);
  assert.deepEqual(lane.controller.activeGameIds, ids);

  assert.equal(lane.controller.goOnChain(), true);
  await flushWrapperDrain(adapters);
  assert.equal(lane.controller.lastChannelStatus?.state, 'GoingOnChain');
  lane = (await injectSessionReload(lane, poller)).lane;
  assert.equal(lane.controller.getRestoreStatus(), 'restored');
  assert.equal(lane.controller.lastChannelStatus?.state, 'GoingOnChain');

  for (
    let block = 0;
    block < 10 && lane.controller.lastChannelStatus?.state === 'GoingOnChain';
    block++
  ) {
    await fakeBlockchainInfo.farmBlock();
    await pollOnce(poller);
    await flushWrapperDrain(adapters);
  }
  assert.equal(
    lane.controller.lastChannelStatus?.state,
    'Unrolling',
    'restored channel-spend phase must advance to an observed unroll',
  );

  lane = (await injectSessionReload(lane, poller)).lane;
  assert.equal(lane.controller.lastChannelStatus?.state, 'Unrolling');
  for (
    let block = 0;
    block < 40 && lane.controller.lastChannelStatus?.state === 'Unrolling';
    block++
  ) {
    await fakeBlockchainInfo.farmBlock();
    await pollOnce(poller);
    await flushWrapperDrain(adapters);
  }
  assert.notEqual(
    lane.controller.lastChannelStatus?.state,
    'Unrolling',
    'restored unroll lane must observe a later chain lifecycle state',
  );
  const onChainPresentation = lane.runtime.getState().model.game.instances[ids[0]]?.presentation;
  assert.ok(
    onChainPresentation === 'on-chain-my-turn' || onChainPresentation === 'on-chain-their-turn',
    `resolved unroll must expose a real on-chain game turn, got ${onChainPresentation}`,
  );

  for (
    let block = 0;
    block < 40 && lane.runtime.getState().model.game.instances[ids[0]]?.presentation !== 'ended';
    block++
  ) {
    await fakeBlockchainInfo.farmBlock();
    await pollOnce(poller);
    await flushWrapperDrain(adapters);
  }
  assert.equal(
    lane.runtime.getState().model.game.instances[ids[0]]?.presentation,
    'ended',
    'restored on-chain turn must progress through its real timeout terminal',
  );
  await lane.runtime.persist();
  await flushSessionSave();
  const terminalSave = await peekSession();
  assert.equal(terminalSave?.phase, 'terminal');
  assert.equal(
    terminalSave && sessionModelFromSave(terminalSave).game.instances[ids[0]]?.presentation,
    'ended',
    'cold terminal restore must retain the timed-out game result',
  );
}

function laneForHandshakeAdapter(adapter: SessionControllerAdapter): ReloadableSessionLane {
  const controller = adapter.blob!;
  const status = controller.lastChannelStatus;
  return createReloadableSessionLane(
    adapter,
    controller,
    createSessionModel(
      status
        ? {
            channel: { status: channelStatusModelFromPayload(status) },
            game: { handKey: 1 },
          }
        : { game: { handKey: 1 } },
    ),
  );
}

type HandshakeReloadCheckpoint =
  | 'initiator-sent-a'
  | 'initiator-sent-c'
  | 'receiver-waiting-for-a'
  | 'receiver-sent-d';

async function runHandshakeRoleReload(
  poller: BlockchainPoller,
  checkpoint: HandshakeReloadCheckpoint,
  suffix: number,
): Promise<void> {
  const adapters = [
    addActiveCradle(new SessionControllerAdapter()),
    addActiveCradle(new SessionControllerAdapter()),
  ] as [SessionControllerAdapter, SessionControllerAdapter];
  const controllers = await Promise.all([
    initSessionController(
      poller,
      `a11ce00${suffix}`,
      true,
      adapters[0].peerConnection,
      new WasmStateInit(fetchPreset),
    ),
    initSessionController(
      poller,
      `b0b7000${suffix}`,
      false,
      adapters[1].peerConnection,
      new WasmStateInit(fetchPreset),
    ),
  ]);
  controllers.forEach((controller, index) => {
    controller.pairingToken = `reload-handshake-${suffix}-${index}`;
    controller.perGameAmount = 100n;
    controller.onSaveNeeded = () => Promise.resolve();
    adapters[index].set_blob(controller);
  });
  await flushWrapperDrain(adapters);

  const deliverNext = async (sender: 0 | 1): Promise<void> => {
    const outbound = adapters[sender].outbound_messages();
    assert.ok(
      outbound.length > 0,
      `${checkpoint}: expected handshake message from player ${sender}`,
    );
    const next = outbound[outbound.length - 1];
    adapters[sender ^ 1].deliver_message(next.msgno, next.msg);
    await flushWrapperDrain(adapters);
    adapters[sender].blob?.receiveAck(BigInt(next.msgno));
    await flushWrapperDrain(adapters);
  };

  if (checkpoint === 'initiator-sent-c' || checkpoint === 'receiver-sent-d') {
    await deliverNext(0);
    await deliverNext(1);
  }
  if (checkpoint === 'receiver-sent-d') {
    await deliverNext(0);
  }

  const target = checkpoint.startsWith('initiator') ? 0 : 1;
  let lane = laneForHandshakeAdapter(adapters[target]);
  const before = lane.controller.getProtocolStatePretty();
  assert.ok(before?.includes(checkpoint.startsWith('initiator') ? 'Initiator' : 'Receiver'));
  lane = (await injectSessionReload(lane, poller)).lane;
  assert.equal(lane.controller.getRestoreStatus(), 'restored');
  assert.equal(lane.controller.getProtocolStatePretty(), before);
  await action_with_messages(poller, adapters[0], adapters[1]);
  assert.equal(
    lane.controller.lastChannelStatus?.state,
    'Active',
    `${checkpoint}: restored handshake phase must make forward progress to Active`,
  );
}

it(
  'restores a real Calpoker peer and continues peer exchange',
  async () => {
    try {
      const poller = await startSimulator(['cafe0005', 'dead0005']);
      if (!poller) return;
      await runCalpokerReloadAndAdvance(poller);
    } catch (error) {
      throw new Error(`[load_wasm reload injection failed]\n${String(error)}`, { cause: error });
    }
  },
  300 * 1000,
);

it(
  'restores a real unilateral unroll and advances on later chain observations',
  async () => {
    try {
      const poller = await startSimulator(['cafe00010', 'dead00010']);
      if (!poller) return;
      await runUnrollReloadAndAdvance(poller);
    } catch (error) {
      throw new Error(`[load_wasm unroll reload injection failed]\n${String(error)}`, {
        cause: error,
      });
    }
  },
  300 * 1000,
);

it.each([
  ['initiator-sent-a', 6],
  ['initiator-sent-c', 7],
  ['receiver-waiting-for-a', 8],
  ['receiver-sent-d', 9],
] as const)(
  'restores the real %s handshake checkpoint and reaches Active',
  async (checkpoint, suffix) => {
    try {
      const poller = await startSimulator([`a11ce00${suffix}`, `b0b7000${suffix}`]);
      if (!poller) return;
      await runHandshakeRoleReload(poller, checkpoint, suffix);
    } catch (error) {
      throw new Error(`[load_wasm handshake reload injection failed]\n${String(error)}`, {
        cause: error,
      });
    }
  },
  300 * 1000,
);
