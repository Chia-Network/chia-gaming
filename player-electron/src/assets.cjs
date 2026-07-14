'use strict';

// Pure (electron-free) helpers for serving the staged static bundle over the
// app:// scheme. Kept separate from main.cjs so they can be unit-tested in
// plain Node without spinning up Electron.

const path = require('node:path');

// Content-Security-Policy applied to the main document. Allows:
//  - our own app:// scheme for all bundled assets
//  - WASM compilation (wasm-unsafe-eval) and the bundle's inline bootstrap
//  - the WalletConnect relay (wss) and any user-chosen tracker (ws/wss/https)
//  - the tracker lobby iframe (http/https, matching the origins connect-src
//    allows for the tracker relay socket)
const CSP = [
  "default-src 'self' app:",
  "script-src 'self' app: 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'",
  "style-src 'self' app: 'unsafe-inline'",
  "img-src 'self' app: data: https:",
  "font-src 'self' app: data:",
  "connect-src 'self' app: https: http: wss: ws:",
  "frame-src https: http:",
].join('; ');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.hex': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function mimeFor(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

// Resolve an app:// URL to an absolute path inside appRoot. Returns null for
// any path that escapes appRoot (directory traversal) or has malformed
// percent-encoding (decodeURIComponent throws URIError).
function resolveAppPath(appRoot, requestUrl) {
  const url = new URL(requestUrl);
  let rel;
  try {
    rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  } catch {
    return null;
  }
  if (rel === '') rel = 'index.html';
  const resolved = path.normalize(path.join(appRoot, rel));
  const rootWithSep = appRoot.endsWith(path.sep) ? appRoot : appRoot + path.sep;
  if (resolved !== appRoot && !resolved.startsWith(rootWithSep)) {
    return null;
  }
  return resolved;
}

module.exports = { CSP, MIME_TYPES, mimeFor, resolveAppPath };
