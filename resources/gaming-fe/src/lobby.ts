import express from 'express';
import { createServer } from 'http';
import { readFile } from 'node:fs/promises';
import { Server as SocketIOServer } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { GenerateRoomResult, Room, Player } from './types/lobby';

const app = express();
const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: { origin: 'http://localhost:3000', methods: ['GET','POST'] }
});

app.use(express.json());

const lobbyQueue: Player[] = [];
const rooms: Record<string,Room> = {};
const TOKEN_TTL = 10 * 60 * 1000;
const socketUsers = {};
// XXX Take from games calling in.
const games: { [id: string]: string; } = {'calpoker': 'http://localhost:3001/?game=calpoker'};

function joinLobby(id: string, alias: string, parameters: any): any {
  if (!id || !alias) {
    return { error: 'Missing id or alias for joining lobby.' };
  };
  const lastActive = Date.now();
  lobbyQueue.push({
    id,
    alias,
    joinedAt: lastActive,
    lastActive,
    status: 'waiting',
    parameters,
  });
  io.emit('lobby_update', lobbyQueue);
  return null;
}

function leaveLobby(id: string): any {
  const idx = lobbyQueue.findIndex(p => p.id === id);
  if (idx !== -1) {
    lobbyQueue.splice(idx, 1);
    io.emit('lobby_update', lobbyQueue);
    return { lobbyQueue };
  }

  return undefined;
}

// Kick the root.
async function serveFile(file: string, contentType: string, res: any) {
    const content = await readFile(file);
    res.set('Content-Type', contentType);
    res.send(content);
}
app.get('/', async (req: any, res: any) => {
  serveFile("public/index.html", "text/html", res);
});
app.get('/index.js', async (req: any, res: any) => {
  serveFile("dist/index-rollup.js", "application/javascript", res);
});
app.post('/lobby/change-alias', (req, res) => {
  const { id, newAlias } = req.body;
  if (!id || !newAlias) return res.status(400).json({ error: 'Missing id or new_alias.' });
  for (var i = 0; i < lobbyQueue.length; i++) {
    if (lobbyQueue[i].id == id) {
      lobbyQueue[i].alias = newAlias;
      io.emit('lobby_update', lobbyQueue);
      return res.json(lobbyQueue[i]);
    }
  }
  res.json({});
});
app.post('/lobby/generate-room', (req, res) => {
  const { id, game, parameters } = req.body;
  if (!id || !game) return res.status(400).json({ error: 'Missing id or game.' });
  const token = crypto.randomBytes(16).toString('hex');
  const now = Date.now();
  const newRoom: Room = {
    token,
    host: id,
    game,
    status: 'waiting',
    createdAt: now,
    expiresAt: now + TOKEN_TTL,
    minPlayers: 2,
    maxPlayers: 2,
    chat: [],
    parameters
  };
  rooms[token] = newRoom;
  const secureUrl = `${req.protocol}://${req.get('host')}/?join=${token}`;
  const result: GenerateRoomResult = { secureUrl, token };
  io.emit('room_update', newRoom);
  res.json(result);
});

app.post('/lobby/join-room', (req, res) => {
  const { token, id } = req.body;
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
  room.joiner = id;
  console.log('join room, target', games[room.game]);
  room.target = `${games[room.game]}&token=${token}&amount=${room.parameters.wagerAmount}`;

  io.emit('room_update', room);
  res.json(room);
});

app.post('/lobby/join', (req, res) => {
  const { id, alias, parameters } = req.body;
  const result = joinLobby(id, alias, parameters);
  if (result) {
    return res.status(400).json(result);
  }
  res.json({ lobbyQueue });
});
app.post('/lobby/leave', (req, res) => {
  const { id } = req.body;
  const result = leaveLobby(id);
  if (result) {
    return res.json(result);
  }
  res.status(404).json({ error: 'Player not found in lobby.' });
});

app.get('/lobby/status', (req, res) => res.json({ lobbyQueue }));

io.on('connection', socket => {
  socket.emit('lobby_update', lobbyQueue);
  socket.emit('room_update', Object.values(rooms));

  socket.on('join', ({ id, alias }) => {
    if (!lobbyQueue.find(p => p.id === id)) {
      joinLobby(id, alias, {});
    }
    // We should send the lobby update so we can observe the person we gave a url to.
    io.emit('lobby_update', lobbyQueue);
  });

  socket.on('leave', ({ id }) => {
    leaveLobby(id);
  });

  socket.on('chat_message', ({ alias, content }) => {
    io.emit('chat_message', { alias, content });
  });
});

httpServer.listen(3000, () => console.log('Lobby server listening on port 3000'));
