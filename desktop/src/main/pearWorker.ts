import path from 'node:path';

import { app, ipcMain, webContents } from 'electron';
import FramedStream from 'framed-stream';
import PearRuntime from 'pear-runtime';

import { isAppUrl } from './appProtocol';
import { log } from './log';
import { isPlayerMainWebContents } from './mainWindow';
import { PEAR_MESSAGE_CHANNEL, PEAR_SEND_CHANNEL } from '../shared/ipc';

/** Generous upper bound for one command: a relayed frame is at most 1 MiB, base64-encoded. */
const MAX_COMMAND_LENGTH = 2 * 1024 * 1024;

/**
 * Broker between the player document and the Pear lobby worker, in the shape
 * of holepunchto/hello-pear-electron: main spawns a Bare sidecar through
 * pear-runtime and pipes framed bytes both ways. Hyperswarm, the lobby, and
 * the updater all live in the worker; main decides nothing about them.
 *
 * The worker is started lazily on the first command and outlives renderer
 * reloads, so a reload re-identifies against the same swarm instead of
 * dropping every peer connection.
 */
export function installPearWorker(): void {
  let pipe: FramedStream | null = null;

  const deliver = (message: string): void => {
    for (const contents of webContents.getAllWebContents()) {
      if (isPlayerMainWebContents(contents)) contents.send(PEAR_MESSAGE_CHANNEL, message);
    }
  };

  const startWorker = (): FramedStream => {
    const entry = path.join(app.getAppPath(), 'workers', 'main.cjs');
    // hello-pear-worker's positional contract: updates, version, upgrade link,
    // bundle name, storage dir, installed app path. There is no provisioned
    // `pear://` upgrade link yet, so OTA stays off.
    const worker = PearRuntime.run(entry, [
      'false',
      app.getVersion(),
      '',
      app.getName(),
      path.join(app.getPath('userData'), 'pear'),
      '',
    ]);
    const framed = new FramedStream(worker);
    worker.stderr.on('data', (data: Buffer) => log.error(`[pear-worker] ${data.toString()}`));
    worker.on('exit', (code) => {
      log.warn(`pear worker exited with code ${String(code)}`);
      if (pipe === framed) pipe = null;
      deliver(JSON.stringify({ t: 'worker_exit' }));
    });
    framed.on('data', (data: Buffer) => deliver(data.toString()));
    framed.on('error', (error: Error) => log.error(`pear worker pipe: ${error.message}`));
    app.once('before-quit', () => framed.destroy());
    log.info(`started pear worker ${entry}`);
    return framed;
  };

  ipcMain.handle(PEAR_SEND_CHANNEL, (event, message: unknown): boolean => {
    const frame = event.senderFrame;
    if (frame === null || frame !== event.sender.mainFrame || !isAppUrl(frame.url)) {
      log.warn(`ignored pear command from ${frame === null ? 'a gone frame' : frame.url}`);
      return false;
    }
    if (typeof message !== 'string' || message.length > MAX_COMMAND_LENGTH) {
      log.warn('ignored malformed pear command');
      return false;
    }
    pipe ??= startWorker();
    pipe.write(Buffer.from(message));
    return true;
  });
}
