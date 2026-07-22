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

/** Cache policy for nonce deploy layout (only root URLs are stable across rebuilds). */
function cacheControlForPath(pathname) {
  if (pathname.startsWith('/app/')) {
    return 'public, max-age=31536000, immutable';
  }
  if (pathname === '/build-meta.json') {
    return 'no-store';
  }
  if (pathname === '/' || pathname === '/index.html' || pathname.endsWith('.html')) {
    return 'no-cache';
  }
  // favicon and other stable root static
  return 'public, max-age=86400';
}

function sendFile(res, filePath, pathname) {
  const ext = path.extname(filePath);
  const ct = MIME[ext] || 'application/octet-stream';
  const headers = {
    'Content-Type': ct,
    'Cache-Control': cacheControlForPath(pathname),
  };
  if (ext === '.wasm') {
    headers['SourceMap'] = path.basename(filePath) + '.map';
  }

  const stream = fs.createReadStream(filePath);
  stream.on('open', () => {
    res.writeHead(200, headers);
    stream.pipe(res);
  });
  stream.on('error', (err) => {
    if (err.code === 'ENOENT') {
      if (!res.headersSent) {
        res.writeHead(404);
        res.end('Not found');
      }
      return;
    }
    if (!res.headersSent) {
      res.writeHead(500);
      res.end('Internal error');
    } else {
      res.destroy(err);
    }
  });
}

const server = http.createServer((req, res) => {
  let pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/') pathname = '/index.html';

  const filePath = resolveUnderRoot(pathname);
  if (!filePath) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.stat(filePath, (err, st) => {
    if (!err && st.isFile()) {
      return sendFile(res, filePath, pathname);
    }

    // SPA fallback: serve index.html for missing extensionless paths
    if (err && err.code === 'ENOENT' && !path.extname(pathname)) {
      const indexPath = path.join(ROOT, 'index.html');
      return fs.stat(indexPath, (err2, st2) => {
        if (err2 || !st2.isFile()) {
          res.writeHead(404);
          return res.end('Not found');
        }
        return sendFile(res, indexPath, '/index.html');
      });
    }

    res.writeHead(404);
    return res.end('Not found');
  });
});

// Keep connections reusable across parallel WASM + CLSP fetches.
server.keepAliveTimeout = 60_000;
server.headersTimeout = 61_000;

server.listen(PORT, HOST, () => {
  console.log(`Static server: http://${HOST}:${PORT} -> ${ROOT}`);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} already in use`);
  }
  process.exit(1);
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Static server received ${signal}; shutting down`);
  const deadline = setTimeout(() => {
    server.closeAllConnections?.();
    process.exit();
  }, 5_000);
  server.close((err) => {
    clearTimeout(deadline);
    if (err) {
      console.error(`Static server shutdown failed: ${err.message}`);
      process.exitCode = 1;
    }
  });
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
