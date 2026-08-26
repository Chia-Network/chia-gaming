import path from 'node:path';

import {
  BrowserWindow,
  Menu,
  app,
  dialog,
  session,
  type MenuItemConstructorOptions,
} from 'electron';

import { showAboutWindow } from './aboutWindow';
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
app.setName('Chia Gaming');

function installApplicationMenu(): void {
  const aboutItem: MenuItemConstructorOptions = {
    label: 'About Chia Gaming',
    click: showAboutWindow,
  };
  const macAppMenu: MenuItemConstructorOptions = {
    label: 'Chia Gaming',
    submenu: [
      aboutItem,
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { label: 'Hide Chia Gaming', role: 'hide' },
      { label: 'Hide Others', role: 'hideOthers' },
      { label: 'Show All', role: 'unhide' },
      { type: 'separator' },
      { label: 'Quit Chia Gaming', role: 'quit' },
    ],
  };
  const helpMenu: MenuItemConstructorOptions = {
    label: 'Help',
    submenu: [aboutItem],
  };
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [macAppMenu] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    ...(process.platform === 'darwin' ? [] : [helpMenu]),
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

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
    installApplicationMenu();
    installSessionSecurity(session.defaultSession, policy);
    serveAppScheme(rendererRoot, policy);
    createMainWindow();

    app.on('activate', focusMainWindow);
  });
}
