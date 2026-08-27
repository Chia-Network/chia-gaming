import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { protocol } from 'electron';

import { log } from './log';
import type { PolicyRef } from './networkPolicy';

/**
 * The renderer is served from a custom scheme rather than `file://`.
 *
 * A registered standard+secure scheme gives the player app a real opaque
 * origin, which is what makes localStorage, IndexedDB, `crypto.subtle` and
 * relative asset URLs behave exactly as they do in the browser deploy — with
 * `webSecurity` left on and no `file://` privileges granted to anything.
 */
const APP_SCHEME = 'chiagaming';
const APP_HOST = 'app';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

/**
 * True for URLs this app serves itself.
 *
 * Matched on scheme and host rather than compared against `APP_ORIGIN`, because
 * `URL.origin` is unusable for a scheme the URL standard does not consider
 * special: Node's parser reports the origin as `"null"`, and Chromium
 * serialises it as `chiagaming://app/` with a trailing slash. Neither form ever
 * equals `APP_ORIGIN`, so comparing origins silently denies the app itself.
 */
export function isAppUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === `${APP_SCHEME}:` && url.host === APP_HOST;
  } catch {
    return false;
  }
}

const MIME_TYPES = new Map<string, string>([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.woff2', 'font/woff2'],
  ['.ico', 'image/x-icon'],
  ['.hex', 'text/plain; charset=utf-8'],
]);

/** Chialisp `.dat` payloads and anything else are fetched as bytes. */
const DEFAULT_MIME_TYPE = 'application/octet-stream';

/** Must match `CLOUD_WALLET_OAUTH_CALLBACK_PATH` in `front-end/src/constants/env.ts`. */
const OAUTH_CALLBACK_PATH = '/oauth/callback';

function isOAuthCallbackPath(pathname: string): boolean {
  const normalized = pathname.replace(/\/$/, '') || '/';
  return normalized === OAUTH_CALLBACK_PATH;
}

/** Must run before the `ready` event: Chromium reads the scheme registry once at startup. */
export function registerAppSchemeAsPrivileged(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
        allowServiceWorkers: false,
      },
    },
  ]);
}

function textResponse(body: string, status: number): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

/**
 * Map a request pathname onto a file inside `rendererRoot`, or null when the
 * request tries to escape it. `path.resolve` normalises `..` segments, so the
 * containment check below is what actually enforces the boundary.
 */
function resolveRequestedFile(rendererRoot: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) {
    return null;
  }
  const relative = decoded.replace(/^\/+/, '');
  const target = path.resolve(rendererRoot, relative === '' ? 'index.html' : relative);
  if (target !== rendererRoot && !target.startsWith(rendererRoot + path.sep)) {
    return null;
  }
  return target;
}

export function serveAppScheme(rendererRoot: string, policy: PolicyRef): void {
  log.info(`serving ${APP_ORIGIN} from ${rendererRoot}`);

  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== APP_HOST) {
      log.warn(`rejected request for unknown host: ${url.host}`);
      return textResponse('Not found', 404);
    }

    let filePath = resolveRequestedFile(rendererRoot, url.pathname);
    if (filePath === null) {
      log.warn(`rejected out-of-root request: ${url.pathname}`);
      return textResponse('Forbidden', 403);
    }
    // Cloud Wallet OAuth returns the popup to this path. There is no file at
    // that name; serve the player document so App.tsx can render OAuthCallback.
    if (isOAuthCallbackPath(url.pathname)) {
      filePath = path.join(rendererRoot, 'index.html');
    }
    // Read through Node's fs rather than `net.fetch(file://…)`: asar support is
    // implemented as an fs shim, so this is what lets the renderer stay sealed
    // inside app.asar where the integrity-validation fuse still covers it.
    let body: ArrayBuffer;
    try {
      // toArrayBuffer, rather than handing the Buffer straight to Response:
      // readFile returns a view onto a pooled allocation, which is neither a
      // standalone ArrayBuffer nor a valid BodyInit.
      const file = await readFile(filePath);
      body = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'EISDIR') {
        log.warn(`no such asset: ${url.pathname}`);
        return textResponse('Not found', 404);
      }
      log.error(`failed to read ${url.pathname}: ${(error as Error).message}`);
      return textResponse('Internal error', 500);
    }

    const headers = new Headers({
      'content-type': MIME_TYPES.get(path.extname(filePath).toLowerCase()) ?? DEFAULT_MIME_TYPE,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    });
    // The CSP belongs on the document, which is the only thing that can host
    // script. Read per document, so reloading is all it takes to apply a hub
    // the user approved since this document was loaded.
    if (filePath.endsWith('.html')) {
      headers.set('content-security-policy', policy.current.contentSecurityPolicy);
    }

    return new Response(body, { status: 200, headers });
  });
}
