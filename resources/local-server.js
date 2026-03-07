// Lightweight static-file + reverse-proxy server that replaces nginx for local
// development.  Uses only Node.js built-in modules (no npm install needed).
//
// Usage:  node local-server.js <project-root>

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PROJECT_ROOT = process.argv[2];
if (!PROJECT_ROOT) {
    console.error('Usage: node local-server.js <project-root> [game-port] [lobby-port]');
    process.exit(1);
}

const GAME_PORT  = parseInt(process.argv[3] || process.env.GAME_PORT  || '3002', 10);
const LOBBY_PORT = parseInt(process.argv[4] || process.env.LOBBY_PORT || '3003', 10);

const FE_DIR = path.join(PROJECT_ROOT, 'resources', 'gaming-fe');
const LOBBY_VIEW_DIR = path.join(PROJECT_ROOT, 'resources', 'lobby-view');
const CLSP_DIR = path.join(PROJECT_ROOT, 'clsp');

const MIME = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.mjs': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.wasm': 'application/wasm',
    '.hex': 'application/octet-stream',
    '.clsp': 'text/plain',
    '.clinc': 'text/plain',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.map': 'application/json',
};

function sendFile(res, filePath, contentType) {
    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404);
            res.end('Not found');
            return;
        }
        const ct = contentType || MIME[path.extname(filePath)] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': ct });
        res.end(data);
    });
}

function proxyHttp(req, res, port) {
    const opts = {
        hostname: '127.0.0.1',
        port,
        path: req.url,
        method: req.method,
        headers: req.headers,
    };
    const proxy = http.request(opts, (pRes) => {
        res.writeHead(pRes.statusCode, pRes.headers);
        pRes.pipe(res);
    });
    proxy.on('error', () => {
        res.writeHead(502);
        res.end('Bad gateway');
    });
    req.pipe(proxy);
}

function proxyWebSocket(req, clientSocket, head, port) {
    const backend = net.connect(port, '127.0.0.1', () => {
        const hdrs = Object.entries(req.headers)
            .map(([k, v]) => `${k}: ${v}`)
            .join('\r\n');
        backend.write(
            `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${hdrs}\r\n\r\n`
        );
        if (head.length > 0) backend.write(head);
        backend.pipe(clientSocket);
        clientSocket.pipe(backend);
    });
    backend.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => backend.destroy());
}

// ── Game frontend ─────────────────────────────────────────────────

const gameServer = http.createServer((req, res) => {
    const pathname = url.parse(req.url).pathname;

    // Proxy lobby API and socket.io to lobby-service so the game frontend
    // can reach them same-origin (avoids cross-origin issues with port 3003).
    if (pathname.startsWith('/lobby') || pathname.startsWith('/socket.io')) {
        return proxyHttp(req, res, 5801);
    }

    if (pathname === '/index.js') {
        return sendFile(res, path.join(FE_DIR, 'dist', 'js', 'index-rollup.js'));
    }
    if (pathname === '/index.css') {
        return sendFile(res, path.join(FE_DIR, 'dist', 'css', 'index.css'), 'text/css');
    }
    if (pathname === '/chia_gaming_wasm.js') {
        return sendFile(res, path.join(FE_DIR, 'dist', 'chia_gaming_wasm.js'), 'application/javascript');
    }
    if (pathname === '/chia_gaming_wasm_bg.wasm') {
        return sendFile(res, path.join(FE_DIR, 'dist', 'chia_gaming_wasm_bg.wasm'), 'application/wasm');
    }
    if (pathname.startsWith('/clsp/')) {
        return sendFile(res, path.join(CLSP_DIR, pathname.substring(5)));
    }
    if (pathname === '/urls') {
        return sendFile(res, path.join(FE_DIR, 'dist', 'urls'));
    }

    // Try public/ first, then dist/, then SPA fallback to index.html
    const publicPath = path.join(FE_DIR, 'public', pathname === '/' ? 'index.html' : pathname);
    fs.access(publicPath, fs.constants.F_OK, (err) => {
        if (!err) return sendFile(res, publicPath);

        const distPath = path.join(FE_DIR, 'dist', pathname);
        fs.access(distPath, fs.constants.F_OK, (err2) => {
            if (!err2) return sendFile(res, distPath);
            sendFile(res, path.join(FE_DIR, 'public', 'index.html'));
        });
    });
});

gameServer.on('upgrade', (req, socket, head) => {
    if (url.parse(req.url).pathname.startsWith('/socket.io')) {
        proxyWebSocket(req, socket, head, 5801);
    } else {
        socket.destroy();
    }
});

gameServer.listen(GAME_PORT, '127.0.0.1', () => {
    console.log(`Game frontend:  http://localhost:${GAME_PORT}`);
});
gameServer.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
        console.error(`Port ${GAME_PORT} already in use – kill the old process or set GAME_PORT`);
    }
    process.exit(1);
});

// ── Lobby view ────────────────────────────────────────────────────

const lobbyServer = http.createServer((req, res) => {
    const pathname = url.parse(req.url).pathname;

    if (pathname.startsWith('/lobby') || pathname.startsWith('/socket.io')) {
        return proxyHttp(req, res, 5801);
    }
    if (pathname === '/index.js') {
        return sendFile(res, path.join(LOBBY_VIEW_DIR, 'public', 'index.js'));
    }
    if (pathname === '/index.css') {
        return sendFile(res, path.join(LOBBY_VIEW_DIR, 'dist', 'css', 'index.css'), 'text/css');
    }

    const publicPath = path.join(
        LOBBY_VIEW_DIR, 'public',
        pathname === '/' ? 'index.html' : pathname
    );
    fs.access(publicPath, fs.constants.F_OK, (err) => {
        if (!err) return sendFile(res, publicPath);
        sendFile(res, path.join(LOBBY_VIEW_DIR, 'public', 'index.html'));
    });
});

lobbyServer.on('upgrade', (req, socket, head) => {
    if (url.parse(req.url).pathname.startsWith('/socket.io')) {
        proxyWebSocket(req, socket, head, 5801);
    } else {
        socket.destroy();
    }
});

lobbyServer.listen(LOBBY_PORT, '127.0.0.1', () => {
    console.log(`Lobby view:     http://localhost:${LOBBY_PORT}`);
});
lobbyServer.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
        console.error(`Port ${LOBBY_PORT} already in use – kill the old process or set LOBBY_PORT`);
    }
    process.exit(1);
});
