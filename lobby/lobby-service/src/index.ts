import { createServer } from 'http';
import crypto from 'node:crypto';

import cors from 'cors';
import express from 'express';
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
const verbose = Boolean(args.verbose);

type LobbyInboundMessage =
  | { type: 'join'; id?: string; alias?: string; session_id?: string }
  | { type: 'leave'; id?: string }
  | { type: 'challenge'; from_id?: string; target_id: string; amount: string }
  | { type: 'challenge_accept'; challenge_id: string; accepter_id?: string }
  | { type: 'challenge_decline'; challenge_id: string }
  | { type: 'challenge_cancel'; from_id?: string }
  | { type: 'change_alias'; id?: string; newAlias: string }
  | { type: 'get_alias'; id?: string; session_id?: string }
  | { type: 'set_alias'; id?: string; session_id?: string; alias: string }
  | { type: 'keepalive' };

type GameInboundMessage =
  | { type: 'identify'; session_id: string; available?: boolean }
  | { type: 'chat'; session_id: string; text: string }
  | { type: 'close'; session_id: string }
  | { type: 'set_status'; session_id: string; available: boolean }
  | { type: 'keepalive' };

interface LobbyConnMeta {
  playerId: string;
  sessionId: string;
}

interface GameConnMeta {
  sessionId: string;
  playerId: string;
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
const wsLobbyMeta = new WeakMap<WebSocket, LobbyConnMeta>();
const wsGameMeta = new WeakMap<WebSocket, GameConnMeta>();

const pendingLobbyLeaves = new Map<string, ReturnType<typeof setTimeout>>();
const sessionToPlayer = new Map<string, string>();
const playerToSession = new Map<string, string>();
const knownAliases = new Map<string, string>(); // keyed by secret session nonce
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

function randomPublicId(): string {
  let id: string;
  do {
    id = `p_${crypto.randomBytes(16).toString('hex')}`;
  } while (lobby.players[id] || playerToSession.has(id));
  return id;
}

function ensureSession(sessionId: string): string {
  const existing = sessionToPlayer.get(sessionId);
  if (existing) return existing;
  const playerId = randomPublicId();
  sessionToPlayer.set(sessionId, playerId);
  playerToSession.set(playerId, sessionId);
  logTracker('session_created', { player_id: playerId, session_id: sessionId });
  return playerId;
}

function forgetSession(sessionId: string): void {
  const playerId = sessionToPlayer.get(sessionId);
  if (!playerId) return;
  sessionToPlayer.delete(sessionId);
  playerToSession.delete(playerId);
  knownAliases.delete(sessionId);
  logTracker('session_forgotten', { player_id: playerId, session_id: sessionId });
}

app.use(
  cors({
    origin: '*',
    methods: ['GET', 'POST', 'HEAD', 'OPTIONS'],
  }),
);

// Assets under /app/<nonce>/ are immutable (cache-busted by build nonce);
// everything else (index.html, build-meta.json, favicon) uses no-store.
app.use((req, res, next) => {
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

function aliasForPlayer(playerId: string): string {
  return lobby.players[playerId]?.alias ?? playerId;
}

function replayPendingChallengesToPlayer(playerId: string): void {
  for (const challenge of lobby.challenges.values()) {
    if (challenge.target_id !== playerId) continue;
    const fromAlias = aliasForPlayer(challenge.from_id);
    sendLobbyEvent(playerId, 'challenge_received', {
      challenge_id: challenge.id,
      from_id: challenge.from_id,
      from_alias: fromAlias,
      amount: challenge.amount,
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
    const myAlias = aliasForPlayer(playerId);
    const peerAlias = aliasForPlayer(peerId);
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
      amount: pairing.amount,
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

function onLobbyJoin(ws: WebSocket, msg: Extract<LobbyInboundMessage, { type: 'join' }>): void {
  const { alias, session_id } = msg;
  logTracker('lobby_join', { ws_id: wsId(ws), session_id: session_id ?? null, alias: alias ?? null });
  if (!session_id) {
    sendWs(ws, 'error', { error: 'Missing tracker session.' });
    return;
  }

  const playerId = ensureSession(session_id);
  const resolvedAlias = alias || knownAliases.get(session_id) || playerId;

  wsLobbyMeta.set(ws, { playerId, sessionId: session_id });
  cancelPendingLobbyLeave(playerId);
  const previous = lobbyConnections.get(playerId);
  if (previous && previous !== ws) {
    try { previous.close(4001, 'replaced_by_new_connection'); } catch {}
  }
  lobbyConnections.set(playerId, ws);

  if (!lobby.players[playerId]) {
    lobby.addPlayer({
      id: playerId,
      alias: resolvedAlias,
      status: 'waiting',
      parameters: {},
    });
  } else {
    lobby.players[playerId].alias = resolvedAlias;
  }
  knownAliases.set(session_id, resolvedAlias);
  sendWs(ws, 'joined', { id: playerId, alias: resolvedAlias });
  broadcastLobbyUpdate();
  replayPendingChallengesToPlayer(playerId);

  const gameWs = gameConnections.get(session_id);
  if (gameWs) {
    const meta = wsGameMeta.get(gameWs);
    if (meta) meta.playerId = playerId;
    completeGameRegistration(playerId);
  }
}

function onLobbyLeave(ws: WebSocket, _msg: Extract<LobbyInboundMessage, { type: 'leave' }>): void {
  const playerId = getLobbySenderId(ws);
  if (!playerId) return;
  logTracker('lobby_leave', { player_id: playerId });
  cancelPendingLobbyLeave(playerId);
  leaveLobby(playerId);
}

function getLobbySenderId(ws: WebSocket): string | undefined {
  return wsLobbyMeta.get(ws)?.playerId;
}

function onChallenge(ws: WebSocket, msg: Extract<LobbyInboundMessage, { type: 'challenge' }>): void {
  const senderId = getLobbySenderId(ws);
  const { target_id, amount } = msg;
  logTracker('challenge_received', {
    ws_id: wsId(ws),
    sender_id: senderId ?? null,
    target_id,
    amount: amount ?? '100',
  });
  const fromPlayer = senderId ? lobby.players[senderId] : undefined;
  if (!fromPlayer) {
    logTracker('challenge_drop_unknown_sender', { sender_id: senderId ?? null, target_id });
    console.warn('[tracker] challenge dropped: unknown sender', { senderId, target: target_id });
    sendWs(ws, 'error', { error: 'Unknown challenger. Rejoin lobby and retry.' });
    sendWs(ws, 'challenge_resolved', { challenge_id: null, accepted: false });
    return;
  }
  const targetPlayer = lobby.players[target_id];
  if (!targetPlayer) {
    logTracker('challenge_drop_unknown_target', { sender_id: senderId, target_id });
    sendWs(ws, 'error', { error: 'Unknown target.' });
    sendWs(ws, 'challenge_resolved', { challenge_id: null, accepted: false });
    return;
  }
  if (!hasActiveGameConnection(target_id)) {
    logTracker('challenge_drop_target_no_game_conn', { sender_id: senderId, target_id });
    sendWs(ws, 'error', { error: 'Peer is not connected.' });
    sendWs(ws, 'challenge_resolved', { challenge_id: null, accepted: false });
    return;
  }
  if (fromPlayer.status !== 'waiting') {
    logTracker('challenge_drop_sender_unavailable', { sender_id: senderId, target_id, status: fromPlayer.status });
    sendWs(ws, 'error', { error: 'You are in an active session. Finish it first.' });
    sendWs(ws, 'challenge_resolved', { challenge_id: null, accepted: false });
    return;
  }
  if (targetPlayer.status !== 'waiting') {
    logTracker('challenge_drop_target_unavailable', { sender_id: senderId, target_id, status: targetPlayer.status });
    sendWs(ws, 'error', { error: 'That player is in an active session.' });
    sendWs(ws, 'challenge_resolved', { challenge_id: null, accepted: false });
    return;
  }

  if (!amount || !/^[1-9][0-9]{0,18}$/.test(amount)) {
    sendWs(ws, 'error', { error: 'Invalid amount: must be a positive integer.' });
    sendWs(ws, 'challenge_resolved', { challenge_id: null, accepted: false });
    return;
  }
  const MAX_AMOUNT_MOJOS = 1_000_000_000_000_000_000n;
  if (BigInt(amount) > MAX_AMOUNT_MOJOS) {
    sendWs(ws, 'error', { error: 'Amount exceeds maximum (1,000,000 XCH).' });
    sendWs(ws, 'challenge_resolved', { challenge_id: null, accepted: false });
    return;
  }

  const challenge = lobby.createChallenge(
    fromPlayer.id,
    target_id,
    amount,
  );

  sendLobbyEvent(target_id, 'challenge_received', {
    challenge_id: challenge.id,
    from_id: fromPlayer.id,
    from_alias: fromPlayer.alias,
    amount: challenge.amount,
  });
  sendGameEvent(target_id, 'lobby_attention', {});
}

function onChallengeAccept(ws: WebSocket, msg: Extract<LobbyInboundMessage, { type: 'challenge_accept' }>): void {
  const accepter_id = getLobbySenderId(ws);
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
  const challenger = lobby.players[challenge.from_id];
  const accepter = lobby.players[challenge.target_id];
  if (challenger?.status !== 'waiting' || accepter?.status !== 'waiting') {
    logTracker('challenge_accept_drop_player_unavailable', {
      challenge_id,
      challenger_status: challenger?.status ?? null,
      accepter_status: accepter?.status ?? null,
    });
    lobby.removeChallenge(challenge_id);
    sendWs(ws, 'error', { error: 'One or both players are no longer available.' });
    sendWs(ws, 'challenge_resolved', { challenge_id, accepted: false });
    sendLobbyEvent(challenge.from_id, 'challenge_resolved', { challenge_id, accepted: false });
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
    challenge.amount,
  );
  logTracker('pairing_created', {
    challenge_id,
    token: pairing.token,
    challenger_id: challenge.from_id,
    accepter_id: challenge.target_id,
    amount: challenge.amount,
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
    amount: challenge.amount,
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

function onChallengeDecline(ws: WebSocket, msg: Extract<LobbyInboundMessage, { type: 'challenge_decline' }>): void {
  const playerId = getLobbySenderId(ws);
  const challenge = lobby.getChallenge(msg.challenge_id);
  if (!challenge || !playerId || challenge.target_id !== playerId) {
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
  const senderId = getLobbySenderId(ws);
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
  const meta = wsLobbyMeta.get(ws);
  if (!meta) return;
  const playerId = meta.playerId;
  logTracker('alias_change', { ws_id: wsId(ws), player_id: playerId, new_alias: msg.newAlias });
  knownAliases.set(meta.sessionId, msg.newAlias);
  const player = lobby.players[playerId];
  if (player) {
    player.alias = msg.newAlias;
    broadcastLobbyUpdate();
  }
}

function onIdentify(ws: WebSocket, msg: Extract<GameInboundMessage, { type: 'identify' }>): void {
  const playerId = ensureSession(msg.session_id);
  logTracker('identify', {
    ws_id: wsId(ws),
    session_id: msg.session_id,
    player_id: playerId,
  });
  const previousGameConn = gameConnections.get(msg.session_id);
  if (previousGameConn && previousGameConn !== ws) {
    logTracker('game_connection_replaced', { ws_id: wsId(previousGameConn), session_id: msg.session_id });
    try { previousGameConn.close(4001, 'replaced_by_new_connection'); } catch {}
  }
  wsGameMeta.set(ws, { sessionId: msg.session_id, playerId, available: msg.available });
  gameConnections.set(msg.session_id, ws);
  logTracker('identify_complete_registration', { ws_id: wsId(ws), session_id: msg.session_id, player_id: playerId });
  completeGameRegistration(playerId);
}

function onGameChat(ws: WebSocket, msg: Extract<GameInboundMessage, { type: 'chat' }>): void {
  const meta = wsGameMeta.get(ws);
  if (!meta) {
    logTracker('game_chat_drop_unknown_session', { session_id: msg.session_id });
    return;
  }
  const playerId = meta.playerId;
  const peerId = lobby.getPairedPlayerId(playerId);
  if (!peerId) {
    logTracker('game_chat_drop_unpaired', { player_id: playerId, session_id: msg.session_id });
    return;
  }
  const fromAlias = aliasForPlayer(playerId);
  logTrackerVerbose('game_chat_relay', { from_player_id: playerId, to_player_id: peerId, session_id: msg.session_id });
  sendGameEvent(peerId, 'chat', {
    text: msg.text,
    from_alias: fromAlias,
    timestamp: Date.now(),
  });
}

function onGameClose(ws: WebSocket, msg: Extract<GameInboundMessage, { type: 'close' }>): void {
  const meta = wsGameMeta.get(ws);
  if (!meta) {
    logTracker('game_close_drop_unknown_session', { session_id: msg.session_id });
    return;
  }
  const playerId = meta.playerId;
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

function onSetStatus(ws: WebSocket, msg: Extract<GameInboundMessage, { type: 'set_status' }>): void {
  const meta = wsGameMeta.get(ws);
  if (!meta) {
    logTracker('set_status_drop_unknown_session', { session_id: msg.session_id });
    return;
  }
  const playerId = meta.playerId;
  const pairing = lobby.getPairingForPlayer(playerId);
  const newStatus = pairing ? 'playing' : (msg.available ? 'waiting' : 'busy');
  const opponentAlias = pairing
    ? aliasForPlayer(pairing.playerA_id === playerId ? pairing.playerB_id : pairing.playerA_id)
    : undefined;
  logTracker('set_status', { player_id: playerId, available: msg.available, status: newStatus });
  lobby.setPlayerStatus(playerId, newStatus, opponentAlias);
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
  const sessionId = msg.session_id;
  const alias = sessionId ? knownAliases.get(sessionId) ?? null : null;
  logTrackerVerbose('get_alias', { ws_id: wsId(ws), session_id: sessionId ?? null, found: alias !== null });
  sendWs(ws, 'alias_result', { alias });
}

function onSetAlias(ws: WebSocket, msg: Extract<LobbyInboundMessage, { type: 'set_alias' }>): void {
  const sessionId = msg.session_id ?? wsLobbyMeta.get(ws)?.sessionId;
  if (!sessionId) return;
  const playerId = sessionToPlayer.get(sessionId);
  logTracker('set_alias', { ws_id: wsId(ws), session_id: sessionId, player_id: playerId ?? null, alias: msg.alias });
  knownAliases.set(sessionId, msg.alias);
  const player = playerId ? lobby.players[playerId] : undefined;
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
        onLobbyJoin(ws, parsed);
        break;
      }
      case 'leave':
        onLobbyLeave(ws, parsed);
        break;
      case 'challenge':
        onChallenge(ws, parsed);
        break;
      case 'challenge_accept':
        onChallengeAccept(ws, parsed);
        break;
      case 'challenge_decline':
        onChallengeDecline(ws, parsed);
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
      case 'chat':
        onGameChat(ws, parsed);
        break;
      case 'close':
        onGameClose(ws, parsed);
        break;
      case 'set_status':
        onSetStatus(ws, parsed);
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
      forgetSession(sessionId);
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
    pending_lobby_leaves: pendingLobbyLeaves.size,
    session_to_player: sessionToPlayer.size,
    player_to_session: playerToSession.size,
  });
}, 15_000);

const port = process.env.PORT || 5801;
// Keep HTTP downloads reusable briefly, then close idle sockets by timeout.
// WebSocket upgrades are long-lived and are not closed by this HTTP keep-alive timeout.
httpServer.keepAliveTimeout = 5_000;
httpServer.headersTimeout = 6_000;
httpServer.listen({ host: '::', port }, () => {
  console.log(`Server running on port ${port}`);
});
