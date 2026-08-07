import path from 'node:path';

import { BrowserWindow, app, dialog, session } from 'electron';

import { registerAppSchemeAsPrivileged, serveAppScheme } from './appProtocol';
import { loadDesktopConfig, type DesktopConfig } from './config';
import { installHubTrustHandler } from './hubTrust';
import { log } from './log';
import { createMainWindow } from './mainWindow';
import { buildNetworkPolicy, type PolicyRef } from './networkPolicy';
import { installSessionSecurity, installWebContentsSecurity } from './security';

// Both of these have to happen before the 'ready' event.
registerAppSchemeAsPrivileged();
app.enableSandbox();

function loadConfigOrExit(): DesktopConfig {
  try {
    return loadDesktopConfig();
  } catch (error) {
    dialog.showErrorBox('Chia Gaming configuration error', (error as Error).message);
    app.exit(1);
    throw error;
  }
}

if (!app.requestSingleInstanceLock()) {
  log.info('another instance already holds the single-instance lock; exiting');
  app.exit(0);
} else {
  const config = loadConfigOrExit();
  const policy: PolicyRef = { current: buildNetworkPolicy(config) };
  const rendererRoot = path.join(app.getAppPath(), 'dist', 'renderer');

  installWebContentsSecurity(policy);
  installHubTrustHandler(config, policy);

  // The window is looked up in the live list rather than held in a variable: a
  // saved handle would be a destroyed BrowserWindow after a close, and every
  // method on one of those throws. The list is empty while startup has not
  // created the window yet and while the app is shutting down after a close.
  const focusMainWindow = (): void => {
    const [existing] = BrowserWindow.getAllWindows();
    if (existing === undefined) {
      return;
    }
    if (existing.isMinimized()) {
      existing.restore();
    }
    existing.focus();
  };

  app.on('second-instance', focusMainWindow);

  // Closing the window quits on macOS too, unlike the platform convention: this
  // is a single-window app with no document model and no tray presence, so a
  // process with no window left would offer the player nothing.
  app.on('window-all-closed', () => {
    app.quit();
  });

  void app.whenReady().then(() => {
    installSessionSecurity(session.defaultSession, policy);
    serveAppScheme(rendererRoot, policy);
    createMainWindow();

    app.on('activate', focusMainWindow);
  });
}
