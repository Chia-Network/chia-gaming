import type { PeerProtocolApi, PeerProtocolState } from '../../../wasm/contract';
import type { ReadonlySessionReceivePolicy } from '../lib/session/receivePolicy';

export type PeerProtocolFactory = (
  state: PeerProtocolState,
  policy: ReadonlySessionReceivePolicy,
  seed: string,
) => PeerProtocolApi;

let factory: PeerProtocolFactory | undefined;

export function resetPeerProtocolForTests(): void {
  factory = undefined;
}

export function isPeerProtocolInstalled(): boolean {
  return !!factory;
}

export function installPeerProtocol(create: PeerProtocolFactory): void {
  factory = create;
}

export function createPeerProtocol(
  state: PeerProtocolState,
  policy: ReadonlySessionReceivePolicy,
  seed?: string,
): PeerProtocolApi {
  if (!factory) throw new Error('Peer protocol requires initialized WASM');
  if (seed === undefined) {
    const entropy = crypto.getRandomValues(new Uint8Array(32));
    seed = Array.from(entropy, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return factory(state, policy, seed);
}
