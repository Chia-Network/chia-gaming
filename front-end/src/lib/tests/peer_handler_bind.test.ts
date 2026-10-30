import { restorePeerState } from './peer_protocol.harness';
import { encodePeerAppMessage, PeerSession, type MessageHandler } from '../../services/PeerSession';
import type { HubConnection } from '../../services/HubConnection';
import { SessionController } from '../../hooks/SessionController';
import {
  attachTestCommitCoordinator,
  setTestPersistence,
  trackTestController,
} from './message_protocol.harness';
import { handshakeA, installAcceptedChannel } from './accepted_session.harness';
import { DEFAULT_SESSION_RECEIVE_POLICY } from '../session/receivePolicy';
import { createSessionModel } from '../session/model';
import { createSessionMachineState } from '../session/sessionMachine';
import { SessionMachineRuntime } from '../session/sessionMachineRuntime';

/** Mirrors Shell's direct-owner bypass for the legacy callback bridge. */
function bindPeerMessageHandler(
  peerSession: PeerSession,
  handler: MessageHandler,
  controller: SessionController,
): void {
  if (!peerSession || !handler || !controller) return;
  controller.attachReliableTransport(peerSession.reliableTransport);
}

const sessionId = '000102030405060708090a0b0c0d0e0f';
function mockHub(): HubConnection & { sendToPeer: jest.Mock } {
  return { sendToPeer: jest.fn(() => true) } as unknown as HubConnection & {
    sendToPeer: jest.Mock;
  };
}
function dataFrame(msgno: number, body: Uint8Array): Uint8Array {
  const frame = new Uint8Array(21 + body.byteLength);
  frame[0] = 0x01;
  frame.set(
    Uint8Array.from({ length: 16 }, (_, index) => index),
    1,
  );
  new DataView(frame.buffer).setUint32(17, msgno, false);
  frame.set(body, 21);
  return frame;
}
async function acceptedController(peerSession: PeerSession, coordinate = true) {
  const controller = new SessionController(null, 'test', 100n, 100n, peerSession);
  trackTestController(controller);
  controller.pairingToken = 'test-pairing';
  const cradle = await installAcceptedChannel(controller);
  controller.kickSystem(2);
  if (coordinate) {
    setTestPersistence(
      controller,
      jest.fn(async () => {}),
    );
    attachTestCommitCoordinator(controller);
  }
  return { controller, cradle };
}

describe('delayed PeerSession message-handler binding', () => {
  it('keeps the accepted Rust owner when the legacy bridge binds', async () => {
    const hub = mockHub();
    const peerSession = new PeerSession('peer-1', sessionId, hub);
    const { controller, cradle } = await acceptedController(peerSession);
    const before = cradle.serialize();
    const owner = controller.getPeerProtocol();
    const legacyDelivery = jest.fn();
    bindPeerMessageHandler(
      peerSession,
      {
        handler: legacyDelivery,
        ackHandler: (ack) => controller.receiveAck(BigInt(ack)),
        keepaliveHandler: () => controller.receiveKeepalive(),
      },
      controller,
    );

    peerSession.deliverRawPeerMessage('peer-1', dataFrame(1, await handshakeA()));
    await controller.flushPendingWork();

    expect(controller.getPeerProtocol()).toBe(owner);
    expect(legacyDelivery).not.toHaveBeenCalled();
    expect(cradle.serialize()).not.toEqual(before);
    expect(hub.sendToPeer).toHaveBeenCalledTimes(1);
    expect((hub.sendToPeer.mock.calls[0][1] as Uint8Array)[0]).toBe(0x02);
  });

  it('orders an out-of-order rejection after the preceding Rust channel message', async () => {
    const order: string[] = [];
    const hub = mockHub();
    hub.sendToPeer.mockImplementation((_peerId: string, payload: Uint8Array) => {
      order.push(
        `ack-${new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(17, false)}`,
      );
      return true;
    });
    const peerSession = new PeerSession('peer-1', sessionId, hub);
    restorePeerState(peerSession, { remoteNumber: 5n });
    const { controller, cradle } = await acceptedController(peerSession);
    const before = cradle.serialize();
    const process = controller.processResult.bind(controller);
    jest.spyOn(controller, 'processResult').mockImplementation((result) => {
      order.push('channel-result');
      process(result);
    });
    controller.setInboundSessionRejectHandler(() => order.push('cancel'));
    peerSession.deliverRawPeerMessage(
      'peer-1',
      dataFrame(7, encodePeerAppMessage({ type: 'session_reject' })),
    );
    expect(cradle.serialize()).toEqual(before);
    peerSession.deliverRawPeerMessage('peer-1', dataFrame(6, await handshakeA()));
    peerSession.deliverRawPeerMessage('peer-1', dataFrame(8, new Uint8Array([8])));
    expect(cradle.serialize()).not.toEqual(before);
    expect(order).toEqual(['channel-result']);
    await controller.flushPendingWork();
    expect(order).toEqual(['channel-result', 'ack-6', 'ack-7', 'cancel']);
    expect(controller.remoteNumber).toBe(7n);
  });

  it('durably handles a contiguous rejection without delivering it to the channel', async () => {
    const order: string[] = [];
    const hub = mockHub();
    hub.sendToPeer.mockImplementation((_peerId: string, payload: Uint8Array) => {
      order.push(
        `ack-${new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(17, false)}`,
      );
      return true;
    });
    const peerSession = new PeerSession('peer-1', sessionId, hub);
    restorePeerState(peerSession, { remoteNumber: 5n });
    const { controller, cradle } = await acceptedController(peerSession, false);
    const before = cradle.serialize();
    const normalPersist = jest.fn(async () => {
      order.push('normal-persist');
    });
    const runtime = new SessionMachineRuntime(createSessionMachineState(createSessionModel()), {
      controller,
      iStarted: false,
      restoring: false,
      getRestoreStatus: () => 'idle',
      getRestoreError: () => null,
      onError: jest.fn(),
      persist: normalPersist,
    });
    runtime.activate();
    controller.setInboundSessionRejectPersistence(async () => {
      order.push('persist-receipt');
    });
    controller.setInboundSessionRejectHandler(() => order.push('cancel'));
    peerSession.deliverRawPeerMessage(
      'peer-1',
      dataFrame(6, encodePeerAppMessage({ type: 'session_reject' })),
    );
    expect(order).toEqual([]);
    await controller.flushPendingWork();
    expect(cradle.serialize()).toEqual(before);
    expect(order).toEqual(['persist-receipt', 'ack-6', 'cancel']);
    expect(normalPersist).not.toHaveBeenCalled();
  });

  it('retains an inbound receipt after ACK failure and re-ACKs after reload', async () => {
    const order: string[] = [];
    const firstHub = mockHub();
    firstHub.sendToPeer.mockImplementation(() => {
      order.push('ack-failed');
      return false;
    });
    const firstPeer = new PeerSession('peer-1', sessionId, firstHub);
    const { controller } = await acceptedController(firstPeer);
    let receiptRemoteNumber = 0n;
    controller.setInboundSessionRejectPersistence(async (_session, remoteNumber) => {
      receiptRemoteNumber = remoteNumber;
      order.push('persist-receipt');
    });
    controller.setInboundSessionRejectHandler(() => order.push('cancel'));
    const rejection = dataFrame(1, encodePeerAppMessage({ type: 'session_reject' }));
    firstPeer.deliverRawPeerMessage('peer-1', rejection);
    await controller.flushPendingWork();
    expect(order).toEqual(['persist-receipt', 'ack-failed', 'cancel']);
    expect(receiptRemoteNumber).toBe(1n);
    controller.cleanup();

    const restoredHub = mockHub();
    const restoredReceipt = new PeerSession(
      'peer-1',
      sessionId,
      restoredHub,
      DEFAULT_SESSION_RECEIVE_POLICY,
      {
        messageNumber: 1n,
        remoteNumber: receiptRemoteNumber,
        unackedMessages: [],
        disposition: 'inbound-reject',
      },
    );
    expect(restoredReceipt.deliverRawPeerMessage('peer-1', rejection)).toBe(true);
    expect(restoredHub.sendToPeer).toHaveBeenCalledTimes(1);
    expect((restoredHub.sendToPeer.mock.calls[0][1] as Uint8Array)[0]).toBe(0x02);
    restoredReceipt.reliableTransport.clearRuntime();
  });
});
