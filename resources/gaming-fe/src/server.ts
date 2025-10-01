import express from 'express';
import fetch from 'node-fetch';
// @ts-ignore
import bufferReplace from 'buffer-replace';
import minimist from 'minimist';
import { createServer } from 'http';
import { readFile } from 'node:fs/promises';
import cors from 'cors';
import helmet from 'helmet';
import { config } from 'dotenv';

config();

const app = (express as any)();
const httpServer = createServer(app);
let coinset: string | null = null;

// Parse args
function parseArgs() {
  const args = minimist(process.argv.slice(2));

  if (!args.tracker || !args.self) {
    console.warn('usage: server --tracker [tracker-url] --self [own-url] (--coinset [host]) --extras [extra-urls colon separated]');
    process.exit(1);
  }

  if (args.coinset) {
    coinset = args.coinset;
  }

  const extras: string[] = [];
  if (args.extras) {
    const newExtras = args.extras.split(':');
    newExtras.forEach((extra: string) => {
      extras.push(extra);
    });
  }

  return { args, extras }
}

const { args, extras } = parseArgs();

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'", "https://explorer-api.walletconnect.com", ...extras],
      scriptSrc: ["'self'", "'wasm-unsafe-eval'", "'unsafe-inline'", ...extras],
      connectSrc: ["'self'", "https://explorer-api.walletconnect.com", "wss://relay.walletconnect.com", "https://verify.walletconnect.org", "https://verify.walletconnect.org", "https://api.coinset.org", "wss://api.coinset.org", "http://localhost:5800", "wss://relay.walletconnect.org", args.tracker, 'ws://localhost:3002', "http://localhost:3002", ...extras],
      frameSrc: ["'self'",  'https://verify.walletconnect.org', args.tracker, ...extras],
      frameAncestors: ["'self'", args.tracker],
    }
  }
}));
app.use(cors({
  origin: process.env.GAME_PUBLIC_URL || args.self,
  methods: ['GET', 'POST', 'HEAD', 'OPTIONS']
}));
app.use(express.json());

async function serveFile(file: string, contentType: string, replace: boolean, res: any) {
  let content = await readFile(file);
  // A simple way to patch the javascript so we talk to a local surrogate for
  // api.coinset.org.
  if (replace && coinset) {
    content = bufferReplace(content, "https://api.coinset.org", coinset);
  }
  res.set('Content-Type', contentType);
  res.send(content);
}
async function serveDirectory(dir: string, req: any, res: any) {
  let targetFile = dir + req.path;
  serveFile(targetFile, 'text/plain', false, res);
}
app.get('/', async (req: any, res: any) => {
  serveFile('public/index.html', 'text/html', false, res);
});
app.get('/index.js', async (req: any, res: any) => {
  serveFile("dist/index-rollup.js", "application/javascript", true, res);
});
app.get('/chia_gaming_wasm_bg.wasm', async (req: any, res: any) => {
  serveFile("dist/chia_gaming_wasm_bg.wasm", "application/wasm", false, res);
});
app.get('/chia_gaming_wasm.js', async (req: any, res: any) => {
  serveFile("dist/chia_gaming_wasm.js", "application/javascript", false, res);
});
app.get('/urls', async (req: any, res: any) => {
  res.set('Content-Type', 'application/json');
  res.send(JSON.stringify({
    tracker: `${args.tracker}?lobby=true`
  }));
});
app.get('/clsp*', async (req: any, res: any) => {
  serveDirectory("./", req, res);
});
app.get('/resources*', async (req: any, res: any) => {
  serveDirectory("./", req, res);
});

process.on('SIGTERM', () => {
  process.exit(0);
});

process.on('SIGINT', () => {
  process.exit(0);
});

function refreshLobby() {
  fetch(`${args.tracker}/lobby/game`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      game: 'calpoker',
      target: `${args.self}?game=calpoker&lobbyUrl=${args.tracker}`,
    })
  }).then(res => res.json()).then(res => {
    console.log('tracker:', res);
  }).catch(e => {
    console.error('tracker:', e);
  });
}

setInterval(() => {
  refreshLobby();
}, 120000);

refreshLobby();

const port = process.env.PORT || 3000;
httpServer.listen(port, () => {
  console.log(`Game server listening on port ${port}`)
});
