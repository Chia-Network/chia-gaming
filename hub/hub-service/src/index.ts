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

import { Hub } from './hubState';

const hub = new Hub();
const app = express();
const httpServer = createServer(app);

function parseArgs() {
  const args = minimist(process.argv.slice(2), { boolean: ['verbose'], alias: { verbose: 'v' } });
  if (!args.self) {
    console.warn('usage: hub --self [own-url] --dir [serve-directory] [--verbose]');
    process.exit(1);
  }
  return args;
}

const args = parseArgs();
const verbose = Boolean(args.verbose);

type HubInboundMessage =
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

interface HubConnMeta {
  playerId: string;
  sessionId: string;
}

interface GameConnMeta {
  sessionId: string;
  playerId: string;
  busy?: boolean;
}

const HUB_DISCONNECT_GRACE_MS = 3000;
const CONNECTION_TTL_MS = 60_000;
const hubWsServer = new WebSocketServer({ noServer: true });
const gameWsServer = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url!, `http://${req.headers.host}`).pathname;
  if (pathname === '/ws/hub') {
    hubWsServer.handleUpgrade(req, socket, head, (ws) => {
      hubWsServer.emit('connection', ws, req);
    });
  } else if (pathname === '/ws/game') {
    gameWsServer.handleUpgrade(req, socket, head, (ws) => {
      gameWsServer.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

const hubConnections = new Map<string, WebSocket>();
const gameConnections = new Map<string, WebSocket>();
const wsHubMeta = new WeakMap<WebSocket, HubConnMeta>();
const wsGameMeta = new WeakMap<WebSocket, GameConnMeta>();

const pendingHubLeaves = new Map<string, ReturnType<typeof setTimeout>>();
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

function logHub(event: string, fields?: Record<string, unknown>): void {
  const payload = fields ? ` ${JSON.stringify(fields)}` : '';
  console.log(`[hub] ${new Date().toISOString()} ${event}${payload}`);
}

function logHubVerbose(event: string, fields?: Record<string, unknown>): void {
  if (!verbose) return;
  logHub(event, fields);
}

function randomPublicId(): string {
  let id: string;
  do {
    id = `p_${crypto.randomBytes(16).toString('hex')}`;
  } while (hub.players[id] || playerToSession.has(id));
  return id;
}

function ensureSession(sessionId: string): string {
  const existing = sessionToPlayer.get(sessionId);
  if (existing) return existing;
  // Mapping is intentionally retained for the hub process lifetime —
  // disconnect / leaveHub must not mint a new public id for the same secret.
  const playerId = randomPublicId();
  sessionToPlayer.set(sessionId, playerId);
  playerToSession.set(playerId, sessionId);
  logHub('session_created', { player_id: playerId, session_id: sessionId });
  return playerId;
}

app.use(
  cors({
    origin: '*',
    methods: ['GET', 'POST', 'HEAD', 'OPTIONS'],
  }),
);

app.use((req, res, next) => {
  // Nonce /app/* URLs change every rebuild; only root shell/meta are stable.
  const p = req.path;
  let cc: string;
  if (p.startsWith('/app/')) {
    cc = 'public, max-age=31536000, immutable';
  } else if (p === '/build-meta.json') {
    cc = 'no-store';
  } else if (p === '/' || p === '/index.html' || p.endsWith('.html')) {
    cc = 'no-cache';
  } else {
    cc = 'public, max-age=86400';
  }
  res.set('Cache-Control', cc);
  next();
});

app.use(express.json());
if (args.dir) {
  app.use(express.static(args.dir));
}

function sendWs(ws: WebSocket, type: string, payload: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) {
    logHub('send_ws_drop_not_open', { ws_id: wsId(ws), type, ready_state: ws.readyState });
    return;
  }
  ws.send(JSON.stringify({ type, ...((payload as Record<string, unknown>) ?? {}) }));
  logHubVerbose('send_ws_ok', { ws_id: wsId(ws), type });
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
    logHub('send_game_ws_drop_not_open', { ws_id: wsId(ws), type, ready_state: ws.readyState });
    return;
  }
  ws.send(encodeBencodex({ type, ...definedBencodexFields(payload) }));
  logHubVerbose('send_game_ws_ok', { ws_id: wsId(ws), type });
}

function sendHubEvent(playerId: string, type: string, payload: unknown): void {
  const ws = hubConnections.get(playerId);
  if (!ws) {
    logHub('send_hub_event_drop_missing_ws', { player_id: playerId, type });
    return;
  }
  logHubVerbose('send_hub_event', { player_id: playerId, ws_id: wsId(ws), type });
  sendWs(ws, type, payload);
}

function aliasForPlayer(playerId: string): string {
  const liveAlias = hub.players[playerId]?.alias;
  if (liveAlias) return liveAlias;
  const sessionId = playerToSession.get(playerId);
  return sessionId ? knownAliases.get(sessionId) ?? playerId : playerId;
}

function rememberGameAlias(sessionId: string, playerId: string, alias: string | undefined): void {
  if (!alias) return;
  // Hub set_alias / join / change_alias own the display name. Game-channel
  // identify/set_busy may carry a generated prefs fallback (Player_*) and must
  // not clobber a name the user already chose in the hub.
  if (knownAliases.has(sessionId)) return;
  knownAliases.set(sessionId, alias);
  const player = hub.players[playerId];
  if (player) {
    player.alias = alias;
  }
}

function replayPendingChallengesToPlayer(playerId: string): void {
  for (const challenge of hub.challenges.values()) {
    if (challenge.target_id !== playerId) continue;
    const fromAlias = aliasForPlayer(challenge.from_id);
    sendHubEvent(playerId, 'challenge_received', {
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
    logHub('send_game_event_drop_missing_session', { player_id: playerId, type });
    return;
  }
  const ws = gameConnections.get(sessionId);
  if (!ws) {
    logHub('send_game_event_drop_missing_ws', { player_id: playerId, session_id: sessionId, type });
    return;
  }
  logHubVerbose('send_game_event', { player_id: playerId, session_id: sessionId, ws_id: wsId(ws), type });
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

function broadcastHubUpdate(): void {
  const players = hub.getPlayers();
  for (const [playerId] of hubConnections) {
    sendHubEvent(playerId, 'hub_update', { players });
  }
}

function cancelPendingHubLeave(playerId: string): void {
  const timer = pendingHubLeaves.get(playerId);
  if (timer) {
    clearTimeout(timer);
    pendingHubLeaves.delete(playerId);
  }
}

function leaveHub(playerId: string): boolean {
  if (hub.removePlayer(playerId)) {
    broadcastHubUpdate();
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
  for (const [id, challenge] of hub.challenges) {
    if (challenge.from_id === playerId || challenge.target_id === playerId) {
      toCancel.push(id);
    }
  }
  for (const id of toCancel) {
    const challenge = hub.getChallenge(id);
    if (!challenge) continue;
    const otherId = challenge.from_id === playerId ? challenge.target_id : challenge.from_id;
    hub.removeChallenge(id);
    sendHubEvent(otherId, 'challenge_resolved', { challenge_id: id, accepted: false });
    logHub('challenge_cancelled_on_sweep', { challenge_id: id, swept_player: playerId, notified_player: otherId });
  }
}

function applyPlayerBusy(playerId: string, busy: boolean): void {
  const status = busy ? 'busy' : 'waiting';
  // Not in hub yet: busy is held on game meta and applied on join.
  if (!hub.setPlayerStatus(playerId, status)) {
    return;
  }
  if (busy) {
    cancelPlayerChallenges(playerId);
  }
}

// --- Hub channel handlers ---

function onHubJoin(ws: WebSocket, msg: Extract<HubInboundMessage, { type: 'join' }>): void {
  const { alias, session_id } = msg;
  logHub('hub_join', { ws_id: wsId(ws), session_id: session_id ?? null, alias: alias ?? null });
  if (!session_id) {
    sendWs(ws, 'error', { error: 'Missing hub session.' });
    return;
  }

  const playerId = ensureSession(session_id);
  const resolvedAlias = alias || knownAliases.get(session_id) || playerId;

  wsHubMeta.set(ws, { playerId, sessionId: session_id });
  cancelPendingHubLeave(playerId);
  const previous = hubConnections.get(playerId);
  if (previous && previous !== ws) {
    try { previous.close(4001, 'replaced_by_new_connection'); } catch {}
  }
  hubConnections.set(playerId, ws);

  if (!hub.players[playerId]) {
    hub.addPlayer({
      id: playerId,
      alias: resolvedAlias,
      status: 'waiting',
    });
  } else {
    hub.players[playerId].alias = resolvedAlias;
  }
  knownAliases.set(session_id, resolvedAlias);
  sendWs(ws, 'joined', { id: playerId, alias: resolvedAlias });
  broadcastHubUpdate();
  replayPendingChallengesToPlayer(playerId);

  // If the game channel was already identified, apply busy status
  const gameWs = gameConnections.get(session_id);
  if (gameWs) {
    const meta = wsGameMeta.get(gameWs);
    if (meta) meta.playerId = playerId;
    if (meta?.busy !== undefined) {
      applyPlayerBusy(playerId, meta.busy);
      broadcastHubUpdate();
    }
  }
}

function onHubLeave(ws: WebSocket, _msg: Extract<HubInboundMessage, { type: 'leave' }>): void {
  const playerId = getHubSenderId(ws);
  if (!playerId) return;
  logHub('hub_leave', { player_id: playerId });
  cancelPendingHubLeave(playerId);
  leaveHub(playerId);
}

function getHubSenderId(ws: WebSocket): string | undefined {
  return wsHubMeta.get(ws)?.playerId;
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

function onChallenge(ws: WebSocket, msg: Extract<HubInboundMessage, { type: 'challenge' }>): void {
  const senderId = getHubSenderId(ws);
  const { target_id, challenger_amount, target_amount } = msg;
  logHub('challenge_received', {
    ws_id: wsId(ws),
    sender_id: senderId ?? null,
    target_id,
    challenger_amount: challenger_amount ?? '100',
    target_amount: target_amount ?? '100',
  });
  const fromPlayer = senderId ? hub.players[senderId] : undefined;
  if (!fromPlayer) {
    logHub('challenge_drop_unknown_sender', { sender_id: senderId ?? null, target_id });
    sendWs(ws, 'error', { error: 'Unknown challenger. Rejoin hub and retry.' });
    sendWs(ws, 'challenge_resolved', { challenge_id: null, accepted: false });
    return;
  }
  const targetPlayer = hub.players[target_id];
  if (!targetPlayer) {
    logHub('challenge_drop_unknown_target', { sender_id: senderId, target_id });
    sendWs(ws, 'error', { error: 'Unknown target.' });
    sendWs(ws, 'challenge_resolved', { challenge_id: null, accepted: false });
    return;
  }
  if (!hasActiveGameConnection(target_id)) {
    logHub('challenge_drop_target_no_game_conn', { sender_id: senderId, target_id });
    sendWs(ws, 'error', { error: 'Peer is not connected.' });
    sendWs(ws, 'challenge_resolved', { challenge_id: null, accepted: false });
    return;
  }
  if (fromPlayer.status !== 'waiting') {
    logHub('challenge_drop_sender_unavailable', { sender_id: senderId, target_id, status: fromPlayer.status });
    sendWs(ws, 'error', { error: 'You are in an active session. Finish it first.' });
    sendWs(ws, 'challenge_resolved', { challenge_id: null, accepted: false });
    return;
  }
  if (targetPlayer.status !== 'waiting') {
    logHub('challenge_drop_target_unavailable', { sender_id: senderId, target_id, status: targetPlayer.status });
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

  const MIN_TIMEOUT_BLOCKS = 3;
  const MAX_TIMEOUT_BLOCKS = 30;
  for (const field of ['channel_timeout', 'unroll_timeout'] as const) {
    const raw = msg[field];
    if (raw !== undefined) {
      const val = Number(raw);
      if (!Number.isInteger(val) || val < MIN_TIMEOUT_BLOCKS || val > MAX_TIMEOUT_BLOCKS) {
        sendWs(ws, 'error', { error: `Invalid ${field}: must be an integer between ${MIN_TIMEOUT_BLOCKS} and ${MAX_TIMEOUT_BLOCKS}.` });
        sendWs(ws, 'challenge_resolved', { challenge_id: null, accepted: false });
        return;
      }
    }
  }

  const challenge = hub.createChallenge(
    fromPlayer.id,
    target_id,
    challenger_amount,
    target_amount,
    msg.channel_timeout,
    msg.unroll_timeout,
  );

  sendHubEvent(target_id, 'challenge_received', {
    challenge_id: challenge.id,
    from_id: fromPlayer.id,
    from_alias: fromPlayer.alias,
    challenger_amount: challenge.challenger_amount,
    target_amount: challenge.target_amount,
    channel_timeout: challenge.channel_timeout,
    unroll_timeout: challenge.unroll_timeout,
  });
  sendGameEvent(target_id, 'hub_attention', {});
}

function onChallengeAccept(ws: WebSocket, msg: Extract<HubInboundMessage, { type: 'challenge_accept' }>): void {
  const accepter_id = getHubSenderId(ws);
  const { challenge_id } = msg;
  const challenge = hub.getChallenge(challenge_id);
  if (!challenge || !accepter_id || accepter_id !== challenge.target_id) {
    logHub('challenge_accept_drop_invalid_accepter', {
      ws_id: wsId(ws),
      challenge_id,
      accepter_id: accepter_id ?? null,
      expected_target_id: challenge?.target_id ?? null,
    });
    sendWs(ws, 'error', { error: 'Invalid or unknown challenge accept.' });
    sendWs(ws, 'challenge_resolved', { challenge_id: challenge_id ?? null, accepted: false });
    return;
  }
  const challenger = hub.players[challenge.from_id];
  const accepter = hub.players[challenge.target_id];
  if (challenger?.status !== 'waiting' || accepter?.status !== 'waiting') {
    logHub('challenge_accept_drop_player_unavailable', {
      challenge_id,
      challenger_status: challenger?.status ?? null,
      accepter_status: accepter?.status ?? null,
    });
    hub.removeChallenge(challenge_id);
    sendWs(ws, 'error', { error: 'One or both players are no longer available.' });
    sendWs(ws, 'challenge_resolved', { challenge_id, accepted: false });
    sendHubEvent(challenge.from_id, 'challenge_resolved', { challenge_id, accepted: false });
    return;
  }
  if (!hasActiveGameConnection(challenge.from_id) || !hasActiveGameConnection(accepter_id)) {
    logHub('challenge_accept_drop_missing_game_conn', {
      challenge_id,
      challenger_connected: hasActiveGameConnection(challenge.from_id),
      accepter_connected: hasActiveGameConnection(accepter_id),
    });
    hub.removeChallenge(challenge_id);
    const errorMsg = 'Game connection not available for both players.';
    sendWs(ws, 'error', { error: errorMsg });
    sendWs(ws, 'challenge_resolved', { challenge_id, accepted: false });
    sendHubEvent(challenge.from_id, 'error', { error: errorMsg });
    sendHubEvent(challenge.from_id, 'challenge_resolved', { challenge_id, accepted: false });
    return;
  }

  hub.removeChallenge(challenge_id);
  // The clients are authoritative for busy state. The hub only cleans up
  // challenge records it knows are now stale.
  cancelPlayerChallenges(challenge.target_id);
  cancelPlayerChallenges(challenge.from_id);
  broadcastHubUpdate();
  logHub('challenge_accepted_advisory', {
    challenge_id,
    initiator_id: challenge.from_id,
    target_id: challenge.target_id,
    challenger_amount: challenge.challenger_amount,
    target_amount: challenge.target_amount,
  });

  const challengerAlias = hub.players[challenge.from_id]?.alias ?? challenge.from_id;

  // Notify both hub sides that the challenge was accepted.
  sendHubEvent(challenge.from_id, 'challenge_resolved', {
    challenge_id,
    accepted: true,
  });
  sendWs(ws, 'challenge_resolved', {
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

function onChallengeDecline(ws: WebSocket, msg: Extract<HubInboundMessage, { type: 'challenge_decline' }>): void {
  const playerId = getHubSenderId(ws);
  const challenge = hub.getChallenge(msg.challenge_id);
  if (!challenge || !playerId || challenge.target_id !== playerId) {
    logHub('challenge_decline_drop_missing', { challenge_id: msg.challenge_id });
    return;
  }
  logHub('challenge_declined', {
    challenge_id: msg.challenge_id,
    challenger_id: challenge.from_id,
    target_id: challenge.target_id,
  });
  hub.removeChallenge(msg.challenge_id);
  sendHubEvent(challenge.from_id, 'challenge_resolved', {
    challenge_id: msg.challenge_id,
    accepted: false,
  });
  sendWs(ws, 'challenge_resolved', {
    challenge_id: msg.challenge_id,
    accepted: false,
  });
}

function onChallengeCancel(ws: WebSocket, _msg: Extract<HubInboundMessage, { type: 'challenge_cancel' }>): void {
  const senderId = getHubSenderId(ws);
  if (!senderId) return;
  const toCancel: string[] = [];
  for (const [id, challenge] of hub.challenges) {
    if (challenge.from_id === senderId) {
      toCancel.push(id);
    }
  }
  if (toCancel.length === 0) return;
  for (const id of toCancel) {
    const challenge = hub.getChallenge(id);
    if (!challenge) continue;
    logHub('challenge_cancelled', { challenge_id: id, challenger_id: senderId, target_id: challenge.target_id });
    hub.removeChallenge(id);
    sendHubEvent(challenge.target_id, 'challenge_resolved', { challenge_id: id, accepted: false });
  }
  sendWs(ws, 'challenge_resolved', { challenge_id: null, accepted: false });
}

function onChangeAlias(ws: WebSocket, msg: Extract<HubInboundMessage, { type: 'change_alias' }>): void {
  const meta = wsHubMeta.get(ws);
  if (!meta) return;
  const playerId = meta.playerId;
  logHub('alias_change', { ws_id: wsId(ws), player_id: playerId, new_alias: msg.newAlias });
  knownAliases.set(meta.sessionId, msg.newAlias);
  const player = hub.players[playerId];
  if (player) {
    player.alias = msg.newAlias;
    broadcastHubUpdate();
  }
}

function onGetAlias(ws: WebSocket, msg: Extract<HubInboundMessage, { type: 'get_alias' }>): void {
  const sessionId = msg.session_id;
  const alias = sessionId ? knownAliases.get(sessionId) ?? null : null;
  logHubVerbose('get_alias', { ws_id: wsId(ws), session_id: sessionId ?? null, found: alias !== null });
  sendWs(ws, 'alias_result', { alias });
}

function onSetAlias(ws: WebSocket, msg: Extract<HubInboundMessage, { type: 'set_alias' }>): void {
  const sessionId = msg.session_id ?? wsHubMeta.get(ws)?.sessionId;
  if (!sessionId) return;
  const playerId = sessionToPlayer.get(sessionId);
  logHub('set_alias', { ws_id: wsId(ws), session_id: sessionId, player_id: playerId ?? null, alias: msg.alias });
  knownAliases.set(sessionId, msg.alias);
  const player = playerId ? hub.players[playerId] : undefined;
  if (player) {
    player.alias = msg.alias;
    broadcastHubUpdate();
  }
  sendWs(ws, 'alias_result', { alias: msg.alias });
}

// --- Game channel handlers ---

function onIdentify(ws: WebSocket, msg: Extract<GameInboundMessage, { type: 'identify' }>): void {
  const playerId = ensureSession(msg.session_id);
  logHub('identify', {
    ws_id: wsId(ws),
    session_id: msg.session_id,
    player_id: playerId,
  });
  const previousGameConn = gameConnections.get(msg.session_id);
  if (previousGameConn && previousGameConn !== ws) {
    logHub('game_connection_replaced', { ws_id: wsId(previousGameConn), session_id: msg.session_id });
    try { previousGameConn.close(4001, 'replaced_by_new_connection'); } catch {}
  }
  wsGameMeta.set(ws, { sessionId: msg.session_id, playerId, busy: msg.busy });
  gameConnections.set(msg.session_id, ws);
  rememberGameAlias(msg.session_id, playerId, msg.alias);

  // Apply busy status if hub player exists
  if (msg.busy !== undefined && hub.players[playerId]) {
    applyPlayerBusy(playerId, msg.busy);
    broadcastHubUpdate();
  }

  sendGameWs(ws, 'registered', { player_id: playerId });
  logHub('identify_registered', { ws_id: wsId(ws), session_id: msg.session_id, player_id: playerId });
}

function onGameSend(ws: WebSocket, msg: Extract<GameInboundMessage, { type: 'send' }>, rawPayload: Buffer | null): void {
  const meta = wsGameMeta.get(ws);
  if (!meta?.playerId) {
    logHub('game_send_drop_no_player', { ws_id: wsId(ws) });
    return;
  }
  const targetId = msg.to;
  const targetSessionId = playerToSession.get(targetId);
  const targetWs = targetSessionId ? gameConnections.get(targetSessionId) : undefined;

  if (!targetWs || targetWs.readyState !== WebSocket.OPEN) {
    // Includes unknown peer ids and known peers with no live game socket.
    // Pre-game-session clients cancel; live sessions treat this as peer hard-disconnect.
    logHub('game_send_delivery_failure', {
      from: meta.playerId,
      to: targetId,
      reason: targetSessionId ? 'peer_offline' : 'unknown_peer',
    });
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
    logHubVerbose('game_relay_binary', { from: meta.playerId, to: targetId, payload_bytes: rawPayload.byteLength });
  } else {
    logHubVerbose('game_relay_json_noop', { from: meta.playerId, to: targetId });
  }
}

function onGameBinarySend(ws: WebSocket, targetId: string, payload: Buffer): void {
  const meta = wsGameMeta.get(ws);
  if (!meta?.playerId) {
    logHub('game_binary_send_drop_no_player', { ws_id: wsId(ws) });
    return;
  }

  const targetSessionId = playerToSession.get(targetId);
  const targetWs = targetSessionId ? gameConnections.get(targetSessionId) : undefined;

  if (!targetWs || targetWs.readyState !== WebSocket.OPEN) {
    logHub('game_binary_delivery_failure', {
      from: meta.playerId,
      to: targetId,
      reason: targetSessionId ? 'peer_offline' : 'unknown_peer',
    });
    sendGameWs(ws, 'delivery_failure', { to: targetId });
    return;
  }

  // Relay binary: [4B from_id_len BE][from_id][4B from_alias_len BE][from_alias][payload]
  const fromIdBuf = Buffer.from(meta.playerId, 'utf8');
  const fromAlias = hub.players[meta.playerId]?.alias ?? meta.playerId;
  const fromAliasBuf = Buffer.from(fromAlias, 'utf8');
  const header = Buffer.alloc(4 + fromIdBuf.byteLength + 4 + fromAliasBuf.byteLength);
  let offset = 0;
  header.writeUInt32BE(fromIdBuf.byteLength, offset); offset += 4;
  fromIdBuf.copy(header, offset); offset += fromIdBuf.byteLength;
  header.writeUInt32BE(fromAliasBuf.byteLength, offset); offset += 4;
  fromAliasBuf.copy(header, offset);
  const frame = Buffer.concat([header, payload]);
  targetWs.send(frame);
  logHubVerbose('game_relay_binary', { from: meta.playerId, to: targetId, payload_bytes: payload.byteLength });
}

function onGameClose(ws: WebSocket, msg: Extract<GameInboundMessage, { type: 'close' }>): void {
  const meta = wsGameMeta.get(ws);
  if (!meta) {
    logHub('game_close_drop_unknown_session', { session_id: msg.session_id });
    return;
  }
  const playerId = meta.playerId;
  logHub('game_close', { player_id: playerId, session_id: msg.session_id });
  sendGameEvent(playerId, 'closed', {});
}

function onSetBusy(ws: WebSocket, msg: Extract<GameInboundMessage, { type: 'set_busy' }>): void {
  const meta = wsGameMeta.get(ws);
  if (!meta) {
    logHub('set_busy_drop_unknown_session', { session_id: msg.session_id });
    return;
  }
  const playerId = meta.playerId;
  rememberGameAlias(meta.sessionId, playerId, msg.alias);
  meta.busy = msg.busy;
  logHub('set_busy', { player_id: playerId, busy: msg.busy });
  applyPlayerBusy(playerId, msg.busy);
  broadcastHubUpdate();
}

// --- Message parsing ---

function parseHubInbound(raw: string): HubInboundMessage | null {
  try {
    const parsed = JSON.parse(raw) as HubInboundMessage;
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

function setupHubKeepalive(ws: WebSocket): void {
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

// --- Hub WebSocket server ---

hubWsServer.on('connection', (ws) => {
  const currentWsId = wsId(ws);
  wsLastActivity.set(ws, Date.now());
  logHub('hub_ws_connected', { ws_id: currentWsId });
  setupHubKeepalive(ws);

  ws.on('message', (message) => {
    wsLastActivity.set(ws, Date.now());
    const text = typeof message === 'string' ? message : message.toString();
    const parsed = parseHubInbound(text);
    if (!parsed) {
      logHub('hub_ws_message_parse_drop', { ws_id: currentWsId, bytes: text.length });
      return;
    }
    logHubVerbose('hub_ws_message', { ws_id: currentWsId, type: parsed.type, bytes: text.length });

    switch (parsed.type) {
      case 'join':
        onHubJoin(ws, parsed);
        break;
      case 'leave':
        onHubLeave(ws, parsed);
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
    logHub('hub_ws_error', { ws_id: currentWsId, error: err.message });
  });

  ws.on('close', (code, reason) => {
    clearKeepalive(ws);
    logHub('hub_ws_closed', { ws_id: currentWsId, code, reason: reason.toString() });
    const hubMeta = wsHubMeta.get(ws);
    if (hubMeta) {
      const playerId = hubMeta.playerId;
      if (hubConnections.get(playerId) === ws) {
        hubConnections.delete(playerId);
      }
      cancelPendingHubLeave(playerId);
      const timer = setTimeout(() => {
        pendingHubLeaves.delete(playerId);
        if (!hubConnections.has(playerId)) {
          logHub('hub_grace_timeout_leave', { player_id: playerId });
          leaveHub(playerId);
        }
      }, HUB_DISCONNECT_GRACE_MS);
      pendingHubLeaves.set(playerId, timer);
    }
  });
});

// --- Game WebSocket server ---

// Binary frame format for addressed messaging:
// Outbound (client -> hub): [4-byte target_id_len BE][target_id UTF-8][payload]
// Inbound (hub -> client):  [4B from_id_len BE][from_id][4B from_alias_len BE][from_alias][payload]

gameWsServer.on('connection', (ws) => {
  const currentWsId = wsId(ws);
  wsLastActivity.set(ws, Date.now());
  logHub('game_ws_connected', { ws_id: currentWsId });
  setupGameKeepalive(ws);

  ws.on('message', (message, isBinary) => {
    wsLastActivity.set(ws, Date.now());
    const buf = rawDataToBuffer(message);

    if (isBinary && buf[0] !== 0x64) {
      // Binary frame: addressed message to another peer
      if (buf.byteLength < 4) {
        logHub('game_binary_too_short', { ws_id: currentWsId, bytes: buf.byteLength });
        return;
      }
      const targetIdLen = buf.readUInt32BE(0);
      if (buf.byteLength < 4 + targetIdLen) {
        logHub('game_binary_header_incomplete', { ws_id: currentWsId, bytes: buf.byteLength, target_id_len: targetIdLen });
        return;
      }
      const targetId = buf.slice(4, 4 + targetIdLen).toString('utf8');
      const payload = buf.slice(4 + targetIdLen);
      onGameBinarySend(ws, targetId, payload);
      return;
    }

    if (!isBinary) {
      const text = typeof message === 'string' ? message : message.toString();
      logHub('game_ws_text_frame_drop', { ws_id: currentWsId, bytes: text.length });
      return;
    }

    const parsed = parseGameInbound(buf);
    if (!parsed) {
      logHub('game_ws_message_parse_drop', { ws_id: currentWsId, bytes: buf.byteLength });
      return;
    }
    logHubVerbose('game_ws_message', { ws_id: currentWsId, type: parsed.type, bytes: buf.byteLength });

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
    logHub('game_ws_error', { ws_id: currentWsId, error: err.message });
  });

  ws.on('close', (code, reason) => {
    clearKeepalive(ws);
    logHub('game_ws_closed', { ws_id: currentWsId, code, reason: reason.toString() });
    const gameMeta = wsGameMeta.get(ws);
    if (gameMeta) {
      const { sessionId } = gameMeta;
      if (gameConnections.get(sessionId) === ws) {
        gameConnections.delete(sessionId);
        logHub('game_connection_removed_on_close', { ws_id: currentWsId, session_id: sessionId });
      }
    }
  });
});

// --- Sweep / liveness ---

function sweepHubConnections(now: number): boolean {
  let changed = false;
  const expired: string[] = [];
  for (const [playerId, ws] of hubConnections) {
    const lastSeen = wsLastActivity.get(ws) ?? 0;
    if (now - lastSeen > CONNECTION_TTL_MS) {
      expired.push(playerId);
    }
  }
  for (const playerId of expired) {
    const ws = hubConnections.get(playerId);
    if (ws) {
      logHub('hub_sweep_expired', { player_id: playerId, ws_id: wsId(ws) });
      try { ws.close(4002, 'idle_timeout'); } catch {}
    }
    hubConnections.delete(playerId);
    cancelPendingHubLeave(playerId);
    cancelPlayerChallenges(playerId);
    if (hub.removePlayer(playerId)) {
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
    logHub('game_sweep_expired', { session_id: sessionId, player_id: playerId ?? null, ws_id: ws ? wsId(ws) : null });
    if (ws) {
      try { ws.close(4002, 'idle_timeout'); } catch {}
    }
    gameConnections.delete(sessionId);
  }
}

const sweepTimer = setInterval(() => {
  const now = Date.now();
  const hubChanged = sweepHubConnections(now);
  sweepGameConnections(now);
  if (hubChanged) {
    broadcastHubUpdate();
  }
  logHubVerbose('state_snapshot', {
    players: Object.keys(hub.players).length,
    challenges: hub.challenges.size,
    hub_connections: hubConnections.size,
    game_connections: gameConnections.size,
    pending_hub_leaves: pendingHubLeaves.size,
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

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; shutting down`);
  clearInterval(sweepTimer);

  for (const ws of [...hubWsServer.clients, ...gameWsServer.clients]) {
    try { ws.close(1001, 'server_shutdown'); } catch {}
  }

  let pendingClosures = 3;
  const deadline = setTimeout(() => {
    for (const ws of [...hubWsServer.clients, ...gameWsServer.clients]) {
      try { ws.terminate(); } catch {}
    }
    httpServer.closeAllConnections?.();
    process.exit();
  }, 5_000);
  const closed = (err?: Error): void => {
    if (err) {
      console.error(`Shutdown failed: ${err.message}`);
      process.exitCode = 1;
    }
    pendingClosures -= 1;
    if (pendingClosures === 0) {
      clearTimeout(deadline);
    }
  };

  hubWsServer.close(closed);
  gameWsServer.close(closed);
  httpServer.close(closed);
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
