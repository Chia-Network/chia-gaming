import { fakeBlockchainInfo } from '../../hooks/FakeBlockchainInterface';
import type { ChiaGame, TransactionSubmission } from '../../types/ChiaGaming';
import { channelStatusModelFromPayload, createSessionModel } from '../session/model';
import { channelFundingRuntime } from '../session/channelFundingRuntime';
import WholeWasmObject from '../../../node-pkg/chia_gaming_wasm.js';
import {
  createActivePair,
  flushWrapperDrain,
  LONG_WASM_TEST_TIMEOUT,
  pollOnce,
  startSimulator,
} from './load_wasm.harness';
import { createReloadableSessionLane, injectSessionReload } from './reload_injection.harness';
// @ts-expect-error Node.js types are not included in the frontend TypeScript configuration.
import * as assert from 'assert';

interface CradleAccess {
  cradle: ChiaGame;
}

function captureRustSubmissions(
  controller: unknown,
  submissions: TransactionSubmission[],
  acknowledged: string[],
  relinquished: string[],
): void {
  const cradle = (controller as CradleAccess).cradle;
  const drain = cradle.drain_submissions.bind(cradle);
  cradle.drain_submissions = () => {
    const result = drain();
    submissions.push(...result.submissions);
    return result;
  };
  const acknowledge = cradle.acknowledge_submission_attempt.bind(cradle);
  cradle.acknowledge_submission_attempt = (token) => {
    acknowledged.push(token);
    return acknowledge(token);
  };
  const relinquish = cradle.relinquish_submission_attempt.bind(cradle);
  cradle.relinquish_submission_attempt = (token) => {
    relinquished.push(token);
    return relinquish(token);
  };
}

it(
  'preserves Rust-issued submission lineage and exact bytes across schema-22 reload',
  async () => {
    const poller = await startSimulator(['cafe00021', 'dead00021']);
    if (!poller) return;
    poller.stop();
    await pollOnce(poller);
    const provider = fakeBlockchainInfo.getWalletOfferProvider();
    if (provider) channelFundingRuntime.attachProvider(provider);

    const adapters = await createActivePair(poller, 21);
    const controller = adapters[0].blob!;
    const status = controller.lastChannelStatus;
    assert.ok(status);
    let lane = createReloadableSessionLane(
      adapters[0],
      controller,
      createSessionModel({ channel: { status: channelStatusModelFromPayload(status) } }),
    );
    lane.controller.getFee = () => 10n;

    const rustSubmissions: TransactionSubmission[] = [];
    const acknowledged: string[] = [];
    const relinquished: string[] = [];
    captureRustSubmissions(lane.controller, rustSubmissions, acknowledged, relinquished);

    const submittedBlobs: string[] = [];
    let feeOffers = 0;
    const originalSpend = fakeBlockchainInfo.spend;
    const originalBeginWalletOffer = fakeBlockchainInfo.beginWalletOffer;
    fakeBlockchainInfo.beginWalletOffer = async (...args) => {
      if (args[1].kind === 'fee' && ++feeOffers === 1) {
        return { kind: 'unavailable', reason: 'lineage base fallback' };
      }
      return originalBeginWalletOffer.apply(fakeBlockchainInfo, args);
    };
    fakeBlockchainInfo.spend = async (...args) => {
      submittedBlobs.push(args[0]);
      if (submittedBlobs.length === 1 || submittedBlobs.length === 3) {
        return { status: 'acknowledged' as const };
      }
      if (submittedBlobs.length === 2) {
        return { status: 'unavailable' as const, detail: 'lineage reload boundary' };
      }
      return originalSpend.apply(fakeBlockchainInfo, args);
    };

    try {
      assert.equal(WholeWasmObject.game_session_serialization_schema(), 23);
      assert.equal(lane.controller.goOnChain(), true);
      await flushWrapperDrain(adapters);

      lane.controller.attachBlockchain(poller);
      await flushWrapperDrain(adapters);
      await flushWrapperDrain(adapters);
      assert.equal(rustSubmissions.length, 2);
      const [initial, upgraded] = rustSubmissions;
      assert.equal(initial.relationship, 'initial');
      assert.equal(initial.predecessor_attempt_token, null);
      assert.equal(upgraded.id, initial.id);
      assert.equal(upgraded.relationship, 'newer-fee-bearing');
      assert.equal(upgraded.predecessor_attempt_token, initial.attempt_token);
      assert.deepEqual(acknowledged, [initial.attempt_token]);
      assert.ok(relinquished.includes(initial.attempt_token));
      assert.ok(relinquished.includes(upgraded.attempt_token));

      const upgradedBlob = submittedBlobs[1];
      const restored = await injectSessionReload(lane, poller, undefined, async () => {
        const restoredProvider = fakeBlockchainInfo.getWalletOfferProvider();
        if (restoredProvider) channelFundingRuntime.attachProvider(restoredProvider);
      });
      lane = restored.lane;
      assert.equal(restored.save.session.live.gameSessionSchemaVersion, 23n);
      captureRustSubmissions(lane.controller, rustSubmissions, acknowledged, relinquished);

      for (let attempt = 0; attempt < 20 && rustSubmissions.length < 3; attempt += 1) {
        await pollOnce(poller);
        await flushWrapperDrain(adapters);
      }
      await flushWrapperDrain(adapters);
      await flushWrapperDrain(adapters);
      assert.equal(rustSubmissions.length, 3);
      const exact = rustSubmissions[2]!;
      assert.equal(exact.id, initial.id);
      assert.equal(exact.relationship, 'exact');
      assert.equal(exact.predecessor_attempt_token, upgraded.attempt_token);
      assert.notDeepEqual(exact.bundle, initial.bundle);
      assert.equal(submittedBlobs[2], upgradedBlob);
      assert.ok(acknowledged.includes(exact.attempt_token));
      assert.ok(relinquished.includes(exact.attempt_token));
      assert.equal(feeOffers, 2, 'exact replay must not create another fee reservation');
    } finally {
      for (const adapter of adapters) {
        if (adapter.blob) poller.detachGameSession(adapter.blob);
      }
      poller.stop();
      for (const adapter of adapters) adapter.blob?.cleanup();
      fakeBlockchainInfo.spend = originalSpend;
      fakeBlockchainInfo.beginWalletOffer = originalBeginWalletOffer;
    }
  },
  LONG_WASM_TEST_TIMEOUT,
);
