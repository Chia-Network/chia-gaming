import { WasmStateInit, storeInitArgs } from '../../hooks/WasmStateInit';
import WholeWasmObject from '../../../node-pkg/chia_gaming_wasm.js';
import { PeerConnectionResult } from '../../types/ChiaGaming';
import { fakeBlockchainInfo } from '../../hooks/FakeBlockchainInterface';
// @ts-expect-error Node.js types are not included in the frontend TypeScript configuration.
import * as assert from 'assert';
import { storageRepository } from '../session/storageRepository';
import { hasSavedSessionMarker } from '../../hooks/saveCoordination';
import {
  SessionControllerAdapter,
  action_with_messages,
  addActiveCradle,
  assertCradleRoundTrip,
  fetchPreset,
  flushWrapperDrain,
  initSessionController,
  LONG_WASM_TEST_TIMEOUT,
  makeTestReliableState,
  pollOnce,
  startSimulator,
} from './load_wasm.harness';
import { liveSave } from './session_save_envelope.fixtures';

function saveLiveFields(fields: Record<string, unknown>): Promise<void> {
  const save = liveSave(fields);
  if (save.phase !== 'live') throw new Error('expected live save');
  return storageRepository.saveSession({
    scope: 'live',
    walletProviderScope: save.walletProviderScope,
    pairing: save.pairing,
    live: save.live,
    presentation: save.presentation,
    history: save.history,
  });
}

it(
  'persists and reloads real handshake and post-move game cradles',
  async () => {
    try {
      const poller = await startSimulator(['a11ce000', 'b0b77777']);
      if (!poller) return;

      const cradle1 = addActiveCradle(new SessionControllerAdapter());
      const cradle2 = addActiveCradle(new SessionControllerAdapter());
      const peer_conn1: PeerConnectionResult = {
        reliableState: makeTestReliableState(),
        sendMessage: (msgno: number, message: Uint8Array) => {
          cradle1.add_outbound_message(msgno, message);
          return true;
        },
        sendAck: (_ackMsgno: number) => true,
        sendKeepalive: () => true,
        hostLog: (msg: string) => process.stderr.write(msg + '\n'),
        close: () => {},
      };
      const wasm_init1 = new WasmStateInit(fetchPreset);
      storeInitArgs(async () => {}, WholeWasmObject);
      const wasm_blob1 = await initSessionController(
        poller,
        'a11ce000',
        true,
        peer_conn1,
        wasm_init1,
      );
      wasm_blob1.getFee = () => 10n;
      cradle1.set_blob(wasm_blob1);

      const peer_conn2: PeerConnectionResult = {
        reliableState: makeTestReliableState(),
        sendMessage: (msgno: number, message: Uint8Array) => {
          cradle2.add_outbound_message(msgno, message);
          return true;
        },
        sendAck: (_ackMsgno: number) => true,
        sendKeepalive: () => true,
        hostLog: (msg: string) => process.stderr.write(msg + '\n'),
        close: () => {},
      };
      const wasm_init2 = new WasmStateInit(fetchPreset);
      const wasm_blob2 = await initSessionController(
        poller,
        'b0b77777',
        false,
        peer_conn2,
        wasm_init2,
      );
      cradle2.set_blob(wasm_blob2);

      await flushWrapperDrain([cradle1, cradle2]);
      assertCradleRoundTrip('initiator-sent-a', wasm_blob1);
      assertCradleRoundTrip('receiver-waiting-for-a', wasm_blob2);

      const sentA = cradle1.outbound_messages();
      assert.equal(sentA.length, 1, 'initiator should have one HandshakeA message');

      cradle2.deliver_message(sentA[0].msgno, sentA[0].msg);
      await flushWrapperDrain([cradle2]);
      await fakeBlockchainInfo.farmBlock();
      await pollOnce(poller);
      await wasm_blob2.flushPendingWork();
      await flushWrapperDrain([cradle2]);
      wasm_blob1.receiveAck(BigInt(sentA[0].msgno));
      await flushWrapperDrain([cradle1]);
      assertCradleRoundTrip('receiver-processed-a-sent-b', wasm_blob2);
      assert.deepEqual(
        wasm_blob2.getCoinsOfInterest().map((coin) => coin.label),
        ['Channel coin'],
      );
      const receiverChannelWatch = wasm_blob2.snapshotWatchedCoins();
      assert.equal(receiverChannelWatch.length, 1);
      assert.equal(receiverChannelWatch[0].coin_name, wasm_blob2.getCoinsOfInterest()[0].id);
      const sentB = cradle2.outbound_messages();
      assert.equal(sentB.length, 1, 'receiver should have one HandshakeB message');

      cradle1.deliver_message(sentB[0].msgno, sentB[0].msg);
      await flushWrapperDrain([cradle1]);
      await wasm_blob1.flushPendingWork();
      await flushWrapperDrain([cradle1]);
      wasm_blob2.receiveAck(BigInt(sentB[0].msgno));
      await flushWrapperDrain([cradle2]);
      assertCradleRoundTrip('initiator-processed-b-funded-sent-c', wasm_blob1);
      assert.deepEqual(
        wasm_blob1.getCoinsOfInterest().map((coin) => coin.label),
        ['Channel coin'],
      );
      const initiatorChannelWatch = wasm_blob1.snapshotWatchedCoins();
      assert.equal(initiatorChannelWatch.length, 1);
      assert.equal(initiatorChannelWatch[0].coin_name, wasm_blob1.getCoinsOfInterest()[0].id);
      const sentC = cradle1.outbound_messages();
      assert.equal(sentC.length, 1, 'initiator should have one HandshakeC message');

      cradle2.deliver_message(sentC[0].msgno, sentC[0].msg);
      await flushWrapperDrain([cradle2]);
      await wasm_blob2.flushPendingWork();
      await flushWrapperDrain([cradle2]);
      wasm_blob1.receiveAck(BigInt(sentC[0].msgno));
      await flushWrapperDrain([cradle1]);
      const makingOfferAcceptanceBytes = assertCradleRoundTrip(
        'receiver-processed-c-sent-d',
        wasm_blob2,
      );
      const sentD = cradle2.outbound_messages();
      assert.equal(sentD.length, 1, 'receiver should have one HandshakeD message');

      cradle1.deliver_message(sentD[0].msgno, sentD[0].msg);
      await flushWrapperDrain([cradle1]);
      wasm_blob2.receiveAck(BigInt(sentD[0].msgno));
      await flushWrapperDrain([cradle2]);
      assertCradleRoundTrip('initiator-processed-d', wasm_blob1);
      await fakeBlockchainInfo.farmBlock();
      await pollOnce(poller);
      await flushWrapperDrain([cradle1]);
      assertCradleRoundTrip('initiator-observed-channel', wasm_blob1);
      const receiverFields = wasm_blob2.getWasmFields();
      assert.ok(receiverFields);
      void saveLiveFields({
        ...receiverFields,
        serializedGameSession: makingOfferAcceptanceBytes,
        gameSessionSchemaVersion: BigInt(WholeWasmObject.game_session_serialization_schema()),
        pairingToken: 'reload-regression',
      });
      await storageRepository.flushSessionSave();

      // Simulate marker-only boot + preference patches while resume dialog is open.
      await flushWrapperDrain([cradle1, cradle2]);
      storageRepository._resetForTests();
      await storageRepository.claimLease();
      assert.ok(hasSavedSessionMarker());
      void storageRepository.saveSession({
        scope: 'common',
        history: { diagnosticLog: ['boot-before-resume'] },
      });
      await storageRepository.flushSessionSave();

      storageRepository._resetForTests();
      await storageRepository.claimLease();
      const reloaded = await storageRepository.peekSession();
      assert.equal(reloaded?.phase, 'live');
      if (reloaded?.phase !== 'live') throw new Error('expected live reload');
      assert.ok(reloaded.live.serializedGameSession instanceof Uint8Array);
      assert.equal(
        reloaded.live.serializedGameSession.byteLength,
        makingOfferAcceptanceBytes.byteLength,
      );
      assert.deepEqual(reloaded.live.serializedGameSession, makingOfferAcceptanceBytes);
      assert.ok(
        reloaded.history.diagnosticLog?.includes('boot-before-resume'),
        'preference patch during marker-only boot must be retained',
      );
      const restoredId = WholeWasmObject.restore_session(
        reloaded.live.serializedGameSession,
        'reload-regression-seed',
      );
      assert.equal(typeof restoredId, 'number');
      const restoredWatches = WholeWasmObject.snapshot_watched_coins(restoredId) as Array<{
        coin_name: string;
        coin_string: string;
      }>;
      // This fixture's funding bundle has seven creating inputs. They remain
      // bounded reconciliation interests until its watched channel output lands.
      assert.ok(
        restoredWatches.length <= 8,
        `restored handshake poll interests must stay bounded, got ${restoredWatches.length}`,
      );
      assert.equal(
        restoredWatches.filter((watch) => watch.coin_name === receiverChannelWatch[0].coin_name)
          .length,
        1,
        'reload before channel creation must preserve the channel watch',
      );

      await flushWrapperDrain([cradle2]);
      assertCradleRoundTrip('receiver-finished-four-message-handshake', wasm_blob2);

      await action_with_messages(poller, cradle1, cradle2);
      for (const blob of [wasm_blob1, wasm_blob2]) {
        assert.equal(
          typeof blob.lastChannelStatus?.state_number,
          'bigint',
          'active real-WASM status must expose state_number as bigint',
        );
        const coins = blob.getCoinsOfInterest();
        assert.equal(coins.length, 1);
        const [channelCoin] = coins;
        assert.equal(channelCoin.label, 'Channel coin');
        assert.match(channelCoin.id, /^[0-9a-f]{64}$/);
      }
    } catch (e) {
      throw new Error(`[load_wasm loads failed]\n${String(e)}`, { cause: e });
    }
  },
  LONG_WASM_TEST_TIMEOUT,
);
