// @ts-expect-error Node.js types are not included in the frontend configuration.
import * as fs from 'fs';
// @ts-expect-error Node.js types are not included in the frontend configuration.
import { resolve } from 'path';
import * as wasm from '../../../node-pkg/chia_gaming_wasm';
import { PRESET_FILES } from '../../generated/gamePresets';
import { createPeerProtocol } from '../../services/peerProtocol';
import { type WasmConnection } from '../../types/ChiaGaming';
import { DEFAULT_SESSION_RECEIVE_POLICY } from '../session/receivePolicy';
import { SessionController } from '../session/SessionController';
import {
  attachTestCommitCoordinator,
  makePeerConn,
  saveLiveSession,
  setTestPersistence,
  trackTestController,
} from './message_protocol.harness';

export const acceptedTerms = {
  proposer_amount: '100',
  responder_amount: '100',
  channel_timeout: '15',
  unroll_timeout: '15',
};
export const realWasm = wasm as unknown as WasmConnection;

export function initializeAcceptedSessionWasm(): void {
  wasm.init();
  for (const name of PRESET_FILES) {
    // @ts-expect-error Node.js globals are not included in the frontend configuration.
    wasm.cache_file(name, new Uint8Array(fs.readFileSync(resolve(__dirname, '../../../..', name))));
  }
}

/** A real accepted Rust owner and channel; the wallet remains unavailable. */
export async function installAcceptedChannel(
  blob: SessionController,
  initiator = false,
  alreadyAccepted = false,
) {
  initializeAcceptedSessionWasm();
  blob.blockchain = null;
  const protocol = blob.getPeerProtocol();
  if (!alreadyAccepted) protocol.accept_session(acceptedTerms, initiator);
  const channel = await protocol.open_channel(acceptedTerms, initiator, '03'.repeat(32), async () =>
    (initiator ? '04' : '05').repeat(32),
  );
  if (!channel) throw new Error('accepted fixture was retired');
  const cradle = protocol;
  blob.iStarted = initiator;
  blob.rewardPuzzleHash = channel.rewardPuzzleHash;
  blob.loadWasm(realWasm);
  blob.setGameSession(cradle);
  return cradle;
}

export async function createAcceptedBlob(initiator = false, ready = true) {
  const sentMessages: Array<{ msgno: number; msg: Uint8Array }> = [];
  const sentAcks: number[] = [];
  const blob = new SessionController(
    null,
    'test',
    100n,
    100n,
    makePeerConn(sentMessages, sentAcks),
  );
  trackTestController(blob);
  blob.pairingToken = 'test-pairing';
  const fixture = { blob, sentMessages, sentAcks };
  attachTestCommitCoordinator(blob);
  const cradle = await installAcceptedChannel(blob, initiator);
  if (ready) blob.kickSystem(2);
  setTestPersistence(fixture.blob, () => {
    const fields = fixture.blob.getWasmFields();
    if (!fields) throw new Error('accepted session is not serializable');
    return saveLiveSession(fields as unknown as Record<string, unknown>);
  });
  await fixture.blob.flushPendingWork();
  fixture.sentMessages.length = 0;
  fixture.sentAcks.length = 0;
  return { ...fixture, cradle };
}

/** Generate input using the real initiator, without a simulator or opaque byte fixtures. */
export async function handshakeA(terms = acceptedTerms): Promise<Uint8Array> {
  initializeAcceptedSessionWasm();
  const peer = createPeerProtocol(
    {
      sessionId: '00'.repeat(16),
      messageNumber: 1n,
      remoteNumber: 0n,
      unackedMessages: [],
      disposition: 'active',
    },
    DEFAULT_SESSION_RECEIVE_POLICY,
    '01'.repeat(32),
  );
  peer.accept_session(terms, true);
  const channel = await peer.open_channel(terms, true, '03'.repeat(32), async () =>
    '04'.repeat(32),
  );
  if (!channel) throw new Error('initiator fixture was retired');
  peer.start_handshake('0');
  const body = peer.snapshot().unackedMessages.at(-1)?.msg;
  if (!body) throw new Error('initiator did not produce HandshakeA');
  peer.free();
  return Uint8Array.from(body);
}
