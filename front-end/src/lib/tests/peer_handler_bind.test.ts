import { PeerSession, type MessageHandler } from '../../services/PeerSession';
import type { HubConnection } from '../../services/HubConnection';

/**
 * Mirrors Shell's restore/bind behavior: handlers may be registered before a
 * PeerSession exists (GameSession mounts during resume before hub
 * onRegistered recreates the peer). Creating the PeerSession later must still
 * attach those handlers, or inbound game messages are only buffered for
 * keepalives' liveness side-effect while proposals never reach WASM.
 */
function bindPeerMessageHandler(
  peerSession: PeerSession | null,
  handler: MessageHandler | null,
): void {
  if (!peerSession || !handler) return;
  peerSession.registerMessageHandler(handler);
}

describe('delayed PeerSession message-handler binding', () => {
  function mockHub(): HubConnection {
    return {
      sendToPeer: jest.fn(),
      sendPeerAppMessage: jest.fn(),
    } as unknown as HubConnection;
  }

  it('delivers a proposal message that arrived before the handler was bound', () => {
    const delivered: Array<{ msgno: number; msg: Uint8Array }> = [];
    const handler: MessageHandler = {
      handler: (msgno, msg) => delivered.push({ msgno, msg }),
      ackHandler: () => {},
      keepaliveHandler: () => {},
    };

    // Resume path: GameSession registers handlers while peerSession is still null.
    let peerSession: PeerSession | null = null;
    let pendingHandler: MessageHandler | null = handler;
    bindPeerMessageHandler(peerSession, pendingHandler);
    expect(delivered).toEqual([]);

    // Hub onRegistered recreates the PeerSession and must re-bind.
    peerSession = new PeerSession('peer-1', 'session-1', mockHub());
    bindPeerMessageHandler(peerSession, pendingHandler);

    const frame = new Uint8Array(5 + 3);
    frame[0] = 0x01;
    new DataView(frame.buffer).setUint32(1, 7, false);
    frame.set([9, 8, 7], 5);
    peerSession.deliverRawPeerMessage('peer-1', frame);

    expect(delivered).toEqual([{ msgno: 7, msg: new Uint8Array([9, 8, 7]) }]);
  });

  it('buffers inbound messages until the handler is bound after PeerSession exists', () => {
    const delivered: Array<{ msgno: number; msg: Uint8Array }> = [];
    const peerSession = new PeerSession('peer-1', 'session-1', mockHub());

    const frame = new Uint8Array(5 + 2);
    frame[0] = 0x01;
    new DataView(frame.buffer).setUint32(1, 3, false);
    frame.set([1, 2], 5);
    peerSession.deliverRawPeerMessage('peer-1', frame);

    bindPeerMessageHandler(peerSession, {
      handler: (msgno, msg) => delivered.push({ msgno, msg }),
      ackHandler: () => {},
      keepaliveHandler: () => {},
    });

    expect(delivered).toEqual([{ msgno: 3, msg: new Uint8Array([1, 2]) }]);
  });
});
