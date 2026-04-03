import { createServer } from 'http';

import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import minimist from 'minimist';
import { WebSocketServer, WebSocket } from 'ws';

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
const selfWs = String(args.self).replace(/^http/i, 'ws');
const simUrl = String(args.sim || 'http://localhost:5800');
const simWsUrl = simUrl.replace(/^http/i, 'ws').replace(/:5800\b/, ':5801');

type RelayPayload =
  | { msgno: number; msg: string }
  | { ack: number }
  | { ping: true };

type InboundMessage =
  | { type: 'join'; id: string; alias?: string; session_id?: string }
  | { type: 'leave'; id: string }
  | { type: 'challenge'; from_id: string; target_id: string; game?: string; amount?: string; per_game?: string }
  | { type: 'challenge_accept'; challenge_id: string; accepter_id: string }
  | { type: 'challenge_decline'; challenge_id: string }
  | { type: 'change_alias'; id: string; newAlias: string }
  | { type: 'identify'; session_id: string }
  | { type: 'message'; session_id: string; data: RelayPayload }
  | { type: 'chat'; session_id: string; text: string }
  | { type: 'close'; session_id: string };

interface LobbyConnMeta {
  playerId: string;
}

interface GameConnMeta {
  sessionId: string;
  playerId?: string;
}

const LOBBY_DISCONNECT_GRACE_MS = 3000;
const wsServer = new WebSocketServer({ server: httpServer, path: '/ws' });

const lobbyConnections = new Map<string, WebSocket>();
const gameConnections = new Map<string, WebSocket>(); // keyed by session_id
const pendingGameIdentifies = new Map<string, WebSocket>(); // session_id -> ws
const wsLobbyMeta = new WeakMap<WebSocket, LobbyConnMeta>();
const wsGameMeta = new WeakMap<WebSocket, GameConnMeta>();

const pendingLobbyLeaves = new Map<string, ReturnType<typeof setTimeout>>();
const sessionToPlayer = new Map<string, string>();
const playerToSession = new Map<string, string>();
const knownAliases = new Map<string, string>();
const peerLastSeenAt = new Map<string, number>(); // keyed by player_id

app.use(
  helmet({
    frameguard: false,
    crossOriginOpenerPolicy: false,
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
          simUrl,
          simWsUrl,
          'wss://relay.walletconnect.org',
          args.self,
          selfWs,
        ],
        frameSrc: ["'self'", 'https://verify.walletconnect.org', args.self],
        frameAncestors: ["'self'", '*'],
        upgradeInsecureRequests: null,
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

// Prevent HTTP keep-alive from exhausting the browser's per-host connection
// pool (typically 6 for HTTP/1.1), which would block WebSocket upgrades when
// multiple tabs connect to the same tracker origin.  Also disable caching so
// the browser never serves stale lobby JS after a rebuild.
app.use((_req, res, next) => {
  res.set('Connection', 'close');
  res.set('Cache-Control', 'no-store');
  next();
});

app.use(express.json());
if (args.dir) {
  app.use(express.static(args.dir));
}

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

function sendWs(ws: WebSocket, type: string, payload: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type, ...((payload as Record<string, unknown>) ?? {}) }));
}

function sendLobbyEvent(playerId: string, type: string, payload: unknown): void {
  const ws = lobbyConnections.get(playerId);
  if (!ws) return;
  sendWs(ws, type, payload);
}

function replayPendingChallengesToPlayer(playerId: string): void {
  for (const challenge of lobby.challenges.values()) {
    if (challenge.target_id !== playerId) continue;
    const fromAlias = lobby.players[challenge.from_id]?.alias ?? knownAliases.get(challenge.from_id) ?? challenge.from_id;
    sendLobbyEvent(playerId, 'challenge_received', {
      challenge_id: challenge.id,
      from_id: challenge.from_id,
      from_alias: fromAlias,
      game: challenge.game,
      amount: challenge.amount,
      per_game: challenge.per_game,
    });
  }
}

function sendGameEvent(playerId: string, type: string, payload: unknown): void {
  const sessionId = playerToSession.get(playerId);
  if (!sessionId) return;
  const ws = gameConnections.get(sessionId);
  if (!ws) return;
  sendWs(ws, type, payload);
}

function broadcastLobbyUpdate(): void {
  const players = lobby.getPlayers();
  for (const [playerId] of lobbyConnections) {
    sendLobbyEvent(playerId, 'lobby_update', { players });
  }
}

function cancelPendingLobbyLeave(playerId: string): void {
  const timer = pendingLobbyLeaves.get(playerId);
  if (timer) {
    clearTimeout(timer);
    pendingLobbyLeaves.delete(playerId);
  }
}

function leaveLobby(playerId: string): boolean {
  if (lobby.removePlayer(playerId)) {
    broadcastLobbyUpdate();
    return true;
  }
  return false;
}

function bindSessionToPlayer(playerId: string, sessionId: string): boolean {
  const previousSession = playerToSession.get(playerId);
  if (previousSession && previousSession !== sessionId) {
    sessionToPlayer.delete(previousSession);
    pendingGameIdentifies.delete(previousSession);
    const previousConn = gameConnections.get(previousSession);
    if (previousConn) {
      try { previousConn.close(); } catch {}
      gameConnections.delete(previousSession);
    }
    console.log(`[tracker] session replaced player=${playerId} old=${previousSession} new=${sessionId}`);
  }

  const previousPlayer = sessionToPlayer.get(sessionId);
  if (previousPlayer && previousPlayer !== playerId) {
    console.warn(`[tracker] rejected session reuse session=${sessionId} owner=${previousPlayer} requester=${playerId}`);
    return false;
  }

  sessionToPlayer.set(sessionId, playerId);
  playerToSession.set(playerId, sessionId);
  return true;
}

function computePeerConnected(playerId: string): boolean {
  const peerId = lobby.getPairedPlayerId(playerId);
  if (!peerId) return false;
  const seen = peerLastSeenAt.get(peerId) ?? 0;
  return Date.now() - seen <= 60_000;
}

function completeGameRegistration(playerId: string): void {
  const pairing = lobby.getPairingForPlayer(playerId);
  if (pairing) {
    const peerId = pairing.playerA_id === playerId ? pairing.playerB_id : pairing.playerA_id;
    const peerSessionId = playerToSession.get(peerId);
    const peerConn = peerSessionId ? gameConnections.get(peerSessionId) : undefined;
    const myAlias = lobby.players[playerId]?.alias ?? knownAliases.get(playerId) ?? playerId;
    const peerAlias = lobby.players[peerId]?.alias ?? knownAliases.get(peerId) ?? peerId;
    const peerConnected = computePeerConnected(playerId) && !!peerConn;
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
    if (peerConn) {
      sendGameEvent(peerId, 'peer_reconnected', {});
    }
  } else {
    sendGameEvent(playerId, 'connection_status', { has_pairing: false });
  }
}

function onLobbyJoin(msg: Extract<InboundMessage, { type: 'join' }>): void {
  const { id, alias, session_id } = msg;
  cancelPendingLobbyLeave(id);
  if (session_id && !bindSessionToPlayer(id, session_id)) {
    sendLobbyEvent(id, 'error', { error: 'Session ID does not belong to this player.' });
    return;
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
    if (session_id) lobby.players[id].session_id = session_id;
    lobby.players[id].lastActive = Date.now();
  }
  knownAliases.set(id, resolvedAlias);
  broadcastLobbyUpdate();
  replayPendingChallengesToPlayer(id);

  if (session_id) {
    const pendingIdentify = pendingGameIdentifies.get(session_id);
    if (pendingIdentify) {
      pendingGameIdentifies.delete(session_id);
      const meta = wsGameMeta.get(pendingIdentify);
      if (meta) meta.playerId = id;
      completeGameRegistration(id);
    }
  }
}

function onLobbyLeave(msg: Extract<InboundMessage, { type: 'leave' }>): void {
  cancelPendingLobbyLeave(msg.id);
  leaveLobby(msg.id);
}

function getLobbySenderId(ws: WebSocket): string | undefined {
  return wsLobbyMeta.get(ws)?.playerId;
}

function onChallenge(ws: WebSocket, msg: Extract<InboundMessage, { type: 'challenge' }>): void {
  const senderId = getLobbySenderId(ws) ?? msg.from_id;
  const { target_id, game, amount, per_game } = msg;
  const fromPlayer = senderId ? lobby.players[senderId] : undefined;
  if (!fromPlayer) {
    console.warn('[tracker] challenge dropped: unknown sender', { senderId, target: target_id });
    sendWs(ws, 'error', { error: 'Unknown challenger. Rejoin lobby and retry.' });
    return;
  }

  const challenge = lobby.createChallenge(
    fromPlayer.id,
    target_id,
    game || 'calpoker',
    amount || '100',
    per_game || '10',
  );

  sendLobbyEvent(target_id, 'challenge_received', {
    challenge_id: challenge.id,
    from_id: fromPlayer.id,
    from_alias: fromPlayer.alias,
    game: challenge.game,
    amount: challenge.amount,
    per_game: challenge.per_game,
  });
}

function onChallengeAccept(ws: WebSocket, msg: Extract<InboundMessage, { type: 'challenge_accept' }>): void {
  const accepter_id = getLobbySenderId(ws) ?? msg.accepter_id;
  const { challenge_id } = msg;
  const challenge = lobby.getChallenge(challenge_id);
  if (!challenge || !accepter_id || accepter_id !== challenge.target_id) {
    console.warn('[tracker] challenge_accept dropped: invalid accepter', { challenge_id, accepter_id });
    return;
  }

  lobby.removeChallenge(challenge_id);
  const pairing = lobby.createPairing(
    challenge.from_id,
    challenge.target_id,
    challenge.game,
    challenge.amount,
    challenge.per_game,
  );

  sendLobbyEvent(challenge.from_id, 'challenge_resolved', {
    challenge_id,
    accepted: true,
  });

  const challengerAlias = lobby.players[challenge.from_id]?.alias ?? challenge.from_id;
  const accepterAlias = lobby.players[challenge.target_id]?.alias ?? challenge.target_id;
  const matchedBase = {
    token: pairing.token,
    game_type: challenge.game,
    amount: challenge.amount,
    per_game: challenge.per_game,
  };

  sendGameEvent(challenge.from_id, 'matched', {
    ...matchedBase,
    i_am_initiator: true,
    my_alias: challengerAlias,
    peer_alias: accepterAlias,
  });
  sendGameEvent(challenge.target_id, 'matched', {
    ...matchedBase,
    i_am_initiator: false,
    my_alias: accepterAlias,
    peer_alias: challengerAlias,
  });
}

function onChallengeDecline(msg: Extract<InboundMessage, { type: 'challenge_decline' }>): void {
  const challenge = lobby.getChallenge(msg.challenge_id);
  if (!challenge) return;
  lobby.removeChallenge(msg.challenge_id);
  sendLobbyEvent(challenge.from_id, 'challenge_resolved', {
    challenge_id: msg.challenge_id,
    accepted: false,
  });
}

function onChangeAlias(ws: WebSocket, msg: Extract<InboundMessage, { type: 'change_alias' }>): void {
  const playerId = getLobbySenderId(ws) ?? msg.id;
  if (!playerId) return;
  knownAliases.set(playerId, msg.newAlias);
  const player = lobby.players[playerId];
  if (player) {
    player.alias = msg.newAlias;
    broadcastLobbyUpdate();
  }
}

function onIdentify(ws: WebSocket, msg: Extract<InboundMessage, { type: 'identify' }>): void {
  const playerId = sessionToPlayer.get(msg.session_id);
  wsGameMeta.set(ws, { sessionId: msg.session_id, playerId });
  gameConnections.set(msg.session_id, ws);
  if (!playerId) {
    pendingGameIdentifies.set(msg.session_id, ws);
    return;
  }
  completeGameRegistration(playerId);
}

function onGameMessage(msg: Extract<InboundMessage, { type: 'message' }>): void {
  const playerId = sessionToPlayer.get(msg.session_id);
  if (!playerId) return;
  if (!isRelayPayload(msg.data)) return;
  const peerId = lobby.getPairedPlayerId(playerId);
  if (!peerId) return;
  peerLastSeenAt.set(playerId, Date.now());
  sendGameEvent(peerId, 'message', { data: msg.data });
}

function onGameChat(msg: Extract<InboundMessage, { type: 'chat' }>): void {
  const playerId = sessionToPlayer.get(msg.session_id);
  if (!playerId) return;
  const peerId = lobby.getPairedPlayerId(playerId);
  if (!peerId) return;
  const fromAlias = lobby.players[playerId]?.alias ?? playerId;
  sendGameEvent(peerId, 'chat', {
    text: msg.text,
    from_alias: fromAlias,
    timestamp: Date.now(),
  });
}

function onGameClose(msg: Extract<InboundMessage, { type: 'close' }>): void {
  const playerId = sessionToPlayer.get(msg.session_id);
  if (!playerId) return;
  const peerId = lobby.getPairedPlayerId(playerId);
  if (peerId) sendGameEvent(peerId, 'closed', {});
  sendGameEvent(playerId, 'closed', {});
  const pairing = lobby.getPairingForPlayer(playerId);
  if (pairing) lobby.removePairing(pairing.token);
}

function parseInbound(raw: string): InboundMessage | null {
  try {
    const parsed = JSON.parse(raw) as InboundMessage;
    if (!parsed || typeof parsed !== 'object' || !('type' in parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

wsServer.on('connection', (ws) => {
  ws.on('message', (message) => {
    const text = typeof message === 'string' ? message : message.toString();
    const parsed = parseInbound(text);
    if (!parsed) return;

    switch (parsed.type) {
      case 'join': {
        wsLobbyMeta.set(ws, { playerId: parsed.id });
        const previous = lobbyConnections.get(parsed.id);
        if (previous && previous !== ws) {
          try { previous.close(4001, 'replaced_by_new_connection'); } catch {}
        }
        lobbyConnections.set(parsed.id, ws);
        onLobbyJoin(parsed);
        break;
      }
      case 'leave':
        onLobbyLeave(parsed);
        break;
      case 'challenge':
        onChallenge(ws, parsed);
        break;
      case 'challenge_accept':
        onChallengeAccept(ws, parsed);
        break;
      case 'challenge_decline':
        onChallengeDecline(parsed);
        break;
      case 'change_alias':
        onChangeAlias(ws, parsed);
        break;
      case 'identify':
        onIdentify(ws, parsed);
        break;
      case 'message':
        onGameMessage(parsed);
        break;
      case 'chat':
        onGameChat(parsed);
        break;
      case 'close':
        onGameClose(parsed);
        break;
      default:
        break;
    }
  });

  ws.on('close', () => {
    const lobbyMeta = wsLobbyMeta.get(ws);
    if (lobbyMeta) {
      const playerId = lobbyMeta.playerId;
      if (lobbyConnections.get(playerId) === ws) {
        lobbyConnections.delete(playerId);
      }
      cancelPendingLobbyLeave(playerId);
      const timer = setTimeout(() => {
        pendingLobbyLeaves.delete(playerId);
        if (!lobbyConnections.has(playerId)) {
          leaveLobby(playerId);
        }
      }, LOBBY_DISCONNECT_GRACE_MS);
      pendingLobbyLeaves.set(playerId, timer);
    }

    const gameMeta = wsGameMeta.get(ws);
    if (gameMeta) {
      const { sessionId } = gameMeta;
      if (gameConnections.get(sessionId) === ws) {
        gameConnections.delete(sessionId);
      }
      pendingGameIdentifies.delete(sessionId);
    }
  });
});

app.get('/lobby/alias', (req, res) => {
  const id = req.query.id as string;
  if (!id) return res.status(400).json({ error: 'Missing id.' });
  const alias = knownAliases.get(id) ?? null;
  res.json({ alias });
});

app.post('/lobby/set-alias', (req, res) => {
  const { id, alias } = req.body;
  if (!id || !alias) return res.status(400).json({ error: 'Missing id or alias.' });
  knownAliases.set(id, alias);
  const player = lobby.players[id];
  if (player) {
    player.alias = alias;
    broadcastLobbyUpdate();
  }
  res.json({ ok: true });
});

setInterval(() => {
  lobby.sweep(Date.now());
  broadcastLobbyUpdate();
}, 15_000);

const port = process.env.PORT || 5801;
httpServer.listen({ host: '0.0.0.0', port }, () => {
  console.log(`Server running on port ${port}`);
});
