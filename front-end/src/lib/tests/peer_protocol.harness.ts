import type { PeerProtocolApi, PeerProtocolState } from '../../../../wasm/contract';

/** Seed a saved checkpoint through the restore boundary, never by mutating a live queue. */
export function restorePeerState(
  target: {
    getPeerProtocol?: () => PeerProtocolApi;
    reliableTransport?: { protocol: PeerProtocolApi };
    reliableState?: PeerProtocolState;
  },
  state: Partial<PeerProtocolState>,
): void {
  const protocol = target.getPeerProtocol?.() ?? target.reliableTransport?.protocol;
  if (protocol) protocol.restore({ ...protocol.snapshot(), ...state });
  else Object.assign(target.reliableState!, state);
}
