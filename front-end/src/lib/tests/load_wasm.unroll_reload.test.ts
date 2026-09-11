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
  process.stderr.write(`[DBG_UNROLL] init pair suffix=${suffix}\n`);
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
  process.stderr.write(`[DBG_UNROLL] inits done suffix=${suffix}\n`);
  controllers.forEach((activeController, index) => {
    activeController.pairingToken = `reload-asymmetric-${suffix}-${index}`;
    activeController.perGameAmount = 100n;
    activeController.onSaveNeeded = () => Promise.resolve();
    adapters[index].set_blob(activeController);
  });
  process.stderr.write(`[DBG_UNROLL] handshake start suffix=${suffix}\n`);
  await action_with_messages(poller, adapters[0], adapters[1]);
  process.stderr.write(`[DBG_UNROLL] handshake done suffix=${suffix}\n`);
  return adapters;
}

async function runUnrollReloadAndAdvance(poller: BlockchainPoller): Promise<void> {
  process.stderr.write('[DBG_UNROLL] runUnrollReloadAndAdvance start\n');
  const adapters = await createAsymmetricActivePair(poller, 10);
  process.stderr.write('[DBG_UNROLL] pair active\n');
  const controller = adapters[0].blob!;
  const status = controller.lastChannelStatus;
  assert.ok(status, 'unroll reload lane must begin Active');
  const handProposal: HandProposal = {
    gameType: 'calpoker',
    playerAContribution: 20n,
    playerBContribution: 20n,
    senderIsPlayerA: false,
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
  120 * 1000,
);
