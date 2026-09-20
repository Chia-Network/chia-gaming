import { WasmStateInit } from '../../hooks/WasmStateInit';
import { fakeBlockchainInfo } from '../../hooks/FakeBlockchainInterface';
import type { BlockchainPoller } from '../../hooks/BlockchainPoller';
import {
  discardStagedTerminalSession,
  flushSessionSave,
  markSavedSession,
  peekSession,
  stageTerminalSession,
} from '../../hooks/save';
import {
  channelStatusModelFromPayload,
  createSessionModel,
  sessionModelFromSave,
} from '../session/model';
import { isTerminalChannelSnapshot } from '../session/selectors';
import { finalizeTerminalSession } from '../session/terminalFinalization';
import { coinIdFromBytes, toUint8 } from '../../util';
import { coinRecordToName } from '../../util/coinWatch';
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
// @ts-expect-error Node.js types are not included in the frontend TypeScript configuration.
import { createHash } from 'crypto';

const harnessTerminalDependencies = {
  stageTerminal: stageTerminalSession,
  flushSave: flushSessionSave,
  discardTerminal: discardStagedTerminalSession,
  updateMarker: markSavedSession,
  teardown: () => {},
};

function diagnosticBlobHash(blob: string): string {
  return createHash('sha256').update(blob).digest('hex');
}

function diagnosticBlobSummary(blobs: string[]): string {
  return blobs.map((blob) => `{hash=${diagnosticBlobHash(blob)},length=${blob.length}}`).join(',');
}

async function runBoundedPollAttempts(
  maxAttempts: number,
  done: () => boolean,
  pollAttempt: () => Promise<void>,
): Promise<{ attempts: number; completed: boolean }> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await pollAttempt();
    if (done()) return { attempts: attempt, completed: true };
  }
  return { attempts: maxAttempts, completed: false };
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
  assert.equal(
    typeof lane.controller.lastChannelStatus?.unrolling_state_number,
    'bigint',
    'unrolling real-WASM status must expose unrolling_state_number as bigint',
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
  await finalizeTerminalSession(
    {
      controller: lane.controller,
      identity: { myName: 'Alice', opponentName: 'Bob', iStarted: lane.controller.iStarted },
    },
    harnessTerminalDependencies,
  );
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
  await finalizeTerminalSession(
    {
      controller: lane.controller,
      identity: { myName: 'Alice', opponentName: 'Bob', iStarted: lane.controller.iStarted },
    },
    harnessTerminalDependencies,
  );
  assert.equal((await peekSession())?.phase, 'terminal');
}

async function runOfflineReplacementRestore(poller: BlockchainPoller): Promise<void> {
  const adapters = await createAsymmetricActivePair(poller, 13);
  poller.stop();
  await pollOnce(poller);
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
  const puzzleSolutionCoinIds: string[] = [];
  const originalSpend = fakeBlockchainInfo.spend;
  const originalGetPuzzleAndSolution = fakeBlockchainInfo.getPuzzleAndSolution;
  fakeBlockchainInfo.spend = async (...args: Parameters<typeof originalSpend>) => {
    submittedBlobs.push(args[0]);
    return originalSpend.apply(fakeBlockchainInfo, args);
  };
  fakeBlockchainInfo.getPuzzleAndSolution = async (
    ...args: Parameters<typeof originalGetPuzzleAndSolution>
  ) => {
    puzzleSolutionCoinIds.push(await coinIdFromBytes(toUint8(args[0])));
    return originalGetPuzzleAndSolution.apply(fakeBlockchainInfo, args);
  };

  try {
    const baselineSubmissionCount = submittedBlobs.length;
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
    // The snapshot that first observes the channel spend registers the new
    // unroll output but cannot include it retroactively. Refresh the expanded
    // watch set so the retained submission records its output as landed.
    const landedWatches = lane.controller.snapshotWatchedCoins();
    poller.snapshotGameSessionCoinInterest(lane.controller, landedWatches);
    await pollOnce(poller);
    await flushWrapperDrain(adapters);
    const landedRecords = await fakeBlockchainInfo.getCoinRecordsByNames(
      landedWatches.map(({ coin_name }) => coin_name),
    );
    assert.equal(
      landedRecords.length,
      landedWatches.length,
      'every retained watch, including the expected output, must exist before replacement',
    );
    await pollOnce(poller);
    await flushWrapperDrain(adapters);
    const landedHeight = await fakeBlockchainInfo.getHeightInfo();
    assert.ok(landedHeight > preLandingHeight, 'landing must advance the simulator tip');
    const preReplacementSubmissionCount = submittedBlobs.length;
    const puzzleRequestsBeforeReload = puzzleSolutionCoinIds.length;
    const controllerBeforeReplacementReload = lane.controller;
    let vanishedOutputCoinIds: string[] = [];

    lane = (
      await injectSessionReload(lane, poller, undefined, async () => {
        const replacementHeight = await fakeBlockchainInfo.replaceChain(
          preLandingHeight,
          landedHeight,
        );
        assert.equal(
          replacementHeight,
          landedHeight,
          'replacement chain must reach the persisted tip',
        );
        const replacementRecords = await fakeBlockchainInfo.getCoinRecordsByNames(
          landedWatches.map(({ coin_name }) => coin_name),
        );
        const landedRecordEntries = await Promise.all(
          landedRecords.map(async (record) => [await coinRecordToName(record), record] as const),
        );
        const replacementRecordEntries = await Promise.all(
          replacementRecords.map(
            async (record) => [await coinRecordToName(record), record] as const,
          ),
        );
        const landedRecordsByName = new Map(
          landedRecordEntries.filter(
            (entry): entry is readonly [string, (typeof landedRecords)[number]] =>
              entry[0] !== undefined,
          ),
        );
        const replacementRecordsByName = new Map(
          replacementRecordEntries.filter(
            (entry): entry is readonly [string, (typeof replacementRecords)[number]] =>
              entry[0] !== undefined,
          ),
        );
        vanishedOutputCoinIds = landedWatches
          .map(({ coin_name }) => coin_name)
          .filter(
            (coinName) =>
              landedRecordsByName.has(coinName) && !replacementRecordsByName.has(coinName),
          );
        assert.ok(
          vanishedOutputCoinIds.length > 0,
          'equal-tip replacement must remove at least one landed watched output',
        );
        const revivedInputCoinIds = landedWatches
          .map(({ coin_name }) => coin_name)
          .filter(
            (coinName) =>
              landedRecordsByName.get(coinName)?.spent === true &&
              replacementRecordsByName.get(coinName)?.spent === false,
          );
        assert.ok(
          revivedInputCoinIds.length > 0,
          'equal-tip replacement must revive a spent input from the retained transaction',
        );
        // Force the poll that used to race teardown. Before the reload harness
        // retired the old controller first, it consumed this replacement and
        // lost its queued transaction rebroadcast during teardown.
        await pollOnce(poller);
      })
    ).lane;
    assert.equal(lane.controller.getRestoreStatus(), 'restored');

    // Scheduled polling is stopped for this offline lane. An explicit poll may
    // intentionally decline to report after exhausting its coherent-snapshot
    // attempts. The recorder is shared by both controllers, so only the exact
    // retained bundle proves that the restored controller rebroadcast its transaction.
    const transactionRebroadcastPoll = await runBoundedPollAttempts(
      100,
      () => submittedBlobs.slice(preReplacementSubmissionCount).includes(finalizedBlob),
      async () => {
        await pollOnce(poller);
        await flushWrapperDrain(adapters);
        // The first pass releases the transaction rebroadcast into the controller
        // queue; the second persists finalization and releases its submission.
        await flushWrapperDrain(adapters);
      },
    );
    assert.equal(
      transactionRebroadcastPoll.completed,
      true,
      `exact retained transaction did not rebroadcast within ${transactionRebroadcastPoll.attempts} attempts`,
    );
    const transactionRebroadcasts = submittedBlobs.slice(preReplacementSubmissionCount);
    const watchedCoins = lane.controller.snapshotWatchedCoins();
    const rebroadcastProvenance = async (observed: string[]): Promise<string> =>
      `attempts=${transactionRebroadcastPoll.attempts}/100 completed=${transactionRebroadcastPoll.completed} ` +
      `peak=${await fakeBlockchainInfo.getHeightInfo()} ` +
      `submissions={total=${submittedBlobs.length},baseline=${baselineSubmissionCount},preReplacement=${preReplacementSubmissionCount},postReplacement=${observed.length}} ` +
      `expected={hash=${diagnosticBlobHash(finalizedBlob)},length=${finalizedBlob.length}} ` +
      `observed=[${diagnosticBlobSummary(observed)}] ` +
      `vanishedOutputCoinIds=[${vanishedOutputCoinIds.join(',')}] ` +
      `channelStatus=${lane.controller.lastChannelStatus?.state ?? 'none'} ` +
      `watchedCoins={count=${watchedCoins.length},ids=[${watchedCoins.map(({ coin_name }) => coin_name).join(',')}]} ` +
      `controller={uniqueId=${lane.controller.uniqueId},replaced=${controllerBeforeReplacementReload !== lane.controller},adapterOwnsController=${lane.adapter.blob === lane.controller}} ` +
      `runtime={adapterOwnsLaneRuntime=${lane.adapter.runtime === lane.runtime}} ` +
      `diagnosticLog=[${lane.controller.diagnosticLog.join('|')}]`;
    assert.equal(
      transactionRebroadcasts.filter((blob) => blob === finalizedBlob).length,
      1,
      `restore must rebroadcast exact transaction bytes once: ${await rebroadcastProvenance(transactionRebroadcasts)}`,
    );
    const replacementPuzzleRequests = puzzleSolutionCoinIds.slice(puzzleRequestsBeforeReload);
    assert.deepEqual(
      replacementPuzzleRequests.filter((coinId) => vanishedOutputCoinIds.includes(coinId)),
      [],
      `vanished output IDs must not request nonexistent puzzles and solutions; vanished=[${vanishedOutputCoinIds.join(',')}], requested=[${replacementPuzzleRequests.join(',')}]`,
    );
    assert.equal((await peekSession())?.phase, 'live');
    assert.equal(lane.controller.lastChannelStatus?.state, 'Unrolling');
    assert.notEqual(lane.controller.lastChannelStatus?.session_disposition, 'Abandoned');
    assert.equal(isTerminalChannelSnapshot(lane.controller.lastChannelStatus), false);

    await pollOnce(poller);
    await flushWrapperDrain(adapters);
    await lane.controller.flushPendingWork();
    const submissionsAfterRepeatedSnapshot = submittedBlobs.slice(preReplacementSubmissionCount);
    assert.equal(
      submissionsAfterRepeatedSnapshot.filter((blob) => blob === finalizedBlob).length,
      1,
      `a repeated replacement snapshot must not duplicate the transaction rebroadcast: ${await rebroadcastProvenance(submissionsAfterRepeatedSnapshot)}`,
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
      const poller = await startSimulator(['cafe00013', 'dead00013']);
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
