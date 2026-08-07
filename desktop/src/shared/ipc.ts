/**
 * The single IPC channel this app has. Shared by the main process and the
 * preload so the name cannot drift between them.
 */
export const HUB_TRUST_CHANNEL = 'chia-gaming:request-hub-trust';

/**
 * - `trusted`  already on the allowlist; connect straight away.
 * - `granted`  just added to it; the renderer must reload to pick up the widened
 *              CSP before the hub becomes reachable.
 * - `invalid`  malformed origin, or a request from somewhere that may not ask.
 */
export type HubTrustOutcome = 'trusted' | 'granted' | 'invalid';
