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
  exchangeUntilIdle,
  fetchPreset,
  flushWrapperDrain,
  initSessionController,
  LONG_WASM_TEST_TIMEOUT,
  pollOnce,
  SessionControllerAdapter,
  startSimulator,
} from './load_wasm.harness';
import { createReloadableSessionLane, injectSessionReload } from './reload_injection.harness';
// @ts-expect-error Node.js types are not included in the frontend TypeScript configuration.
import * as assert from 'assert';

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
    senderIsPlayerA: false,
    gameTimeout: 15n,
    parameters: 20n,
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
    .model.betweenHand.pendingProposals.find((proposal) => proposal.lifecycle === 'local-outgoing');
  assert.ok(outgoing);
  await exchangeUntilIdle(adapters);
  adapters[1].blob!.acceptProposal(outgoing.id);
  await exchangeUntilIdle(adapters);
  const ids = [...lane.controller.activeGameIds];
  assert.equal(ids.length, 1);
  assert.deepEqual(adapters[1].blob!.activeGameIds, ids);

  lane.controller.makeMove(ids[0], null);
  await exchangeUntilIdle(adapters);
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
  for (
    let block = 0;
    block < 40 &&
    lane.runtime.getState().model.game.instances[ids[0]]?.presentation === 'replaying-move';
    block++
  ) {
    await fakeBlockchainInfo.farmBlock();
    await pollOnce(poller);
    await flushWrapperDrain(adapters);
  }
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

async function runCleanShutdownReloadAndLand(poller: BlockchainPoller): Promise<void> {
  const adapters = await createAsymmetricActivePair(poller, 11);
  const initiatorIndex = adapters[0].blob!.lastChannelStatus?.have_potato ? 0 : 1;
  const reloadingIndex = initiatorIndex ^ 1;
  const controller = adapters[reloadingIndex].blob!;
  const status = controller.lastChannelStatus;
  assert.ok(status, 'clean shutdown reload lane must begin Active');
  let lane = createReloadableSessionLane(
    adapters[reloadingIndex],
    controller,
    createSessionModel({
      channel: { status: channelStatusModelFromPayload(status) },
    }),
  );

  adapters[initiatorIndex].blob!.cleanShutdown();
  await flushWrapperDrain(adapters);
  const shutdownRequests = adapters[initiatorIndex].outbound_messages();
  assert.equal(shutdownRequests.length, 1);
  for (const request of shutdownRequests) {
    adapters[reloadingIndex].deliver_message(request.msgno, request.msg);
  }
  await flushWrapperDrain(adapters);
  assert.equal(lane.controller.lastChannelStatus?.state, 'ShutdownTransactionPending');

  lane = (
    await injectSessionReload(lane, poller, undefined, async () => {
      const shutdownResponses = adapters[reloadingIndex].outbound_messages();
      assert.equal(shutdownResponses.length, 1);
      for (const response of shutdownResponses) {
        adapters[initiatorIndex].deliver_message(response.msgno, response.msg);
      }
      await flushWrapperDrain(adapters);
      await fakeBlockchainInfo.farmBlock();
    })
  ).lane;
  assert.equal(lane.controller.getRestoreStatus(), 'restored');
  await flushWrapperDrain(adapters);
  for (
    let block = 0;
    block < 10 && lane.controller.lastChannelStatus?.state !== 'ResolvedClean';
    block++
  ) {
    await fakeBlockchainInfo.farmBlock();
    await pollOnce(poller);
    await flushWrapperDrain(adapters);
  }
  assert.equal(
    lane.controller.lastChannelStatus?.state,
    'ResolvedClean',
    `clean landing failed: advisory=${lane.controller.lastChannelStatus?.advisory ?? 'none'}\n${lane.controller.diagnosticLog.join('\n')}`,
  );
  await lane.runtime.persist();
  await flushSessionSave();
  assert.equal((await peekSession())?.phase, 'terminal');
}

async function runOfflineReplacementRestore(poller: BlockchainPoller): Promise<void> {
  const adapters = await createAsymmetricActivePair(poller, 12);
  const controller = adapters[0].blob!;
  const status = controller.lastChannelStatus;
  assert.ok(status, 'offline-reorg lane must begin Active');
  const handProposal: HandProposal = {
    gameType: 'calpoker',
    senderIsPlayerA: false,
    gameTimeout: 15n,
    parameters: 20n,
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
    .model.betweenHand.pendingProposals.find((proposal) => proposal.lifecycle === 'local-outgoing');
  assert.ok(outgoing);
  await exchangeUntilIdle(adapters);
  adapters[1].blob!.acceptProposal(outgoing.id);
  await exchangeUntilIdle(adapters);
  const [gameId] = [...lane.controller.activeGameIds];
  assert.ok(gameId);
  lane.controller.makeMove(gameId, null);
  await exchangeUntilIdle(adapters);

  const submittedBlobs: string[] = [];
  const puzzleSolutionCoins: string[] = [];
  const originalSpend = fakeBlockchainInfo.spend;
  const originalGetPuzzleAndSolution = fakeBlockchainInfo.getPuzzleAndSolution;
  fakeBlockchainInfo.spend = async (...args: Parameters<typeof originalSpend>) => {
    submittedBlobs.push(args[0]);
    return originalSpend.apply(fakeBlockchainInfo, args);
  };
  fakeBlockchainInfo.getPuzzleAndSolution = async (
    ...args: Parameters<typeof originalGetPuzzleAndSolution>
  ) => {
    puzzleSolutionCoins.push(args[0]);
    return originalGetPuzzleAndSolution.apply(fakeBlockchainInfo, args);
  };

  try {
    assert.equal(lane.controller.goOnChain(), true);
    await flushWrapperDrain(adapters);
    assert.equal(submittedBlobs.length, 1, 'unilateral spend must be submitted once');
    const finalizedBlob = submittedBlobs[0];

    lane = (await injectSessionReload(lane, poller)).lane;
    assert.equal(lane.controller.getRestoreStatus(), 'restored');
    assert.equal(lane.controller.lastChannelStatus?.state, 'GoingOnChain');

    const preLandingHeight = await fakeBlockchainInfo.getHeightInfo();
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
      'the retained unilateral spend must land before the offline reorg',
    );
    const landedHeight = await fakeBlockchainInfo.getHeightInfo();
    const rollbackDepth = Number(landedHeight - preLandingHeight);
    assert.ok(rollbackDepth > 0, 'landing must advance the simulator tip');
    const spendsBeforeReload = submittedBlobs.length;
    const puzzleRequestsBeforeReload = puzzleSolutionCoins.length;

    lane = (
      await injectSessionReload(lane, poller, undefined, async () => {
        const replacementHeight = await fakeBlockchainInfo.replaceChain(
          rollbackDepth,
          landedHeight,
        );
        assert.equal(
          replacementHeight,
          landedHeight,
          'replacement chain must reach the persisted tip',
        );
      })
    ).lane;
    assert.equal(lane.controller.getRestoreStatus(), 'restored');

    await pollOnce(poller);
    await flushWrapperDrain(adapters);
    const replayed = submittedBlobs.slice(spendsBeforeReload);
    assert.deepEqual(
      replayed,
      [finalizedBlob],
      `restore must rebroadcast exact bytes once: count=${replayed.length} expectedLength=${finalizedBlob.length} actualLengths=${replayed.map((blob) => blob.length).join(',')}`,
    );
    assert.equal(
      puzzleSolutionCoins.length,
      puzzleRequestsBeforeReload,
      'vanished output must not request a nonexistent puzzle and solution',
    );
    assert.equal((await peekSession())?.phase, 'live');
    assert.notEqual(lane.controller.lastChannelStatus?.state, 'ResolvedClean');
    assert.notEqual(lane.controller.lastChannelStatus?.state, 'ResolvedAborted');

    await pollOnce(poller);
    await flushWrapperDrain(adapters);
    assert.deepEqual(
      submittedBlobs.slice(spendsBeforeReload),
      [finalizedBlob],
      'a repeated replacement snapshot must not rebroadcast again',
    );
  } finally {
    fakeBlockchainInfo.spend = originalSpend;
    fakeBlockchainInfo.getPuzzleAndSolution = originalGetPuzzleAndSolution;
  }
}

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
  LONG_WASM_TEST_TIMEOUT,
);

it(
  'restores during cooperative shutdown and persists the clean landing',
  async () => {
    try {
      const poller = await startSimulator(['cafe00011', 'dead00011']);
      if (!poller) return;
      await runCleanShutdownReloadAndLand(poller);
    } catch (error) {
      throw new Error(`[load_wasm clean shutdown reload injection failed]\n${String(error)}`, {
        cause: error,
      });
    }
  },
  120 * 1000,
);

it(
  'restores after an offline equal-tip replacement and rebroadcasts exactly once',
  async () => {
    try {
      const poller = await startSimulator(['cafe00012', 'dead00012']);
      if (!poller) return;
      await runOfflineReplacementRestore(poller);
    } catch (error) {
      throw new Error(`[load_wasm offline replacement restore failed]\n${String(error)}`, {
        cause: error,
      });
    }
  },
  LONG_WASM_TEST_TIMEOUT,
);
