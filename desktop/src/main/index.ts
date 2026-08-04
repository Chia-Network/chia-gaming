import path from 'node:path';

import { BrowserWindow, app, dialog, session } from 'electron';

import { registerAppSchemeAsPrivileged, serveAppScheme } from './appProtocol';
import { loadDesktopConfig, type DesktopConfig } from './config';
import { log } from './log';
import { createMainWindow } from './mainWindow';
import { buildNetworkPolicy } from './networkPolicy';
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
  const policy = buildNetworkPolicy(config);
  const rendererRoot = path.join(app.getAppPath(), 'dist', 'renderer');

  installWebContentsSecurity(policy);

  // The window is looked up in the live list rather than held in a variable:
  // macOS keeps the app running with every window closed, so a saved handle
  // would be a destroyed BrowserWindow, and every method on one of those
  // throws. `isReady` covers a second launch arriving during our own startup,
  // before a window may be created at all.
  const focusOrCreateMainWindow = (): void => {
    const [existing] = BrowserWindow.getAllWindows();
    if (existing === undefined) {
      if (app.isReady()) {
        createMainWindow();
      }
      return;
    }
    if (existing.isMinimized()) {
      existing.restore();
    }
    existing.focus();
  };

  app.on('second-instance', focusOrCreateMainWindow);

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  void app.whenReady().then(() => {
    installSessionSecurity(session.defaultSession, policy);
    serveAppScheme(rendererRoot, policy.contentSecurityPolicy);
    createMainWindow();

    app.on('activate', focusOrCreateMainWindow);
  });
}
