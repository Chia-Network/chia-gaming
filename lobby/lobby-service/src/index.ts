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
  const args = minimist(process.argv.slice(2), { boolean: ['verbose'], alias: { verbose: 'v' } });
  if (!args.self) {
    console.warn('usage: lobby --self [own-url] --dir [serve-directory] [--verbose]');
    process.exit(1);
  }
  return args;
}

const args = parseArgs();
const selfWs = String(args.self).replace(/^http/i, 'ws');
const simUrl = String(args.sim || 'http://localhost:5800');
const simWsUrl = simUrl.replace(/^http/i, 'ws').replace(/:5800\b/, ':5801');
const verbose = Boolean(args.verbose);

type RelayPayload =
  | { ack: number }
  | { keepalive: true };

type LobbyInboundMessage =
  | { type: 'join'; id: string; alias?: string; session_id?: string }
  | { type: 'leave'; id: string }
  | { type: 'challenge'; from_id: string; target_id: string; game?: string; amount?: string; per_game?: string }
  | { type: 'challenge_accept'; challenge_id: string; accepter_id: string }
  | { type: 'challenge_decline'; challenge_id: string }
  | { type: 'challenge_cancel'; from_id: string }
  | { type: 'change_alias'; id: string; newAlias: string }
  | { type: 'get_alias'; id: string }
  | { type: 'set_alias'; id: string; alias: string }
  | { type: 'keepalive' };

type GameInboundMessage =
  | { type: 'identify'; session_id: string; available?: boolean }
  | { type: 'message'; session_id: string; data: RelayPayload }
  | { type: 'chat'; session_id: string; text: string }
  | { type: 'close'; session_id: string }
  | { type: 'set_status'; session_id: string; available: boolean }
  | { type: 'keepalive' };

interface LobbyConnMeta {
  playerId: string;
}

interface GameConnMeta {
  sessionId: string;
  playerId?: string;
  available?: boolean;
}

const LOBBY_DISCONNECT_GRACE_MS = 3000;
const CONNECTION_TTL_MS = 60_000;
const lobbyWsServer = new WebSocketServer({ noServer: true });
const gameWsServer = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url!, `http://${req.headers.host}`).pathname;
  if (pathname === '/ws/lobby') {
    lobbyWsServer.handleUpgrade(req, socket, head, (ws) => {
      lobbyWsServer.emit('connection', ws, req);
    });
  } else if (pathname === '/ws/game') {
    gameWsServer.handleUpgrade(req, socket, head, (ws) => {
      gameWsServer.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

const lobbyConnections = new Map<string, WebSocket>();
const gameConnections = new Map<string, WebSocket>(); // keyed by session_id
const pendingGameIdentifies = new Map<string, WebSocket>(); // session_id -> ws
const wsLobbyMeta = new WeakMap<WebSocket, LobbyConnMeta>();
const wsGameMeta = new WeakMap<WebSocket, GameConnMeta>();

const pendingLobbyLeaves = new Map<string, ReturnType<typeof setTimeout>>();
const sessionToPlayer = new Map<string, string>();
const playerToSession = new Map<string, string>();
const knownAliases = new Map<string, string>();
const wsLastActivity = new WeakMap<WebSocket, number>();
const wsIds = new WeakMap<WebSocket, number>();
const wsKeepaliveTimers = new WeakMap<WebSocket, ReturnType<typeof setInterval>>();
let nextWsId = 1;

function wsId(ws: WebSocket): number {
  const existing = wsIds.get(ws);
  if (existing) return existing;
  const id = nextWsId++;
  wsIds.set(ws, id);
  return id;
}

function logTracker(event: string, fields?: Record<string, unknown>): void {
  const payload = fields ? ` ${JSON.stringify(fields)}` : '';
  console.log(`[tracker] ${new Date().toISOString()} ${event}${payload}`);
}

function logTrackerVerbose(event: string, fields?: Record<string, unknown>): void {
  if (!verbose) return;
  logTracker(event, fields);
}

function relayPayloadKind(data: RelayPayload): 'keepalive' | 'ack' {
  if ('keepalive' in data) return 'keepalive';
  return 'ack';
}

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
// multiple tabs connect to the same tracker origin.
// Assets under /app/<nonce>/ are immutable (cache-busted by build nonce);
// everything else (index.html, build-meta.json, favicon) uses no-store.
app.use((req, res, next) => {
  res.set('Connection', 'close');
  res.set('Cache-Control',
    req.path.startsWith('/app/')
      ? 'public, max-age=31536000, immutable'
      : 'no-store');
  next();
});

app.use(express.json());
if (args.dir) {
  app.use(express.static(args.dir));
}

function isRelayPayload(data: unknown): data is RelayPayload {
  if (!data || typeof data !== 'object') return false;
  if ('keepalive' in data) return (data as { keepalive?: unknown }).keepalive === true;
  if ('ack' in data) return typeof (data as { ack?: unknown }).ack === 'number';
  return false;
}

function sendWs(ws: WebSocket, type: string, payload: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) {
    logTracker('send_ws_drop_not_open', { ws_id: wsId(ws), type, ready_state: ws.readyState });
    return;
  }
  ws.send(JSON.stringify({ type, ...((payload as Record<string, unknown>) ?? {}) }));
  logTrackerVerbose('send_ws_ok', { ws_id: wsId(ws), type });
}

function sendLobbyEvent(playerId: string, type: string, payload: unknown): void {
  const ws = lobbyConnections.get(playerId);
  if (!ws) {
    logTracker('send_lobby_event_drop_missing_ws', { player_id: playerId, type });
    return;
  }
  logTrackerVerbose('send_lobby_event', { player_id: playerId, ws_id: wsId(ws), type });
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
  if (!sessionId) {
    logTracker('send_game_event_drop_missing_session', { player_id: playerId, type });
    return;
  }
  const ws = gameConnections.get(sessionId);
  if (!ws) {
    logTracker('send_game_event_drop_missing_ws', { player_id: playerId, session_id: sessionId, type });
    return;
  }
  logTrackerVerbose('send_game_event', { player_id: playerId, session_id: sessionId, ws_id: wsId(ws), type });
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
    logTracker('bind_session_replace_previous_player_session', {
      player_id: playerId,
      old_session_id: previousSession,
      new_session_id: sessionId,
    });
    console.log(`[tracker] session replaced player=${playerId} old=${previousSession} new=${sessionId}`);
  }

  const previousPlayer = sessionToPlayer.get(sessionId);
  if (previousPlayer && previousPlayer !== playerId) {
    logTracker('bind_session_reject_reuse', {
      session_id: sessionId,
      owner_player_id: previousPlayer,
      requester_player_id: playerId,
    });
    console.warn(`[tracker] rejected session reuse session=${sessionId} owner=${previousPlayer} requester=${playerId}`);
    return false;
  }

  sessionToPlayer.set(sessionId, playerId);
  playerToSession.set(playerId, sessionId);
  logTracker('bind_session_ok', { player_id: playerId, session_id: sessionId });
  return true;
}

function computePeerConnected(playerId: string): boolean {
  const peerId = lobby.getPairedPlayerId(playerId);
  if (!peerId) return false;
  const sessionId = playerToSession.get(peerId);
  if (!sessionId) return false;
  const ws = gameConnections.get(sessionId);
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  const lastSeen = wsLastActivity.get(ws) ?? 0;
  return Date.now() - lastSeen <= CONNECTION_TTL_MS;
}

function hasActiveGameConnection(playerId: string): boolean {
  const sessionId = playerToSession.get(playerId);
  if (!sessionId) return false;
  const ws = gameConnections.get(sessionId);
  return !!ws && ws.readyState === WebSocket.OPEN;
}

function cancelPlayerChallenges(playerId: string): void {
  const toCancel: string[] = [];
  for (const [id, challenge] of lobby.challenges) {
    if (challenge.from_id === playerId || challenge.target_id === playerId) {
      toCancel.push(id);
    }
  }
  for (const id of toCancel) {
    const challenge = lobby.getChallenge(id);
    if (!challenge) continue;
    const otherId = challenge.from_id === playerId ? challenge.target_id : challenge.from_id;
    lobby.removeChallenge(id);
    sendLobbyEvent(otherId, 'challenge_resolved', { challenge_id: id, accepted: false });
    logTracker('challenge_cancelled_on_sweep', { challenge_id: id, swept_player: playerId, notified_player: otherId });
  }
}

function completeGameRegistration(playerId: string): void {
  const sessionId = playerToSession.get(playerId);
  const gameWs = sessionId ? gameConnections.get(sessionId) : undefined;
  const gameMeta = gameWs ? wsGameMeta.get(gameWs) : undefined;
  if (gameMeta?.available === false) {
    lobby.setPlayerStatus(playerId, 'busy');
    broadcastLobbyUpdate();
  }
  const pairing = lobby.getPairingForPlayer(playerId);
  if (pairing) {
    const peerId = pairing.playerA_id === playerId ? pairing.playerB_id : pairing.playerA_id;
    const peerSessionId = playerToSession.get(peerId);
    const peerConn = peerSessionId ? gameConnections.get(peerSessionId) : undefined;
    const myAlias = lobby.players[playerId]?.alias ?? knownAliases.get(playerId) ?? playerId;
    const peerAlias = lobby.players[peerId]?.alias ?? knownAliases.get(peerId) ?? peerId;
    const peerConnected = computePeerConnected(playerId) && !!peerConn;
    logTracker('game_registration_status_pairing', {
      player_id: playerId,
      peer_id: peerId,
      has_peer_conn: !!peerConn,
      peer_connected: peerConnected,
      token: pairing.token,
    });
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
      logTracker('game_registration_notify_peer_reconnected', { player_id: playerId, peer_id: peerId });
      sendGameEvent(peerId, 'peer_reconnected', {});
    }
  } else {
    logTracker('game_registration_status_no_pairing', { player_id: playerId });
    sendGameEvent(playerId, 'connection_status', { has_pairing: false });
  }
}

function onLobbyJoin(msg: Extract<LobbyInboundMessage, { type: 'join' }>): void {
  const { id, alias, session_id } = msg;
  logTracker('lobby_join', { player_id: id, session_id: session_id ?? null, alias: alias ?? null });
  cancelPendingLobbyLeave(id);
  if (session_id && !bindSessionToPlayer(id, session_id)) {
    sendLobbyEvent(id, 'error', { error: 'Session ID does not belong to this player.' });
    return;
  }

  const resolvedAlias = alias || knownAliases.get(id) || id;
  if (!lobby.players[id]) {
    lobby.addPlayer({
      id,
      alias: resolvedAlias,
      session_id: session_id || '',
      status: 'waiting',
      parameters: {},
    });
  } else {
    lobby.players[id].alias = resolvedAlias;
    if (session_id) lobby.players[id].session_id = session_id;
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
      logTracker('lobby_join_flush_pending_identify', {
        player_id: id,
        session_id,
        ws_id: wsId(pendingIdentify),
      });
      completeGameRegistration(id);
    }
  }
}

function onLobbyLeave(msg: Extract<LobbyInboundMessage, { type: 'leave' }>): void {
  logTracker('lobby_leave', { player_id: msg.id });
  cancelPendingLobbyLeave(msg.id);
  leaveLobby(msg.id);
}

function getLobbySenderId(ws: WebSocket): string | undefined {
  return wsLobbyMeta.get(ws)?.playerId;
}

function onChallenge(ws: WebSocket, msg: Extract<LobbyInboundMessage, { type: 'challenge' }>): void {
  const senderId = getLobbySenderId(ws) ?? msg.from_id;
  const { target_id, game, amount, per_game } = msg;
  logTracker('challenge_received', {
    ws_id: wsId(ws),
    sender_id: senderId ?? null,
    target_id,
    game: game ?? 'calpoker',
    amount: amount ?? '100',
    per_game: per_game ?? '10',
  });
  const fromPlayer = senderId ? lobby.players[senderId] : undefined;
  if (!fromPlayer) {
    logTracker('challenge_drop_unknown_sender', { sender_id: senderId ?? null, target_id });
    console.warn('[tracker] challenge dropped: unknown sender', { senderId, target: target_id });
    sendWs(ws, 'error', { error: 'Unknown challenger. Rejoin lobby and retry.' });
    return;
  }
  if (senderId && lobby.getPairingForPlayer(senderId)) {
    logTracker('challenge_drop_sender_playing', { sender_id: senderId, target_id });
    sendWs(ws, 'error', { error: 'You are already in a game.' });
    return;
  }
  if (lobby.getPairingForPlayer(target_id)) {
    logTracker('challenge_drop_target_playing', { sender_id: senderId, target_id });
    sendWs(ws, 'error', { error: 'That player is already in a game.' });
    sendWs(ws, 'challenge_resolved', { challenge_id: null, accepted: false });
    return;
  }
  if (!hasActiveGameConnection(target_id)) {
    logTracker('challenge_drop_target_no_game_conn', { sender_id: senderId, target_id });
    sendWs(ws, 'error', { error: 'Peer is not connected.' });
    sendWs(ws, 'challenge_resolved', { challenge_id: null, accepted: false });
    return;
  }
  if (fromPlayer.status === 'busy') {
    logTracker('challenge_drop_sender_busy', { sender_id: senderId, target_id });
    sendWs(ws, 'error', { error: 'You are in an active session. Finish it first.' });
    return;
  }
  const targetPlayer = lobby.players[target_id];
  if (targetPlayer?.status === 'busy') {
    logTracker('challenge_drop_target_busy', { sender_id: senderId, target_id });
    sendWs(ws, 'error', { error: 'That player is in an active session.' });
    sendWs(ws, 'challenge_resolved', { challenge_id: null, accepted: false });
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
  sendGameEvent(target_id, 'lobby_attention', {});
}

function onChallengeAccept(ws: WebSocket, msg: Extract<LobbyInboundMessage, { type: 'challenge_accept' }>): void {
  const accepter_id = getLobbySenderId(ws) ?? msg.accepter_id;
  const { challenge_id } = msg;
  const challenge = lobby.getChallenge(challenge_id);
  if (!challenge || !accepter_id || accepter_id !== challenge.target_id) {
    logTracker('challenge_accept_drop_invalid_accepter', {
      ws_id: wsId(ws),
      challenge_id,
      accepter_id: accepter_id ?? null,
      expected_target_id: challenge?.target_id ?? null,
    });
    console.warn('[tracker] challenge_accept dropped: invalid accepter', { challenge_id, accepter_id });
    return;
  }
  if (!hasActiveGameConnection(challenge.from_id) || !hasActiveGameConnection(accepter_id)) {
    logTracker('challenge_accept_drop_missing_game_conn', {
      challenge_id,
      challenger_connected: hasActiveGameConnection(challenge.from_id),
      accepter_connected: hasActiveGameConnection(accepter_id),
    });
    lobby.removeChallenge(challenge_id);
    const errorMsg = 'Game connection not available for both players.';
    sendWs(ws, 'error', { error: errorMsg });
    sendWs(ws, 'challenge_resolved', { challenge_id, accepted: false });
    sendLobbyEvent(challenge.from_id, 'error', { error: errorMsg });
    sendLobbyEvent(challenge.from_id, 'challenge_resolved', { challenge_id, accepted: false });
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
  logTracker('pairing_created', {
    challenge_id,
    token: pairing.token,
    challenger_id: challenge.from_id,
    accepter_id: challenge.target_id,
    game_type: challenge.game,
    amount: challenge.amount,
    per_game: challenge.per_game,
  });

  const challengerAlias = lobby.players[challenge.from_id]?.alias ?? challenge.from_id;
  const accepterAlias = lobby.players[challenge.target_id]?.alias ?? challenge.target_id;

  lobby.setPlayerStatus(challenge.from_id, 'playing', accepterAlias);
  lobby.setPlayerStatus(challenge.target_id, 'playing', challengerAlias);
  cancelPlayerChallenges(challenge.from_id);
  cancelPlayerChallenges(challenge.target_id);
  broadcastLobbyUpdate();

  sendLobbyEvent(challenge.from_id, 'challenge_resolved', {
    challenge_id,
    accepted: true,
  });
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

function onChallengeDecline(msg: Extract<LobbyInboundMessage, { type: 'challenge_decline' }>): void {
  const challenge = lobby.getChallenge(msg.challenge_id);
  if (!challenge) {
    logTracker('challenge_decline_drop_missing', { challenge_id: msg.challenge_id });
    return;
  }
  logTracker('challenge_declined', {
    challenge_id: msg.challenge_id,
    challenger_id: challenge.from_id,
    target_id: challenge.target_id,
  });
  lobby.removeChallenge(msg.challenge_id);
  sendLobbyEvent(challenge.from_id, 'challenge_resolved', {
    challenge_id: msg.challenge_id,
    accepted: false,
  });
}

function onChallengeCancel(ws: WebSocket, msg: Extract<LobbyInboundMessage, { type: 'challenge_cancel' }>): void {
  const senderId = getLobbySenderId(ws) ?? msg.from_id;
  if (!senderId) return;
  const toCancel: string[] = [];
  for (const [id, challenge] of lobby.challenges) {
    if (challenge.from_id === senderId) {
      toCancel.push(id);
    }
  }
  if (toCancel.length === 0) return;
  for (const id of toCancel) {
    const challenge = lobby.getChallenge(id);
    if (!challenge) continue;
    logTracker('challenge_cancelled', { challenge_id: id, challenger_id: senderId, target_id: challenge.target_id });
    lobby.removeChallenge(id);
    sendLobbyEvent(challenge.target_id, 'challenge_resolved', { challenge_id: id, accepted: false });
  }
  sendWs(ws, 'challenge_resolved', { challenge_id: null, accepted: false });
}

function onChangeAlias(ws: WebSocket, msg: Extract<LobbyInboundMessage, { type: 'change_alias' }>): void {
  const playerId = getLobbySenderId(ws) ?? msg.id;
  if (!playerId) return;
  logTracker('alias_change', { ws_id: wsId(ws), player_id: playerId, new_alias: msg.newAlias });
  knownAliases.set(playerId, msg.newAlias);
  const player = lobby.players[playerId];
  if (player) {
    player.alias = msg.newAlias;
    broadcastLobbyUpdate();
  }
}

function onIdentify(ws: WebSocket, msg: Extract<GameInboundMessage, { type: 'identify' }>): void {
  const playerId = sessionToPlayer.get(msg.session_id);
  logTracker('identify', {
    ws_id: wsId(ws),
    session_id: msg.session_id,
    player_id: playerId ?? null,
  });
  const previousGameConn = gameConnections.get(msg.session_id);
  if (previousGameConn && previousGameConn !== ws) {
    logTracker('game_connection_replaced', { ws_id: wsId(previousGameConn), session_id: msg.session_id });
    try { previousGameConn.close(4001, 'replaced_by_new_connection'); } catch {}
  }
  wsGameMeta.set(ws, { sessionId: msg.session_id, playerId, available: msg.available });
  gameConnections.set(msg.session_id, ws);
  if (!playerId) {
    pendingGameIdentifies.set(msg.session_id, ws);
    logTracker('identify_pending', {
      ws_id: wsId(ws),
      session_id: msg.session_id,
      pending_game_identifies: pendingGameIdentifies.size,
    });
    return;
  }
  logTracker('identify_complete_registration', { ws_id: wsId(ws), session_id: msg.session_id, player_id: playerId });
  completeGameRegistration(playerId);
}

function onGameMessage(msg: Extract<GameInboundMessage, { type: 'message' }>): void {
  const playerId = sessionToPlayer.get(msg.session_id);
  if (!playerId) {
    logTracker('game_message_drop_unknown_session', { session_id: msg.session_id });
    return;
  }
  if (!isRelayPayload(msg.data)) {
    logTracker('game_message_drop_bad_payload', { player_id: playerId, session_id: msg.session_id });
    return;
  }
  const peerId = lobby.getPairedPlayerId(playerId);
  if (!peerId) {
    logTracker('game_message_drop_unpaired', { player_id: playerId, session_id: msg.session_id });
    return;
  }
  logTrackerVerbose('game_message_relay', {
    from_player_id: playerId,
    to_player_id: peerId,
    session_id: msg.session_id,
    payload_kind: relayPayloadKind(msg.data),
  });
  sendGameEvent(peerId, 'message', { data: msg.data });
}

function onGameChat(msg: Extract<GameInboundMessage, { type: 'chat' }>): void {
  const playerId = sessionToPlayer.get(msg.session_id);
  if (!playerId) {
    logTracker('game_chat_drop_unknown_session', { session_id: msg.session_id });
    return;
  }
  const peerId = lobby.getPairedPlayerId(playerId);
  if (!peerId) {
    logTracker('game_chat_drop_unpaired', { player_id: playerId, session_id: msg.session_id });
    return;
  }
  const fromAlias = lobby.players[playerId]?.alias ?? playerId;
  logTrackerVerbose('game_chat_relay', { from_player_id: playerId, to_player_id: peerId, session_id: msg.session_id });
  sendGameEvent(peerId, 'chat', {
    text: msg.text,
    from_alias: fromAlias,
    timestamp: Date.now(),
  });
}

function onGameClose(msg: Extract<GameInboundMessage, { type: 'close' }>): void {
  const playerId = sessionToPlayer.get(msg.session_id);
  if (!playerId) {
    logTracker('game_close_drop_unknown_session', { session_id: msg.session_id });
    return;
  }
  const peerId = lobby.getPairedPlayerId(playerId);
  logTracker('game_close', { player_id: playerId, peer_id: peerId ?? null, session_id: msg.session_id });
  if (peerId) sendGameEvent(peerId, 'closed', {});
  sendGameEvent(playerId, 'closed', {});
  const pairing = lobby.getPairingForPlayer(playerId);
  if (pairing) {
    lobby.setPlayerStatus(pairing.playerA_id, 'waiting');
    lobby.setPlayerStatus(pairing.playerB_id, 'waiting');
    lobby.removePairing(pairing.token);
    broadcastLobbyUpdate();
    logTracker('pairing_removed_on_close', { token: pairing.token, player_id: playerId, peer_id: peerId ?? null });
  }
}

function onSetStatus(msg: Extract<GameInboundMessage, { type: 'set_status' }>): void {
  const playerId = sessionToPlayer.get(msg.session_id);
  if (!playerId) {
    logTracker('set_status_drop_unknown_session', { session_id: msg.session_id });
    return;
  }
  const newStatus = msg.available ? 'waiting' : 'busy';
  logTracker('set_status', { player_id: playerId, available: msg.available, status: newStatus });
  lobby.setPlayerStatus(playerId, newStatus);
  broadcastLobbyUpdate();
}

function parseLobbyInbound(raw: string): LobbyInboundMessage | null {
  try {
    const parsed = JSON.parse(raw) as LobbyInboundMessage;
    if (!parsed || typeof parsed !== 'object' || !('type' in parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function parseGameInbound(raw: string): GameInboundMessage | null {
  try {
    const parsed = JSON.parse(raw) as GameInboundMessage;
    if (!parsed || typeof parsed !== 'object' || !('type' in parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function setupKeepalive(ws: WebSocket): void {
  const kaTimer = setInterval(() => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'keepalive' }));
    }
  }, 15_000);
  wsKeepaliveTimers.set(ws, kaTimer);
}

function clearKeepalive(ws: WebSocket): void {
  const timer = wsKeepaliveTimers.get(ws);
  if (timer) {
    clearInterval(timer);
    wsKeepaliveTimers.delete(ws);
  }
}

function onGetAlias(ws: WebSocket, msg: Extract<LobbyInboundMessage, { type: 'get_alias' }>): void {
  const alias = knownAliases.get(msg.id) ?? null;
  logTrackerVerbose('get_alias', { ws_id: wsId(ws), player_id: msg.id, found: alias !== null });
  sendWs(ws, 'alias_result', { alias });
}

function onSetAlias(ws: WebSocket, msg: Extract<LobbyInboundMessage, { type: 'set_alias' }>): void {
  logTracker('set_alias', { ws_id: wsId(ws), player_id: msg.id, alias: msg.alias });
  knownAliases.set(msg.id, msg.alias);
  const player = lobby.players[msg.id];
  if (player) {
    player.alias = msg.alias;
    broadcastLobbyUpdate();
  }
  sendWs(ws, 'alias_result', { alias: msg.alias });
}

lobbyWsServer.on('connection', (ws) => {
  const currentWsId = wsId(ws);
  wsLastActivity.set(ws, Date.now());
  logTracker('lobby_ws_connected', { ws_id: currentWsId });
  setupKeepalive(ws);

  ws.on('message', (message) => {
    wsLastActivity.set(ws, Date.now());
    const text = typeof message === 'string' ? message : message.toString();
    const parsed = parseLobbyInbound(text);
    if (!parsed) {
      logTracker('lobby_ws_message_parse_drop', { ws_id: currentWsId, bytes: text.length });
      return;
    }
    logTrackerVerbose('lobby_ws_message', { ws_id: currentWsId, type: parsed.type, bytes: text.length });

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
      case 'challenge_cancel':
        onChallengeCancel(ws, parsed);
        break;
      case 'change_alias':
        onChangeAlias(ws, parsed);
        break;
      case 'get_alias':
        onGetAlias(ws, parsed);
        break;
      case 'set_alias':
        onSetAlias(ws, parsed);
        break;
      case 'keepalive':
        break;
      default:
        break;
    }
  });

  ws.on('error', (err) => {
    logTracker('lobby_ws_error', { ws_id: currentWsId, error: err.message });
  });

  ws.on('close', (code, reason) => {
    clearKeepalive(ws);
    logTracker('lobby_ws_closed', { ws_id: currentWsId, code, reason: reason.toString() });
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
          logTracker('lobby_grace_timeout_leave', { player_id: playerId });
          leaveLobby(playerId);
        }
      }, LOBBY_DISCONNECT_GRACE_MS);
      pendingLobbyLeaves.set(playerId, timer);
    }
  });
});

gameWsServer.on('connection', (ws) => {
  const currentWsId = wsId(ws);
  wsLastActivity.set(ws, Date.now());
  logTracker('game_ws_connected', { ws_id: currentWsId });
  setupKeepalive(ws);

  ws.on('message', (message, isBinary) => {
    wsLastActivity.set(ws, Date.now());

    if (isBinary) {
      const buf = Buffer.isBuffer(message) ? message : Buffer.from(message as ArrayBuffer);
      const meta = wsGameMeta.get(ws);
      if (!meta?.playerId) {
        logTracker('game_binary_drop_no_player', { ws_id: currentWsId, bytes: buf.byteLength });
        return;
      }
      const peerId = lobby.getPairedPlayerId(meta.playerId);
      if (!peerId) {
        logTracker('game_binary_drop_unpaired', { ws_id: currentWsId, player_id: meta.playerId, bytes: buf.byteLength });
        return;
      }
      const peerSessionId = playerToSession.get(peerId);
      const peerWs = peerSessionId ? gameConnections.get(peerSessionId) : undefined;
      if (!peerWs || peerWs.readyState !== WebSocket.OPEN) {
        logTracker('game_binary_drop_peer_offline', { ws_id: currentWsId, player_id: meta.playerId, peer_id: peerId });
        return;
      }
      logTrackerVerbose('game_binary_relay', { from: meta.playerId, to: peerId, bytes: buf.byteLength });
      peerWs.send(buf);
      return;
    }

    const text = typeof message === 'string' ? message : message.toString();
    const parsed = parseGameInbound(text);
    if (!parsed) {
      logTracker('game_ws_message_parse_drop', { ws_id: currentWsId, bytes: text.length });
      return;
    }
    logTrackerVerbose('game_ws_message', { ws_id: currentWsId, type: parsed.type, bytes: text.length });

    switch (parsed.type) {
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
      case 'set_status':
        onSetStatus(parsed);
        break;
      case 'keepalive':
        break;
      default:
        break;
    }
  });

  ws.on('error', (err) => {
    logTracker('game_ws_error', { ws_id: currentWsId, error: err.message });
  });

  ws.on('close', (code, reason) => {
    clearKeepalive(ws);
    logTracker('game_ws_closed', { ws_id: currentWsId, code, reason: reason.toString() });
    const gameMeta = wsGameMeta.get(ws);
    if (gameMeta) {
      const { sessionId } = gameMeta;
      if (gameConnections.get(sessionId) === ws) {
        gameConnections.delete(sessionId);
        logTracker('game_connection_removed_on_close', { ws_id: currentWsId, session_id: sessionId });
      }
      pendingGameIdentifies.delete(sessionId);
    }
  });
});

function sweepLobbyConnections(now: number): boolean {
  let changed = false;
  const expired: string[] = [];
  for (const [playerId, ws] of lobbyConnections) {
    const lastSeen = wsLastActivity.get(ws) ?? 0;
    if (now - lastSeen > CONNECTION_TTL_MS) {
      expired.push(playerId);
    }
  }
  for (const playerId of expired) {
    const ws = lobbyConnections.get(playerId);
    if (ws) {
      logTracker('lobby_sweep_expired', { player_id: playerId, ws_id: wsId(ws) });
      try { ws.close(4002, 'idle_timeout'); } catch {}
    }
    lobbyConnections.delete(playerId);
    cancelPendingLobbyLeave(playerId);
    cancelPlayerChallenges(playerId);
    if (lobby.removePlayer(playerId)) {
      changed = true;
    }
  }
  return changed;
}

function sweepGameConnections(now: number): void {
  const expired: string[] = [];
  for (const [sessionId, ws] of gameConnections) {
    const lastSeen = wsLastActivity.get(ws) ?? 0;
    if (now - lastSeen > CONNECTION_TTL_MS) {
      expired.push(sessionId);
    }
  }
  for (const sessionId of expired) {
    const ws = gameConnections.get(sessionId);
    const meta = ws ? wsGameMeta.get(ws) : undefined;
    const playerId = meta?.playerId;
    logTracker('game_sweep_expired', { session_id: sessionId, player_id: playerId ?? null, ws_id: ws ? wsId(ws) : null });
    if (ws) {
      try { ws.close(4002, 'idle_timeout'); } catch {}
    }
    gameConnections.delete(sessionId);
    pendingGameIdentifies.delete(sessionId);
    if (playerId) {
      const pairing = lobby.getPairingForPlayer(playerId);
      if (pairing) {
        const peerId = pairing.playerA_id === playerId ? pairing.playerB_id : pairing.playerA_id;
        sendGameEvent(peerId, 'closed', {});
        lobby.setPlayerStatus(pairing.playerA_id, 'waiting');
        lobby.setPlayerStatus(pairing.playerB_id, 'waiting');
        lobby.removePairing(pairing.token);
        broadcastLobbyUpdate();
        logTracker('pairing_removed_on_sweep', { token: pairing.token, swept_player: playerId, peer_id: peerId });
      }
    }
  }
}

function sweepSessionMaps(): void {
  for (const [sessionId, playerId] of sessionToPlayer) {
    const hasLobby = lobbyConnections.has(playerId);
    const hasGame = gameConnections.has(sessionId);
    if (!hasLobby && !hasGame) {
      sessionToPlayer.delete(sessionId);
      playerToSession.delete(playerId);
      logTracker('session_map_swept', { session_id: sessionId, player_id: playerId });
    }
  }
}

setInterval(() => {
  const now = Date.now();
  const lobbyChanged = sweepLobbyConnections(now);
  sweepGameConnections(now);
  sweepSessionMaps();
  if (lobbyChanged) {
    broadcastLobbyUpdate();
  }
  logTrackerVerbose('state_snapshot', {
    players: Object.keys(lobby.players).length,
    challenges: lobby.challenges.size,
    pairings: lobby.pairings.size,
    lobby_connections: lobbyConnections.size,
    game_connections: gameConnections.size,
    pending_game_identifies: pendingGameIdentifies.size,
    pending_lobby_leaves: pendingLobbyLeaves.size,
    session_to_player: sessionToPlayer.size,
    player_to_session: playerToSession.size,
  });
}, 15_000);

const port = process.env.PORT || 5801;
httpServer.listen({ host: '::', port }, () => {
  console.log(`Server running on port ${port}`);
});
