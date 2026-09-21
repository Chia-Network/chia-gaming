import { fakeBlockchainInfo } from '../../hooks/FakeBlockchainInterface';
import { storageRepository } from '../session/storageRepository';
import { readSessionRecord, readWalletOperationRecord } from '../session/indexedDb';
import { channelStatusModelFromPayload, createSessionModel } from '../session/model';
import { walletOperationRuntime } from '../session/walletOperationRuntime';
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
  'broadcasts base, upgrades later under one intent, and exactly replays the upgrade',
  async () => {
    const poller = await startSimulator(['cafe00014', 'dead00014']);
    if (!poller) return;
    poller.stop();
    await pollOnce(poller);
    const provider = fakeBlockchainInfo.getWalletOfferProvider();
    if (provider) walletOperationRuntime.attachProvider(provider);

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
      if (args[1].kind === 'fee') {
        feeOfferCreations += 1;
        if (feeOfferCreations === 1) {
          return { kind: 'unavailable', reason: 'deterministic fee provider outage' };
        }
      }
      return originalBeginWalletOffer.apply(fakeBlockchainInfo, args);
    };
    fakeBlockchainInfo.spend = async (...args) => {
      submittedBlobs.push(args[0]);
      submittedFees.push(args[4]);
      if (submittedBlobs.length === 1) {
        const outcome = { status: 'acknowledged' as const };
        submissionOutcomes.push(outcome);
        return outcome;
      }
      if (submittedBlobs.length === 2) {
        const outcome = {
          status: 'unavailable' as const,
          detail: 'deterministic upgraded delivery outage',
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
      assert.equal(submittedBlobs.length, 1, 'fee unavailability must broadcast base immediately');
      assert.equal(submittedFees[0], undefined);
      assert.equal(feeOfferCreations, 1);
      assert.deepEqual(walletOperationRuntime.snapshot(), []);

      lane.controller.attachBlockchain(poller);
      await flushWrapperDrain(adapters);
      await flushWrapperDrain(adapters);
      assert.equal(submittedBlobs.length, 2, 'provider attachment must publish one fee upgrade');
      assert.equal(submittedFees[1], 10n);
      assert.equal(feeOfferCreations, 2);
      assert.notEqual(
        submittedBlobs[1],
        submittedBlobs[0],
        'fee upgrade must replace the current exact-byte variant',
      );

      const finalizedBlob = submittedBlobs[1]!;
      const retained = walletOperationRuntime.snapshot();
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
        readWalletOperationRecord(),
      ]);
      assert.equal(diskSession?.phase, 'live');
      assert.deepEqual(
        diskLedger?.entries,
        retained,
        'the live session and retained fee reservation must share one durable checkpoint',
      );

      const restored = await injectSessionReload(lane, poller, undefined, async () => {
        await storageRepository.hydrateOwnedStorage();
        const provider = fakeBlockchainInfo.getWalletOfferProvider();
        if (provider) walletOperationRuntime.attachProvider(provider);
      });
      lane = restored.lane;
      assert.equal(lane.controller.getRestoreStatus(), 'restored');
      assert.deepEqual(
        restored.save.live.serializedGameSession,
        diskSession?.phase === 'live' ? diskSession.live.serializedGameSession : undefined,
        'reload must consume the cradle bytes checkpointed with the fee ledger',
      );

      for (let attempt = 0; attempt < 20 && submittedBlobs.length < 3; attempt += 1) {
        await pollOnce(poller);
        await flushWrapperDrain(adapters);
        await flushWrapperDrain(adapters);
      }
      assert.equal(submittedBlobs.length, 3, 'fresh synchronization must replay once');
      assert.equal(submittedBlobs[2], finalizedBlob, 'replay must preserve exact upgraded bytes');
      assert.equal(submittedFees[2], 10n, 'exact replay must retain the upgraded fee');
      assert.equal(feeOfferCreations, 2, 'replay must not request a third fee offer');
      assert.deepEqual(submissionOutcomes[2], { status: 'acknowledged' });
      assert.equal(
        walletOperationRuntime.snapshot()[0]?.stage,
        'retained-for-replay',
        'wallet acknowledgement must not retire fee material before chain terminality',
      );

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
      for (
        let attempt = 0;
        attempt < 20 && walletOperationRuntime.snapshot().length > 0;
        attempt += 1
      ) {
        await pollOnce(poller);
        await flushWrapperDrain(adapters);
        await lane.controller.flushPendingWork();
        await lane.runtime.persist();
      }
      assert.deepEqual(
        cancellationOutcomes,
        [{ status: 'already-terminal', detail: 'simulator fee offer was spent' }],
        `landed fee cleanup stalled: ledger=${JSON.stringify(walletOperationRuntime.snapshot())} diagnostics=${lane.controller.diagnosticLog.join('|')}`,
      );
      assert.deepEqual(walletOperationRuntime.snapshot(), []);
      assert.deepEqual((await readWalletOperationRecord())?.entries, []);
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

it(
  'propagates an authoritative report_height error before draining real WASM',
  async () => {
    const poller = await startSimulator(['cafe00015', 'dead00015']);
    if (!poller) return;
    const adapters = await createActivePair(poller, 15);
    const controller = adapters[0].blob!;
    const cradle = (
      controller as unknown as {
        cradle: { report_height(height: bigint): unknown };
      }
    ).cradle;
    const before = controller.getWasmFields()?.serializedGameSession;
    assert.ok(before instanceof Uint8Array);

    try {
      assert.throws(
        () => cradle.report_height(1_000_000_000_001n),
        /report_height.*exceeds MAX_REPORTED_HEIGHT/i,
      );
      assert.deepEqual(controller.getWasmFields()?.serializedGameSession, before);
    } finally {
      for (const adapter of adapters) {
        if (adapter.blob) poller.detachGameSession(adapter.blob);
      }
      poller.stop();
      for (const adapter of adapters) adapter.blob?.cleanup();
    }
  },
  LONG_WASM_TEST_TIMEOUT,
);
