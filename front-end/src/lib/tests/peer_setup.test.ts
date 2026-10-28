import * as wasm from '../../../node-pkg/chia_gaming_wasm';
import { createPeerProtocol } from '../../services/peerProtocol';
import { decodePeerAppMessage } from '../../services/PeerSession';
import { DEFAULT_SESSION_RECEIVE_POLICY } from '../session/receivePolicy';

const terms = {
  proposer_amount: '100',
  responder_amount: '200',
  channel_timeout: '15',
  unroll_timeout: '16',
  network: 'testnet11',
};

function pendingPeer() {
  return createPeerProtocol(
    {
      sessionId: '000102030405060708090a0b0c0d0e0f',
      messageNumber: 1n,
      remoteNumber: 0n,
      unackedMessages: [],
      disposition: 'active',
    },
    DEFAULT_SESSION_RECEIVE_POLICY,
  );
}

test('local acceptance owns proposal delivery and the wallet-address wait in Rust', () => {
  wasm.init();
  const peer = pendingPeer();
  expect(peer.wallet_address_requested()).toBe(false);
  peer.accept_session(terms, true);
  expect(peer.wallet_address_requested()).toBe(true);
  const proposal = peer.snapshot().unackedMessages[0];
  expect(proposal.msgno).toBe(1n);
  expect(decodePeerAppMessage(Uint8Array.from(proposal.msg))).toEqual({
    type: 'session_proposal',
    ...terms,
  });
  expect(peer.connectivity('registered', 10000, false)).toEqual([]);
  const frames = peer.complete_commit(peer.prepare_commit(), true);
  expect(frames.outbound).toHaveLength(1);
  // The proposal can be released while the session is still waiting for its
  // address. Supplying the result creates the channel in that same session.
  expect(peer.wallet_address_requested()).toBe(true);
  const rng = wasm.create_rng('01'.repeat(32));
  const channel = peer.provide_wallet_address(rng, '02'.repeat(32), '03'.repeat(32));
  expect(wasm.serialize_game_session(channel.id).length).toBeGreaterThan(0);
  expect(peer.wallet_address_requested()).toBe(false);
  expect(peer.message_number()).toBe(2n);
  expect(() => peer.provide_wallet_address(rng, '02'.repeat(32), '03'.repeat(32))).toThrow(
    'not waiting',
  );
  wasm.drop_game_session(channel.id);
  peer.free();
});

test('restoring accepted setup requests the address without allocating a second proposal', () => {
  const original = pendingPeer();
  original.accept_session(terms, true);
  const state = original.snapshot();
  const restored = createPeerProtocol(state, DEFAULT_SESSION_RECEIVE_POLICY);
  restored.restore_setup(terms, true);
  expect(restored.wallet_address_requested()).toBe(true);
  expect(restored.message_number()).toBe(2n);
  expect(restored.snapshot().unackedMessages).toHaveLength(1);
  expect(restored.connectivity('registered', 10000, false)).toHaveLength(1);
  original.free();
  restored.free();
});

test('accepting an inbound proposal adopts the buffered stream without an outgoing proposal', () => {
  const peer = pendingPeer();
  peer.delivered(1n);
  peer.receive(2n, new Uint8Array([7]), false, false);
  peer.accept_session(terms, false);
  expect(peer.remote_number()).toBe(1n);
  expect(peer.next_message()?.msgno).toBe(2n);
  expect(peer.snapshot().unackedMessages).toEqual([]);
  expect(peer.wallet_address_requested()).toBe(true);
  peer.free();
});
