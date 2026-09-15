import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { test } from 'node:test';

import bencodex from 'chia-gaming-bencodex';
import { WebSocket } from 'ws';

const { decode: decodeBencodex, encode: encodeBencodex, isDictionary } = bencodex;

function sessionKey(label) {
  return /^[0-9a-f]{32}$/.test(label)
    ? label
    : crypto.createHash('sha256').update(label).digest('hex').slice(0, 32);
}

function sessionBytes(label) {
  return Buffer.from(sessionKey(label), 'hex');
}

function playerBytes(playerId) {
  assert.match(playerId, /^p_[0-9a-f]{32}$/);
  return Buffer.from(playerId.slice(2), 'hex');
}

function playerId(bytes) {
  assert.equal(bytes.byteLength, 16);
  return `p_${Buffer.from(bytes).toString('hex')}`;
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function startHub(env = {}) {
  const port = await getFreePort();
  const dir = mkdtempSync(path.join(tmpdir(), 'hub-behavior-'));
  const child = spawn(
    process.execPath,
    ['dist/index-rollup.cjs', '--self', `http://127.0.0.1:${port}`, '--dir', dir],
    {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: {
        ...process.env,
        PORT: String(port),
        HUB_MAX_TOTAL_CONNECTIONS: '2000',
        HUB_MAX_CONNECTIONS_PER_IP: '8',
        HUB_MAX_PLAYERS: '1000',
        HUB_MAX_RETAINED_SESSIONS: '10000',
        HUB_RETAINED_SESSION_TTL_MS: '86400000',
        HUB_MAX_CONNECTION_ATTEMPTS_PER_WINDOW: '100',
        HUB_TRUST_PROXY: '0',
        HUB_RATE_WINDOW_MS: '10000',
        HUB_MAX_MESSAGES_PER_WINDOW: '100',
        HUB_MAX_BYTES_PER_WINDOW: '1000000',
        HUB_CONTROL_MAX_WS_PAYLOAD_BYTES: '65536',
        GAME_MAX_WS_PAYLOAD_BYTES: '11534336',
        GAME_MAX_MESSAGES_PER_WINDOW: '1000',
        GAME_MAX_BYTES_PER_WINDOW: '11534336',
        GAME_MAX_OUTBOUND_BYTES_PER_CONNECTION: '23068672',
        GAME_MAX_TOTAL_OUTBOUND_BYTES: '268435456',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`hub did not start:\n${output}`));
    }, 5_000);
    const onData = (chunk) => {
      output += chunk.toString();
      if (output.includes(`Server running on port ${port}`)) {
        clearTimeout(timer);
        resolve(undefined);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`hub exited with ${code}:\n${output}`));
    });
  });
  return {
    origin: `http://127.0.0.1:${port}`,
    stop: async () => {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    },
  };
}

async function openWs(origin, pathName, options) {
  const ws = new WebSocket(`${origin.replace(/^http/, 'ws')}${pathName}`, options);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out connecting ${pathName}`)), 2_000);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    ws.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  return ws;
}

function sendJson(ws, payload) {
  ws.send(JSON.stringify(payload));
}

function compactGameInbound(payload) {
  switch (payload.type) {
    case 'identify':
      return { t: 'I', si: payload.session_id, b: payload.busy };
    case 'set_busy':
      return { t: 'SB', b: payload.busy };
    case 'relay':
      return { t: 'R', to: payload.to, p: payload.payload };
    case 'close':
      return { t: 'C' };
    case 'keepalive':
      return { t: 'K' };
    default:
      throw new Error(`unsupported test game message: ${String(payload.type)}`);
  }
}

function sendGame(ws, payload) {
  ws.send(encodeBencodex(compactGameInbound(payload)));
}

function sendRawGame(ws, payload) {
  ws.send(encodeBencodex(payload));
}

function plainBencodex(value) {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return value.map(plainBencodex);
  if (isDictionary(value)) {
    const out = {};
    for (const [key, item] of value.entries()) {
      out[typeof key === 'string' ? key : Buffer.from(key).toString('utf8')] = plainBencodex(item);
    }
    return out;
  }
  return value;
}

function descriptiveGameOutbound(raw) {
  const wire = plainBencodex(decodeBencodex(raw));
  switch (wire.t) {
    case 'R':
      return { type: 'relay', from: wire.f, alias: wire.a, payload: wire.p };
    case 'K':
      return { type: 'keepalive' };
    case 'RG':
      return { type: 'registered', player_id: wire.pi };
    case 'AS':
      return {
        type: 'advisory_start',
        peer_id: wire.pi,
        peer_alias: wire.pa,
        my_amount: wire.ma,
        their_amount: wire.ta,
        channel_timeout: wire.ct,
        unroll_timeout: wire.ut,
      };
    case 'DF':
      return { type: 'delivery_failure', to: wire.to };
    case 'AU':
      return { type: 'alias_updated', alias: wire.a };
    case 'PA':
      return { type: 'peer_available', player_id: wire.pi };
    case 'PU':
      return { type: 'peer_unavailable', player_id: wire.pi };
    case 'HA':
      return { type: 'hub_attention' };
    case 'CD':
      return { type: 'closed' };
    default:
      return null;
  }
}

function assertCompactFixedWireText(value) {
  if (value instanceof Uint8Array || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach(assertCompactFixedWireText);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    assert.ok(Buffer.byteLength(key, 'utf8') <= 2, `wire key ${key} exceeds two bytes`);
    if (key === 't') {
      assert.equal(typeof item, 'string');
      assert.ok(Buffer.byteLength(item, 'utf8') <= 2, `wire tag ${item} exceeds two bytes`);
    }
    assertCompactFixedWireText(item);
  }
}

async function nextJson(ws, predicate = () => true, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error('timed out waiting for websocket message'));
    }, timeoutMs);
    function onMessage(raw) {
      const text = typeof raw === 'string' ? raw : raw.toString();
      const msg = JSON.parse(text);
      if (!predicate(msg)) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve(msg);
    }
    ws.on('message', onMessage);
  });
}

async function nextGame(ws, predicate = () => true, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error('timed out waiting for websocket message'));
    }, timeoutMs);
    function onMessage(raw) {
      const msg = descriptiveGameOutbound(raw);
      if (!msg) return;
      if (!predicate(msg)) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve(msg);
    }
    ws.on('message', onMessage);
  });
}

async function nextRawMessage(ws, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error('timed out waiting for websocket message'));
    }, timeoutMs);
    function onMessage(raw) {
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve(Buffer.from(raw));
    }
    ws.on('message', onMessage);
  });
}

async function closeWs(ws) {
  if (ws.readyState === WebSocket.CLOSED) return;
  ws.close();
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 500);
    ws.once('close', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
  });
}

async function nextClose(ws) {
  return new Promise((resolve) => {
    ws.once('close', (code, reason) => {
      resolve({ code, reason: reason.toString() });
    });
  });
}

async function joinHub(origin, sessionId, alias, extra = {}) {
  const ws = await openWs(origin, '/ws/hub');
  sendJson(ws, { type: 'join', session_id: sessionKey(sessionId), alias, ...extra });
  const joined = await nextJson(ws, (msg) => msg.type === 'joined');
  return { ws, id: joined.id };
}

async function identifyGame(origin, sessionId) {
  const game = await openWs(origin, '/ws/game');
  sendGame(game, { type: 'identify', session_id: sessionBytes(sessionId), busy: false });
  await nextGame(game, (msg) => msg.type === 'registered');
  return game;
}

async function identifyGameRegistered(origin, sessionId) {
  const game = await openWs(origin, '/ws/game');
  sendGame(game, { type: 'identify', session_id: sessionBytes(sessionId), busy: false });
  const registered = await nextGame(game, (msg) => msg.type === 'registered');
  return { game, playerId: playerId(registered.player_id) };
}

test('HTTP responses prohibit referrer disclosure', async () => {
  const hub = await startHub();
  try {
    const response = await fetch(hub.origin);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  } finally {
    await hub.stop();
  }
});

test('malformed upgrade Host cannot kill the hub', async () => {
  const hub = await startHub();
  try {
    const malformedHost = await openWs(hub.origin, '/ws/hub', { headers: { Host: '[' } });
    await closeWs(malformedHost);
    const valid = await openWs(hub.origin, '/ws/hub');
    await closeWs(valid);
  } finally {
    await hub.stop();
  }
});

test('hub-owned aliases update the game channel and cannot be set there', async () => {
  const hub = await startHub();
  try {
    const sessionId = 'secret-alias-clobber';
    const game = await identifyGame(hub.origin, sessionId);
    const aliasUpdated = nextGame(game, (msg) => msg.type === 'alias_updated');
    const { ws } = await joinHub(hub.origin, sessionId, 'Alice');
    assert.equal((await aliasUpdated).alias, 'Alice');
    const aliasChanged = nextGame(game, (msg) => msg.type === 'alias_updated');
    sendJson(ws, { type: 'change_alias', newAlias: 'Alice Two' });
    assert.equal((await aliasChanged).alias, 'Alice Two');

    sendGame(game, {
      type: 'set_busy',
      busy: false,
      alias: 'Player_deadbeef',
    });

    const aliasProbe = await openWs(hub.origin, '/ws/hub');
    sendJson(aliasProbe, { type: 'get_alias', session_id: sessionKey(sessionId) });
    const aliasResult = await nextJson(aliasProbe, (msg) => msg.type === 'alias_result');
    assert.equal(aliasResult.alias, 'Alice Two');

    await closeWs(ws);
    await closeWs(game);
    await closeWs(aliasProbe);
  } finally {
    await hub.stop();
  }
});

test('post-identification game controls use the bound socket session', async () => {
  const hub = await startHub();
  try {
    const game = await identifyGame(hub.origin, 'secret-bound-controls');
    const closed = nextGame(game, (msg) => msg.type === 'closed');

    sendGame(game, { type: 'keepalive' });
    sendGame(game, { type: 'set_busy', busy: true });
    sendGame(game, { type: 'close' });

    assert.equal((await closed).type, 'closed');
    await closeWs(game);
  } finally {
    await hub.stop();
  }
});

test('one game socket cannot identify more than one player', async () => {
  const hub = await startHub();
  try {
    const game = await identifyGame(hub.origin, 'single-game-socket-first-player');
    const closed = nextClose(game);
    sendGame(game, {
      type: 'identify',
      session_id: sessionBytes('single-game-socket-second-player'),
      busy: false,
    });
    assert.deepEqual(await closed, { code: 4003, reason: 'already_identified' });
  } finally {
    await hub.stop();
  }
});

test('game boundary accepts and emits byte-exact compact golden vectors', async () => {
  const hub = await startHub();
  try {
    const game = await openWs(hub.origin, '/ws/game');
    const session = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
    const identify = Buffer.concat([
      Buffer.from('du1:bfu2:si16:'),
      session,
      Buffer.from('u1:tu1:Ie'),
    ]);
    game.send(identify);
    await nextGame(game, (msg) => msg.type === 'registered');

    const closedRaw = nextRawMessage(game);
    sendGame(game, { type: 'close' });
    assert.deepEqual(await closedRaw, Buffer.from('du1:tu2:CDe'));
    await closeWs(game);
  } finally {
    await hub.stop();
  }
});

test('game boundary rejects old verbose discriminator and tags', async () => {
  const hub = await startHub();
  try {
    const game = await openWs(hub.origin, '/ws/game');
    const noVerboseRegistration = nextGame(game, (msg) => msg.type === 'registered', 100);
    sendRawGame(game, {
      type: 'identify',
      session_id: sessionBytes('old-discriminator'),
      busy: false,
    });
    sendRawGame(game, { t: 'identify', si: sessionBytes('old-tag'), b: false });
    await assert.rejects(noVerboseRegistration, /timed out/);

    sendGame(game, {
      type: 'identify',
      session_id: sessionBytes('compact-after-old'),
      busy: false,
    });
    await nextGame(game, (msg) => msg.type === 'registered');
    await closeWs(game);
  } finally {
    await hub.stop();
  }
});

test('every fixed game-wire key and tag is at most two UTF-8 bytes', () => {
  const id = Buffer.alloc(16);
  const frames = [
    compactGameInbound({ type: 'identify', session_id: id, busy: false }),
    compactGameInbound({ type: 'set_busy', busy: true }),
    compactGameInbound({ type: 'relay', to: id, payload: Buffer.from('x') }),
    compactGameInbound({ type: 'close' }),
    compactGameInbound({ type: 'keepalive' }),
    { t: 'R', f: id, a: 'Alias', p: Buffer.from('x') },
    { t: 'K' },
    { t: 'RG', pi: id },
    { t: 'AS', pi: id, pa: 'Alias', ma: 1n, ta: 2n, ct: 3n, ut: 4n },
    { t: 'DF', to: id },
    { t: 'AU', a: 'Alias' },
    { t: 'PA', pi: id },
    { t: 'PU', pi: id },
    { t: 'HA' },
    { t: 'CD' },
  ];
  frames.forEach(assertCompactFixedWireText);
});

test('hub emits the compact game keepalive semantically', async () => {
  const hub = await startHub();
  try {
    const game = await openWs(hub.origin, '/ws/game');
    assert.equal(
      (await nextGame(game, (msg) => msg.type === 'keepalive', 16_000)).type,
      'keepalive',
    );
    await closeWs(game);
  } finally {
    await hub.stop();
  }
});

test('game messages reject text and wrong-width binary identifiers', async () => {
  const hub = await startHub();
  try {
    const game = await openWs(hub.origin, '/ws/game');
    const invalidRegistration = nextGame(game, (msg) => msg.type === 'registered', 100);
    sendGame(game, { type: 'identify', session_id: 'not-bytes', busy: false });
    await assert.rejects(invalidRegistration, /timed out/);

    sendGame(game, {
      type: 'identify',
      session_id: sessionBytes('valid-after-invalid'),
      busy: false,
    });
    await nextGame(game, (msg) => msg.type === 'registered');

    const receiver = await identifyGameRegistered(hub.origin, 'malformed-relay-receiver');
    const invalidRelay = nextGame(receiver.game, (msg) => msg.type === 'relay', 100);
    sendGame(game, { type: 'relay', to: Buffer.alloc(15), payload: Buffer.from('no') });
    await assert.rejects(invalidRelay, /timed out/);

    await closeWs(game);
    await closeWs(receiver.game);
  } finally {
    await hub.stop();
  }
});

test('hub messages reject session ids that are not exactly 16-byte hex', async () => {
  const hub = await startHub();
  try {
    const ws = await openWs(hub.origin, '/ws/hub');
    for (const sessionId of ['a'.repeat(31), 'g'.repeat(32), 'a'.repeat(34)]) {
      const errorPromise = nextJson(ws, (msg) => msg.type === 'error');
      sendJson(ws, { type: 'join', session_id: sessionId, alias: 'Alice' });
      assert.match((await errorPromise).error, /invalid hub session/i);
    }

    const joinedPromise = nextJson(ws, (msg) => msg.type === 'joined');
    sendJson(ws, {
      type: 'join',
      session_id: sessionKey('valid-after-invalid-hub-sessions'),
      alias: 'Alice',
    });
    await joinedPromise;
    await closeWs(ws);
  } finally {
    await hub.stop();
  }
});

test('public hub updates never include the secret nonce', async () => {
  const hub = await startHub();
  try {
    const secret = 'secret-nonce-public-update-test';
    const sessionId = sessionKey(secret);
    const ws = await openWs(hub.origin, '/ws/hub');
    const joinedPromise = nextJson(ws, (msg) => msg.type === 'joined');
    const updatePromise = nextJson(ws, (msg) => msg.type === 'hub_update');
    sendJson(ws, { type: 'join', session_id: sessionId, alias: 'Alice' });
    const [{ id }, update] = await Promise.all([joinedPromise, updatePromise]);
    assert.equal(JSON.stringify(update).includes(sessionId), false);
    assert.equal(
      update.players.some((player) => player.id === id),
      true,
    );
    assert.equal(
      update.players.some((player) => 'session_id' in player),
      false,
    );
    await closeWs(ws);
  } finally {
    await hub.stop();
  }
});

test('a different nonce cannot claim another public hub id', async () => {
  const hub = await startHub();
  try {
    const alice = await joinHub(hub.origin, 'secret-alice', 'Alice');
    const bob = await joinHub(hub.origin, 'secret-bob', 'Bob', { id: alice.id });
    assert.notEqual(bob.id, alice.id);
    assert.equal(alice.ws.readyState, WebSocket.OPEN);
    await closeWs(alice.ws);
    await closeWs(bob.ws);
  } finally {
    await hub.stop();
  }
});

test('the same nonce reconnect intentionally replaces the old hub socket', async () => {
  const hub = await startHub();
  try {
    const first = await joinHub(hub.origin, 'secret-reconnect', 'Alice');
    const closed = new Promise((resolve) => first.ws.once('close', (code) => resolve(code)));
    const second = await joinHub(hub.origin, 'secret-reconnect', 'Alice Reloaded');
    assert.equal(second.id, first.id);
    assert.equal(await closed, 4001);
    await closeWs(second.ws);
  } finally {
    await hub.stop();
  }
});

test('challenge authority and availability come from bound sessions', async () => {
  const hub = await startHub();
  try {
    const alice = await joinHub(hub.origin, 'secret-alice-match', 'Alice');
    const bob = await joinHub(hub.origin, 'secret-bob-match', 'Bob');
    const carol = await joinHub(hub.origin, 'secret-carol-match', 'Carol');
    const aliceGame = await identifyGame(hub.origin, 'secret-alice-match');
    const bobGame = await identifyGame(hub.origin, 'secret-bob-match');
    const carolGame = await identifyGame(hub.origin, 'secret-carol-match');

    sendJson(alice.ws, {
      type: 'challenge',
      target_id: bob.id,
      challenger_amount: '100',
      target_amount: '100',
    });
    const challenge = await nextJson(bob.ws, (msg) => msg.type === 'challenge_received');

    // Carol cannot accept Bob's challenge (she's not the target)
    sendJson(carol.ws, {
      type: 'challenge_accept',
      challenge_id: challenge.challenge_id,
      accepter_id: bob.id,
    });
    await assert.rejects(
      nextGame(bobGame, (msg) => msg.type === 'advisory_start', 250),
      /timed out/,
    );

    // Bob accepts — Bob (accepter/initiator) gets advisory_start
    const bobAdvisory = nextGame(bobGame, (msg) => msg.type === 'advisory_start');
    sendJson(bob.ws, { type: 'challenge_accept', challenge_id: challenge.challenge_id });
    const advisory = await bobAdvisory;
    assert.deepEqual(advisory.peer_id, playerBytes(alice.id));
    assert.equal(advisory.my_amount, 100n);
    assert.equal(advisory.their_amount, 100n);

    // Bob's client sets busy (simulating what the frontend does on advisory_start)
    sendGame(bobGame, { type: 'set_busy', busy: true });
    // Wait for hub update to propagate
    await nextJson(carol.ws, (msg) => msg.type === 'hub_update');

    // Carol cannot challenge Bob (he's now busy)
    const carolError = nextJson(carol.ws, (msg) => msg.type === 'error');
    const carolResolved = nextJson(carol.ws, (msg) => msg.type === 'challenge_resolved');
    sendJson(carol.ws, {
      type: 'challenge',
      target_id: bob.id,
      challenger_amount: '100',
      target_amount: '100',
    });
    const error = await carolError;
    assert.match(error.error, /active session/);
    const resolved = await carolResolved;
    assert.equal(resolved.accepted, false);

    await closeWs(alice.ws);
    await closeWs(bob.ws);
    await closeWs(carol.ws);
    await closeWs(aliceGame);
    await closeWs(bobGame);
    await closeWs(carolGame);
  } finally {
    await hub.stop();
  }
});

test('leaving the hub atomically cancels challenges and notifies counterparts', async () => {
  const hub = await startHub();
  try {
    const alice = await joinHub(hub.origin, 'retire-challenge-alice', 'Alice');
    const bob = await joinHub(hub.origin, 'retire-challenge-bob', 'Bob');
    const aliceGame = await identifyGame(hub.origin, 'retire-challenge-alice');
    const bobGame = await identifyGame(hub.origin, 'retire-challenge-bob');

    sendJson(alice.ws, {
      type: 'challenge',
      target_id: bob.id,
      challenger_amount: '100',
      target_amount: '100',
    });
    const challenge = await nextJson(bob.ws, (msg) => msg.type === 'challenge_received');
    const resolved = nextJson(
      bob.ws,
      (msg) => msg.type === 'challenge_resolved' && msg.challenge_id === challenge.challenge_id,
    );

    sendJson(alice.ws, { type: 'leave' });
    assert.equal((await resolved).accepted, false);

    await closeWs(alice.ws);
    await closeWs(bob.ws);
    await closeWs(aliceGame);
    await closeWs(bobGame);
  } finally {
    await hub.stop();
  }
});

test('asymmetric buy-in amounts are perspective-corrected in advisory_start', async () => {
  const hub = await startHub();
  try {
    const alice = await joinHub(hub.origin, 'secret-alice-asym', 'Alice');
    const bob = await joinHub(hub.origin, 'secret-bob-asym', 'Bob');
    const aliceGame = await identifyGame(hub.origin, 'secret-alice-asym');
    const bobGame = await identifyGame(hub.origin, 'secret-bob-asym');

    // Alice challenges Bob with asymmetric amounts
    sendJson(alice.ws, {
      type: 'challenge',
      target_id: bob.id,
      challenger_amount: '200',
      target_amount: '50',
    });
    const challenge = await nextJson(bob.ws, (msg) => msg.type === 'challenge_received');
    assert.equal(challenge.challenger_amount, '200');
    assert.equal(challenge.target_amount, '50');

    // Bob accepts — advisory_start should be from Bob's perspective
    const bobAdvisory = nextGame(bobGame, (msg) => msg.type === 'advisory_start');
    sendJson(bob.ws, { type: 'challenge_accept', challenge_id: challenge.challenge_id });
    const advisory = await bobAdvisory;
    assert.deepEqual(advisory.peer_id, playerBytes(alice.id));
    assert.equal(advisory.my_amount, 50n);
    assert.equal(advisory.their_amount, 200n);

    await closeWs(alice.ws);
    await closeWs(bob.ws);
    await closeWs(aliceGame);
    await closeWs(bobGame);
  } finally {
    await hub.stop();
  }
});

test('challenges with out-of-range timeouts are rejected by the server', async () => {
  const hub = await startHub();
  try {
    const alice = await joinHub(hub.origin, 'secret-alice-timeout', 'Alice');
    const bob = await joinHub(hub.origin, 'secret-bob-timeout', 'Bob');
    const aliceGame = await identifyGame(hub.origin, 'secret-alice-timeout');
    const bobGame = await identifyGame(hub.origin, 'secret-bob-timeout');

    // channel_timeout too low (below min of 3)
    const errPromise1 = nextJson(alice.ws, (msg) => msg.type === 'error');
    const resolvedPromise1 = nextJson(alice.ws, (msg) => msg.type === 'challenge_resolved');
    sendJson(alice.ws, {
      type: 'challenge',
      target_id: bob.id,
      challenger_amount: '100',
      target_amount: '100',
      channel_timeout: '1',
    });
    const err1 = await errPromise1;
    assert.match(err1.error, /Channel timeout/);
    await resolvedPromise1;

    for (const [field, value] of [
      ['channel_timeout', '3.0'],
      ['channel_timeout', '1e1'],
      ['unroll_timeout', '30.0'],
    ]) {
      const errPromise = nextJson(alice.ws, (msg) => msg.type === 'error');
      const resolvedPromise = nextJson(alice.ws, (msg) => msg.type === 'challenge_resolved');
      sendJson(alice.ws, {
        type: 'challenge',
        target_id: bob.id,
        challenger_amount: '100',
        target_amount: '100',
        [field]: value,
      });
      const err = await errPromise;
      assert.match(err.error, /timeout/i);
      await resolvedPromise;
    }

    // channel_timeout too high (above max of 30)
    const errPromise2 = nextJson(alice.ws, (msg) => msg.type === 'error');
    const resolvedPromise2 = nextJson(alice.ws, (msg) => msg.type === 'challenge_resolved');
    const noBobChallenge = assert.rejects(
      nextJson(bob.ws, (msg) => msg.type === 'challenge_received', 250),
      /timed out/,
    );
    sendJson(alice.ws, {
      type: 'challenge',
      target_id: bob.id,
      challenger_amount: '100',
      target_amount: '100',
      channel_timeout: '83',
      unroll_timeout: '15',
    });
    const err2 = await errPromise2;
    assert.match(err2.error, /Channel timeout/);
    await resolvedPromise2;
    await noBobChallenge;

    // Valid timeouts at the max should succeed
    sendJson(alice.ws, {
      type: 'challenge',
      target_id: bob.id,
      challenger_amount: '100',
      target_amount: '100',
      channel_timeout: '30',
      unroll_timeout: '30',
    });
    const challenge = await nextJson(bob.ws, (msg) => msg.type === 'challenge_received');
    assert.equal(challenge.channel_timeout, '30');
    assert.equal(challenge.unroll_timeout, '30');

    await closeWs(alice.ws);
    await closeWs(bob.ws);
    await closeWs(aliceGame);
    await closeWs(bobGame);
  } finally {
    await hub.stop();
  }
});

test('same secret session_id keeps the same player_id across game disconnect', async () => {
  const hub = await startHub();
  try {
    const sessionId = 'secret-stable-across-disconnect';
    const first = await identifyGameRegistered(hub.origin, sessionId);
    await closeWs(first.game);

    const second = await identifyGameRegistered(hub.origin, sessionId);
    assert.equal(second.playerId, first.playerId);
    await closeWs(second.game);
  } finally {
    await hub.stop();
  }
});

test('same secret session_id keeps the same player_id across hub leave and rejoin', async () => {
  const hub = await startHub();
  try {
    const sessionId = 'secret-stable-hub-rejoin';
    const first = await joinHub(hub.origin, sessionId, 'Alice');
    await closeWs(first.ws);

    const second = await joinHub(hub.origin, sessionId, 'Alice');
    assert.equal(second.id, first.id);
    await closeWs(second.ws);
  } finally {
    await hub.stop();
  }
});

test('explicit leave makes a retained identity capacity-evictable before socket close', async () => {
  const hub = await startHub({ HUB_MAX_RETAINED_SESSIONS: '1' });
  try {
    const first = await joinHub(hub.origin, 'retained-cap-first', 'First Alias');
    const left = nextJson(
      first.ws,
      (msg) => msg.type === 'hub_update' && !msg.players.some((player) => player.id === first.id),
    );
    sendJson(first.ws, { type: 'leave' });
    await left;
    const second = await joinHub(hub.origin, 'retained-cap-second', 'Second Alias');
    assert.notEqual(second.id, first.id);

    const aliasResultPromise = nextJson(first.ws, (msg) => msg.type === 'alias_result');
    sendJson(first.ws, { type: 'change_alias', newAlias: 'Resurrected Alias' });
    sendJson(first.ws, {
      type: 'get_alias',
      session_id: sessionKey('retained-cap-first'),
    });
    const aliasResult = await aliasResultPromise;
    assert.equal(aliasResult.alias, null);

    await closeWs(first.ws);
    await closeWs(second.ws);
  } finally {
    await hub.stop();
  }
});

test('retained session capacity does not evict an active identity', async () => {
  const hub = await startHub({ HUB_MAX_RETAINED_SESSIONS: '1' });
  try {
    const active = await joinHub(hub.origin, 'retained-active', 'Alice');
    const rejected = await openWs(hub.origin, '/ws/hub');
    const errorPromise = nextJson(rejected, (msg) => msg.type === 'error');
    sendJson(rejected, {
      type: 'join',
      session_id: sessionKey('retained-rejected'),
      alias: 'Bob',
    });
    assert.match((await errorPromise).error, /retained session limit/i);

    const replacement = await joinHub(hub.origin, 'retained-active', 'Alice Reloaded');
    assert.equal(replacement.id, active.id);
    await closeWs(replacement.ws);
    await closeWs(rejected);
  } finally {
    await hub.stop();
  }
});

test('set_alias cannot allocate storage for an unknown session', async () => {
  const hub = await startHub();
  try {
    const ws = await openWs(hub.origin, '/ws/hub');
    const errorPromise = nextJson(ws, (msg) => msg.type === 'error');
    sendJson(ws, {
      type: 'set_alias',
      session_id: sessionKey('unknown-alias-session'),
      alias: 'Mallory',
    });
    assert.match((await errorPromise).error, /unknown hub session/i);
    await closeWs(ws);
  } finally {
    await hub.stop();
  }
});

test('one hub socket cannot join more than one player', async () => {
  const hub = await startHub();
  try {
    const ws = await openWs(hub.origin, '/ws/hub');
    const joinedPromise = nextJson(ws, (msg) => msg.type === 'joined');
    const firstUpdatePromise = nextJson(ws, (msg) => msg.type === 'hub_update');
    sendJson(ws, {
      type: 'join',
      session_id: sessionKey('single-socket-first-player'),
      alias: 'Alice',
    });
    const joined = await joinedPromise;
    await firstUpdatePromise;

    const errorPromise = nextJson(ws, (msg) => msg.type === 'error');
    sendJson(ws, {
      type: 'join',
      session_id: sessionKey('single-socket-second-player'),
      alias: 'Mallory',
    });
    assert.match((await errorPromise).error, /already joined/);

    const updatePromise = nextJson(ws, (msg) => msg.type === 'hub_update');
    sendJson(ws, { type: 'change_alias', newAlias: 'Alice Again' });
    const update = await updatePromise;
    assert.deepEqual(update.players, [{ id: joined.id, alias: 'Alice Again', status: 'waiting' }]);

    await closeWs(ws);
  } finally {
    await hub.stop();
  }
});

test('hub player cap rejects new players while allowing reconnects', async () => {
  const hub = await startHub({ HUB_MAX_PLAYERS: '2' });
  try {
    const alice = await joinHub(hub.origin, 'player-cap-alice', 'Alice');
    const bob = await joinHub(hub.origin, 'player-cap-bob', 'Bob');
    const rejected = await openWs(hub.origin, '/ws/hub');
    const errorPromise = nextJson(rejected, (msg) => msg.type === 'error');
    sendJson(rejected, {
      type: 'join',
      session_id: sessionKey('player-cap-carol'),
      alias: 'Carol',
    });
    assert.match((await errorPromise).error, /player limit/);

    await closeWs(alice.ws);
    const reconnected = await joinHub(hub.origin, 'player-cap-alice', 'Alice');
    assert.equal(reconnected.id, alice.id);

    await closeWs(reconnected.ws);
    await closeWs(bob.ws);
    await closeWs(rejected);
  } finally {
    await hub.stop();
  }
});

test('identify ignores client-supplied player_id and assigns from the secret', async () => {
  const hub = await startHub();
  try {
    const sessionId = 'secret-ignore-client-player-id';
    const game = await openWs(hub.origin, '/ws/game');
    sendGame(game, {
      type: 'identify',
      session_id: sessionBytes(sessionId),
      busy: false,
      player_id: 'p_attacker_chosen_id_abcdef',
    });
    const registered = await nextGame(game, (msg) => msg.type === 'registered');
    assert.equal(registered.player_id.byteLength, 16);
    await closeWs(game);
  } finally {
    await hub.stop();
  }
});

test('total connection cap rejects excess upgrades and recovers after close', async () => {
  const hub = await startHub({
    HUB_MAX_TOTAL_CONNECTIONS: '2',
    HUB_MAX_CONNECTIONS_PER_IP: '10',
  });
  try {
    const hubSocket = await openWs(hub.origin, '/ws/hub');
    const gameSocket = await openWs(hub.origin, '/ws/game');

    await assert.rejects(openWs(hub.origin, '/ws/hub'), /Unexpected server response: 503/);

    await closeWs(hubSocket);
    const replacement = await openWs(hub.origin, '/ws/hub');

    await closeWs(replacement);
    await closeWs(gameSocket);
  } finally {
    await hub.stop();
  }
});

test('per-IP connection cap uses trusted forwarded addresses only when configured', async () => {
  const hub = await startHub({
    HUB_MAX_TOTAL_CONNECTIONS: '10',
    HUB_MAX_CONNECTIONS_PER_IP: '1',
    HUB_TRUST_PROXY: '1',
  });
  try {
    const first = await openWs(hub.origin, '/ws/hub', {
      headers: { 'x-forwarded-for': '203.0.113.1' },
    });

    await assert.rejects(
      openWs(hub.origin, '/ws/game', {
        headers: { 'x-forwarded-for': '203.0.113.1' },
      }),
      /Unexpected server response: 503/,
    );

    const differentIp = await openWs(hub.origin, '/ws/game', {
      headers: { 'x-forwarded-for': '203.0.113.2' },
    });

    await closeWs(first);
    const replacement = await openWs(hub.origin, '/ws/hub', {
      headers: { 'x-forwarded-for': '203.0.113.1' },
    });

    await closeWs(replacement);
    await closeWs(differentIp);
  } finally {
    await hub.stop();
  }
});

test('per-IP connection cap ignores forwarded addresses from untrusted clients', async () => {
  const hub = await startHub({
    HUB_MAX_TOTAL_CONNECTIONS: '10',
    HUB_MAX_CONNECTIONS_PER_IP: '1',
  });
  try {
    const first = await openWs(hub.origin, '/ws/hub', {
      headers: { 'x-forwarded-for': '203.0.113.1' },
    });

    await assert.rejects(
      openWs(hub.origin, '/ws/game', {
        headers: { 'x-forwarded-for': '203.0.113.2' },
      }),
      /Unexpected server response: 503/,
    );

    await closeWs(first);
  } finally {
    await hub.stop();
  }
});

test('per-IP connection attempt limit rejects reconnect churn', async () => {
  const hub = await startHub({
    HUB_MAX_TOTAL_CONNECTIONS: '10',
    HUB_MAX_CONNECTIONS_PER_IP: '10',
    HUB_MAX_CONNECTION_ATTEMPTS_PER_WINDOW: '2',
  });
  try {
    const first = await openWs(hub.origin, '/ws/hub');
    await closeWs(first);
    const second = await openWs(hub.origin, '/ws/hub');
    await closeWs(second);

    await assert.rejects(openWs(hub.origin, '/ws/hub'), /Unexpected server response: 503/);
  } finally {
    await hub.stop();
  }
});

test('hub message flood closes the connection with a distinct rate-limit code', async () => {
  const hub = await startHub({ HUB_MAX_MESSAGES_PER_WINDOW: '2' });
  try {
    const ws = await openWs(hub.origin, '/ws/hub');
    const closed = nextClose(ws);

    sendJson(ws, { type: 'keepalive' });
    sendJson(ws, { type: 'keepalive' });
    sendJson(ws, { type: 'keepalive' });

    assert.deepEqual(await closed, { code: 4008, reason: 'rate_limited' });
  } finally {
    await hub.stop();
  }
});

test('WebSocket parser ceilings independently bound hub control and game frames', async () => {
  const hub = await startHub({
    HUB_CONTROL_MAX_WS_PAYLOAD_BYTES: '128',
    GAME_MAX_WS_PAYLOAD_BYTES: '256',
    HUB_MAX_BYTES_PER_WINDOW: '1000',
    GAME_MAX_BYTES_PER_WINDOW: '1000',
  });
  try {
    const hubWs = await openWs(hub.origin, '/ws/hub');
    const hubClosed = nextClose(hubWs);
    hubWs.send('x'.repeat(129));
    assert.deepEqual(await hubClosed, { code: 1009, reason: '' });

    const gameWs = await openWs(hub.origin, '/ws/game');
    gameWs.send(Buffer.alloc(129));
    sendGame(gameWs, {
      type: 'identify',
      session_id: sessionBytes('parser-ceiling-game'),
      busy: false,
    });
    await nextGame(gameWs, (msg) => msg.type === 'registered');

    const gameClosed = nextClose(gameWs);
    gameWs.send(Buffer.alloc(257));
    assert.deepEqual(await gameClosed, { code: 1009, reason: '' });
  } finally {
    await hub.stop();
  }
});

test('game relay dictionaries are limited by their encoded byte budget', async () => {
  const hub = await startHub({ GAME_MAX_BYTES_PER_WINDOW: '100' });
  try {
    const ws = await openWs(hub.origin, '/ws/game');
    const closed = nextClose(ws);
    const frame = encodeBencodex({
      t: 'R',
      to: Buffer.alloc(16),
      p: Buffer.alloc(40),
    });

    ws.send(frame);
    ws.send(frame);

    assert.deepEqual(await closed, { code: 4008, reason: 'rate_limited' });
  } finally {
    await hub.stop();
  }
});

test('relay delivery fails before exceeding a destination outbound budget', async () => {
  const hub = await startHub({
    GAME_MAX_OUTBOUND_BYTES_PER_CONNECTION: '128',
    GAME_MAX_TOTAL_OUTBOUND_BYTES: '1048576',
  });
  try {
    const sender = await identifyGameRegistered(hub.origin, 'destination-budget-sender');
    const receiver = await identifyGameRegistered(hub.origin, 'destination-budget-receiver');
    const failed = nextGame(sender.game, (msg) => msg.type === 'delivery_failure');
    const unexpectedRelay = nextGame(receiver.game, (msg) => msg.type === 'relay', 100);

    sendGame(sender.game, {
      type: 'relay',
      to: playerBytes(receiver.playerId),
      payload: Buffer.alloc(256),
    });

    assert.deepEqual((await failed).to, playerBytes(receiver.playerId));
    await assert.rejects(unexpectedRelay, /timed out/);
    await closeWs(sender.game);
    await closeWs(receiver.game);
  } finally {
    await hub.stop();
  }
});

test('relay delivery fails before exceeding the global outbound budget', async () => {
  const hub = await startHub({
    GAME_MAX_OUTBOUND_BYTES_PER_CONNECTION: '1048576',
    GAME_MAX_TOTAL_OUTBOUND_BYTES: '128',
  });
  try {
    const sender = await identifyGameRegistered(hub.origin, 'global-budget-sender');
    const receiver = await identifyGameRegistered(hub.origin, 'global-budget-receiver');
    const failed = nextGame(sender.game, (msg) => msg.type === 'delivery_failure');
    const unexpectedRelay = nextGame(receiver.game, (msg) => msg.type === 'relay', 100);

    sendGame(sender.game, {
      type: 'relay',
      to: playerBytes(receiver.playerId),
      payload: Buffer.alloc(256),
    });

    assert.deepEqual((await failed).to, playerBytes(receiver.playerId));
    await assert.rejects(unexpectedRelay, /timed out/);
    await closeWs(sender.game);
    await closeWs(receiver.game);
  } finally {
    await hub.stop();
  }
});

test('delivery failure stays route-level and connect or disconnect notifies recent correspondents', async () => {
  const hub = await startHub();
  try {
    const sender = await identifyGameRegistered(hub.origin, 'recent-sender');
    const receiver = await identifyGameRegistered(hub.origin, 'recent-receiver');
    const relayed = nextGame(receiver.game, (msg) => msg.type === 'relay');
    sendGame(sender.game, {
      type: 'relay',
      to: playerBytes(receiver.playerId),
      payload: Buffer.from('hello'),
    });
    await relayed;

    const unavailable = nextGame(sender.game, (msg) => msg.type === 'peer_unavailable');
    await closeWs(receiver.game);
    assert.deepEqual((await unavailable).player_id, playerBytes(receiver.playerId));

    const failed = nextGame(sender.game, (msg) => msg.type === 'delivery_failure');
    sendGame(sender.game, {
      type: 'relay',
      to: playerBytes(receiver.playerId),
      payload: Buffer.from('retry me'),
    });
    const failure = await failed;
    assert.deepEqual(failure.to, playerBytes(receiver.playerId));
    assert.equal('relay_id' in failure, false);

    const available = nextGame(sender.game, (msg) => msg.type === 'peer_available');
    const reconnected = await identifyGameRegistered(hub.origin, 'recent-receiver');
    assert.equal(reconnected.playerId, receiver.playerId);
    assert.deepEqual((await available).player_id, playerBytes(receiver.playerId));

    await closeWs(sender.game);
    await closeWs(reconnected.game);
  } finally {
    await hub.stop();
  }
});

test('closing a stale replaced game socket does not notify correspondents', async () => {
  const hub = await startHub();
  try {
    const sender = await identifyGameRegistered(hub.origin, 'replace-sender');
    const receiver = await identifyGameRegistered(hub.origin, 'replace-receiver');
    const relayed = nextGame(receiver.game, (msg) => msg.type === 'relay');
    sendGame(sender.game, {
      type: 'relay',
      to: playerBytes(receiver.playerId),
      payload: Buffer.from('hello'),
    });
    await relayed;

    const unavailablePlayers = [];
    const recordUnavailable = (raw) => {
      const msg = descriptiveGameOutbound(raw);
      if (msg.type === 'peer_unavailable') unavailablePlayers.push(msg.player_id);
    };
    sender.game.on('message', recordUnavailable);

    const receiverClosed = nextClose(receiver.game);
    const available = nextGame(sender.game, (msg) => msg.type === 'peer_available');
    const replaced = await identifyGameRegistered(hub.origin, 'replace-receiver');
    assert.equal(replaced.playerId, receiver.playerId);
    assert.deepEqual((await available).player_id, playerBytes(receiver.playerId));
    assert.deepEqual(await receiverClosed, {
      code: 4001,
      reason: 'replaced_by_new_connection',
    });

    const barrier = await identifyGame(hub.origin, 'replace-close-barrier');
    await closeWs(barrier);
    assert.deepEqual(unavailablePlayers, []);
    sender.game.off('message', recordUnavailable);

    await closeWs(sender.game);
    await closeWs(replaced.game);
  } finally {
    await hub.stop();
  }
});

test('closing the current game socket with client-supplied code 4001 notifies correspondents', async () => {
  const hub = await startHub();
  try {
    const sender = await identifyGameRegistered(hub.origin, 'close-code-sender');
    const receiver = await identifyGameRegistered(hub.origin, 'close-code-receiver');
    const relayed = nextGame(receiver.game, (msg) => msg.type === 'relay');
    sendGame(sender.game, {
      type: 'relay',
      to: playerBytes(receiver.playerId),
      payload: Buffer.from('hello'),
    });
    await relayed;

    const unavailable = nextGame(sender.game, (msg) => msg.type === 'peer_unavailable');
    receiver.game.close(4001, 'client_requested');
    assert.deepEqual((await unavailable).player_id, playerBytes(receiver.playerId));

    await closeWs(sender.game);
    await closeWs(receiver.game);
  } finally {
    await hub.stop();
  }
});

test('recent correspondent tracking evicts the oldest route at its configured cap', async () => {
  const hub = await startHub({
    GAME_MAX_RECENT_CORRESPONDENTS: '1',
  });
  try {
    const sender = await identifyGameRegistered(hub.origin, 'cap-sender');
    const first = await identifyGameRegistered(hub.origin, 'cap-first');
    const second = await identifyGameRegistered(hub.origin, 'cap-second');

    const firstRelay = nextGame(first.game, (msg) => msg.type === 'relay');
    sendGame(sender.game, {
      type: 'relay',
      to: playerBytes(first.playerId),
      payload: Buffer.from('first'),
    });
    await firstRelay;

    const secondRelay = nextGame(second.game, (msg) => msg.type === 'relay');
    sendGame(sender.game, {
      type: 'relay',
      to: playerBytes(second.playerId),
      payload: Buffer.from('second'),
    });
    await secondRelay;

    await closeWs(first.game);
    const evictedHint = nextGame(sender.game, (msg) => msg.type === 'peer_available', 100);
    const firstAgain = await identifyGameRegistered(hub.origin, 'cap-first');
    await assert.rejects(evictedHint, /timed out/);

    await closeWs(second.game);
    const retainedHint = nextGame(sender.game, (msg) => msg.type === 'peer_available');
    const secondAgain = await identifyGameRegistered(hub.origin, 'cap-second');
    assert.deepEqual((await retainedHint).player_id, playerBytes(second.playerId));

    await closeWs(sender.game);
    await closeWs(firstAgain.game);
    await closeWs(secondAgain.game);
  } finally {
    await hub.stop();
  }
});

test('default game byte budget relays a maximum-size protocol message', async () => {
  const hub = await startHub();
  try {
    const sender = await identifyGameRegistered(hub.origin, 'secret-max-message-sender');
    const receiver = await identifyGameRegistered(hub.origin, 'secret-max-message-receiver');
    const payload = Buffer.alloc(10 * 1024 * 1024);

    const relayed = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('timed out waiting for maximum message')),
        5000,
      );
      receiver.game.once('message', (message) => {
        clearTimeout(timer);
        resolve(Buffer.from(message));
      });
    });
    sendGame(sender.game, {
      type: 'relay',
      to: playerBytes(receiver.playerId),
      payload,
    });

    const received = descriptiveGameOutbound(await relayed);
    assert.equal(received.type, 'relay');
    assert.deepEqual(received.from, playerBytes(sender.playerId));
    assert.equal(received.payload.byteLength, payload.byteLength);

    await closeWs(sender.game);
    await closeWs(receiver.game);
  } finally {
    await hub.stop();
  }
});
