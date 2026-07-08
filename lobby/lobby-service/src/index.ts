import { createServer } from 'http';
import crypto from 'node:crypto';

import cors from 'cors';
import express from 'express';
import minimist from 'minimist';
import {
  decode as decodeBencodex,
  encode as encodeBencodex,
  getBoolean,
  getText,
  isDictionary,
  type BencodexKey,
  type BencodexValue,
} from 'chia-gaming-bencodex';
import { WebSocketServer, WebSocket, type RawData } from 'ws';

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
  | { type: 'challenge'; from_id?: string; target_id: string; challenger_amount: string; target_amount: string; channel_timeout?: string; unroll_timeout?: string }
  | { type: 'challenge_accept'; challenge_id: string; accepter_id?: string }
  | { type: 'challenge_decline'; challenge_id: string }
  | { type: 'challenge_cancel'; from_id?: string }
  | { type: 'change_alias'; id?: string; newAlias: string }
  | { type: 'get_alias'; id?: string; session_id?: string }
  | { type: 'set_alias'; id?: string; session_id?: string; alias: string }
  | { type: 'keepalive' };

type GameInboundMessage =
  | { type: 'identify'; session_id: string; busy?: boolean; alias?: string }
  | { type: 'send'; to: string }
  | { type: 'close'; session_id: string }
  | { type: 'set_busy'; session_id: string; busy: boolean; alias?: string }
  | { type: 'keepalive' };

interface LobbyConnMeta {
  playerId: string;
  sessionId: string;
}

interface GameConnMeta {
  sessionId: string;
  playerId: string;
  busy?: boolean;
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
const gameConnections = new Map<string, WebSocket>();
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

app.use(
  cors({
    origin: '*',
    methods: ['GET', 'POST', 'HEAD', 'OPTIONS'],
  }),
);

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

function definedBencodexFields(payload: unknown): Record<string, BencodexValue> {
  const out: Record<string, BencodexValue> = {};
  if (!payload || typeof payload !== 'object') return out;
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (value === undefined) continue;
    if (
      value === null ||
      typeof value === 'boolean' ||
      typeof value === 'bigint' ||
      typeof value === 'string' ||
      value instanceof Uint8Array
    ) {
      out[key] = value;
      continue;
    }
    if (typeof value === 'number' && Number.isSafeInteger(value)) {
      out[key] = BigInt(value);
      continue;
    }
    throw new Error(`unsupported bencodex payload field ${key}`);
  }
  return out;
}

function sendGameWs(ws: WebSocket, type: string, payload: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) {
    logTracker('send_game_ws_drop_not_open', { ws_id: wsId(ws), type, ready_state: ws.readyState });
    return;
  }
  ws.send(encodeBencodex({ type, ...definedBencodexFields(payload) }));
  logTrackerVerbose('send_game_ws_ok', { ws_id: wsId(ws), type });
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
  const liveAlias = lobby.players[playerId]?.alias;
  if (liveAlias) return liveAlias;
  const sessionId = playerToSession.get(playerId);
  return sessionId ? knownAliases.get(sessionId) ?? playerId : playerId;
}

function rememberGameAlias(sessionId: string, playerId: string, alias: string | undefined): void {
  if (!alias) return;
  knownAliases.set(sessionId, alias);
  const player = lobby.players[playerId];
  if (player) {
    player.alias = alias;
  }
}

function replayPendingChallengesToPlayer(playerId: string): void {
  for (const challenge of lobby.challenges.values()) {
    if (challenge.target_id !== playerId) continue;
    const fromAlias = aliasForPlayer(challenge.from_id);
    sendLobbyEvent(playerId, 'challenge_received', {
      challenge_id: challenge.id,
      from_id: challenge.from_id,
      from_alias: fromAlias,
      challenger_amount: challenge.challenger_amount,
      target_amount: challenge.target_amount,
      channel_timeout: challenge.channel_timeout,
      unroll_timeout: challenge.unroll_timeout,
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
  sendGameWs(ws, type, payload);
}

function sendGameBinary(playerId: string, data: Buffer): boolean {
  const sessionId = playerToSession.get(playerId);
  if (!sessionId) return false;
  const ws = gameConnections.get(sessionId);
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(data);
  return true;
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

function applyPlayerBusy(playerId: string, busy: boolean): void {
  const status = busy ? 'busy' : 'waiting';
  lobby.setPlayerStatus(playerId, status);
  if (busy) {
    cancelPlayerChallenges(playerId);
  }
}

// --- Lobby channel handlers ---

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

  // If the game channel was already identified, apply busy status
  const gameWs = gameConnections.get(session_id);
  if (gameWs) {
    const meta = wsGameMeta.get(gameWs);
    if (meta) meta.playerId = playerId;
    if (meta?.busy !== undefined) {
      applyPlayerBusy(playerId, meta.busy);
      broadcastLobbyUpdate();
    }
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

const MAX_AMOUNT_MOJOS = 1_000_000_000_000_000_000n; // 1,000,000 XCH — sanity cap, not a business limit

function validateAmount(raw: string | undefined): string | null {
  if (!raw || !/^[1-9][0-9]{0,18}$/.test(raw)) return 'Invalid amount: must be a positive integer.';
  if (BigInt(raw) > MAX_AMOUNT_MOJOS) return 'Amount exceeds sanity limit.';
  return null;
}

const MIN_TIMEOUT_BLOCKS = 3;
const MAX_TIMEOUT_BLOCKS = 30;

function validateTimeout(raw: string | undefined, label: string): string | null {
  if (raw === undefined) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < MIN_TIMEOUT_BLOCKS || n > MAX_TIMEOUT_BLOCKS) {
    return `${label} must be an integer between ${MIN_TIMEOUT_BLOCKS} and ${MAX_TIMEOUT_BLOCKS}.`;
  }
  return null;
}

function onChallenge(ws: WebSocket, msg: Extract<LobbyInboundMessage, { type: 'challenge' }>): void {
  const senderId = getLobbySenderId(ws);
  const { target_id, challenger_amount, target_amount } = msg;
  logTracker('challenge_received', {
    ws_id: wsId(ws),
    sender_id: senderId ?? null,
    target_id,
    challenger_amount: challenger_amount ?? '100',
    target_amount: target_amount ?? '100',
  });
  const fromPlayer = senderId ? lobby.players[senderId] : undefined;
  if (!fromPlayer) {
    logTracker('challenge_drop_unknown_sender', { sender_id: senderId ?? null, target_id });
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

  const challengerErr = validateAmount(challenger_amount);
  if (challengerErr) {
    sendWs(ws, 'error', { error: challengerErr });
    sendWs(ws, 'challenge_resolved', { challenge_id: null, accepted: false });
    return;
  }
  const targetErr = validateAmount(target_amount);
  if (targetErr) {
    sendWs(ws, 'error', { error: targetErr });
    sendWs(ws, 'challenge_resolved', { challenge_id: null, accepted: false });
    return;
  }

  const channelTimeoutErr = validateTimeout(msg.channel_timeout, 'Channel timeout');
  if (channelTimeoutErr) {
    sendWs(ws, 'error', { error: channelTimeoutErr });
    sendWs(ws, 'challenge_resolved', { challenge_id: null, accepted: false });
    return;
  }
  const unrollTimeoutErr = validateTimeout(msg.unroll_timeout, 'Unroll timeout');
  if (unrollTimeoutErr) {
    sendWs(ws, 'error', { error: unrollTimeoutErr });
    sendWs(ws, 'challenge_resolved', { challenge_id: null, accepted: false });
    return;
  }

  const challenge = lobby.createChallenge(
    fromPlayer.id,
    target_id,
    challenger_amount,
    target_amount,
    msg.channel_timeout,
    msg.unroll_timeout,
  );

  sendLobbyEvent(target_id, 'challenge_received', {
    challenge_id: challenge.id,
    from_id: fromPlayer.id,
    from_alias: fromPlayer.alias,
    challenger_amount: challenge.challenger_amount,
    target_amount: challenge.target_amount,
    channel_timeout: challenge.channel_timeout,
    unroll_timeout: challenge.unroll_timeout,
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
  // The clients are authoritative for busy state. The tracker only cleans up
  // challenge records it knows are now stale.
  cancelPlayerChallenges(challenge.target_id);
  cancelPlayerChallenges(challenge.from_id);
  broadcastLobbyUpdate();
  logTracker('challenge_accepted_advisory', {
    challenge_id,
    initiator_id: challenge.from_id,
    target_id: challenge.target_id,
    challenger_amount: challenge.challenger_amount,
    target_amount: challenge.target_amount,
  });

  const challengerAlias = lobby.players[challenge.from_id]?.alias ?? challenge.from_id;

  // Notify the lobby of the challenger that the challenge was accepted
  sendLobbyEvent(challenge.from_id, 'challenge_resolved', {
    challenge_id,
    accepted: true,
  });

  // Send advisory_start to the ACCEPTER (target) who becomes the initiator.
  // Map to the accepter's perspective: my_amount = target_amount, their_amount = challenger_amount.
  const advisoryPayload: Record<string, unknown> = {
    peer_id: challenge.from_id,
    peer_alias: challengerAlias,
    my_amount: challenge.target_amount,
    their_amount: challenge.challenger_amount,
  };
  if (challenge.channel_timeout) advisoryPayload.channel_timeout = challenge.channel_timeout;
  if (challenge.unroll_timeout) advisoryPayload.unroll_timeout = challenge.unroll_timeout;
  sendGameEvent(challenge.target_id, 'advisory_start', advisoryPayload);
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

function onChallengeCancel(ws: WebSocket, _msg: Extract<LobbyInboundMessage, { type: 'challenge_cancel' }>): void {
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

// --- Game channel handlers ---

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
  wsGameMeta.set(ws, { sessionId: msg.session_id, playerId, busy: msg.busy });
  gameConnections.set(msg.session_id, ws);
  rememberGameAlias(msg.session_id, playerId, msg.alias);

  // Apply busy status if lobby player exists
  if (msg.busy !== undefined && lobby.players[playerId]) {
    applyPlayerBusy(playerId, msg.busy);
    broadcastLobbyUpdate();
  }

  sendGameWs(ws, 'registered', { player_id: playerId });
  logTracker('identify_registered', { ws_id: wsId(ws), session_id: msg.session_id, player_id: playerId });
}

function onGameSend(ws: WebSocket, msg: Extract<GameInboundMessage, { type: 'send' }>, rawPayload: Buffer | null): void {
  const meta = wsGameMeta.get(ws);
  if (!meta?.playerId) {
    logTracker('game_send_drop_no_player', { ws_id: wsId(ws) });
    return;
  }
  const targetId = msg.to;
  const targetSessionId = playerToSession.get(targetId);
  const targetWs = targetSessionId ? gameConnections.get(targetSessionId) : undefined;

  if (!targetWs || targetWs.readyState !== WebSocket.OPEN) {
    logTracker('game_send_delivery_failure', { from: meta.playerId, to: targetId });
    sendGameWs(ws, 'delivery_failure', { to: targetId });
    return;
  }

  const fromAlias = aliasForPlayer(meta.playerId);

  if (rawPayload) {
    // Binary payload: [4B from_id_len BE][from_id][4B from_alias_len BE][from_alias][payload]
    const fromIdBuf = Buffer.from(meta.playerId, 'utf8');
    const fromAliasBuf = Buffer.from(fromAlias, 'utf8');
    const header = Buffer.alloc(4 + fromIdBuf.byteLength + 4 + fromAliasBuf.byteLength);
    let off = 0;
    header.writeUInt32BE(fromIdBuf.byteLength, off); off += 4;
    fromIdBuf.copy(header, off); off += fromIdBuf.byteLength;
    header.writeUInt32BE(fromAliasBuf.byteLength, off); off += 4;
    fromAliasBuf.copy(header, off);
    const frame = Buffer.concat([header, rawPayload]);
    targetWs.send(frame);
    logTrackerVerbose('game_relay_binary', { from: meta.playerId, to: targetId, payload_bytes: rawPayload.byteLength });
  } else {
    logTrackerVerbose('game_relay_json_noop', { from: meta.playerId, to: targetId });
  }
}

function onGameBinarySend(ws: WebSocket, targetId: string, payload: Buffer): void {
  const meta = wsGameMeta.get(ws);
  if (!meta?.playerId) {
    logTracker('game_binary_send_drop_no_player', { ws_id: wsId(ws) });
    return;
  }

  const targetSessionId = playerToSession.get(targetId);
  const targetWs = targetSessionId ? gameConnections.get(targetSessionId) : undefined;

  if (!targetWs || targetWs.readyState !== WebSocket.OPEN) {
    logTracker('game_binary_delivery_failure', { from: meta.playerId, to: targetId });
    sendGameWs(ws, 'delivery_failure', { to: targetId });
    return;
  }

  // Relay binary: [4B from_id_len BE][from_id][4B from_alias_len BE][from_alias][payload]
  const fromIdBuf = Buffer.from(meta.playerId, 'utf8');
  const fromAlias = lobby.players[meta.playerId]?.alias ?? meta.playerId;
  const fromAliasBuf = Buffer.from(fromAlias, 'utf8');
  const header = Buffer.alloc(4 + fromIdBuf.byteLength + 4 + fromAliasBuf.byteLength);
  let offset = 0;
  header.writeUInt32BE(fromIdBuf.byteLength, offset); offset += 4;
  fromIdBuf.copy(header, offset); offset += fromIdBuf.byteLength;
  header.writeUInt32BE(fromAliasBuf.byteLength, offset); offset += 4;
  fromAliasBuf.copy(header, offset);
  const frame = Buffer.concat([header, payload]);
  targetWs.send(frame);
  logTrackerVerbose('game_relay_binary', { from: meta.playerId, to: targetId, payload_bytes: payload.byteLength });
}

function onGameClose(ws: WebSocket, msg: Extract<GameInboundMessage, { type: 'close' }>): void {
  const meta = wsGameMeta.get(ws);
  if (!meta) {
    logTracker('game_close_drop_unknown_session', { session_id: msg.session_id });
    return;
  }
  const playerId = meta.playerId;
  logTracker('game_close', { player_id: playerId, session_id: msg.session_id });
  sendGameEvent(playerId, 'closed', {});
}

function onSetBusy(ws: WebSocket, msg: Extract<GameInboundMessage, { type: 'set_busy' }>): void {
  const meta = wsGameMeta.get(ws);
  if (!meta) {
    logTracker('set_busy_drop_unknown_session', { session_id: msg.session_id });
    return;
  }
  const playerId = meta.playerId;
  rememberGameAlias(meta.sessionId, playerId, msg.alias);
  meta.busy = msg.busy;
  logTracker('set_busy', { player_id: playerId, busy: msg.busy });
  applyPlayerBusy(playerId, msg.busy);
  broadcastLobbyUpdate();
}

// --- Message parsing ---

function parseLobbyInbound(raw: string): LobbyInboundMessage | null {
  try {
    const parsed = JSON.parse(raw) as LobbyInboundMessage;
    if (!parsed || typeof parsed !== 'object' || !('type' in parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function rawDataToBuffer(message: RawData): Buffer {
  if (Buffer.isBuffer(message)) return message;
  if (Array.isArray(message)) return Buffer.concat(message);
  return Buffer.from(message);
}

function optionalText(map: Map<BencodexKey, BencodexValue>, key: string): string | undefined {
  const value = map.get(key);
  return typeof value === 'string' ? value : undefined;
}

function requireText(map: Map<BencodexKey, BencodexValue>, key: string): string {
  const value = optionalText(map, key);
  if (value === undefined) throw new Error(`missing text field: ${key}`);
  return value;
}

function parseGameInbound(raw: Buffer): GameInboundMessage | null {
  try {
    const decoded = decodeBencodex(raw);
    if (!isDictionary(decoded)) return null;
    const type = getText(decoded, 'type');
    if (!type) return null;
    switch (type) {
      case 'identify':
        return {
          type,
          session_id: requireText(decoded, 'session_id'),
          busy: getBoolean(decoded, 'busy'),
          alias: optionalText(decoded, 'alias'),
        };
      case 'send':
        return { type, to: requireText(decoded, 'to') };
      case 'set_busy': {
        const busy = getBoolean(decoded, 'busy');
        if (busy === undefined) return null;
        return {
          type,
          session_id: requireText(decoded, 'session_id'),
          busy,
          alias: optionalText(decoded, 'alias'),
        };
      }
      case 'close':
        return { type, session_id: requireText(decoded, 'session_id') };
      case 'keepalive':
        return { type };
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function setupLobbyKeepalive(ws: WebSocket): void {
  const kaTimer = setInterval(() => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'keepalive' }));
    }
  }, 15_000);
  wsKeepaliveTimers.set(ws, kaTimer);
}

function setupGameKeepalive(ws: WebSocket): void {
  const kaTimer = setInterval(() => {
    if (ws.readyState === ws.OPEN) {
      sendGameWs(ws, 'keepalive', {});
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

// --- Lobby WebSocket server ---

lobbyWsServer.on('connection', (ws) => {
  const currentWsId = wsId(ws);
  wsLastActivity.set(ws, Date.now());
  logTracker('lobby_ws_connected', { ws_id: currentWsId });
  setupLobbyKeepalive(ws);

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
      case 'join':
        onLobbyJoin(ws, parsed);
        break;
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

// --- Game WebSocket server ---

// Binary frame format for addressed messaging:
// Outbound (client -> tracker): [4-byte target_id_len BE][target_id UTF-8][payload]
// Inbound (tracker -> client):  [4B from_id_len BE][from_id][4B from_alias_len BE][from_alias][payload]

gameWsServer.on('connection', (ws) => {
  const currentWsId = wsId(ws);
  wsLastActivity.set(ws, Date.now());
  logTracker('game_ws_connected', { ws_id: currentWsId });
  setupGameKeepalive(ws);

  ws.on('message', (message, isBinary) => {
    wsLastActivity.set(ws, Date.now());
    const buf = rawDataToBuffer(message);

    if (isBinary && buf[0] !== 0x64) {
      // Binary frame: addressed message to another peer
      if (buf.byteLength < 4) {
        logTracker('game_binary_too_short', { ws_id: currentWsId, bytes: buf.byteLength });
        return;
      }
      const targetIdLen = buf.readUInt32BE(0);
      if (buf.byteLength < 4 + targetIdLen) {
        logTracker('game_binary_header_incomplete', { ws_id: currentWsId, bytes: buf.byteLength, target_id_len: targetIdLen });
        return;
      }
      const targetId = buf.slice(4, 4 + targetIdLen).toString('utf8');
      const payload = buf.slice(4 + targetIdLen);
      onGameBinarySend(ws, targetId, payload);
      return;
    }

    if (!isBinary) {
      const text = typeof message === 'string' ? message : message.toString();
      logTracker('game_ws_text_frame_drop', { ws_id: currentWsId, bytes: text.length });
      return;
    }

    const parsed = parseGameInbound(buf);
    if (!parsed) {
      logTracker('game_ws_message_parse_drop', { ws_id: currentWsId, bytes: buf.byteLength });
      return;
    }
    logTrackerVerbose('game_ws_message', { ws_id: currentWsId, type: parsed.type, bytes: buf.byteLength });

    switch (parsed.type) {
      case 'identify':
        onIdentify(ws, parsed);
        break;
      case 'send':
        onGameSend(ws, parsed, null);
        break;
      case 'close':
        onGameClose(ws, parsed);
        break;
      case 'set_busy':
        onSetBusy(ws, parsed);
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

// --- Sweep / liveness ---

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
  }
}

setInterval(() => {
  const now = Date.now();
  const lobbyChanged = sweepLobbyConnections(now);
  sweepGameConnections(now);
  if (lobbyChanged) {
    broadcastLobbyUpdate();
  }
  logTrackerVerbose('state_snapshot', {
    players: Object.keys(lobby.players).length,
    challenges: lobby.challenges.size,
    lobby_connections: lobbyConnections.size,
    game_connections: gameConnections.size,
    pending_lobby_leaves: pendingLobbyLeaves.size,
    session_to_player: sessionToPlayer.size,
    player_to_session: playerToSession.size,
  });
}, 15_000);

const port = process.env.PORT || 5801;
httpServer.keepAliveTimeout = 5_000;
httpServer.headersTimeout = 6_000;
httpServer.listen({ host: '::', port }, () => {
  console.log(`Server running on port ${port}`);
});
