import { WasmStateInit } from '../../hooks/WasmStateInit';
import { SessionController } from '../../hooks/SessionController';
import { restoreSession } from '../../hooks/blobSingleton';
import {
  _resetForTests as resetSaveState,
  flushSessionSave,
  peekSession,
  saveSession,
} from '../../hooks/save';
import { canRemountFinishedGameState } from '../gameRegistry';
import { encodeGameProposalParameters } from '../gameProposalCodec';
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
import { createSessionMachineState } from '../session/sessionMachine';
import { SessionMachineRuntime } from '../session/sessionMachineRuntime';
import {
  createActivePair,
  exchangeUntilIdle,
  fetchPreset,
  flushWrapperDrain,
  postMoveHandState,
  startSimulator,
} from './load_wasm.harness';
import { liveSave } from './session_save_envelope.fixtures';
// @ts-expect-error Node.js types are not included in the frontend TypeScript configuration.
import * as assert from 'assert';

async function runRealGameRestoreCases(poller: BlockchainPoller): Promise<void> {
  const cases: Array<{ handProposal: HandProposal; expectedMembers: number; canRemount: boolean }> =
    [
      {
        handProposal: {
          gameType: 'calpoker',
          myContribution: 100n,
          theirContribution: 100n,
          gameTimeout: 15n,
        },
        expectedMembers: 1,
        canRemount: true,
      },
      {
        handProposal: {
          gameType: 'spacepoker',
          myContribution: 100n,
          theirContribution: 100n,
          gameTimeout: 15n,
          unitSizeMojos: 10n,
        },
        expectedMembers: 1,
        canRemount: true,
      },
      {
        handProposal: {
          gameType: 'krunk',
          myContribution: 100n,
          theirContribution: 100n,
          gameTimeout: 15n,
        },
        expectedMembers: 2,
        canRemount: true,
      },
    ];

  for (const [index, testCase] of cases.entries()) {
    const cradles = await createActivePair(poller, index);
    const proposer = cradles[0].blob!;
    const mover = cradles[1].blob!;
    const ids = proposer.proposeGame({
      game_type: protocolIdForCatalog(testCase.handProposal.gameType),
      timeout: testCase.handProposal.gameTimeout,
      parameters: encodeGameProposalParameters(testCase.handProposal, true),
    });
    assert.equal(ids.length, testCase.expectedMembers);
    await exchangeUntilIdle(cradles);
    mover.acceptProposal(ids[0]);
    await exchangeUntilIdle(cradles);
    assert.deepEqual(mover.activeGameIds, ids);

    const postMove = postMoveHandState(testCase.handProposal, ids);
    const beforeMove = Uint8Array.from(mover.getWasmFields()!.serializedGameSession);
    mover.makeMove(postMove.moverId, postMove.move);
    await flushWrapperDrain([cradles[1]]);
    const afterMove = mover.getWasmFields()!;
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
        currentHandOrigin: 'local',
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
    await saveSession({
      scope: 'live',
      pairing: save.pairing,
      live: save.live,
      presentation: save.presentation,
      history: save.history,
    });
    await flushSessionSave();

    resetSaveState();
    const reloaded = await peekSession();
    assert.ok(
      reloaded,
      `${testCase.handProposal.gameType}: IndexedDB peek must return saved session`,
    );
    assert.equal(reloaded.phase, 'live');
    if (reloaded.phase !== 'live') throw new Error('expected live reload');
    assert.deepEqual(reloaded.presentation.currentHandGameIds, ids);
    assert.deepEqual(reloaded.presentation.activeGameIds, ids);

    const restored = new SessionController(poller, `feed000${index}`, 100n, 100n, {
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
      assert.equal(restored.handState, null);
      assert.deepEqual(
        restored.getWasmFields()!.serializedGameSession,
        reloaded.live.serializedGameSession,
      );

      const restoredModel = sessionModelFromSave(reloaded);
      const runtime = new SessionMachineRuntime(createSessionMachineState(restoredModel), {
        controller: restored,
        iStarted: reloaded.pairing.iStarted,
        restoring: true,
        getRestoreStatus: () => restored.getRestoreStatus(),
        getRestoreError: () => restored.getRestoreError(),
        emitGameplay: () => {},
        onError: (error) => {
          throw error;
        },
        persist: async () => {},
      });
      assert.deepEqual(restoredModel.game.currentHandIds, ids);
      assert.deepEqual(restoredModel.game.handState, postMove.handState);
      assert.deepEqual(restored.handState, restoredModel.game.handState);
      assert.equal(canRemountFinishedGameState(restoredModel.game.handState), testCase.canRemount);
      if (testCase.handProposal.gameType === 'krunk') {
        const krunk = krunkStateCodec.decode(restoredModel.game.handState);
        assert.ok(krunk);
        assert.deepEqual(Object.keys(krunk.games), ids);
        assert.notEqual(krunk.games[ids[0]].role, krunk.games[ids[1]].role);
      }
      runtime.dispose();
    } finally {
      restored.cleanup();
    }

    cradles.forEach((cradle) => cradle.shutdown());
    resetSaveState();
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase(SESSION_DB_NAME);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    });
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
  300 * 1000,
);
