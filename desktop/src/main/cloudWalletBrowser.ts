import { randomUUID } from 'node:crypto';

import {
  BrowserWindow,
  app,
  ipcMain,
  net,
  shell,
  type IpcMainInvokeEvent,
  type WebContents,
} from 'electron';

import { startLoopbackCallback, type LoopbackCallback } from './cloudWalletLoopback';
import { authorizeRequestState, cloudWalletUrl, isCloudWalletTokenUrl } from './cloudWalletPolicy';
import { describeSender, isPlayerDocumentSender } from './ipcSender';
import { log } from './log';
import { type PolicyRef } from './networkPolicy';
import {
  CLOUD_WALLET_BEGIN_LOGIN_CHANNEL,
  CLOUD_WALLET_CANCEL_LOGIN_CHANNEL,
  CLOUD_WALLET_COMPLETE_LOGIN_CHANNEL,
  CLOUD_WALLET_OPEN_CHANNEL,
  CLOUD_WALLET_TOKEN_CHANNEL,
  type CloudWalletLoginFlow,
  type CloudWalletLoginResult,
  type CloudWalletTokenResponse,
} from '../shared/ipc';

/** Matches the web popup's OAuth wait (`waitForOAuthCode`). */
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
/** Form bodies carry a code or refresh token plus fixed fields; this is generous. */
const MAX_TOKEN_REQUEST_LENGTH = 8 * 1024;

/** Bring back the window that started sign-in once the browser hands control back. */
function focusWindowOf(contents: WebContents): void {
  const window = BrowserWindow.fromWebContents(contents);
  if (window !== null && !window.isDestroyed()) {
    if (window.isMinimized()) window.restore();
    window.focus();
  }
  // A plain focus() does not raise a background app on macOS.
  if (process.platform === 'darwin') app.focus({ steal: true });
}

/**
 * Cloud Wallet sign-in and signature approval run in the system browser, where
 * passkeys work. Electron's WebAuthn has no platform authenticator, so the same
 * pages in an Electron window wait forever. Sign-in returns through a loopback
 * redirect bound per sign-in; approvals need no return path because the player
 * polls the signature request.
 */
export function installCloudWalletBrowser(policy: PolicyRef): void {
  // One sign-in at a time: starting another cancels the previous one, so an
  // abandoned browser tab can neither hold a listener nor complete later.
  let pending: { flowId: string; callback: LoopbackCallback } | null = null;

  const fromPlayer = (event: IpcMainInvokeEvent, channel: string): boolean => {
    if (isPlayerDocumentSender(event)) return true;
    log.warn(`ignored ${channel} from ${describeSender(event)}`);
    return false;
  };

  ipcMain.handle(
    CLOUD_WALLET_BEGIN_LOGIN_CHANNEL,
    async (event): Promise<CloudWalletLoginFlow | null> => {
      if (!fromPlayer(event, CLOUD_WALLET_BEGIN_LOGIN_CHANNEL)) return null;
      pending?.callback.close();
      const flowId = randomUUID();
      const callback = await startLoopbackCallback(LOGIN_TIMEOUT_MS, () =>
        focusWindowOf(event.sender),
      );
      const flow = { flowId, callback };
      pending = flow;
      void callback.result.finally(() => {
        if (pending === flow) pending = null;
      });
      return { flowId, redirectUri: callback.redirectUri };
    },
  );

  ipcMain.handle(
    CLOUD_WALLET_COMPLETE_LOGIN_CHANNEL,
    async (event, flowId: unknown, authorizeUrl: unknown): Promise<CloudWalletLoginResult> => {
      if (!fromPlayer(event, CLOUD_WALLET_COMPLETE_LOGIN_CHANNEL)) {
        return { error: 'Cloud Wallet sign-in is only available to the player app' };
      }
      if (pending === null || pending.flowId !== flowId) {
        return { error: 'Cloud Wallet sign-in was superseded or has ended' };
      }
      const { callback } = pending;
      const state = authorizeRequestState(
        authorizeUrl,
        callback.redirectUri,
        policy.current.cloudWalletOrigins,
      );
      if (state === null) {
        callback.close();
        log.warn(`refused Cloud Wallet sign-in URL ${String(authorizeUrl)}`);
        return { error: 'Cloud Wallet sign-in URL is not allowed' };
      }
      callback.expectState(state);
      try {
        await shell.openExternal(authorizeUrl as string);
      } catch (error) {
        callback.close();
        return { error: `Could not open the browser: ${(error as Error).message}` };
      }
      return callback.result;
    },
  );

  // The browser cannot tell us its tab was closed, so the app's Cancel ends
  // the sign-in instead of leaving it to the timeout.
  ipcMain.handle(CLOUD_WALLET_CANCEL_LOGIN_CHANNEL, (event, flowId: unknown): void => {
    if (!fromPlayer(event, CLOUD_WALLET_CANCEL_LOGIN_CHANNEL)) return;
    if (pending !== null && pending.flowId === flowId) pending.callback.close();
  });

  // The token endpoint answers CORS only for http(s) client origins, so the
  // player's `chiagaming:` document cannot call it. Main makes the request as
  // a native client would (RFC 8252); PKCE still binds the code to the player.
  ipcMain.handle(
    CLOUD_WALLET_TOKEN_CHANNEL,
    async (event, tokenUrl: unknown, body: unknown): Promise<CloudWalletTokenResponse> => {
      if (!fromPlayer(event, CLOUD_WALLET_TOKEN_CHANNEL)) {
        return { transportError: 'Cloud Wallet tokens are only available to the player app' };
      }
      if (
        typeof body !== 'string' ||
        body.length > MAX_TOKEN_REQUEST_LENGTH ||
        !isCloudWalletTokenUrl(tokenUrl, policy.current.cloudWalletOrigins)
      ) {
        log.warn(`refused Cloud Wallet token request to ${String(tokenUrl)}`);
        return { transportError: 'Cloud Wallet token request is not allowed' };
      }
      try {
        const response = await net.fetch(tokenUrl as string, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
        });
        return { status: response.status, text: await response.text() };
      } catch (error) {
        return { transportError: (error as Error).message };
      }
    },
  );

  ipcMain.handle(CLOUD_WALLET_OPEN_CHANNEL, async (event, url: unknown): Promise<boolean> => {
    if (!fromPlayer(event, CLOUD_WALLET_OPEN_CHANNEL)) return false;
    const page = cloudWalletUrl(url, policy.current.cloudWalletOrigins);
    if (page === null) {
      log.warn(`refused to open ${String(url)} in the browser`);
      return false;
    }
    try {
      await shell.openExternal(page.toString());
      return true;
    } catch (error) {
      log.warn(`could not open ${page.toString()}: ${(error as Error).message}`);
      return false;
    }
  });
}
