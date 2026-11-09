import { PeerSession } from '../../services/PeerSession';
import { createAcceptedBlob, handshakeA } from './accepted_session.harness';
import { setTestPersistence } from './message_protocol.harness';

test('the accepted Rust owner delivers a handshake and checkpoints its ACK without calling the TypeScript channel wrapper', async () => {
  const { blob, cradle, sentAcks } = await createAcceptedBlob();
  expect(cradle).toBe(blob.getPeerProtocol());
  const projection = jest.spyOn(blob, 'processResult');
  const before = cradle.serialize();
  const save = jest.fn(() => {
    expect(sentAcks).toEqual([]);
    expect(blob.remoteNumber).toBe(1n);
    expect(cradle.serialize()).not.toEqual(before);
  });
  setTestPersistence(blob, save);

  blob.deliverMessage(1n, await handshakeA());
  expect(sentAcks).toEqual([]);
  await blob.flushPendingWork();

  expect(projection).toHaveBeenCalledTimes(1);
  expect(projection.mock.calls[0][0].events.every((event) => !('OutboundMessage' in event))).toBe(
    true,
  );
  expect(save).toHaveBeenCalledTimes(1);
  expect(sentAcks).toEqual([1]);
  projection.mockRestore();
});

test('attaching a hub route after restore preserves the accepted adapter and its callbacks', async () => {
  const { blob, cradle, sentAcks } = await createAcceptedBlob();
  const owner = blob.getPeerProtocol();
  const transport = blob.reliableTransport;
  const before = cradle.serialize();
  const peer = new PeerSession(
    'peer',
    owner.snapshot().sessionId,
    { sendToPeer: () => false },
    undefined,
    transport,
  );
  expect(peer.reliableTransport).toBe(transport);
  expect(peer.reliableTransport.protocol).toBe(owner);
  expect(cradle.serialize()).toEqual(before);

  peer.reliableTransport.receiveData(1n, await handshakeA());
  await blob.flushPendingWork();
  expect(sentAcks).toEqual([1]);
  expect(cradle.serialize()).not.toEqual(before);
});

test('retiring an accepted session releases its owned channel', async () => {
  const { blob, cradle } = await createAcceptedBlob();
  expect(cradle.serialize().length).toBeGreaterThan(0);
  blob.cleanup();
  expect(() => cradle.serialize()).toThrow();
});

test('a terminal Rust notification automatically checkpoints the cleared peer journal', async () => {
  const { blob, cradle } = await createAcceptedBlob(true);
  expect(blob.unackedMessages).toHaveLength(1);
  const before = cradle.serialize();
  let saved!: () => void;
  const checkpointed = new Promise<void>((resolve) => {
    saved = resolve;
  });
  const save = jest.fn(() => {
    expect(blob.unackedMessages).toEqual([]);
    expect(cradle.serialize()).not.toEqual(before);
    expect(blob.getWasmFields()?.channelStatus?.session_disposition).toBe('Abandoned');
    saved();
  });
  setTestPersistence(blob, save);

  const terminal = cradle.abandon();
  expect(terminal.disposition.kind).toBe('terminal');
  expect(terminal.events).toEqual([
    expect.objectContaining({
      Notification: expect.objectContaining({
        ChannelStatus: expect.objectContaining({ session_disposition: 'Abandoned' }),
      }),
    }),
  ]);
  blob.processResult(terminal);

  // No explicit flush or later stimulus: draining the terminal notification
  // must itself schedule the checkpoint after Rust clears the peer journal.
  await checkpointed;
  expect(save).toHaveBeenCalledTimes(1);
});

test('a failed checkpoint preserves the accepted channel state and releases its inbound ACK once', async () => {
  const { blob, cradle, sentAcks } = await createAcceptedBlob();
  const body = await handshakeA();
  let fail = true;
  setTestPersistence(blob, () => {
    if (fail) return Promise.reject(new Error('receiver checkpoint failed'));
  });
  blob.deliverMessage(1n, body);
  const accepted = cradle.serialize();
  try {
    await expect(blob.flushPendingWork()).rejects.toThrow('receiver checkpoint failed');
    expect(blob.remoteNumber).toBe(1n);
    expect(cradle.serialize()).toEqual(accepted);
    expect(sentAcks).toEqual([1]);
  } finally {
    fail = false;
  }
  await blob.flushPendingWork();
  expect(cradle.serialize()).toEqual(accepted);
  expect(sentAcks).toEqual([1]);
});
