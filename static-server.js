// Zero-dependency static file server for the player app.
// Usage: node static-server.js <serve-directory> [port] [host]

const http = require('http');
const fs = require('fs');
const path = require('path');

const SERVE_DIR = process.argv[2];
const PORT = parseInt(process.argv[3] || '3002', 10);
const HOST = process.argv[4] || '127.0.0.1';

if (!SERVE_DIR) {
  console.error('Usage: node static-server.js <serve-directory> [port]');
  process.exit(1);
}

const ROOT = path.resolve(SERVE_DIR);

function resolveUnderRoot(urlPathname) {
  const rel = urlPathname.replace(/^\/+/, '');
  const filePath = path.resolve(ROOT, rel);
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    return null;
  }
  return filePath;
}

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.hex': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
};

const server = http.createServer((req, res) => {
  let pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/') pathname = '/index.html';

  const filePath = resolveUnderRoot(pathname);
  if (!filePath) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA fallback: serve index.html for missing files
      if (err.code === 'ENOENT' && !path.extname(pathname)) {
        return fs.readFile(path.join(ROOT, 'index.html'), (err2, html) => {
          if (err2) { res.writeHead(404); return res.end('Not found'); }
          res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
          res.end(html);
        });
      }
      res.writeHead(404);
      return res.end('Not found');
    }
    const ext = path.extname(filePath);
    const ct = MIME[ext] || 'application/octet-stream';
    const cc = pathname.startsWith('/app/')
      ? 'public, max-age=31536000, immutable'
      : 'no-store';
    const headers = { 'Content-Type': ct, 'Cache-Control': cc };
    if (ext === '.wasm') {
      headers['SourceMap'] = path.basename(filePath) + '.map';
    }
    res.writeHead(200, headers);
    res.end(data);
  });
});

// Leave HTTP asset connections reusable briefly, then let Node close idle
// keep-alives. This does not affect upgraded WebSocket connections.
server.keepAliveTimeout = 5_000;
server.headersTimeout = 6_000;

server.listen(PORT, HOST, () => {
  console.log(`Static server: http://${HOST}:${PORT} -> ${ROOT}`);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} already in use`);
  }
  process.exit(1);
});
