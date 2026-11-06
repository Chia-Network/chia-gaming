import { protocolIdForCatalog } from '../gameIdentities';
import type { WalletOfferCompletion, WalletOfferProvider } from '../../types/ChiaGaming';
import { observeWasmEvents } from './session_execution.harness';
import { channelFundingRuntime } from '../session/channelFundingRuntime';
import { readApplicationState } from '../session/indexedDb';
import { channelStatusModelFromPayload, createSessionModel } from '../session/model';
import { storageRepository } from '../session/storageRepository';
import { fakeBlockchainInfo } from '../wallet/FakeBlockchainInterface';
import {
  createActivePair,
  exchangeUntilIdle,
  flushWrapperDrain,
  LONG_WASM_TEST_TIMEOUT,
  pollOnce,
  startSimulator,
} from './load_wasm.harness';
import { createReloadableSessionLane, injectSessionReload } from './reload_injection.harness';
// @ts-expect-error Node.js types are not included in the frontend TypeScript configuration.
import * as assert from 'assert';

it(
  'resumes the same pending fee after provider loss at its checkpoint and Rust base fallback',
  async () => {
    const poller = await startSimulator(['cafe00017', 'dead00017']);
    if (!poller) return;
    poller.pauseChainPolling();
    await pollOnce(poller);
    const adapters = await createActivePair(poller, 17);
    const controller = adapters[0].blob!;
    const status = controller.lastChannelStatus;
    assert.ok(status);
    const lane = createReloadableSessionLane(
      adapters[0],
      controller,
      createSessionModel({ channel: { status: channelStatusModelFromPayload(status) } }),
    );
    // Both simulated peers share one repository; this lane owns its checkpoint.
    const detachPersistence = storageRepository.attachRuntime(controller);
    controller.getFee = () => 10n;
    const originalProvider = fakeBlockchainInfo.getWalletOfferProvider;
    const originalSpend = fakeBlockchainInfo.spend;
    const realCheckpoint = storageRepository.checkpointDomainMutations.bind(storageRepository);
    let material: WalletOfferCompletion | undefined;
    const provider: WalletOfferProvider = {
      capability: 'recoverable',
      scope: controller.getWalletProviderScope(),
      beginCreation: jest.fn(async (operation, request) => {
        material = await fakeBlockchainInfo.beginWalletOffer(operation, request);
        assert.equal(material.kind, 'created-reserved');
        return { kind: 'pending', recoveryId: 'checkpoint-fee-recovery' };
      }),
      reconcileCreation: jest.fn(async () => {
        assert.ok(material);
        return material;
      }),
      beginCancellation: jest.fn((id) => fakeBlockchainInfo.beginWalletOfferCancellation(id)),
      reconcileCancellation: jest.fn(),
    };
    fakeBlockchainInfo.getWalletOfferProvider = () => provider;
    channelFundingRuntime.attachProvider(provider);
    const fees: Array<bigint | undefined> = [];
    fakeBlockchainInfo.spend = async (...args) => {
      fees.push(args[4]);
      return { status: 'acknowledged' };
    };
    let disconnected = false;
    let checkpointedStage: string | undefined;
    const checkpoint = jest
      .spyOn(storageRepository, 'checkpointDomainMutations')
      .mockImplementation(async () => {
        await realCheckpoint();
        if (!disconnected && storageRepository.feeAttachments()[0]?.stage === 'creating') {
          const saved = await readApplicationState();
          checkpointedStage = saved?.feeAttachments[0]?.stage;
          disconnected = true;
          channelFundingRuntime.detachProvider(provider);
        }
      });
    try {
      assert.equal(controller.goOnChain(), true);
      await flushWrapperDrain(adapters);
      assert.equal(disconnected, true);
      assert.equal(checkpointedStage, 'creating', 'provider loss must follow the durable request');
      assert.deepEqual(fees, [undefined], 'Rust must acknowledge the base fallback');
      expect(provider.beginCreation).toHaveBeenCalledTimes(1);
      expect(provider.reconcileCreation).not.toHaveBeenCalled();
      const pending = storageRepository.feeAttachments();
      assert.equal(pending.length, 1);
      assert.equal(pending[0]?.stage, 'creating');
      assert.equal(pending[0]?.stage === 'creating' && pending[0].disposition, 'active');

      controller.setWallet(null);
      controller.setWallet(poller);
      await flushWrapperDrain(adapters);
      await lane.runtime.flush();

      assert.deepEqual(
        fees,
        [undefined, 10n],
        'wallet readiness must upgrade the same Rust intent',
      );
      expect(provider.beginCreation).toHaveBeenCalledTimes(1);
      expect(provider.reconcileCreation).toHaveBeenCalledTimes(1);
      expect(provider.reconcileCreation).toHaveBeenCalledWith(
        expect.objectContaining({
          purpose: { kind: 'fee', operationId: pending[0]!.submissionId },
        }),
        expect.anything(),
        'checkpoint-fee-recovery',
        expect.objectContaining({ mode: 'delivery' }),
      );
      expect(provider.beginCancellation).not.toHaveBeenCalled();
      assert.equal(storageRepository.feeAttachments()[0]?.stage, 'retained-for-replay');
      assert.equal(storageRepository.feeAttachments()[0]?.submissionId, pending[0]!.submissionId);
      assert.deepEqual(
        (await readApplicationState())?.feeAttachments,
        storageRepository.feeAttachments(),
      );
    } finally {
      checkpoint.mockRestore();
      for (const adapter of adapters) {
        if (adapter.blob) poller.detachGameSession(adapter.blob);
      }
      poller.pauseChainPolling();
      for (const adapter of adapters) adapter.blob?.cleanup();
      lane.subscription.unsubscribe();
      detachPersistence();
      channelFundingRuntime.detachProvider(provider);
      fakeBlockchainInfo.getWalletOfferProvider = originalProvider;
      fakeBlockchainInfo.spend = originalSpend;
    }
  },
  LONG_WASM_TEST_TIMEOUT,
);

it(
  'broadcasts base, upgrades later under one intent, and exactly replays the upgrade',
  async () => {
    const poller = await startSimulator(['cafe00014', 'dead00014']);
    if (!poller) return;
    poller.pauseChainPolling();
    await pollOnce(poller);
    const provider = fakeBlockchainInfo.getWalletOfferProvider();
    if (provider) channelFundingRuntime.attachProvider(provider);

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
    const errorSubscription = observeWasmEvents(lane.controller).subscribe((event) => {
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
      assert.deepEqual(storageRepository.feeAttachments(), []);

      lane.controller.setWallet(null);
      lane.controller.setWallet(poller);
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
      const retained = storageRepository.feeAttachments();
      assert.equal(
        retained.length,
        1,
        `fee source was not retained: fees=${submittedFees.join(',')} cancellations=${JSON.stringify(cancellationOutcomes)}\n${lane.controller.diagnosticLog.join('\n')}`,
      );
      assert.equal(retained[0]!.submissionId.length > 0, true);
      assert.equal(
        retained[0]!.stage,
        'retained-for-replay',
        `fee was not attached: fees=${submittedFees.join(',')} cancellations=${JSON.stringify(cancellationOutcomes)} errors=${controllerErrors.join('|')}`,
      );

      await lane.runtime.flush();
      await lane.controller.flushPendingWork();
      await lane.runtime.flush();
      const diskState = await readApplicationState();
      assert.equal(diskState?.session?.phase, 'live');
      assert.deepEqual(
        diskState?.feeAttachments,
        retained,
        'the live session and retained fee reservation must share one durable checkpoint',
      );

      const restored = await injectSessionReload(lane, poller, undefined, async () => {
        const provider = fakeBlockchainInfo.getWalletOfferProvider();
        if (provider) channelFundingRuntime.attachProvider(provider);
      });
      lane = restored.lane;
      assert.equal(lane.controller.getRestoreStatus(), 'restored');
      assert.deepEqual(
        restored.save.session.live.serializedGameSession,
        diskState?.session?.phase === 'live'
          ? diskState.session.live.serializedGameSession
          : undefined,
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
        storageRepository.feeAttachments()[0]?.stage,
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
        attempt < 20 && storageRepository.feeAttachments().length > 0;
        attempt += 1
      ) {
        await pollOnce(poller);
        await flushWrapperDrain(adapters);
        await lane.controller.flushPendingWork();
        await lane.runtime.flush();
      }
      assert.deepEqual(
        cancellationOutcomes,
        [{ status: 'already-terminal', detail: 'simulator fee offer was spent' }],
        `landed fee cleanup stalled: ledger=${JSON.stringify(storageRepository.feeAttachments())} diagnostics=${lane.controller.diagnosticLog.join('|')}`,
      );
      assert.deepEqual(storageRepository.feeAttachments(), []);
      assert.deepEqual((await readApplicationState())?.feeAttachments, []);
    } finally {
      for (const adapter of adapters) {
        if (adapter.blob) poller.detachGameSession(adapter.blob);
      }
      poller.pauseChainPolling();
      for (const adapter of adapters) adapter.blob?.cleanup();
      errorSubscription.unsubscribe();
      fakeBlockchainInfo.spend = originalSpend;
      fakeBlockchainInfo.beginWalletOffer = originalBeginWalletOffer;
      fakeBlockchainInfo.beginWalletOfferCancellation = originalReleaseWalletOffer;
    }
  },
  LONG_WASM_TEST_TIMEOUT,
);

it.each(['channel spend', 'on-chain game move'])(
  'keeps one fee approval for %s when a fresh snapshot arrives during wallet approval',
  async (transactionKind) => {
    const poller = await startSimulator(['cafe00016', 'dead00016']);
    if (!poller) return;
    poller.pauseChainPolling();
    await pollOnce(poller);
    const provider = fakeBlockchainInfo.getWalletOfferProvider();
    if (provider) channelFundingRuntime.attachProvider(provider);
    const adapters = await createActivePair(poller, 16);
    let controller = adapters[0].blob!;
    let gameId: string | undefined;
    if (transactionKind === 'on-chain game move') {
      const statuses = ['', ''];
      const subscriptions = adapters.map((adapter, index) =>
        observeWasmEvents(adapter.blob!).subscribe((event) => {
          if (event.type !== 'notification') return;
          if (event.data.ProposalAcceptedGroup) {
            gameId = String(event.data.ProposalAcceptedGroup.members[0].id);
          }
          if (event.data.GameStatus) statuses[index] = event.data.GameStatus.status;
        }),
      );
      try {
        const [proposalId] = controller.proposeGame({
          game_type: protocolIdForCatalog('calpoker'),
          timeout: 15n,
          sender_is_player_a: false,
          parameters: 20n,
        });
        await exchangeUntilIdle(adapters);
        adapters[1].blob!.acceptProposal(proposalId);
        await exchangeUntilIdle(adapters);
        assert.ok(gameId);
        controller.makeMove(gameId, null);
        await exchangeUntilIdle(adapters);
        for (const adapter of adapters) poller.attachGameSession(adapter.blob!);
        assert.equal(controller.goOnChain(), true);
        await flushWrapperDrain(adapters);
        for (let block = 0; block < 80 && !statuses.includes('on-chain-my-turn'); block += 1) {
          await fakeBlockchainInfo.farmBlock();
          await pollOnce(poller);
          await flushWrapperDrain(adapters);
        }
        const moverIndex = statuses.indexOf('on-chain-my-turn');
        assert.ok(moverIndex >= 0, `expected a real on-chain game turn, got ${statuses}`);
        controller = adapters[moverIndex].blob!;
      } finally {
        subscriptions.forEach((subscription) => subscription.unsubscribe());
      }
    }
    controller.getFee = () => 10n;
    const originalBegin = fakeBlockchainInfo.beginWalletOffer;
    const originalCancel = fakeBlockchainInfo.beginWalletOfferCancellation;
    let enteredApproval!: () => void;
    let approve!: () => void;
    const approvalStarted = new Promise<void>((resolve) => {
      enteredApproval = resolve;
    });
    const approval = new Promise<void>((resolve) => {
      approve = resolve;
    });
    let creations = 0;
    const feeSubmissionIds: string[] = [];
    let cancellations = 0;
    fakeBlockchainInfo.beginWalletOffer = async (...args) => {
      if (args[1].kind === 'fee') {
        creations += 1;
        feeSubmissionIds.push(args[0].purpose.operationId);
        enteredApproval();
        await approval;
      }
      return originalBegin.apply(fakeBlockchainInfo, args);
    };
    fakeBlockchainInfo.beginWalletOfferCancellation = async (...args) => {
      cancellations += 1;
      return originalCancel.apply(fakeBlockchainInfo, args);
    };
    try {
      if (gameId) controller.makeMove(gameId, null);
      else assert.equal(controller.goOnChain(), true);
      await approvalStarted;
      await controller.reportChainSnapshotReady(poller.getPeak());
      approve();
      await flushWrapperDrain(adapters);
      await controller.reportChainSnapshotReady(poller.getPeak());
      await flushWrapperDrain(adapters);
      assert.equal(
        creations,
        1,
        `fresh synchronization must preserve the pending fee approval; submission IDs=${feeSubmissionIds}`,
      );
      assert.equal(
        cancellations,
        0,
        'a live fee approval must not be retired by fresh synchronization',
      );
      assert.equal(storageRepository.feeAttachments()[0]?.stage, 'retained-for-replay');
      assert.equal(storageRepository.feeAttachments()[0]?.submissionId, feeSubmissionIds[0]);
    } finally {
      approve();
      for (const adapter of adapters) {
        if (adapter.blob) poller.detachGameSession(adapter.blob);
      }
      poller.pauseChainPolling();
      for (const adapter of adapters) adapter.blob?.cleanup();
      fakeBlockchainInfo.beginWalletOffer = originalBegin;
      fakeBlockchainInfo.beginWalletOfferCancellation = originalCancel;
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
      poller.pauseChainPolling();
      for (const adapter of adapters) adapter.blob?.cleanup();
    }
  },
  LONG_WASM_TEST_TIMEOUT,
);
