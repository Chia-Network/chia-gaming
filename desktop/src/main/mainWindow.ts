import path from 'node:path';

import { BrowserWindow, app, dialog } from 'electron';

import { APP_ORIGIN } from './appProtocol';

let playerMainWebContentsId: number | undefined;

/** True for the player window created by `createMainWindow`, not About or popups. */
export function isPlayerMainWebContents(contents: { id: number }): boolean {
  return playerMainWebContentsId !== undefined && contents.id === playerMainWebContentsId;
}

export function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    backgroundColor: '#000000',
    title: 'Chia Gaming',
    webPreferences: {
      preload: path.join(app.getAppPath(), 'dist', 'preload', 'index.cjs'),
      // The isolation posture. Several of these are already the default; they
      // are spelled out so the whole boundary is auditable in one place and a
      // future Electron default change cannot quietly widen it.
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
      // State-channel timeouts and the hub relay socket must keep running while
      // the window is in the background, where Chromium throttles timers hard.
      backgroundThrottling: false,
    },
  });

  window.on('close', (event) => {
    const response = dialog.showMessageBoxSync(window, {
      type: 'question',
      buttons: ['Cancel', 'Quit'],
      defaultId: 0,
      cancelId: 0,
      title: 'Quit Chia Gaming?',
      message: 'Are you sure you want to quit Chia Gaming?',
    });

    if (response === 0) {
      event.preventDefault();
    }
  });

  playerMainWebContentsId = window.webContents.id;
  window.on('closed', () => {
    if (playerMainWebContentsId === window.webContents.id) {
      playerMainWebContentsId = undefined;
    }
  });

  window.once('ready-to-show', () => window.show());
  void window.loadURL(`${APP_ORIGIN}/index.html`);
  return window;
}
