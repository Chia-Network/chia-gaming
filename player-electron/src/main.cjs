'use strict';

// Chia Gaming player app - Electron main process.
//
// The renderer is the unmodified static player-app bundle (staged into
// ../app at build time). It is served over a custom `app://` scheme rather
// than file:// so that the bundle's relative `fetch()` calls for .hex/.wasm
// assets behave exactly as they do on the web.

const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, protocol, shell } = require('electron');
const { CSP, mimeFor, resolveAppRoot, resolveAppPath } = require('./assets.cjs');

// Root of the staged static bundle (dev: player-electron/app/; packaged:
// app.asar.unpacked/app — see resolveAppRoot).
const APP_ROOT = resolveAppRoot(__dirname);

// The single origin the renderer runs under.
const APP_ORIGIN = 'app://local';

// Register `app://` as a standard, secure, fetch-capable scheme. Must run
// before the app `ready` event.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

function registerAppProtocol() {
  protocol.handle('app', async (request) => {
    const filePath = resolveAppPath(APP_ROOT, request.url);
    if (!filePath) {
      return new Response('Forbidden', { status: 403 });
    }
    try {
      const data = await fs.promises.readFile(filePath);
      const headers = { 'content-type': mimeFor(filePath) };
      // Apply CSP to the top-level document.
      if (filePath.endsWith('.html')) {
        headers['content-security-policy'] = CSP;
      }
      return new Response(data, { status: 200, headers });
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        return new Response('Not found', { status: 404 });
      }
      return new Response('Internal error', { status: 500 });
    }
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: '#000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  // Never open game/tracker links in a new Electron window; hand them to the
  // user's real browser instead.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Keep the top-level frame pinned to our own origin. Subframes (the tracker
  // iframe) are unaffected by will-navigate on the main frame.
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(APP_ORIGIN)) {
      event.preventDefault();
      if (/^https?:/.test(url)) {
        shell.openExternal(url);
      }
    }
  });

  win.loadURL(`${APP_ORIGIN}/index.html`);
  return win;
}

app.whenReady().then(() => {
  registerAppProtocol();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
