import { BrowserWindow, app, shell } from 'electron';

import { APP_ORIGIN } from './appProtocol';
import { log } from './log';

const PROJECT_URL = 'https://github.com/Chia-Network/chia-gaming';

let aboutWindow: BrowserWindow | null = null;

export function showAboutWindow(): void {
  if (aboutWindow !== null && !aboutWindow.isDestroyed()) {
    aboutWindow.show();
    aboutWindow.focus();
    return;
  }

  const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const window = new BrowserWindow({
    width: 520,
    height: 590,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    show: false,
    parent,
    title: 'About Chia Gaming',
    backgroundColor: '#0d120f',
    webPreferences: {
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
    },
  });

  aboutWindow = window;
  window.setMenuBarVisibility(false);
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url === PROJECT_URL) {
      void shell.openExternal(url).catch((error: unknown) => {
        log.error(`failed to open project website: ${String(error)}`);
      });
    } else {
      log.warn(`blocked About window link: ${url}`);
    }
    return { action: 'deny' };
  });
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {
    aboutWindow = null;
  });

  const query = new URLSearchParams({
    version: app.getVersion(),
    electron: process.versions.electron,
    chromium: process.versions.chrome,
  });
  void window.loadURL(`${APP_ORIGIN}/about.html?${query.toString()}`);
}
