import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

import { buildSync } from 'esbuild';

const require = createRequire(import.meta.url);
const source = buildSync({
  entryPoints: [fileURLToPath(new URL('./mainWindow.ts', import.meta.url))],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  packages: 'external',
  write: false,
}).outputFiles[0].text;

function event() {
  return {
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
}

function playerWindow(responses: number[]) {
  let confirmations = 0;
  class Window extends EventEmitter {
    webContents = Object.assign(new EventEmitter(), { id: 1 });
    show() {}
    async loadURL() {}
  }
  const module = { exports: {} as { createMainWindow: () => Window } };
  runInNewContext(source, {
    module,
    require: (name: string) =>
      name === 'electron'
        ? {
            BrowserWindow: Window,
            app: { getAppPath: () => '/app', isPackaged: true },
            dialog: {
              showMessageBoxSync: () => {
                confirmations++;
                assert.ok(responses.length > 0, 'unexpected extra quit confirmation');
                return responses.shift();
              },
            },
          }
        : require(name),
  });
  return {
    window: module.exports.createMainWindow(),
    confirmations: () => confirmations,
  };
}

describe('player window quit confirmation', () => {
  it('honors Quit even when a live session prevents browser unload', () => {
    const { window, confirmations } = playerWindow([1]);
    const close = event();
    window.emit('close', close);
    assert.equal(close.defaultPrevented, false);
    const unload = event();
    window.webContents.emit('will-prevent-unload', unload);
    // Electron interprets preventing this event as allowing the unload.
    assert.equal(unload.defaultPrevented, true);
    assert.equal(confirmations(), 1);
  });

  it('honors Cancel, then allows a later explicitly confirmed close', () => {
    const { window, confirmations } = playerWindow([0, 1]);
    const cancelled = event();
    window.emit('close', cancelled);
    assert.equal(cancelled.defaultPrevented, true);
    const unloadAfterCancel = event();
    window.webContents.emit('will-prevent-unload', unloadAfterCancel);
    assert.equal(unloadAfterCancel.defaultPrevented, false);
    const confirmed = event();
    window.emit('close', confirmed);
    assert.equal(confirmed.defaultPrevented, false);
    const unloadAfterQuit = event();
    window.webContents.emit('will-prevent-unload', unloadAfterQuit);
    assert.equal(unloadAfterQuit.defaultPrevented, true);
    assert.equal(confirmations(), 2);
  });

  it('preserves the browser unload warning without a confirmed close', () => {
    const { window, confirmations } = playerWindow([]);
    const unload = event();
    window.webContents.emit('will-prevent-unload', unload);
    assert.equal(unload.defaultPrevented, false);
    assert.equal(confirmations(), 0);
  });
});
