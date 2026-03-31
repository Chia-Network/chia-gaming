import { createServer } from 'http';

import cors from 'cors';
import express, { Response } from 'express';
import helmet from 'helmet';
import minimist from 'minimist';

import { Lobby } from './lobbyState';

const lobby = new Lobby();
const app = express();
const httpServer = createServer(app);

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
    frameguard: false,
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

app.use((req, _res, next) => {
  const contentLengthHeader = req.headers['content-length'];
  const contentLength = Number(contentLengthHeader);
  if (Number.isFinite(contentLength) && contentLength > 5 * 1024) {
    console.warn(`[tracker] large request: ${req.method} ${req.path} content-length=${contentLength}`);
  }
  next();
});

app.use(express.json());
if (args.dir) {
  app.use(express.static(args.dir));
}

// ---------------------------------------------------------------------------
// SSE infrastructure
// ---------------------------------------------------------------------------

interface SSEClient {
  res: Response;
  nextId: number;
  ringBuffer: { id: number; event: string; data: string }[];
}

const RING_BUFFER_SIZE = 100;

const lobbySSE = new Map<string, SSEClient>();
// Game SSE keyed by session_id (game client connects before player_id is known)
const gameSSE = new Map<string, SSEClient>();

type RelayPayload =
  | { msgno: number; msg: string }
  | { ack: number }
  | { ping: true };

function isRelayPayload(data: unknown): data is RelayPayload {
  if (!data || typeof data !== 'object') return false;
  if ('ping' in data) return (data as { ping?: unknown }).ping === true;
  if ('ack' in data) return typeof (data as { ack?: unknown }).ack === 'number';
  if ('msgno' in data || 'msg' in data) {
    return (
      typeof (data as { msgno?: unknown }).msgno === 'number' &&
      typeof (data as { msg?: unknown }).msg === 'string'
    );
  }
  return false;
}

function initSSE(res: Response): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
}

function sendSSE(client: SSEClient, event: string, data: unknown): void {
  const id = client.nextId++;
  const json = JSON.stringify(data);
  client.ringBuffer.push({ id, event, data: json });
  if (client.ringBuffer.length > RING_BUFFER_SIZE) {
    client.ringBuffer.shift();
  }
  client.res.write(`event: ${event}\nid: ${id}\ndata: ${json}\n\n`);
}

function replayFromId(client: SSEClient, lastEventId: number): void {
  for (const entry of client.ringBuffer) {
    if (entry.id > lastEventId) {
      client.res.write(`event: ${entry.event}\nid: ${entry.id}\ndata: ${entry.data}\n\n`);
    }
  }
}

function sendGameEvent(playerId: string, event: string, data: unknown): void {
  const sessionId = playerToSession.get(playerId);
  if (!sessionId) return;
  const client = gameSSE.get(sessionId);
  if (client) {
    sendSSE(client, event, data);
  }
}

// ---------------------------------------------------------------------------
// Player tracking
// ---------------------------------------------------------------------------

const sessionToPlayer = new Map<string, string>();
const playerToSession = new Map<string, string>();
const knownAliases = new Map<string, string>();
const pendingIdentifySessions = new Set<string>();

// ---------------------------------------------------------------------------
// Broadcast helpers
// ---------------------------------------------------------------------------

function broadcastLobbyUpdate(): void {
  const players = lobby.getPlayers();
  for (const [, client] of lobbySSE) {
    sendSSE(client, 'lobby_update', players);
  }
}

function leaveLobby(id: string): boolean {
  if (lobby.removePlayer(id)) {
    broadcastLobbyUpdate();
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Game registration (replaces completeGameSocketRegistration)
// ---------------------------------------------------------------------------

function completeGameRegistration(playerId: string): void {
  const pairing = lobby.getPairingForPlayer(playerId);
  if (pairing) {
    const peerId = pairing.playerA_id === playerId ? pairing.playerB_id : pairing.playerA_id;
    const peerSessionId = playerToSession.get(peerId);
    const peerConnected = peerSessionId ? gameSSE.has(peerSessionId) : false;
    console.log(`[tracker] game registered player=${playerId} pairing=${pairing.token} peer_connected=${peerConnected}`);
    const myAlias = lobby.players[playerId]?.alias ?? playerId;
    const peerAlias = lobby.players[peerId]?.alias ?? peerId;
    sendGameEvent(playerId, 'connection_status', {
      has_pairing: true,
      token: pairing.token,
      game_type: pairing.game_type,
      amount: pairing.amount,
      per_game: pairing.per_game,
      i_am_initiator: pairing.playerA_id === playerId,
      peer_connected: peerConnected,
      my_alias: myAlias,
      peer_alias: peerAlias,
    });
    if (peerConnected) {
      sendGameEvent(peerId, 'peer_reconnected', {});
    }
  } else {
    console.log(`[tracker] game registered player=${playerId} (no pairing)`);
    sendGameEvent(playerId, 'connection_status', { has_pairing: false });
  }
}

// ---------------------------------------------------------------------------
// Existing HTTP endpoints (unchanged API)
// ---------------------------------------------------------------------------

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
    broadcastLobbyUpdate();
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
    broadcastLobbyUpdate();
    return res.json(player);
  }
  res.json({});
});

app.post('/lobby/game', (req, res) => {
  const { game, target } = req.body;
  const time = Date.now();
  lobby.addGame(time, game, target);
  const games = lobby.getGames();
  for (const [, client] of lobbySSE) {
    sendSSE(client, 'game_update', games);
  }
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Lobby SSE stream
// ---------------------------------------------------------------------------

app.get('/lobby/events', (req, res) => {
  const playerId = req.query.player_id as string;
  if (!playerId) return res.status(400).json({ error: 'Missing player_id.' });

  const oldClient = lobbySSE.get(playerId);
  if (oldClient) {
    try { oldClient.res.end(); } catch {}
  }

  initSSE(res);

  const lastEventId = req.headers['last-event-id']
    ? parseInt(req.headers['last-event-id'] as string, 10)
    : -1;

  const client: SSEClient = {
    res,
    nextId: oldClient ? oldClient.nextId : 0,
    ringBuffer: oldClient ? oldClient.ringBuffer : [],
  };
  lobbySSE.set(playerId, client);

  if (lastEventId >= 0 && client.ringBuffer.length > 0) {
    replayFromId(client, lastEventId);
  } else {
    sendSSE(client, 'lobby_update', lobby.getPlayers());
  }

  req.on('close', () => {
    const current = lobbySSE.get(playerId);
    if (current && current.res === res) {
      lobbySSE.delete(playerId);
      leaveLobby(playerId);
      console.log(`[tracker] lobby SSE disconnected player=${playerId}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Lobby action endpoints
// ---------------------------------------------------------------------------

app.post('/lobby/join', (req, res) => {
  const { id, alias, session_id } = req.body;
  if (!id) return res.status(400).json({ error: 'Missing id.' });

  console.log(`[tracker] join: player=${id} session=${session_id ?? 'none'}`);

  if (session_id) {
    sessionToPlayer.set(session_id, id);
    playerToSession.set(id, session_id);
  }

  const resolvedAlias = alias || knownAliases.get(id) || id;

  if (!lobby.players[id]) {
    const lastActive = Date.now();
    lobby.addPlayer({
      id,
      alias: resolvedAlias,
      session_id: session_id || '',
      joinedAt: lastActive,
      lastActive,
      status: 'waiting',
      parameters: {},
    });
  } else {
    lobby.players[id].alias = resolvedAlias;
    if (session_id) {
      lobby.players[id].session_id = session_id;
    }
  }
  lobby.players[id].lastActive = Date.now();
  broadcastLobbyUpdate();

  if (session_id && pendingIdentifySessions.has(session_id)) {
    pendingIdentifySessions.delete(session_id);
    console.log(`[tracker] join: resolving pending identify for session=${session_id} player=${id}`);
    completeGameRegistration(id);
  }

  res.json({ ok: true });
});

app.post('/lobby/leave', (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'Missing id.' });
  leaveLobby(id);
  res.json({ ok: true });
});

app.post('/lobby/challenge', (req, res) => {
  const { from_id, target_id, game, amount, per_game } = req.body;
  if (!from_id || !target_id)
    return res.status(400).json({ error: 'Missing from_id or target_id.' });

  const fromPlayer = lobby.players[from_id];
  if (!fromPlayer) return res.status(400).json({ error: 'Unknown from_id.' });

  const challenge = lobby.createChallenge(
    from_id, target_id, game || 'calpoker',
    amount || '100', per_game || '10',
  );

  const targetClient = lobbySSE.get(target_id);
  if (targetClient) {
    sendSSE(targetClient, 'challenge_received', {
      challenge_id: challenge.id,
      from_id,
      from_alias: fromPlayer.alias,
      game: challenge.game,
      amount: challenge.amount,
      per_game: challenge.per_game,
    });
  }

  res.json({ ok: true });
});

app.post('/lobby/challenge/accept', (req, res) => {
  const { challenge_id, accepter_id } = req.body;
  if (!challenge_id || !accepter_id)
    return res.status(400).json({ error: 'Missing challenge_id or accepter_id.' });

  const challenge = lobby.getChallenge(challenge_id);
  if (!challenge) return res.status(404).json({ error: 'Challenge not found.' });
  if (accepter_id !== challenge.target_id)
    return res.status(403).json({ error: 'Not the challenge target.' });

  lobby.removeChallenge(challenge_id);

  const pairing = lobby.createPairing(
    challenge.from_id, challenge.target_id,
    challenge.game, challenge.amount, challenge.per_game,
  );

  const challengerLobbyClient = lobbySSE.get(challenge.from_id);
  if (challengerLobbyClient) {
    sendSSE(challengerLobbyClient, 'challenge_resolved', {
      challenge_id,
      accepted: true,
    });
  }

  const challengerAlias = lobby.players[challenge.from_id]?.alias ?? challenge.from_id;
  const accepterAlias = lobby.players[challenge.target_id]?.alias ?? challenge.target_id;

  const matchedBase = {
    token: pairing.token,
    game_type: challenge.game,
    amount: challenge.amount,
    per_game: challenge.per_game,
  };

  sendGameEvent(challenge.from_id, 'matched', {
    ...matchedBase, i_am_initiator: true, my_alias: challengerAlias, peer_alias: accepterAlias,
  });
  sendGameEvent(challenge.target_id, 'matched', {
    ...matchedBase, i_am_initiator: false, my_alias: accepterAlias, peer_alias: challengerAlias,
  });

  res.json({ ok: true });
});

app.post('/lobby/challenge/decline', (req, res) => {
  const { challenge_id } = req.body;
  if (!challenge_id)
    return res.status(400).json({ error: 'Missing challenge_id.' });

  const challenge = lobby.getChallenge(challenge_id);
  if (!challenge) return res.status(404).json({ error: 'Challenge not found.' });

  lobby.removeChallenge(challenge_id);

  const challengerLobbyClient = lobbySSE.get(challenge.from_id);
  if (challengerLobbyClient) {
    sendSSE(challengerLobbyClient, 'challenge_resolved', {
      challenge_id,
      accepted: false,
    });
  }

  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Game SSE stream (keyed by session_id)
// ---------------------------------------------------------------------------

app.get('/game/events', (req, res) => {
  const sessionId = req.query.session_id as string;
  if (!sessionId) return res.status(400).json({ error: 'Missing session_id.' });

  const oldClient = gameSSE.get(sessionId);
  if (oldClient) {
    try { oldClient.res.end(); } catch {}
  }

  initSSE(res);

  const lastEventId = req.headers['last-event-id']
    ? parseInt(req.headers['last-event-id'] as string, 10)
    : -1;

  const client: SSEClient = {
    res,
    nextId: oldClient ? oldClient.nextId : 0,
    ringBuffer: oldClient ? oldClient.ringBuffer : [],
  };
  gameSSE.set(sessionId, client);

  if (lastEventId >= 0 && client.ringBuffer.length > 0) {
    replayFromId(client, lastEventId);
  }

  console.log(`[tracker] game SSE connected session=${sessionId}`);

  req.on('close', () => {
    const current = gameSSE.get(sessionId);
    if (current && current.res === res) {
      gameSSE.delete(sessionId);
      console.log(`[tracker] game SSE disconnected session=${sessionId}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Game action endpoints
// ---------------------------------------------------------------------------

app.post('/game/identify', (req, res) => {
  const { session_id } = req.body;
  if (!session_id) return res.status(400).json({ error: 'Missing session_id.' });

  console.log(`[tracker] identify: session_id=${session_id}`);

  const playerId = sessionToPlayer.get(session_id);
  if (!playerId) {
    console.log(`[tracker] identify: no player yet for session=${session_id}, queuing as pending`);
    pendingIdentifySessions.add(session_id);
    return res.json({ ok: true, player_id: null });
  }

  console.log(`[tracker] identify: resolved session=${session_id} -> player=${playerId}`);
  completeGameRegistration(playerId);

  res.json({ ok: true, player_id: playerId });
});

app.post('/game/send', (req, res) => {
  const { session_id, data } = req.body;
  if (!session_id) return res.status(400).json({ error: 'Missing session_id.' });
  if (!isRelayPayload(data)) {
    console.warn('[tracker] malformed /game/send payload shape');
    return res.status(400).json({ error: 'Malformed data payload.' });
  }

  const playerId = sessionToPlayer.get(session_id);
  if (!playerId) return res.json({ ok: true, delivered: false });

  const peerId = lobby.getPairedPlayerId(playerId);
  if (!peerId) return res.json({ ok: true, delivered: false });

  sendGameEvent(peerId, 'message', { data });
  res.json({ ok: true, delivered: true });
});

app.post('/game/chat', (req, res) => {
  const { session_id, text } = req.body;
  if (!session_id || !text) return res.status(400).json({ error: 'Missing session_id or text.' });

  const playerId = sessionToPlayer.get(session_id);
  if (!playerId) return res.json({ ok: true, delivered: false });

  const peerId = lobby.getPairedPlayerId(playerId);
  if (!peerId) return res.json({ ok: true, delivered: false });

  const fromAlias = lobby.players[playerId]?.alias ?? playerId;
  sendGameEvent(peerId, 'chat', { text, from_alias: fromAlias, timestamp: Date.now() });
  res.json({ ok: true, delivered: true });
});

app.post('/game/close', (req, res) => {
  const { session_id } = req.body;
  if (!session_id) return res.status(400).json({ error: 'Missing session_id.' });

  const playerId = sessionToPlayer.get(session_id);
  console.log(`[tracker] close: session=${session_id} player=${playerId ?? 'none'}`);
  if (!playerId) return res.json({ ok: true });

  const peerId = lobby.getPairedPlayerId(playerId);
  if (peerId) {
    sendGameEvent(peerId, 'closed', {});
  }
  sendGameEvent(playerId, 'closed', {});

  const pairing = lobby.getPairingForPlayer(playerId);
  if (pairing) {
    lobby.removePairing(pairing.token);
  }

  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Periodic sweep + SSE keepalive
// ---------------------------------------------------------------------------

setInterval(() => {
  const time = Date.now();
  lobby.sweep(time);
  broadcastLobbyUpdate();

  for (const [, client] of lobbySSE) {
    try { client.res.write(': keepalive\n\n'); } catch {}
  }
  for (const [, client] of gameSSE) {
    try { client.res.write(': keepalive\n\n'); } catch {}
  }
}, 15_000);

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

const port = process.env.PORT || 5801;
httpServer.listen(
  { host: '0.0.0.0', port },
  () => { console.log(`Server running on port ${port}`); },
);
