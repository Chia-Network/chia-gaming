import { contextBridge, ipcRenderer } from 'electron';

import {
  CLOUD_WALLET_BEGIN_LOGIN_CHANNEL,
  CLOUD_WALLET_COMPLETE_LOGIN_CHANNEL,
  CLOUD_WALLET_OPEN_CHANNEL,
  CLOUD_WALLET_TOKEN_CHANNEL,
  HUB_TRUST_CHANNEL,
  type CloudWalletLoginFlow,
  type CloudWalletLoginResult,
  type CloudWalletTokenResponse,
  type HubTrustOutcome,
} from '../shared/ipc';

/**
 * Sub-frames are remote content — the hub lobby UI and the WalletConnect Verify
 * attestation frame — and must not see anything exposed here.
 *
 * `process.isMainFrame` is not part of the `process` subset a sandboxed preload
 * gets, and `webFrame.parent` reports null for out-of-process frames, so
 * identity against `window.top` is the check that actually holds.
 */
if (window === window.top) {
  // front-end/src/util/distribution.ts reads this to drop web-only
  // affordances. It has to be set before the first render, which is why it is
  // a preload global rather than anything asynchronous.
  contextBridge.exposeInMainWorld('__chiaDistribution', 'electron');

  // Ask the user to allow a hub origin. Nothing here decides anything — main
  // validates the origin, prompts, and owns the allowlist.
  contextBridge.exposeInMainWorld('__chiaHub', {
    requestTrust: (origin: string): Promise<HubTrustOutcome> =>
      ipcRenderer.invoke(HUB_TRUST_CHANNEL, origin) as Promise<HubTrustOutcome>,
  });

  // Cloud Wallet sign-in and approvals open in the system browser, where
  // passkeys work (front-end/src/hooks/cloudWalletOAuth.ts).
  contextBridge.exposeInMainWorld('__chiaCloudWallet', {
    beginBrowserLogin: (): Promise<CloudWalletLoginFlow | null> =>
      ipcRenderer.invoke(CLOUD_WALLET_BEGIN_LOGIN_CHANNEL) as Promise<CloudWalletLoginFlow | null>,
    completeBrowserLogin: (flowId: string, authorizeUrl: string): Promise<CloudWalletLoginResult> =>
      ipcRenderer.invoke(
        CLOUD_WALLET_COMPLETE_LOGIN_CHANNEL,
        flowId,
        authorizeUrl,
      ) as Promise<CloudWalletLoginResult>,
    openInBrowser: (url: string): Promise<boolean> =>
      ipcRenderer.invoke(CLOUD_WALLET_OPEN_CHANNEL, url) as Promise<boolean>,
    postToken: (tokenUrl: string, body: string): Promise<CloudWalletTokenResponse> =>
      ipcRenderer.invoke(
        CLOUD_WALLET_TOKEN_CHANNEL,
        tokenUrl,
        body,
      ) as Promise<CloudWalletTokenResponse>,
  });

  // Dev-only Cloud Wallet endpoints for a local environment. The renderer reads
  // these globals as CLOUD_WALLET_OVERRIDE (front-end/src/constants/env.ts).
  // The origins must also be listed in config.json `cloudWalletOrigins`.
  for (const [variable, global] of [
    ['CHIA_GAMING_CLOUD_WALLET_API_URL', '__CLOUD_WALLET_API_URL__'],
    ['CHIA_GAMING_CLOUD_WALLET_UI_URL', '__CLOUD_WALLET_UI_URL__'],
    ['CHIA_GAMING_CLOUD_WALLET_CLIENT_ID', '__CLOUD_WALLET_CLIENT_ID__'],
  ] as const) {
    const value = process.env[variable];
    if (value) contextBridge.exposeInMainWorld(global, value);
  }
}
