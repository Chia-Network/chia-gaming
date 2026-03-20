import { createServer } from 'http';

import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import minimist from 'minimist';
import { Server as SocketIOServer, Socket } from 'socket.io';

import { Lobby } from './lobbyState';

const lobby = new Lobby();
const app = express();
const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

function parseArgs() {
  const args = minimist(process.argv.slice(2));
  if (!args.self) {
    console.warn('usage: lobby --self [own-url] --dir [serve-directory]');
    process.exit(1);
  }
  return args;
}

const args = parseArgs();

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'", 'https://explorer-api.walletconnect.com'],
        scriptSrc: ["'self'", "'wasm-unsafe-eval'", "'unsafe-inline'"],
        connectSrc: [
          "'self'",
          'https://explorer-api.walletconnect.com',
          'wss://relay.walletconnect.com',
          'https://verify.walletconnect.org',
          'https://api.coinset.org',
          'wss://api.coinset.org',
          'http://localhost:5800',
          'wss://relay.walletconnect.org',
          args.self,
        ],
        frameSrc: ["'self'", 'https://verify.walletconnect.org', args.self],
        frameAncestors: ["'self'", '*'],
      },
    },
  }),
);

app.use(
  cors({
    origin: '*',
    methods: ['GET', 'POST', 'HEAD', 'OPTIONS'],
  }),
);

app.use(express.json());
if (args.dir) {
  app.use(express.static(args.dir));
}

// Socket tracking maps
// lobby iframe sockets: player_id -> Socket
const lobbySocketsByPlayer = new Map<string, Socket>();
// session_id -> player_id (set when lobby iframe joins with session_id)
const sessionToPlayer = new Map<string, string>();
// game (TrackerConnection) sockets: player_id -> Socket
const gameSocketsByPlayer = new Map<string, Socket>();
// reverse: socket.id -> player_id (for cleanup on disconnect)
const lobbySocketToPlayer = new Map<string, string>();
const gameSocketToPlayer = new Map<string, string>();
// identify sockets that arrived before the lobby iframe's join event
const pendingIdentifies = new Map<string, Socket>();
// persistent alias storage: player_id -> alias (survives join/leave cycles)
const knownAliases = new Map<string, string>();
// application-level liveness: socket.id -> last activity timestamp
const lastHeardFrom = new Map<string, number>();

const TRACKER_PING_TIMEOUT_MS = 60_000;

function noteActivity(socketId: string) {
  lastHeardFrom.set(socketId, Date.now());
}

function completeGameSocketRegistration(playerId: string, sock: Socket) {
  const oldSocket = gameSocketsByPlayer.get(playerId);
  if (oldSocket && oldSocket.id !== sock.id) {
    gameSocketToPlayer.delete(oldSocket.id);
    oldSocket.disconnect(true);
  }
  gameSocketsByPlayer.set(playerId, sock);
  gameSocketToPlayer.set(sock.id, playerId);

  const pairing = lobby.getPairingForPlayer(playerId);
  if (pairing) {
    const peerId = pairing.playerA_id === playerId ? pairing.playerB_id : pairing.playerA_id;
    const peerConnected = gameSocketsByPlayer.has(peerId);
    sock.emit('connection_status', {
      has_pairing: true,
      token: pairing.token,
      game_type: pairing.game_type,
      amount: pairing.amount,
      per_game: pairing.per_game,
      i_am_initiator: pairing.playerA_id === playerId,
      peer_connected: peerConnected,
    });
    if (peerConnected) {
      const peerSocket = gameSocketsByPlayer.get(peerId);
      peerSocket?.emit('peer_reconnected', {});
    }
  } else {
    sock.emit('connection_status', { has_pairing: false });
  }
}

function joinLobby(id: string, alias: string, session_id: string): string | null {
  if (!id || !alias) return 'Missing id or alias for joining lobby.';
  const lastActive = Date.now();
  lobby.addPlayer({
    id,
    alias,
    session_id,
    joinedAt: lastActive,
    lastActive,
    status: 'waiting',
    parameters: {},
  });
  return null;
}

function leaveLobby(id: string): boolean {
  if (lobby.removePlayer(id)) {
    io.emit('lobby_update', lobby.getPlayers());
    return true;
  }
  return false;
}

// HTTP endpoints (keep minimal set for game registration + status)
app.get('/lobby/alias', (req, res) => {
  const id = req.query.id as string;
  if (!id) return res.status(400).json({ error: 'Missing id.' });
  const alias = knownAliases.get(id) ?? null;
  res.json({ alias });
});

app.post('/lobby/set-alias', (req, res) => {
  const { id, alias } = req.body;
  if (!id || !alias)
    return res.status(400).json({ error: 'Missing id or alias.' });
  knownAliases.set(id, alias);
  const player = lobby.players[id];
  if (player) {
    player.alias = alias;
    io.emit('lobby_update', lobby.getPlayers());
  }
  res.json({ ok: true });
});

app.post('/lobby/change-alias', (req, res) => {
  const { id, newAlias } = req.body;
  if (!id || !newAlias)
    return res.status(400).json({ error: 'Missing id or new_alias.' });
  knownAliases.set(id, newAlias);
  const player = lobby.players[id];
  if (player) {
    player.alias = newAlias;
    io.emit('lobby_update', lobby.getPlayers());
    return res.json(player);
  }
  res.json({});
});

app.post('/lobby/game', (req, res) => {
  const { game, target } = req.body;
  const time = Date.now();
  lobby.addGame(time, game, target);
  io.emit('game_update', lobby.getGames());
  res.json({ ok: true });
});

app.post('/lobby/join', (req, res) => {
  const { id, alias, session_id } = req.body;
  const resolvedAlias = alias || knownAliases.get(id) || id;
  if (alias) knownAliases.set(id, alias);
  const err = joinLobby(id, resolvedAlias, session_id || '');
  if (err) return res.status(400).json({ error: err });
  io.emit('lobby_update', lobby.getPlayers());
  res.json({ lobbyQueue: lobby.getPlayers() });
});

app.post('/lobby/leave', (req, res) => {
  const { id } = req.body;
  if (leaveLobby(id)) return res.json({ lobbyQueue: lobby.getPlayers() });
  res.status(404).json({ error: 'Player not found in lobby.' });
});

app.get('/lobby/tracking', (_req, res) => {
  res.json({ tracking: lobby.getTracking() });
});

app.get('/lobby/status', (_req, res) => {
  res.json({ lobbyQueue: lobby.getPlayers() });
});

io.on('connection', (socket) => {
  noteActivity(socket.id);

  socket.emit('lobby_update', lobby.getPlayers());
  io.emit('game_update', lobby.getGames());

  socket.on('tracker_ping', () => {
    noteActivity(socket.id);
    socket.emit('tracker_pong');
  });

  socket.on('tracker_pong', () => {
    noteActivity(socket.id);
  });

  // --- Lobby iframe socket events ---

  socket.on('join', ({ id, alias, session_id }) => {
    noteActivity(socket.id);
    if (!id) return;

    lobbySocketsByPlayer.set(id, socket);
    lobbySocketToPlayer.set(socket.id, id);
    if (session_id) {
      sessionToPlayer.set(session_id, id);
    }

    const resolvedAlias = alias || knownAliases.get(id) || id;

    if (!lobby.players[id]) {
      joinLobby(id, resolvedAlias, session_id || '');
    } else {
      lobby.players[id].alias = resolvedAlias;
      if (session_id) {
        lobby.players[id].session_id = session_id;
      }
    }
    lobby.players[id].lastActive = Date.now();
    io.emit('lobby_update', lobby.getPlayers());

    if (session_id) {
      const pendingSock = pendingIdentifies.get(session_id);
      if (pendingSock && pendingSock.connected) {
        pendingIdentifies.delete(session_id);
        completeGameSocketRegistration(id, pendingSock);
      }
    }
  });

  socket.on('leave', ({ id }) => {
    noteActivity(socket.id);
    leaveLobby(id);
  });

  // --- Challenge protocol ---

  socket.on('challenge', ({ target_id, game, amount, per_game }) => {
    noteActivity(socket.id);
    const fromId = lobbySocketToPlayer.get(socket.id);
    if (!fromId) return;

    const fromPlayer = lobby.players[fromId];
    if (!fromPlayer) return;

    const challenge = lobby.createChallenge(
      fromId, target_id, game || 'calpoker',
      amount || '100', per_game || '10',
    );

    const targetSocket = lobbySocketsByPlayer.get(target_id);
    if (targetSocket) {
      targetSocket.emit('challenge_received', {
        challenge_id: challenge.id,
        from_id: fromId,
        from_alias: fromPlayer.alias,
        game: challenge.game,
        amount: challenge.amount,
        per_game: challenge.per_game,
      });
    }
  });

  socket.on('challenge_accept', ({ challenge_id }) => {
    noteActivity(socket.id);
    const challenge = lobby.getChallenge(challenge_id);
    if (!challenge) return;

    const accepterId = lobbySocketToPlayer.get(socket.id);
    if (!accepterId || accepterId !== challenge.target_id) return;

    lobby.removeChallenge(challenge_id);

    const pairing = lobby.createPairing(
      challenge.from_id, challenge.target_id,
      challenge.game, challenge.amount, challenge.per_game,
    );

    // Notify challenger's lobby socket
    const challengerLobbySocket = lobbySocketsByPlayer.get(challenge.from_id);
    if (challengerLobbySocket) {
      challengerLobbySocket.emit('challenge_resolved', {
        challenge_id,
        accepted: true,
      });
    }

    const matchedBase = {
      token: pairing.token,
      game_type: challenge.game,
      amount: challenge.amount,
      per_game: challenge.per_game,
    };

    const challengerGameSocket = gameSocketsByPlayer.get(challenge.from_id);
    const accepterGameSocket = gameSocketsByPlayer.get(challenge.target_id);

    if (challengerGameSocket) {
      challengerGameSocket.emit('matched', { ...matchedBase, i_am_initiator: true });
    }
    if (accepterGameSocket) {
      accepterGameSocket.emit('matched', { ...matchedBase, i_am_initiator: false });
    }
  });

  socket.on('challenge_decline', ({ challenge_id }) => {
    noteActivity(socket.id);
    const challenge = lobby.getChallenge(challenge_id);
    if (!challenge) return;

    lobby.removeChallenge(challenge_id);

    const challengerSocket = lobbySocketsByPlayer.get(challenge.from_id);
    if (challengerSocket) {
      challengerSocket.emit('challenge_resolved', {
        challenge_id,
        accepted: false,
      });
    }
  });

  // --- TrackerConnection (game socket) events ---

  socket.on('identify', ({ session_id }) => {
    noteActivity(socket.id);
    if (!session_id) return;

    const oldPending = pendingIdentifies.get(session_id);
    if (oldPending && oldPending.id !== socket.id && oldPending.connected) {
      oldPending.disconnect(true);
    }

    const playerId = sessionToPlayer.get(session_id);
    if (!playerId) {
      pendingIdentifies.set(session_id, socket);
      return;
    }

    completeGameSocketRegistration(playerId, socket);
  });

  socket.on('message', ({ data }) => {
    noteActivity(socket.id);
    const senderId = gameSocketToPlayer.get(socket.id);
    if (!senderId) return;

    const peerId = lobby.getPairedPlayerId(senderId);
    if (!peerId) return;

    const peerSocket = gameSocketsByPlayer.get(peerId);
    if (peerSocket) {
      peerSocket.emit('message', { data });
    }
  });

  socket.on('close', () => {
    noteActivity(socket.id);
    const senderId = gameSocketToPlayer.get(socket.id);
    if (!senderId) return;

    const peerId = lobby.getPairedPlayerId(senderId);
    if (peerId) {
      const peerSocket = gameSocketsByPlayer.get(peerId);
      if (peerSocket) {
        peerSocket.emit('closed', {});
      }
    }

    socket.emit('closed', {});

    const pairing = lobby.getPairingForPlayer(senderId);
    if (pairing) {
      lobby.removePairing(pairing.token);
    }
  });

  // --- Cleanup on disconnect ---

  socket.on('disconnect', () => {
    lastHeardFrom.delete(socket.id);

    const lobbyPlayerId = lobbySocketToPlayer.get(socket.id);
    if (lobbyPlayerId) {
      lobbySocketToPlayer.delete(socket.id);
      const current = lobbySocketsByPlayer.get(lobbyPlayerId);
      if (current && current.id === socket.id) {
        lobbySocketsByPlayer.delete(lobbyPlayerId);
        leaveLobby(lobbyPlayerId);
      }
    }

    const gamePlayerId = gameSocketToPlayer.get(socket.id);
    if (gamePlayerId) {
      gameSocketToPlayer.delete(socket.id);
      const current = gameSocketsByPlayer.get(gamePlayerId);
      if (current && current.id === socket.id) {
        gameSocketsByPlayer.delete(gamePlayerId);
      }
    }

    for (const [sid, sock] of pendingIdentifies) {
      if (sock.id === socket.id) {
        pendingIdentifies.delete(sid);
        break;
      }
    }
  });
});

setInterval(() => {
  const time = Date.now();
  lobby.sweep(time);
  io.emit('lobby_update', lobby.getPlayers());

  for (const [socketId, ts] of lastHeardFrom) {
    const sock = io.sockets.sockets.get(socketId);
    if (!sock) {
      lastHeardFrom.delete(socketId);
      continue;
    }
    if (time - ts > TRACKER_PING_TIMEOUT_MS) {
      console.log(`[tracker] ping timeout for socket ${socketId}, disconnecting`);
      sock.disconnect(true);
    } else {
      sock.emit('tracker_ping');
    }
  }
}, 15000);

const port = process.env.PORT || 5801;
httpServer.listen(
  { host: '0.0.0.0', port },
  () => { console.log(`Server running on port ${port}`); },
);
