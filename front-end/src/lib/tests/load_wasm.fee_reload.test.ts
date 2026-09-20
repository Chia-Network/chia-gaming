import { fakeBlockchainInfo } from '../../hooks/FakeBlockchainInterface';
import { hydrateWalletReservationLedger } from '../../hooks/save';
import { readSessionRecord, readWalletReservationRecord } from '../session/indexedDb';
import { channelStatusModelFromPayload, createSessionModel } from '../session/model';
import { walletReservationLedger } from '../session/walletReservationLedger';
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

it(
  'checkpoints and exactly replays a simulator transaction with a persisted fee offer',
  async () => {
    const poller = await startSimulator(['cafe00014', 'dead00014']);
    if (!poller) return;
    poller.stop();
    await pollOnce(poller);
    walletReservationLedger.attachRpc(fakeBlockchainInfo);

    const adapters = await createActivePair(poller, 14);
    const controller = adapters[0].blob!;
    const status = controller.lastChannelStatus;
    assert.ok(status, 'fee replay lane must begin Active');
    let lane = createReloadableSessionLane(
      adapters[0],
      controller,
      createSessionModel({
        channel: { status: channelStatusModelFromPayload(status) },
      }),
    );
    lane.controller.getFee = () => 10n;
    const controllerErrors: string[] = [];
    const errorSubscription = lane.controller.getObservable().subscribe((event) => {
      if (event.type === 'error') controllerErrors.push(event.error);
    });

    const submittedBlobs: string[] = [];
    const submittedFees: Array<bigint | undefined> = [];
    const submissionOutcomes: Array<{ status: string; detail?: string }> = [];
    const cancellationOutcomes: Array<{ status: string; detail?: string }> = [];
    let feeOfferCreations = 0;
    const originalSpend = fakeBlockchainInfo.spend;
    const originalBeginWalletOffer = fakeBlockchainInfo.beginWalletOffer;
    const originalReleaseWalletOffer = fakeBlockchainInfo.beginWalletOfferCancellation;
    fakeBlockchainInfo.beginWalletOffer = async (...args) => {
      if (args[1].kind === 'fee') feeOfferCreations += 1;
      return originalBeginWalletOffer.apply(fakeBlockchainInfo, args);
    };
    fakeBlockchainInfo.spend = async (...args) => {
      submittedBlobs.push(args[0]);
      submittedFees.push(args[4]);
      if (submittedBlobs.length === 1) {
        const outcome = {
          status: 'unavailable' as const,
          detail: 'deterministic simulated delivery outage',
        };
        submissionOutcomes.push(outcome);
        return outcome;
      }
      const outcome = await originalSpend.apply(fakeBlockchainInfo, args);
      submissionOutcomes.push(outcome);
      return outcome;
    };
    fakeBlockchainInfo.beginWalletOfferCancellation = async (...args) => {
      const outcome = await originalReleaseWalletOffer.apply(fakeBlockchainInfo, args);
      cancellationOutcomes.push(outcome);
      return outcome;
    };

    try {
      assert.equal(lane.controller.goOnChain(), true);
      await flushWrapperDrain(adapters);
      assert.equal(submittedBlobs.length, 1, 'the first finalized delivery must be attempted once');
      assert.equal(submittedFees[0], 10n, 'Rust must attach the configured nonzero fee');
      assert.equal(feeOfferCreations, 1, 'the first delivery must create one fee offer');

      const finalizedBlob = submittedBlobs[0]!;
      const retained = walletReservationLedger.snapshot();
      assert.equal(
        retained.length,
        1,
        `fee source was not retained: fees=${submittedFees.join(',')} cancellations=${JSON.stringify(cancellationOutcomes)}\n${lane.controller.diagnosticLog.join('\n')}`,
      );
      assert.equal(retained[0]!.purpose.kind, 'fee');
      assert.equal(
        retained[0]!.stage,
        'retained-for-replay',
        `fee was not attached: fees=${submittedFees.join(',')} cancellations=${JSON.stringify(cancellationOutcomes)} errors=${controllerErrors.join('|')}`,
      );

      await lane.runtime.persist();
      await lane.controller.flushPendingWork();
      await lane.runtime.persist();
      const [diskSession, diskLedger] = await Promise.all([
        readSessionRecord(),
        readWalletReservationRecord(),
      ]);
      assert.equal(diskSession?.phase, 'live');
      assert.deepEqual(
        diskLedger?.entries,
        retained,
        'the live session and retained fee reservation must share one durable checkpoint',
      );

      const restored = await injectSessionReload(lane, poller, undefined, async () => {
        await hydrateWalletReservationLedger();
        walletReservationLedger.attachRpc(fakeBlockchainInfo);
      });
      lane = restored.lane;
      assert.equal(lane.controller.getRestoreStatus(), 'restored');
      assert.deepEqual(
        restored.save.live.serializedGameSession,
        diskSession?.phase === 'live' ? diskSession.live.serializedGameSession : undefined,
        'reload must consume the cradle bytes checkpointed with the fee ledger',
      );

      for (let attempt = 0; attempt < 20 && submittedBlobs.length < 2; attempt += 1) {
        await pollOnce(poller);
        await flushWrapperDrain(adapters);
        await flushWrapperDrain(adapters);
      }
      assert.equal(submittedBlobs.length, 2, 'fresh synchronization must replay once');
      assert.equal(submittedBlobs[1], finalizedBlob, 'replay must preserve exact finalized bytes');
      assert.equal(submittedFees[1], 10n, 'exact replay must retain the original applied fee');
      assert.equal(feeOfferCreations, 1, 'replay must not request a second fee offer');
      assert.deepEqual(submissionOutcomes[1], { status: 'acknowledged' });

      for (
        let attempt = 0;
        attempt < 20 && walletReservationLedger.snapshot().length > 0;
        attempt += 1
      ) {
        await lane.controller.flushPendingWork();
        await lane.runtime.persist();
      }
      assert.deepEqual(cancellationOutcomes, [
        { status: 'already-terminal', detail: 'simulator fee offer was spent' },
      ]);
      assert.deepEqual(walletReservationLedger.snapshot(), []);
      assert.deepEqual((await readWalletReservationRecord())?.entries, []);

      for (
        let block = 0;
        block < 10 && lane.controller.lastChannelStatus?.state === 'GoingOnChain';
        block += 1
      ) {
        await fakeBlockchainInfo.farmBlock();
        await pollOnce(poller);
        await flushWrapperDrain(adapters);
      }
      assert.equal(
        lane.controller.lastChannelStatus?.state,
        'Unrolling',
        'the simulator must definitively observe the fee-bearing channel spend',
      );
    } finally {
      for (const adapter of adapters) {
        if (adapter.blob) poller.detachGameSession(adapter.blob);
      }
      poller.stop();
      for (const adapter of adapters) adapter.blob?.cleanup();
      errorSubscription.unsubscribe();
      fakeBlockchainInfo.spend = originalSpend;
      fakeBlockchainInfo.beginWalletOffer = originalBeginWalletOffer;
      fakeBlockchainInfo.beginWalletOfferCancellation = originalReleaseWalletOffer;
    }
  },
  LONG_WASM_TEST_TIMEOUT,
);
