// Asking the desktop shell for permission to reach a hub.
//
// The desktop build confines network egress to an allowlist the main process
// owns, so a hub the user picks has to be added there before it is reachable.
// The web build has no such boundary — the browser already lets the page talk
// to any origin — so there is nothing to ask and every hub reports as trusted.

type HubTrustOutcome = 'trusted' | 'granted' | 'invalid';

export async function requestHubTrust(origin: string): Promise<HubTrustOutcome> {
  const bridge = typeof window === 'undefined' ? undefined : window.__chiaHub;
  if (bridge === undefined) {
    return 'trusted';
  }
  return bridge.requestTrust(origin);
}

/** Message for an outcome that stops the connection attempt, or null to proceed. */
export function hubTrustError(outcome: HubTrustOutcome, origin: string): string | null {
  return outcome === 'invalid' ? `${origin} is not a valid hub address.` : null;
}
