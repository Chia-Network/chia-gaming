import * as wasm from '../../../node-pkg/chia_gaming_wasm';
import { createPeerProtocol } from '../../services/peerProtocol';
import { decodePeerAppMessage } from '../../services/PeerSession';
import { DEFAULT_SESSION_RECEIVE_POLICY } from '../session/receivePolicy';
import type { PeerHost } from '../../../../wasm/contract';

const terms = {
  proposer_amount: '100',
  responder_amount: '200',
  channel_timeout: '15',
  unroll_timeout: '16',
  network: 'testnet11',
};

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
  const host: PeerHost = {
    sendData: (msgno, body) => {
      sent.push({ msgno, body: Uint8Array.from(body) });
      return true;
    },
    sendAck: (msgno) => {
      acks.push(msgno);
      return true;
    },
    ready: () => true,
    canDeliver: () => true,
    canTerminate: () => false,
    deliver: (msgno) => {
      delivered.push(msgno);
    },
    notify: () => {},
  };
  return { peer, host, sent, delivered, acks };
}

test('Rust requests proposal delivery after the checkpoint while waiting for its wallet address', () => {
  wasm.init();
  const { peer, host, sent } = pendingPeer();
  expect(peer.wallet_address_requested()).toBe(false);
  peer.accept_session(terms, true);
  expect(peer.wallet_address_requested()).toBe(true);
  peer.connectivity('registered', 10000, false, host);
  expect(sent).toEqual([]);
  peer.complete_commit(peer.prepare_commit(), true, host);
  expect(sent).toHaveLength(1);
  expect(sent[0].msgno).toBe(1n);
  expect(decodePeerAppMessage(sent[0].body)).toEqual({ type: 'session_proposal', ...terms });
  expect(peer.wallet_address_requested()).toBe(true);
  const rng = wasm.create_rng('01'.repeat(32));
  const channel = peer.provide_wallet_address(rng, '02'.repeat(32), '03'.repeat(32));
  expect(wasm.serialize_game_session(channel.id).length).toBeGreaterThan(0);
  expect(peer.wallet_address_requested()).toBe(false);
  expect(peer.snapshot().messageNumber).toBe(2n);
  expect(() => peer.provide_wallet_address(rng, '02'.repeat(32), '03'.repeat(32))).toThrow(
    'not waiting',
  );
  wasm.drop_game_session(channel.id);
  peer.free();
});

test('restoring accepted setup requests the address and Rust replays the original proposal', () => {
  const { peer: original, host, sent } = pendingPeer();
  original.accept_session(terms, true);
  const restored = createPeerProtocol(original.snapshot(), DEFAULT_SESSION_RECEIVE_POLICY);
  restored.restore_setup(terms, true);
  expect(restored.wallet_address_requested()).toBe(true);
  restored.connectivity('registered', 10000, false, host);
  expect(sent).toHaveLength(1);
  expect(sent[0].msgno).toBe(1n);
  expect(restored.snapshot().messageNumber).toBe(2n);
  original.free();
  restored.free();
});

test('accepting an inbound proposal adopts buffered traffic without an outgoing proposal', () => {
  const { peer, host, delivered, sent } = pendingPeer();
  host.canDeliver = (msgno) => msgno === 1n;
  peer.receive_data(1n, new Uint8Array([1]), host);
  peer.receive_data(2n, new Uint8Array([7]), host);
  peer.accept_session(terms, false);
  expect(delivered).toEqual([1n]);
  host.canDeliver = () => true;
  peer.consumer_ready(host);
  peer.complete_commit(peer.prepare_commit(), true, host);
  expect(delivered).toEqual([1n, 2n]);
  expect(sent).toEqual([]);
  expect(peer.wallet_address_requested()).toBe(true);
  peer.free();
});

test('Rust orders delivery, tolerates a reentrant reply, and releases sends and ACKs after persistence', () => {
  const { peer, host, delivered, sent, acks } = pendingPeer();
  host.deliver = (msgno) => {
    delivered.push(msgno);
    if (msgno === 1n) peer.send_message(new Uint8Array([9]), 'active', host);
  };
  peer.receive_data(3n, new Uint8Array([3]), host);
  peer.receive_data(1n, new Uint8Array([1]), host);
  peer.receive_data(2n, new Uint8Array([2]), host);
  expect(delivered).toEqual([1n, 2n, 3n]);
  expect(sent).toEqual([]);
  expect(acks).toEqual([]);
  peer.complete_commit(peer.prepare_commit(), true, host);
  expect(sent.map(({ msgno }) => msgno)).toEqual([1n]);
  expect(acks).toEqual([1n, 2n, 3n]);
  peer.receive_ack(1n, host);
  expect(peer.snapshot().unackedMessages).toEqual([]);
  peer.free();
});

test('Rust stops replay when the carrier refuses a send and retries on the next registration', () => {
  const { peer, host, sent } = pendingPeer();
  peer.send_message(new Uint8Array([1]), 'active', host);
  peer.send_message(new Uint8Array([2]), 'active', host);
  peer.complete_commit(peer.prepare_commit(), true, host);
  sent.length = 0;
  const send = host.sendData;
  host.sendData = (msgno, body) => {
    send(msgno, body);
    return false;
  };
  peer.connectivity('disconnected', 10000, false, host);
  peer.connectivity('reconnected', 10000, false, host);
  expect(sent).toEqual([]);
  expect(peer.connectivity('registered', 10000, false, host)).toBe(false);
  expect(sent.map(({ msgno }) => msgno)).toEqual([1n]);
  host.sendData = send;
  expect(peer.connectivity('registered', 11000, false, host)).toBe(true);
  expect(sent.map(({ msgno }) => msgno)).toEqual([1n, 1n, 2n]);
  peer.free();
});

test('Rust retires buffered traffic when application delivery fails', () => {
  const { peer, host, delivered } = pendingPeer();
  const failure = jest.fn();
  host.notify = (event) => {
    if (event.type === 'failure') failure(event.reason);
  };
  peer.receive_data(2n, new Uint8Array([2]), host);
  host.deliver = () => {
    throw new Error('invalid application message');
  };
  expect(peer.receive_data(1n, new Uint8Array([1]), host)).toBe(false);
  expect(failure).toHaveBeenCalledWith('invalid application message');
  host.deliver = (msgno) => {
    delivered.push(msgno);
  };
  peer.receive_data(1n, new Uint8Array([1]), host);
  expect(delivered).toEqual([1n]);
  peer.free();
});

test('Rust decides whether a repeated proposal needs another rejection', () => {
  const { peer, host, sent } = pendingPeer();
  peer.reject_session(host);
  peer.complete_commit(peer.prepare_commit(), true, host);
  peer.proposal_received(host);
  peer.complete_commit(peer.prepare_commit(), true, host);
  expect(sent).toHaveLength(1);
  peer.receive_ack(1n, host);
  expect(peer.rejection_complete()).toBe(true);
  peer.proposal_received(host);
  peer.complete_commit(peer.prepare_commit(), true, host);
  expect(sent.map(({ msgno }) => msgno)).toEqual([1n, 2n]);
  expect(sent.map(({ body }) => decodePeerAppMessage(body))).toEqual([
    { type: 'session_reject' },
    { type: 'session_reject' },
  ]);
  peer.free();
});
