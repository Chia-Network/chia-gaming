import express from 'express';
import { createServer } from 'http';
import { readFile } from 'node:fs/promises';
import { Server as SocketIOServer } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { GenerateRoomResult } from './types/lobby';

const app = express();
const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: { origin: 'http://localhost:3000', methods: ['GET','POST'] }
});

app.use(express.json());

interface Player { id: string; game: string; parameters: any; }
interface Room { token: string; host: Player; joiner?: Player; createdAt: number; expiresAt: number; }

const lobbyQueue: Player[] = [];
const rooms: Record<string,Room> = {};
const TOKEN_TTL = 10 * 60 * 1000;
const socketUsers = {};

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
app.post('/lobby/generate-room', (req, res) => {
  const { id, game, parameters } = req.body;
  if (!id || !game) return res.status(400).json({ error: 'Missing id or game.' });
  const token = crypto.randomBytes(16).toString('hex');
  const now = Date.now();
  rooms[token] = {
    token,
    host: { id, game, parameters },
    createdAt: now,
    expiresAt: now + TOKEN_TTL,
  };
  const secureUrl = `${req.protocol}://${req.get('host')}/join/${token}`;
  const result: GenerateRoomResult = { secureUrl, token };
  res.json(result);
});

app.post('/lobby/join-room', (req, res) => {
  const { token, id, game, parameters } = req.body;
  const room = rooms[token];
  if (!room) {
    return res.status(404).json({ error: 'Invalid room token.' });
  }
  if (Date.now() > room.expiresAt) {
    delete rooms[token];
    return res.status(400).json({ error: 'Room token has expired.' });
  }
  if (room.joiner) {
    return res.status(400).json({ error: 'Room is already full.' });
  }
  room.joiner = { id, game, parameters };
  io.emit('room_update', room);
  res.json({ room });
});

app.get('/join/:token', (req, res) => {
  const params = req.params;
  res.setHeader('Location', `${req.protocol}://${req.get('host')}/#token=${params.token}`);
  res.status(302).end();
});
app.post('/lobby/join', (req, res) => {
  const { id, game, parameters } = req.body;
  if (!id || !game) return res.status(400).json({ error: 'Missing id or game.' });
  lobbyQueue.push({ id, game, parameters });
  io.emit('lobby_update', lobbyQueue);
  res.json({ lobbyQueue });
});
app.post('/lobby/leave', (req, res) => {
  const { id } = req.body;
  const idx = lobbyQueue.findIndex(p => p.id === id);
  if (idx !== -1) {
    lobbyQueue.splice(idx, 1);
    io.emit('lobby_update', lobbyQueue);
    return res.json({ lobbyQueue });
  }
  res.status(404).json({ error: 'Player not found in lobby.' });
});

app.get('/lobby/status', (req, res) => res.json({ lobbyQueue }));

io.on('connection', socket => {
  socket.emit('lobby_update', lobbyQueue);
  socket.emit('room_update', Object.values(rooms));

  socket.on('join', ({ id }) => {
    if (!lobbyQueue.find(p => p.id === id)) {
      lobbyQueue.push({ id, game: 'lobby', parameters: {} });
    }
    // We should send the lobby update so we can observe the person we gave a url to.
    io.emit('lobby_update', lobbyQueue);
  });

  socket.on('leave', ({ id }) => {
    const i = lobbyQueue.findIndex(p => p.id === id);
    if (i !== -1) {
      lobbyQueue.splice(i, 1);
      io.emit('lobby_update', lobbyQueue);
    }
  });

  socket.on('chat_message', ({ alias, content }) => {
    io.emit('chat_message', { alias, content });
  });
});

httpServer.listen(3000, () => console.log('Lobby server listening on port 3000'));
