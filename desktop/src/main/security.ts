import path from 'node:path';

import { app } from 'electron';
import type { Session, WebContents, WebPreferences } from 'electron';

import { isAppUrl } from './appProtocol';
import { log } from './log';
import { isPlayerMainWebContents } from './mainWindow';
import { originOfUrl, type NetworkPolicy, type PolicyRef } from './networkPolicy';

/**
 * `navigator.clipboard.writeText` is gated on this permission in Electron, and
 * the UI needs it to copy WalletConnect URIs and diagnostic logs. Nothing else
 * the player app does requires a permission, so everything else is denied.
 */
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write']);

/**
 * Only network schemes are filtered. Requests on the app's own scheme never
 * reach the network stack — the protocol handler answers them from disk.
 */
const NETWORK_URL_PATTERNS = ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'];

export function installSessionSecurity(target: Session, policy: PolicyRef): void {
  target.setPermissionRequestHandler((_contents, permission, callback, details) => {
    const granted = ALLOWED_PERMISSIONS.has(permission) && isAppUrl(details.requestingUrl);
    if (!granted) {
      log.warn(`denied permission "${permission}" requested by ${details.requestingUrl}`);
    }
    callback(granted);
  });

  target.setPermissionCheckHandler(
    (_contents, permission, requestingOrigin) =>
      ALLOWED_PERMISSIONS.has(permission) && isAppUrl(requestingOrigin),
  );

  // No WebUSB / WebHID / Web Serial device is ever reachable.
  target.setDevicePermissionHandler(() => false);

  target.webRequest.onBeforeRequest({ urls: NETWORK_URL_PATTERNS }, (details, callback) => {
    const origin = originOfUrl(details.url);
    if (origin !== null && policy.current.allowedRequestOrigins.has(origin)) {
      callback({});
      return;
    }
    log.warn(`blocked ${details.resourceType} request to ${details.url}`);
    callback({ cancel: true });
  });
}

function isNavigationAllowed(
  url: string,
  isMainFrame: boolean,
  policy: NetworkPolicy,
  contents: WebContents,
): boolean {
  // A page-initiated blank frame grants no capability the page does not have.
  if (url === 'about:blank') {
    return true;
  }
  // App URLs: the player window, About, and the Cloud Wallet OAuth callback
  // popup returning to `chiagaming://app/oauth/callback`.
  if (isAppUrl(url)) {
    return true;
  }
  if (!isMainFrame) {
    const origin = originOfUrl(url);
    return origin !== null && policy.allowedFrameOrigins.has(origin);
  }
  // The player window's top frame stays on the app. Cloud Wallet popups may
  // leave for an allowlisted origin (authorize / consent / approve).
  if (isPlayerMainWebContents(contents)) {
    return false;
  }
  const origin = originOfUrl(url);
  return origin !== null && policy.allowedPopupOrigins.has(origin);
}

function popupWebPreferences(): WebPreferences {
  return {
    // Do not inherit the player preload; Cloud Wallet pages are remote.
    preload: path.join(app.getAppPath(), 'dist', 'preload', 'empty.cjs'),
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    webviewTag: false,
    navigateOnDragDrop: false,
    spellcheck: false,
    devTools: !app.isPackaged,
  };
}

export function installWebContentsSecurity(policy: PolicyRef): void {
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler((details) => {
      const origin = originOfUrl(details.url);
      if (origin !== null && policy.current.allowedPopupOrigins.has(origin)) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            webPreferences: popupWebPreferences(),
          },
        };
      }
      log.warn(`blocked window.open for ${details.url}`);
      return { action: 'deny' };
    });

    // 'will-frame-navigate' covers every frame; 'will-navigate' only the top one.
    contents.on('will-frame-navigate', (details) => {
      if (isNavigationAllowed(details.url, details.isMainFrame, policy.current, contents)) {
        return;
      }
      const frame = details.isMainFrame ? 'top-level' : 'sub-frame';
      log.warn(`blocked ${frame} navigation to ${details.url}`);
      details.preventDefault();
    });

    contents.on('will-attach-webview', (event) => {
      log.warn('blocked <webview> attachment');
      event.preventDefault();
    });
  });
}
