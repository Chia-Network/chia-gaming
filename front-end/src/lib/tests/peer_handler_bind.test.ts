import { encodePeerAppMessage, PeerSession, type MessageHandler } from '../../services/PeerSession';
import type { HubConnection } from '../../services/HubConnection';
import { SessionController } from '../../hooks/SessionController';
import { makeMockCradle, mockWasmConnection } from './message_protocol.harness';
import { DEFAULT_SESSION_RECEIVE_POLICY } from '../session/receivePolicy';

/** Mirrors Shell's direct-owner bypass for the legacy callback bridge. */
function bindPeerMessageHandler(
  peerSession: PeerSession | null,
  handler: MessageHandler | null,
  controller: SessionController | null,
): void {
  if (!peerSession || !handler || !controller) return;
  controller.attachReliableTransport(peerSession.reliableTransport);
}

describe('delayed PeerSession message-handler binding', () => {
  function mockHub(): HubConnection & { sendToPeer: jest.Mock } {
    return {
      sendToPeer: jest.fn(() => true),
    } as unknown as HubConnection & { sendToPeer: jest.Mock };
  }

  const sessionId = '000102030405060708090a0b0c0d0e0f';
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

  it('keeps the direct SessionController consumer when the legacy bridge binds', async () => {
    const hub = mockHub();
    const peerSession = new PeerSession('peer-1', sessionId, hub);
    const controller = new SessionController(null, 'test', 100n, 100n, peerSession);
    const cradle = makeMockCradle();
    controller.loadWasm(mockWasmConnection);
    controller.setGameSession(cradle);
    controller.kickSystem(2);
    controller.onSaveNeeded = jest.fn(() => Promise.resolve());
    const legacyDelivery = jest.fn((msgno: number, msg: Uint8Array) => {
      controller.deliverMessage(BigInt(msgno), msg);
    });
    bindPeerMessageHandler(
      peerSession,
      {
        handler: legacyDelivery,
        ackHandler: (ack) => controller.receiveAck(BigInt(ack)),
        keepaliveHandler: () => controller.receiveKeepalive(),
      },
      controller,
    );

    peerSession.deliverRawPeerMessage('peer-1', dataFrame(1, new Uint8Array([9, 8, 7])));
    await controller.flushPendingWork();

    expect(legacyDelivery).not.toHaveBeenCalled();
    expect(cradle.deliver_message).toHaveBeenCalledTimes(1);
    expect(hub.sendToPeer).toHaveBeenCalledTimes(1);
    expect((hub.sendToPeer.mock.calls[0][1] as Uint8Array)[0]).toBe(0x02);
    controller.cleanup();
  });

  it('orders an out-of-order rejection after the preceding WASM body', async () => {
    const order: string[] = [];
    const hub = mockHub();
    hub.sendToPeer.mockImplementation((_peerId: string, payload: Uint8Array) => {
      const msgno = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(
        17,
        false,
      );
      order.push(`ack-${msgno}`);
      return true;
    });
    const peerSession = new PeerSession('peer-1', sessionId, hub);
    peerSession.reliableState.remoteNumber = 5n;
    const controller = new SessionController(null, 'test', 100n, 100n, peerSession);
    const cradle = makeMockCradle((body) => {
      order.push(`wasm-${body[0]}`);
      return { events: [] };
    });
    controller.loadWasm(mockWasmConnection);
    controller.setGameSession(cradle);
    controller.kickSystem(2);
    controller.onSaveNeeded = jest.fn(() => Promise.resolve());
    controller.setInboundSessionRejectHandler(() => order.push('cancel'));

    peerSession.deliverRawPeerMessage(
      'peer-1',
      dataFrame(7, encodePeerAppMessage({ type: 'session_reject' })),
    );
    expect(cradle.deliver_message).not.toHaveBeenCalled();
    peerSession.deliverRawPeerMessage('peer-1', dataFrame(6, new Uint8Array([6])));
    peerSession.deliverRawPeerMessage('peer-1', dataFrame(8, new Uint8Array([8])));

    expect(cradle.deliver_message).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['wasm-6']);
    await controller.flushPendingWork();
    expect(cradle.deliver_message).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['wasm-6', 'ack-6', 'ack-7', 'cancel']);
    controller.cleanup();
  });

  it('durably handles a contiguous rejection without delivering it to WASM', async () => {
    const order: string[] = [];
    const hub = mockHub();
    hub.sendToPeer.mockImplementation((_peerId: string, payload: Uint8Array) => {
      const msgno = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(
        17,
        false,
      );
      order.push(`ack-${msgno}`);
      return true;
    });
    const peerSession = new PeerSession('peer-1', sessionId, hub);
    peerSession.reliableState.remoteNumber = 5n;
    const controller = new SessionController(null, 'test', 100n, 100n, peerSession);
    const cradle = makeMockCradle();
    controller.loadWasm(mockWasmConnection);
    controller.setGameSession(cradle);
    controller.kickSystem(2);
    controller.setInboundSessionRejectPersistence(async () => {
      order.push('persist-receipt');
    });
    controller.setInboundSessionRejectHandler(() => order.push('cancel'));

    peerSession.deliverRawPeerMessage(
      'peer-1',
      dataFrame(6, encodePeerAppMessage({ type: 'session_reject' })),
    );
    expect(cradle.deliver_message).not.toHaveBeenCalled();
    expect(order).toEqual([]);

    await controller.flushPendingWork();
    expect(cradle.deliver_message).not.toHaveBeenCalled();
    expect(order).toEqual(['persist-receipt', 'ack-6', 'cancel']);
    controller.cleanup();
  });

  it('retains an inbound receipt after ACK failure and re-ACKs after reload', async () => {
    const order: string[] = [];
    const firstHub = mockHub();
    firstHub.sendToPeer.mockImplementation(() => {
      order.push('ack-failed');
      return false;
    });
    const firstPeer = new PeerSession('peer-1', sessionId, firstHub);
    const controller = new SessionController(null, 'test', 100n, 100n, firstPeer);
    const cradle = makeMockCradle();
    controller.loadWasm(mockWasmConnection);
    controller.setGameSession(cradle);
    controller.kickSystem(2);
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
  });

  it('escalates session rejection after channel establishment', async () => {
    const hub = mockHub();
    const peerSession = new PeerSession('peer-1', sessionId, hub);
    const controller = new SessionController(null, 'test', 100n, 100n, peerSession);
    const cradle = makeMockCradle();
    const cancel = jest.fn();
    controller.loadWasm(mockWasmConnection);
    controller.setGameSession(cradle);
    controller.kickSystem(2);
    controller.channelReady = true;
    controller.onSaveNeeded = jest.fn(() => Promise.resolve());
    controller.setInboundSessionRejectHandler(cancel);

    peerSession.deliverRawPeerMessage(
      'peer-1',
      dataFrame(1, encodePeerAppMessage({ type: 'session_reject' })),
    );
    await controller.flushPendingWork();

    expect(cradle.deliver_message).not.toHaveBeenCalled();
    expect(cradle.go_on_chain).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
    expect(peerSession.reliableState.disposition).toBe('active');
    controller.cleanup();
  });
});
