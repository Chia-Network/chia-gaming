import { handshakeA } from './accepted_session.harness';
import * as wasm from '../../../node-pkg/chia_gaming_wasm';
import { createPeerProtocol } from '../../services/peerProtocol';
import { decodePeerAppMessage, encodePeerAppMessage } from '../../services/PeerSession';
import { DEFAULT_SESSION_RECEIVE_POLICY } from '../session/receivePolicy';
import type { PeerEvent, PeerHost, PeerProtocolApi } from '../../../../wasm/contract';

const terms = {
  proposer_amount: '100',
  responder_amount: '200',
  channel_timeout: '15',
  unroll_timeout: '16',
  network: 'testnet11',
};
const proposal = () => encodePeerAppMessage({ type: 'session_proposal', ...terms });
const data = (peer: PeerProtocolApi, host: PeerHost, msgno: bigint, body: Uint8Array) =>
  peer.receive({ type: 'data', msgno, body }, host);
const ack = (peer: PeerProtocolApi, host: PeerHost, msgno: bigint) =>
  peer.receive({ type: 'ack', msgno }, host);
const commit = (peer: PeerProtocolApi, host: PeerHost) =>
  peer.complete_commit(peer.prepare_commit(), true, host);

function pendingPeer() {
  const peer = createPeerProtocol(
    {
      sessionId: '000102030405060708090a0b0c0d0e0f',
      messageNumber: 1n,
      remoteNumber: 0n,
      unackedMessages: [],
      disposition: 'active',
    },
    DEFAULT_SESSION_RECEIVE_POLICY,
  );
  const sent: Array<{ msgno: bigint; body: Uint8Array }> = [];
  const delivered: bigint[] = [];
  const acks: bigint[] = [];
  const events: PeerEvent[] = [];
  const host: PeerHost = {
    send: (frame) => {
      if (frame.type === 'data')
        sent.push({ msgno: frame.msgno, body: Uint8Array.from(frame.body) });
      else acks.push(frame.msgno);
      return true;
    },
    status: () => ({ available: true }),
    notify: (event) => {
      events.push(event);
      if (event.type === 'message') delivered.push(event.msgno);
    },
  };
  return { peer, host, sent, delivered, acks, events };
}

async function openChannel(peer: PeerProtocolApi, address: () => Promise<string>) {
  const rng = wasm.create_rng('01'.repeat(32));
  return peer.open_channel(terms, true, rng, '03'.repeat(32), address);
}

test('session objects isolate channel operations and retirement even with the same protocol ID', async () => {
  wasm.init();
  const first = pendingPeer().peer;
  const second = pendingPeer().peer;
  try {
    for (const peer of [first, second]) {
      peer.accept_session(terms, true);
      await openChannel(peer, async () => '02'.repeat(32));
    }
    const before = second.serialize();
    first.abandon();
    expect(first.serialize()).not.toEqual(before);
    expect(second.serialize()).toEqual(before);
    first.retire(false);
    expect(() => first.serialize()).toThrow();
    expect(second.serialize()).toEqual(before);
    expect(second.snapshot().unackedMessages).toHaveLength(1);
  } finally {
    first.free();
    second.free();
  }
});

test('Rust releases the proposal after checkpointing while waiting for the wallet address', async () => {
  wasm.init();
  const { peer, host, sent } = pendingPeer();
  peer.accept_session(terms, true);
  let resolveAddress!: (address: string) => void;
  const address = jest.fn(
    () =>
      new Promise<string>((resolve) => {
        resolveAddress = resolve;
      }),
  );
  const opening = openChannel(peer, address);
  await Promise.resolve();
  expect(address).toHaveBeenCalledTimes(1);
  peer.connectivity('registered', 10000, false, host);
  expect(sent).toEqual([]);
  commit(peer, host);
  expect(sent).toHaveLength(1);
  expect(sent[0].msgno).toBe(1n);
  expect(decodePeerAppMessage(sent[0].body)).toEqual({ type: 'session_proposal', ...terms });
  resolveAddress('02'.repeat(32));
  const channel = (await opening)!;
  expect(peer.serialize().length).toBeGreaterThan(0);
  expect(channel.rewardPuzzleHash).toBe('02'.repeat(32));
  expect(peer.snapshot().messageNumber).toBe(2n);
  await expect(openChannel(peer, address)).rejects.toThrow('already started');
  expect(address).toHaveBeenCalledTimes(1);
  peer.free();
});

test('restoring accepted setup requests an address and replays the original proposal', async () => {
  const { peer: original, host, sent } = pendingPeer();
  original.accept_session(terms, true);
  const restored = createPeerProtocol(original.snapshot(), DEFAULT_SESSION_RECEIVE_POLICY);
  await openChannel(restored, async () => '02'.repeat(32));
  expect(restored.serialize().length).toBeGreaterThan(0);
  restored.connectivity('registered', 10000, false, host);
  expect(sent).toHaveLength(1);
  expect(sent[0].msgno).toBe(1n);
  expect(restored.snapshot().messageNumber).toBe(2n);
  original.free();
  restored.free();
});

test.each([false, true])(
  'retirement while awaiting an address cancels construction (retain rejection: %s)',
  async (retainRejection) => {
    const { peer, host } = pendingPeer();
    peer.accept_session(terms, true);
    let resolveAddress!: (address: string) => void;
    const opening = openChannel(
      peer,
      () =>
        new Promise<string>((resolve) => {
          resolveAddress = resolve;
        }),
    );
    await Promise.resolve();
    if (retainRejection) peer.reject_session(host);
    peer.retire(retainRejection);
    resolveAddress('02'.repeat(32));
    expect(await opening).toBeUndefined();
    peer.free();
  },
);

test('inbound acceptance retains buffered channel traffic until the wallet address arrives, then delivers inside Rust', async () => {
  const { peer, host, delivered, sent, events } = pendingPeer();
  peer.consumer_ready('proposal', host);
  data(peer, host, 1n, proposal());
  data(peer, host, 2n, await handshakeA(terms));
  peer.accept_session(terms, false);
  peer.consumer_ready('channel', host);
  expect(delivered).toEqual([1n]);
  expect(peer.snapshot().remoteNumber).toBe(1n);
  await peer.open_channel(
    terms,
    false,
    wasm.create_rng('02'.repeat(32)),
    '03'.repeat(32),
    async () => '05'.repeat(32),
  );
  peer.consumer_ready('channel', host);
  commit(peer, host);
  expect(peer.snapshot().remoteNumber).toBe(2n);
  expect(delivered).toEqual([1n]);
  expect(events.filter(({ type }) => type === 'channel-result')).toHaveLength(1);
  expect(sent).toEqual([]);
  peer.free();
  expect(() => peer.serialize()).toThrow();
});

test('Rust handles rejected-session traffic without an application decoder', () => {
  const { peer, host, sent, delivered, events } = pendingPeer();
  peer.consumer_ready('rejection', host);
  peer.reject_session(host);
  commit(peer, host);
  data(peer, host, 1n, proposal());
  commit(peer, host);
  expect(sent).toHaveLength(1);
  ack(peer, host, 1n);
  expect(events).toContainEqual({ type: 'rejection-acknowledged' });
  expect(delivered).toEqual([]);
  expect(sent.map(({ body }) => decodePeerAppMessage(body))).toEqual([{ type: 'session_reject' }]);
  peer.free();
});

test('a proposal arriving after our rejection was acknowledged gets another rejection', () => {
  const { peer, host, sent } = pendingPeer();
  peer.consumer_ready('rejection', host);
  peer.reject_session(host);
  commit(peer, host);
  ack(peer, host, 1n);
  data(peer, host, 1n, proposal());
  commit(peer, host);
  expect(sent.map(({ msgno }) => msgno)).toEqual([1n, 2n]);
  expect(sent.map(({ body }) => decodePeerAppMessage(body))).toEqual([
    { type: 'session_reject' },
    { type: 'session_reject' },
  ]);
  peer.free();
});
