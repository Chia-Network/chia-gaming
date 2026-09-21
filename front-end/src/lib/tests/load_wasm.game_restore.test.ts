import { WasmStateInit } from '../../hooks/WasmStateInit';
import { SessionController } from '../../hooks/SessionController';
import { restoreSession } from '../../hooks/blobSingleton';
import { storageRepository } from '../session/storageRepository';
import { decodePersistedGameState } from '../gameRegistry';
import { protocolIdForCatalog } from '../gameIdentities';
import { SESSION_DB_NAME } from '../session/indexedDb';
import {
  channelStatusModelFromPayload,
  createSessionModel,
  INITIAL_GAME_TERMINAL_MODEL,
  sessionModelFromSave,
  snapshotFromSessionModel,
} from '../session/model';
import { krunkStateCodec } from '@games/krunk/ui/serialize';
import type { HandProposal } from '../session/types';
import {
  createActivePair,
  exchangeUntilIdle,
  fetchPreset,
  flushWrapperDrain,
  LONG_WASM_TEST_TIMEOUT,
  makeTestReliableState,
  postMoveHandState,
  startSimulator,
} from './load_wasm.harness';
import { liveSave } from './session_save_envelope.fixtures';
// @ts-expect-error Node.js types are not included in the frontend TypeScript configuration.
import * as assert from 'assert';

async function runRealGameRestoreCases(poller: BlockchainPoller): Promise<void> {
  const cases: Array<{ handProposal: HandProposal; expectedMembers: number }> = [
    {
      handProposal: {
        gameType: 'calpoker',
        senderIsPlayerA: false,
        gameTimeout: 15n,
        parameters: 100n,
      },
      expectedMembers: 1,
    },
    {
      handProposal: {
        gameType: 'spacepoker',
        senderIsPlayerA: false,
        gameTimeout: 15n,
        parameters: [10n, 10n],
      },
      expectedMembers: 1,
    },
    {
      handProposal: {
        gameType: 'krunk',
        senderIsPlayerA: true,
        gameTimeout: 15n,
        parameters: 100n,
      },
      expectedMembers: 2,
    },
  ];

  for (const [index, testCase] of cases.entries()) {
    const cradles = await createActivePair(poller, index);
    const proposer = cradles[0].blob!;
    const mover = cradles[1].blob!;
    const proposalIds = proposer.proposeGame({
      game_type: protocolIdForCatalog(testCase.handProposal.gameType),
      timeout: testCase.handProposal.gameTimeout,
      sender_is_player_a: testCase.handProposal.senderIsPlayerA,
      parameters: testCase.handProposal.parameters,
    });
    assert.equal(proposalIds.length, 1);
    await exchangeUntilIdle(cradles);
    mover.acceptProposal(proposalIds[0]);
    await exchangeUntilIdle(cradles);
    const ids = [...mover.activeGameIds];
    assert.equal(ids.length, testCase.expectedMembers);
    assert.deepEqual(proposer.activeGameIds, ids);

    const actionIsProposer = testCase.handProposal.gameType !== 'krunk';
    const actionController = actionIsProposer ? proposer : mover;
    const postMove = postMoveHandState(testCase.handProposal, ids);
    const beforeMove = Uint8Array.from(actionController.getWasmFields()!.serializedGameSession);
    actionController.makeMove(postMove.moverId, postMove.move);
    await flushWrapperDrain([cradles[actionIsProposer ? 0 : 1]]);
    const afterMove = actionController.getWasmFields()!;
    assert.notDeepEqual(
      afterMove.serializedGameSession,
      beforeMove,
      `${testCase.handProposal.gameType}: actual WASM move must change serialized protocol state`,
    );
    const status = mover.lastChannelStatus;
    assert.ok(
      status,
      `${testCase.handProposal.gameType}: active controller must have channel status`,
    );
    const model = createSessionModel({
      channel: { status: channelStatusModelFromPayload(status) },
      game: {
        handKey: 1,
        activeIds: ids,
        currentHandIds: ids,
        currentHandOrigin: actionIsProposer ? 'local' : 'peer',
        lastDisplayedId: postMove.moverId,
        activeGameType: testCase.handProposal.gameType,
        handState: postMove.handState,
        instances: Object.fromEntries(
          ids.map((id) => [
            id,
            {
              id,
              amount: '100',
              coinHex: null,
              presentation: 'off-chain-their-turn' as const,
              terminal: INITIAL_GAME_TERMINAL_MODEL,
            },
          ]),
        ),
      },
      betweenHand: { lastHandProposal: testCase.handProposal },
    });
    const save = liveSave({
      ...afterMove,
      pairingToken: `real-restore-${testCase.handProposal.gameType}`,
      ...snapshotFromSessionModel(model),
    });
    assert.equal(save.phase, 'live');
    if (save.phase !== 'live') throw new Error('expected live save');
    await storageRepository.saveSession({
      scope: 'live',
      walletProviderScope: save.walletProviderScope,
      pairing: save.pairing,
      live: save.live,
      presentation: save.presentation,
      history: save.history,
    });
    await storageRepository.flushSessionSave();

    await flushWrapperDrain(cradles);
    storageRepository._resetForTests();
    await storageRepository.claimLease();
    const reloaded = await storageRepository.peekSession();
    assert.ok(
      reloaded,
      `${testCase.handProposal.gameType}: IndexedDB peek must return saved session`,
    );
    assert.equal(reloaded.phase, 'live');
    if (reloaded.phase !== 'live') throw new Error('expected live reload');
    assert.deepEqual(reloaded.presentation.currentHandGameIds, ids);
    assert.deepEqual(reloaded.presentation.activeGameIds, ids);

    const restored = new SessionController(poller, `feed000${index}`, 100n, 100n, {
      reliableState: makeTestReliableState(),
      sendMessage: () => true,
      sendAck: () => true,
      sendKeepalive: () => true,
      hostLog: () => {},
      close: () => {},
    });
    try {
      await restored.beginRestore(
        restoreSession(restored, reloaded, new WasmStateInit(fetchPreset)),
      );
      assert.equal(restored.getRestoreStatus(), 'restored');
      assert.deepEqual(restored.activeGameIds, ids);
      assert.deepEqual(
        restored.getWasmFields()!.serializedGameSession,
        reloaded.live.serializedGameSession,
      );

      const restoredModel = sessionModelFromSave(reloaded);
      assert.deepEqual(restoredModel.game.currentHandIds, ids);
      assert.deepEqual(restoredModel.game.handState, postMove.handState);
      assert.ok(decodePersistedGameState(restoredModel.game.handState));
      if (testCase.handProposal.gameType === 'krunk') {
        const krunk = krunkStateCodec.decode(restoredModel.game.handState);
        assert.ok(krunk);
        assert.equal(krunk.members.length, ids.length);
        assert.notEqual(krunk.members[0].role, krunk.members[1].role);
      }
    } finally {
      restored.cleanup();
      await restored.flushPendingWork();
    }

    await Promise.all(cradles.map((cradle) => cradle.shutdown()));
    await storageRepository.flushSessionSave();
    storageRepository._resetForTests();
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(SESSION_DB_NAME);
      request.onsuccess = () => resolve();
      request.onerror = () =>
        reject(request.error ?? new Error('Failed to delete session database'));
      request.onblocked = () => reject(new Error('Session database deletion was blocked'));
    });
    await storageRepository.claimLease();
  }
}

it(
  'restores real Cal Poker, Space Poker, and Krunk sessions after a move',
  async () => {
    try {
      const poller = await startSimulator([
        'cafe0000',
        'dead0000',
        'cafe0001',
        'dead0001',
        'cafe0002',
        'dead0002',
      ]);
      if (!poller) return;
      await runRealGameRestoreCases(poller);
    } catch (e) {
      throw new Error(`[load_wasm game restore failed]\n${String(e)}`, { cause: e });
    }
  },
  LONG_WASM_TEST_TIMEOUT,
);
