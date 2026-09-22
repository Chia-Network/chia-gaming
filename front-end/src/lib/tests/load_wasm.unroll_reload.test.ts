import { WasmStateInit } from '../../hooks/WasmStateInit';
import { fakeBlockchainInfo } from '../../hooks/FakeBlockchainInterface';
import type { BlockchainPoller } from '../../hooks/BlockchainPoller';
import { storageRepository } from '../session/storageRepository';
import { markSavedSession } from '../../hooks/saveCoordination';
import {
  buildDurableApplicationState,
  type TerminalCapture,
} from '../session/sessionMachinePersist';
import { rehydrateDurableApplicationState } from '../session/persistence';
import { channelStatusModelFromPayload, createSessionModel } from '../session/model';
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
  persistTerminal: async (capture: TerminalCapture) => {
    const snapshot = buildDurableApplicationState(capture);
    if (!snapshot) throw new Error('expected terminal snapshot');
    await storageRepository.write(snapshot);
  },
  updateMarker: markSavedSession,
  teardown: () => {},
};

function diagnosticBlobHash(blob: string): string {
  return createHash('sha256').update(blob).digest('hex');
}

function diagnosticBlobSummary(blobs: string[]): string {
  return blobs.map((blob) => `{hash=${diagnosticBlobHash(blob)},length=${blob.length}}`).join(',');
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
  const ids = [...lane.runtime.getState().model.game.activeIds];
  assert.equal(ids.length, 1);

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
  const terminalSave = await storageRepository.readCurrentState();
  assert.equal(terminalSave?.session?.phase, 'terminal');
  assert.equal(
    terminalSave &&
      rehydrateDurableApplicationState(terminalSave).model.game.instances[ids[0]]?.presentation,
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
  assert.equal((await storageRepository.readCurrentState())?.session?.phase, 'terminal');
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
  const [gameId] = lane.runtime.getState().model.game.activeIds;
  assert.ok(gameId);
  lane.controller.makeMove(gameId, null);
  await exchangeUntilIdle(adapters);

  const submittedBlobs: string[] = [];
  const puzzleSolutionCoinIds: string[] = [];
  const registeredCoinIds: string[] = [];
  const protocolWatchedCoinIds: string[] = [];
  const originalSpend = fakeBlockchainInfo.spend;
  const originalGetPuzzleAndSolution = fakeBlockchainInfo.getPuzzleAndSolution;
  const originalRegisterCoins = fakeBlockchainInfo.registerCoins;
  const originalWatchCoin = poller.watchCoin;
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
  fakeBlockchainInfo.registerCoins = async (...args: Parameters<typeof originalRegisterCoins>) => {
    registeredCoinIds.push(...args[0]);
    return originalRegisterCoins.apply(fakeBlockchainInfo, args);
  };
  poller.watchCoin = (...args: Parameters<typeof originalWatchCoin>) => {
    protocolWatchedCoinIds.push(args[1].coin_name);
    return originalWatchCoin.apply(poller, args);
  };

  try {
    const baselineSubmissionCount = submittedBlobs.length;
    const channelWatches = lane.controller.snapshotWatchedCoins();
    const channelCoin = lane.controller
      .getCoinsOfInterest()
      .find(({ label }) => label === 'Channel coin');
    assert.ok(channelCoin, 'active protocol state must identify its channel coin');
    const channelInput = channelWatches.find(({ coin_name }) => coin_name === channelCoin.id);
    assert.ok(channelInput, 'the protocol channel coin must be present in the durable watch set');
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
    const unrollCoin = lane.controller
      .getCoinsOfInterest()
      .find(({ label }) => label === 'Unroll coin');
    assert.ok(unrollCoin, 'channel-spend observation must identify the exact unroll output');
    const unrollOutput = lane.controller
      .snapshotWatchedCoins()
      .find(({ coin_name }) => coin_name === unrollCoin.id);
    assert.ok(unrollOutput, 'the exact unroll output must be present in the durable watch set');
    assert.deepEqual(
      protocolWatchedCoinIds.filter((coinId) => coinId === unrollOutput.coin_name),
      [unrollOutput.coin_name],
      'the exact unroll output must arrive through one protocol watch intent',
    );

    // Registration follows the protocol watch on the next coherent poll. That
    // poll must also observe the exact output as landed before replacement.
    await pollOnce(poller);
    await flushWrapperDrain(adapters);
    assert.ok(
      registeredCoinIds.includes(unrollOutput.coin_name),
      'the exact unroll output must be registered with the chain provider before replacement',
    );
    const landedRecords = await fakeBlockchainInfo.getCoinRecordsByNames([
      channelInput.coin_name,
      unrollOutput.coin_name,
    ]);
    const landedRecordEntries = await Promise.all(
      landedRecords.map(async (record) => [await coinRecordToName(record), record] as const),
    );
    const landedRecordsByName = new Map(
      landedRecordEntries.filter(
        (entry): entry is readonly [string, (typeof landedRecords)[number]] =>
          entry[0] !== undefined,
      ),
    );
    const landedChannelInput = landedRecordsByName.get(channelInput.coin_name);
    const landedUnrollOutput = landedRecordsByName.get(unrollOutput.coin_name);
    assert.equal(
      landedChannelInput?.spent,
      true,
      'the finalized bundle must spend the exact watched channel input',
    );
    assert.equal(
      landedUnrollOutput?.spent,
      false,
      'the exact protocol-watched unroll output must land unspent',
    );
    assert.ok(landedChannelInput);
    assert.ok(landedUnrollOutput);
    assert.equal(
      landedChannelInput.spentBlockIndex,
      landedUnrollOutput.confirmedBlockIndex,
      'the exact channel spend and unroll output must land in the same block',
    );
    assert.ok(
      landedUnrollOutput.confirmedBlockIndex > 0n,
      'the landed unroll output must have a predecessor block',
    );
    const replacementBaseHeight = landedUnrollOutput.confirmedBlockIndex - 1n;
    const landedHeight = await fakeBlockchainInfo.getHeightInfo();
    assert.ok(landedHeight > preLandingHeight, 'landing must advance the simulator tip');
    const preReplacementSubmissionCount = submittedBlobs.length;
    const puzzleRequestsBeforeReload = puzzleSolutionCoinIds.length;
    const controllerBeforeReplacementReload = lane.controller;

    lane = (
      await injectSessionReload(lane, poller, undefined, async () => {
        const replacementHeight = await fakeBlockchainInfo.replaceChain(
          replacementBaseHeight,
          landedHeight,
        );
        assert.equal(
          replacementHeight,
          landedHeight,
          'replacement chain must reach the persisted tip',
        );
        const replacementRecords = await fakeBlockchainInfo.getCoinRecordsByNames([
          channelInput.coin_name,
          unrollOutput.coin_name,
        ]);
        const replacementRecordEntries = await Promise.all(
          replacementRecords.map(
            async (record) => [await coinRecordToName(record), record] as const,
          ),
        );
        const replacementRecordsByName = new Map(
          replacementRecordEntries.filter(
            (entry): entry is readonly [string, (typeof replacementRecords)[number]] =>
              entry[0] !== undefined,
          ),
        );
        assert.equal(
          replacementRecordsByName.has(unrollOutput.coin_name),
          false,
          'equal-tip replacement must remove the exact landed unroll output',
        );
        assert.equal(
          replacementRecordsByName.get(channelInput.coin_name)?.spent,
          false,
          'equal-tip replacement must revive the finalized bundle channel input',
        );
        // Force the poll that used to race teardown. Before the reload harness
        // retired the old controller first, it consumed this replacement and
        // lost its queued transaction rebroadcast during teardown.
        await pollOnce(poller);
      })
    ).lane;
    assert.equal(lane.controller.getRestoreStatus(), 'restored');

    // One coherent restored snapshot queues the replay; the two fixed-point
    // drains persist finalization and release the exact broadcast.
    await pollOnce(poller);
    await flushWrapperDrain(adapters);
    await flushWrapperDrain(adapters);
    await lane.controller.flushPendingWork();
    const transactionRebroadcasts = submittedBlobs.slice(preReplacementSubmissionCount);
    const watchedCoins = lane.controller.snapshotWatchedCoins();
    const rebroadcastProvenance = async (observed: string[]): Promise<string> =>
      `peak=${await fakeBlockchainInfo.getHeightInfo()} ` +
      `submissions={total=${submittedBlobs.length},baseline=${baselineSubmissionCount},preReplacement=${preReplacementSubmissionCount},postReplacement=${observed.length}} ` +
      `expected={hash=${diagnosticBlobHash(finalizedBlob)},length=${finalizedBlob.length}} ` +
      `observed=[${diagnosticBlobSummary(observed)}] ` +
      `channelInput=${channelInput.coin_name} unrollOutput=${unrollOutput.coin_name} ` +
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
      replacementPuzzleRequests.filter((coinId) => coinId === unrollOutput.coin_name),
      [],
      `vanished unroll output must not request a nonexistent puzzle and solution; output=${unrollOutput.coin_name}, requested=[${replacementPuzzleRequests.join(',')}]`,
    );
    assert.equal((await storageRepository.readCurrentState())?.session?.phase, 'live');
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
    fakeBlockchainInfo.registerCoins = originalRegisterCoins;
    poller.watchCoin = originalWatchCoin;
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
