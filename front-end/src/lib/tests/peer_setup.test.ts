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
    status: () => ({ available: true, established: false, discarding: false }),
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
  expect(wasm.serialize_game_session(channel.id).length).toBeGreaterThan(0);
  expect(channel.rewardPuzzleHash).toBe('02'.repeat(32));
  expect(peer.snapshot().messageNumber).toBe(2n);
  await expect(openChannel(peer, address)).rejects.toThrow('already started');
  expect(address).toHaveBeenCalledTimes(1);
  wasm.drop_game_session(channel.id);
  peer.free();
});

test('restoring accepted setup requests an address and replays the original proposal', async () => {
  const { peer: original, host, sent } = pendingPeer();
  original.accept_session(terms, true);
  const restored = createPeerProtocol(original.snapshot(), DEFAULT_SESSION_RECEIVE_POLICY);
  const channel = (await openChannel(restored, async () => '02'.repeat(32)))!;
  restored.connectivity('registered', 10000, false, host);
  expect(sent).toHaveLength(1);
  expect(sent[0].msgno).toBe(1n);
  expect(restored.snapshot().messageNumber).toBe(2n);
  wasm.drop_game_session(channel.id);
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

test('inbound acceptance preserves buffered traffic without an outgoing proposal', () => {
  const { peer, host, delivered, sent } = pendingPeer();
  peer.consumer_ready('proposal', host);
  data(peer, host, 1n, proposal());
  data(peer, host, 2n, new Uint8Array([7]));
  peer.accept_session(terms, false);
  expect(delivered).toEqual([1n]);
  peer.consumer_ready('channel', host);
  commit(peer, host);
  expect(delivered).toEqual([1n, 2n]);
  expect(sent).toEqual([]);
  peer.free();
});

test('Rust orders delivery, tolerates a reentrant reply, and checkpoints sends and ACKs', () => {
  const { peer, host, delivered, sent, acks } = pendingPeer();
  const notify = host.notify;
  host.notify = (event) => {
    notify(event);
    if (event.type === 'message' && event.msgno === 1n)
      peer.send_message(new Uint8Array([9]), host);
  };
  data(peer, host, 3n, new Uint8Array([3]));
  data(peer, host, 1n, new Uint8Array([1]));
  data(peer, host, 2n, new Uint8Array([2]));
  expect(delivered).toEqual([1n, 2n, 3n]);
  expect(sent).toEqual([]);
  expect(acks).toEqual([]);
  commit(peer, host);
  expect(sent.map(({ msgno }) => msgno)).toEqual([1n]);
  expect(acks).toEqual([1n, 2n, 3n]);
  ack(peer, host, 1n);
  expect(peer.snapshot().unackedMessages).toEqual([]);
  peer.free();
});

test('Rust stops replay on carrier refusal and retries on the next registration', () => {
  const { peer, host, sent } = pendingPeer();
  peer.send_message(new Uint8Array([1]), host);
  peer.send_message(new Uint8Array([2]), host);
  commit(peer, host);
  sent.length = 0;
  const send = host.send;
  host.send = (frame) => {
    send(frame);
    return false;
  };
  peer.connectivity('disconnected', 10000, false, host);
  peer.connectivity('reconnected', 10000, false, host);
  expect(sent).toEqual([]);
  expect(peer.connectivity('registered', 10000, false, host)).toBe(false);
  expect(sent.map(({ msgno }) => msgno)).toEqual([1n]);
  host.send = send;
  expect(peer.connectivity('registered', 11000, false, host)).toBe(true);
  expect(sent.map(({ msgno }) => msgno)).toEqual([1n, 1n, 2n]);
  peer.free();
});

test('Rust retires buffered traffic when application delivery fails', () => {
  const { peer, host, delivered, events } = pendingPeer();
  const notify = host.notify;
  host.notify = (event) => {
    if (event.type === 'message') throw new Error('invalid application message');
    notify(event);
  };
  data(peer, host, 2n, new Uint8Array([2]));
  expect(data(peer, host, 1n, new Uint8Array([1]))).toBe(false);
  expect(events).toContainEqual({ type: 'failure', reason: 'invalid application message' });
  host.notify = notify;
  data(peer, host, 1n, new Uint8Array([1]));
  expect(delivered).toEqual([1n]);
  peer.free();
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
