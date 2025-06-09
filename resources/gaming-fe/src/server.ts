import express from 'express';
import { createServer } from 'http';
import { setupWebSocket } from './lobby/websocket';
import { initLobby, shutdownLobby } from './lobby/lobbyState';
import { readFile } from 'node:fs/promises';
import cors from 'cors';
import helmet from 'helmet';
import { config } from 'dotenv';

config();

const app = (express as any)();
const httpServer = createServer(app);

app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            "connect-src": [
                "ws://localhost:*",
                "wss://localhost:*",
                "http://localhost:*",
                "https://localhost:*",
                "https://explorer-api.walletconnect.com"
            ],
            "default-src": [
                "ws://localhost:*",
                "wss://localhost:*",
                "http://localhost:*",
                "https://localhost:*"
            ],
            "style-src": ["'self'", "'unsafe-inline'"]
        }
    }
}));
app.use(cors({
  origin: process.env.CLIENT_URL || 'http://localhost:3000',
  methods: ['GET', 'POST']
}));
app.use(express.json());

const io = setupWebSocket(httpServer);

process.on('SIGTERM', () => {
  shutdownLobby();
  process.exit(0);
});

process.on('SIGINT', () => {
  shutdownLobby();
  process.exit(0);
});

const port = process.env.PORT || 3001;
httpServer.listen(port, () => {
  console.log(`Server running on port ${port}`);
  initLobby();
});
// Kick the root.
async function serveFile(file: string, contentType: string, res: any) {
    const content = await readFile(file);
    res.set('Content-Type', contentType);
    res.send(content);
}
app.get('/', async (req: any, res: any) => {
    serveFile("dist/index.html", "text/html", res);
});
app.get('/index.js', async (req: any, res: any) => {
    serveFile("dist/index-rollup.js", "application/javascript", res);
});
