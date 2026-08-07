import { ipcMain } from 'electron';

import { isAppUrl } from './appProtocol';
import { hubOriginSchema, persistHubOrigins, type DesktopConfig } from './config';
import { log } from './log';
import { buildNetworkPolicy, type PolicyRef } from './networkPolicy';
import { HUB_TRUST_CHANNEL, type HubTrustOutcome } from '../shared/ipc';

/**
 * A hub is third-party infrastructure anyone can run, and players are meant to
 * be able to choose one freely, so the allowlist is extensible at runtime rather
 * than fixed at build time.
 *
 * The allowlist stays in the main process, and what that buys is that a hub
 * cannot widen it. The preload exposes no bridge to sub-frames, a hub can never
 * navigate the top frame, and the sender is checked below as well: the only
 * caller that can reach this is the player document.
 *
 * That document's request is then taken at face value. It is our own bundle,
 * served from `chiagaming://` under a CSP that permits no inline, remote or
 * `eval`-able script, so a native prompt here would only guard against a
 * compromised bundle, which could equally well fake the prompt's own UI or leave
 * through the hub already on the allowlist. What a hub can see is disclosed in
 * the picker instead, where the user is actually choosing.
 */
export function installHubTrustHandler(config: DesktopConfig, policy: PolicyRef): void {
  ipcMain.handle(HUB_TRUST_CHANNEL, (event, rawOrigin: unknown): HubTrustOutcome => {
    const frame = event.senderFrame;
    if (frame === null || frame !== event.sender.mainFrame || !isAppUrl(frame.url)) {
      log.warn(`ignored hub trust request from ${frame === null ? 'a gone frame' : frame.url}`);
      return 'invalid';
    }

    const parsed = hubOriginSchema.safeParse(rawOrigin);
    if (!parsed.success) {
      log.warn(`ignored hub trust request for a malformed origin: ${String(rawOrigin)}`);
      return 'invalid';
    }
    const origin = parsed.data;

    if (config.hubOrigins.includes(origin)) {
      return 'trusted';
    }

    config.hubOrigins = [...config.hubOrigins, origin];
    policy.current = buildNetworkPolicy(config);
    log.info(`trusted hub origin ${origin}`);

    // Failing to persist costs the user the same reload next launch; it does
    // not invalidate the grant made for this one.
    try {
      persistHubOrigins(config.hubOrigins);
    } catch (error) {
      log.error(`could not persist hub origins: ${(error as Error).message}`);
    }

    return 'granted';
  });
}
