import { app } from 'electron';
import type { Session } from 'electron';

import { isAppUrl } from './appProtocol';
import { log } from './log';
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

function isNavigationAllowed(url: string, isMainFrame: boolean, policy: NetworkPolicy): boolean {
  // A page-initiated blank frame grants no capability the page does not have.
  if (url === 'about:blank') {
    return true;
  }
  // The top frame stays on the app's own pages; reloading it is how a newly
  // trusted hub takes effect, so this has to admit our own URLs.
  if (isMainFrame) {
    return isAppUrl(url);
  }
  const origin = originOfUrl(url);
  return origin !== null && policy.allowedFrameOrigins.has(origin);
}

export function installWebContentsSecurity(policy: PolicyRef): void {
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler((details) => {
      log.warn(`blocked window.open for ${details.url}`);
      return { action: 'deny' };
    });

    // 'will-frame-navigate' covers every frame; 'will-navigate' only the top one.
    contents.on('will-frame-navigate', (details) => {
      if (isNavigationAllowed(details.url, details.isMainFrame, policy.current)) {
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
