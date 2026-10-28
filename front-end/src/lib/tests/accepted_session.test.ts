import { ReliablePeerTransport } from '../../services/PeerSession';
import { DEFAULT_SESSION_RECEIVE_POLICY } from '../session/receivePolicy';
import { createAcceptedBlob, handshakeA } from './accepted_session.harness';
import { setTestPersistence } from './message_protocol.harness';

test('the accepted Rust owner delivers a handshake and checkpoints its ACK without calling the TypeScript channel wrapper', async () => {
  const { blob, cradle, sentAcks } = await createAcceptedBlob();
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

test('replacing the carrier keeps the existing accepted Rust owner and its channel', async () => {
  const { blob, cradle } = await createAcceptedBlob();
  const owner = blob.getPeerProtocol();
  const checkpoint = owner.snapshot();
  const before = cradle.serialize();
  const acks: bigint[] = [];
  const replacement = new ReliablePeerTransport(
    checkpoint,
    DEFAULT_SESSION_RECEIVE_POLICY,
    () => true,
    (ack) => {
      acks.push(ack);
      return true;
    },
  );
  blob.attachReliableTransport(replacement);
  expect(blob.getPeerProtocol()).toBe(owner);
  expect(cradle.serialize()).toEqual(before);

  blob.deliverMessage(1n, await handshakeA());
  await blob.flushPendingWork();
  expect(acks).toEqual([1n]);
  expect(cradle.serialize()).not.toEqual(before);
});

test('retiring an accepted session invalidates its owned channel handle', async () => {
  const { blob, cradle } = await createAcceptedBlob();
  expect(cradle.serialize().length).toBeGreaterThan(0);
  blob.cleanup();
  expect(() => cradle.serialize()).toThrow();
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
