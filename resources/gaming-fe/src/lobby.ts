import express from 'express';
import { createServer } from 'http';
import { readFile } from 'node:fs/promises';
import { Server as SocketIOServer } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { GenerateRoomResult, Room, Player } from './types/lobby';
import { Lobby } from './lobby/lobbyState';

const lobby = new Lobby();
const app = express();
const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, {
  // cors: { origin: process.env.LOBBY_URL || GAME_SERVICE_URL, methods: ['GET','POST'] }
});

app.use(express.json());

const TOKEN_TTL = 10 * 60 * 1000;
const socketUsers = {};

function joinLobby(id: string, alias: string, parameters: any): any {
  if (!id || !alias) {
    return { error: 'Missing id or alias for joining lobby.' };
  };
  const lastActive = new Date().getTime();
  lobby.addPlayer({
    id,
    alias,
    joinedAt: lastActive,
    lastActive,
    status: 'waiting',
    parameters,
  });
  io.emit('lobby_update', lobby.getPlayers());
  return null;
}

function leaveLobby(id: string): any {
  if (lobby.removePlayer(id)) {
    io.emit('lobby_update', lobby.getPlayers());
    return { lobbyQueue: lobby.getPlayers() };
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
  let player = lobby.players[id];
  if (player) {
    player.alias = newAlias;
    io.emit('lobby_update', lobby.getPlayers());
    return res.json(player);
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
  lobby.rooms[token] = newRoom;
  console.log('generate room', game, lobby.games);
  const secureUrl = `${lobby.games[game].target}&join=${token}`;
  const result: GenerateRoomResult = { secureUrl, token };
  io.emit('room_update', newRoom);
  res.json(result);
});
app.post('/lobby/game', (req, res) => {
  let { game, target } = req.body;
  let time = new Date().getTime();
  console.log('update game', game, target);
  lobby.addGame(time, game, target);
});
app.post('/lobby/join-room', (req, res) => {
  const { token, id } = req.body;
  const room = lobby.rooms[token];
  if (!room) {
    return res.status(404).json({ error: 'Invalid room token.' });
  }
  if (room.joiner && room.joiner != id) {
    return res.status(400).json({ error: 'Room is already full.' });
  }
  room.joiner = id;
  console.log('games', lobby.games);
  const fullTargetUrl = `${lobby.games[room.game].target}&token=${token}&amount=${room.parameters.wagerAmount}`;
  room.target = fullTargetUrl;

  io.emit('room_update', room);
  res.json(room);
});
app.post('/lobby/good', (req, res) => {
  const { token, id } = req.body;
  const room = lobby.rooms[token];
  if (!room) {
    return res.status(404).json({ error: 'Invalid room token.' });
  }
  if (room.joiner != id && room.host != id) {
    return res.status(400).json({ error: 'Not room owner.' });
  }
  lobby.removeRoom(token);
  io.emit('room_update', lobby.getRooms());
  res.json({ rooms: lobby.getRooms() });
});
app.post('/lobby/join', (req, res) => {
  const { id, alias, parameters } = req.body;
  const result = joinLobby(id, alias, parameters);
  if (result) {
    return res.status(400).json(result);
  }
  res.json({ lobbyQueue: lobby.getPlayers() });
});
app.post('/lobby/leave', (req, res) => {
  const { id } = req.body;
  const result = leaveLobby(id);
  if (result) {
    return res.json(result);
  }
  res.status(404).json({ error: 'Player not found in lobby.' });
});

app.get('/lobby/status', (req, res) => res.json({ lobbyQueue: lobby.getPlayers() }));

io.on('connection', socket => {
  socket.emit('lobby_update', lobby.getPlayers());
  socket.emit('room_update', Object.values(lobby.rooms));

  socket.on('join', ({ id, alias }) => {
    if (!lobby.players[id]) {
      joinLobby(id, alias, {});
    }
    // We should send the lobby update so we can observe the person we gave a url to.
    io.emit('lobby_update', lobby.getPlayers());
  });

  socket.on('leave', ({ id }) => {
    leaveLobby(id);
  });

  socket.on('chat_message', ({ alias, content }) => {
    io.emit('chat_message', { alias, content });
  });
});

setInterval(() => {
  const time = new Date().getTime();
  lobby.sweep(time);
  io.emit('lobby_update', lobby.getPlayers());
}, 15000);

const port = process.env.PORT || 3001;
httpServer.listen(port, () => {
  console.log(`Lobby server listening on port ${port}`)
});
