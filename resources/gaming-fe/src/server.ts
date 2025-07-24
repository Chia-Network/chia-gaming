import express from 'express';
import fetch from 'node-fetch';
import minimist from 'minimist';
import { createServer } from 'http';
import { setupWebSocket } from './lobby/websocket';
import { readFile } from 'node:fs/promises';
import cors from 'cors';
import helmet from 'helmet';
import { config } from 'dotenv';

config();

const app = (express as any)();
const httpServer = createServer(app);

// Parse args
function parseArgs() {
  const args = minimist(process.argv.slice(2));

  if (!args.tracker || !args.self) {
    console.warn('usage: server --tracker [tracker-url] --self [own-url] --extras [extra-urls colon separated]');
    process.exit(1);
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
      connectSrc: ["'self'", "https://explorer-api.walletconnect.com", "wss://relay.walletconnect.com", "https://verify.walletconnect.org", "https://verify.walletconnect.org", "https://api.coinset.org", "wss://api.coinset.org", args.tracker, ...extras],
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

const io = setupWebSocket(httpServer);

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
      target: `${args.self}?game=calpoker`
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

io.on('connection', socket => {
  socket.on('game_message', ({ party, token, msg }) => {
    console.log('game message', party, token, msg);
    io.emit('game_message', { party, token, msg });
  });

  socket.on('peer', ({ iStarted }) => {
    console.log('peer', iStarted);
    io.emit('peer', { iStarted });
  });
});

const port = process.env.PORT || 3000;
httpServer.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
