// Zero-dependency static file server for the player app.
// Usage: node static-server.js <serve-directory> [port]

const http = require('http');
const fs = require('fs');
const path = require('path');

const SERVE_DIR = process.argv[2];
const PORT = parseInt(process.argv[3] || '3002', 10);

if (!SERVE_DIR) {
  console.error('Usage: node static-server.js <serve-directory> [port]');
  process.exit(1);
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

  const filePath = path.join(SERVE_DIR, pathname);

  // Prevent directory traversal
  if (!filePath.startsWith(path.resolve(SERVE_DIR))) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA fallback: serve index.html for missing files
      if (err.code === 'ENOENT' && !path.extname(pathname)) {
        return fs.readFile(path.join(SERVE_DIR, 'index.html'), (err2, html) => {
          if (err2) { res.writeHead(404); return res.end('Not found'); }
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(html);
        });
      }
      res.writeHead(404);
      return res.end('Not found');
    }
    const ct = MIME[path.extname(filePath)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': ct });
    res.end(data);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Static server: http://localhost:${PORT} -> ${SERVE_DIR}`);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} already in use`);
  }
  process.exit(1);
});
