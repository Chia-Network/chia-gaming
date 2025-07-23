import express from 'express';
import { createServer } from 'http';
import { setupWebSocket } from './lobby/websocket';
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
      defaultSrc: ["'self'", "https://explorer-api.walletconnect.com", "http://localhost:3000", "http://localhost:5800"],
      scriptSrc: ["'self'", "http://localhost:3001", "'wasm-unsafe-eval'", "'unsafe-inline'"],
      connectSrc: ["'self'", "https://explorer-api.walletconnect.com", "http://localhost:3000", "http://localhost:5800", "wss://relay.walletconnect.com", "https://verify.walletconnect.org", "https://verify.walletconnect.org", "https://api.coinset.org", "wss://api.coinset.org"],
      frameAncestors: ["http://localhost:3000", "'self'"],
    }
  }
}));
app.use(cors({
  origin: process.env.CLIENT_URL || 'http://localhost:3000',
  methods: ['GET', 'POST', 'HEAD', 'OPTIONS']
}));
app.use(express.json());

async function serveFile(file: string, contentType: string, res: any) {
    const content = await readFile(file);
    res.set('Content-Type', contentType);
    res.send(content);
}
async function serveDirectory(dir: string, req: any, res: any) {
  let targetFile = dir + req.path;
  serveFile(targetFile, 'text/plain', res);
}
app.get('/', async (req: any, res: any) => {
  serveFile('public/index.html', 'text/html', res);
});
app.get('/index.js', async (req: any, res: any) => {
  serveFile("dist/index-rollup.js", "application/javascript", res);
});
app.get('/chia_gaming_wasm_bg.wasm', async (req: any, res: any) => {
  serveFile("dist/chia_gaming_wasm_bg.wasm", "application/wasm", res);
});
app.get('/chia_gaming_wasm.js', async (req: any, res: any) => {
  serveFile("dist/chia_gaming_wasm.js", "application/javascript", res);
});
app.get('/clsp*', async (req: any, res: any) => {
  serveDirectory("./", req, res);
});
app.get('/resources*', async (req: any, res: any) => {
  serveDirectory("./", req, res);
});

const io = setupWebSocket(httpServer);

process.on('SIGTERM', () => {
  process.exit(0);
});

process.on('SIGINT', () => {
  process.exit(0);
});

const port = process.env.PORT || 3001;
httpServer.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
