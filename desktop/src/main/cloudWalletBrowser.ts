import { randomUUID } from 'node:crypto';

import { ipcMain, net, shell, type IpcMainInvokeEvent } from 'electron';

import { isAppUrl } from './appProtocol';
import {
  isAuthorizeUrlForCallback,
  isCloudWalletTokenUrl,
  startLoopbackCallback,
  type LoopbackCallback,
} from './cloudWalletLoopback';
import { log } from './log';
import { type PolicyRef } from './networkPolicy';
import {
  CLOUD_WALLET_BEGIN_LOGIN_CHANNEL,
  CLOUD_WALLET_COMPLETE_LOGIN_CHANNEL,
  CLOUD_WALLET_OPEN_CHANNEL,
  CLOUD_WALLET_TOKEN_CHANNEL,
  type CloudWalletLoginFlow,
  type CloudWalletLoginResult,
  type CloudWalletTokenResponse,
} from '../shared/ipc';

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TOKEN_REQUEST_BYTES = 8 * 1024;

function fromPlayerDocument(event: IpcMainInvokeEvent, channel: string): boolean {
  const frame = event.senderFrame;
  if (frame === null || frame !== event.sender.mainFrame || !isAppUrl(frame.url)) {
    log.warn(`ignored ${channel} from ${frame === null ? 'a gone frame' : frame.url}`);
    return false;
  }
  return true;
}

function isCloudWalletPage(url: string, policy: PolicyRef): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && policy.current.allowedPopupOrigins.has(parsed.origin);
  } catch {
    return false;
  }
}

/**
 * Cloud Wallet sign-in and signature approval run in the system browser, where
 * passkeys work. Electron's WebAuthn has no platform authenticator, so the same
 * pages in an Electron popup wait forever. Sign-in returns through a loopback
 * redirect bound per login; approvals need no return path because the player
 * polls the signature request.
 */
export function installCloudWalletBrowser(policy: PolicyRef, focusMainWindow: () => void): void {
  const flows = new Map<string, LoopbackCallback>();

  ipcMain.handle(
    CLOUD_WALLET_BEGIN_LOGIN_CHANNEL,
    async (event): Promise<CloudWalletLoginFlow | null> => {
      if (!fromPlayerDocument(event, CLOUD_WALLET_BEGIN_LOGIN_CHANNEL)) return null;
      const flowId = randomUUID();
      const callback = await startLoopbackCallback(LOGIN_TIMEOUT_MS, focusMainWindow);
      flows.set(flowId, callback);
      void callback.result.finally(() => flows.delete(flowId));
      return { flowId, redirectUri: callback.redirectUri };
    },
  );

  ipcMain.handle(
    CLOUD_WALLET_COMPLETE_LOGIN_CHANNEL,
    async (event, flowId: unknown, authorizeUrl: unknown): Promise<CloudWalletLoginResult> => {
      if (!fromPlayerDocument(event, CLOUD_WALLET_COMPLETE_LOGIN_CHANNEL)) {
        return { error: 'Cloud Wallet sign-in is only available to the player app' };
      }
      const callback = typeof flowId === 'string' ? flows.get(flowId) : undefined;
      if (callback === undefined) return { error: 'Unknown Cloud Wallet sign-in' };
      if (
        typeof authorizeUrl !== 'string' ||
        !isAuthorizeUrlForCallback(
          authorizeUrl,
          callback.redirectUri,
          policy.current.allowedPopupOrigins,
        )
      ) {
        callback.close();
        log.warn(`refused Cloud Wallet sign-in URL ${String(authorizeUrl)}`);
        return { error: 'Cloud Wallet sign-in URL is not allowed' };
      }
      await shell.openExternal(authorizeUrl);
      return callback.result;
    },
  );

  // The token endpoint answers CORS only for http(s) client origins, so the
  // player's `chiagaming:` document cannot call it. Main makes the request as
  // a native client would (RFC 8252); PKCE still binds the code to the player.
  ipcMain.handle(
    CLOUD_WALLET_TOKEN_CHANNEL,
    async (event, tokenUrl: unknown, body: unknown): Promise<CloudWalletTokenResponse> => {
      if (!fromPlayerDocument(event, CLOUD_WALLET_TOKEN_CHANNEL)) {
        return { transportError: 'Cloud Wallet tokens are only available to the player app' };
      }
      if (
        typeof tokenUrl !== 'string' ||
        typeof body !== 'string' ||
        body.length > MAX_TOKEN_REQUEST_BYTES ||
        !isCloudWalletTokenUrl(tokenUrl, policy.current.allowedPopupOrigins)
      ) {
        log.warn(`refused Cloud Wallet token request to ${String(tokenUrl)}`);
        return { transportError: 'Cloud Wallet token request is not allowed' };
      }
      try {
        const response = await net.fetch(tokenUrl, {
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
    if (!fromPlayerDocument(event, CLOUD_WALLET_OPEN_CHANNEL)) return false;
    if (typeof url !== 'string' || !isCloudWalletPage(url, policy)) {
      log.warn(`refused to open ${String(url)} in the browser`);
      return false;
    }
    await shell.openExternal(url);
    return true;
  });
}
