import type { PeerProtocolApi, PeerProtocolState } from '../../../wasm/contract';
import type { ReadonlySessionReceivePolicy } from '../lib/session/receivePolicy';

export type PeerProtocolFactory = (
  state: PeerProtocolState,
  policy: ReadonlySessionReceivePolicy,
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
): PeerProtocolApi {
  if (!factory) throw new Error('Peer protocol requires initialized WASM');
  return factory(state, policy);
}
