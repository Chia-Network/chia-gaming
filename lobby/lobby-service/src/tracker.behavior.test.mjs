import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { test } from 'node:test';

import bencodex from 'chia-gaming-bencodex';
import { WebSocket } from 'ws';

const { decode: decodeBencodex, encode: encodeBencodex, isDictionary } = bencodex;

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

async function startTracker() {
  const port = await getFreePort();
  const dir = mkdtempSync(path.join(tmpdir(), 'tracker-behavior-'));
  const child = spawn(
    process.execPath,
    ['dist/index-rollup.cjs', '--self', `http://127.0.0.1:${port}`, '--dir', dir],
    {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`tracker did not start:\n${output}`));
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
      reject(new Error(`tracker exited with ${code}:\n${output}`));
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

async function openWs(origin, pathName) {
  const ws = new WebSocket(`${origin.replace(/^http/, 'ws')}${pathName}`);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out connecting ${pathName}`)), 2_000);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    ws.once('error', reject);
  });
  return ws;
}

function sendJson(ws, payload) {
  ws.send(JSON.stringify(payload));
}

function sendGame(ws, payload) {
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
      const msg = plainBencodex(decodeBencodex(raw));
      if (!predicate(msg)) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve(msg);
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

async function joinLobby(origin, sessionId, alias, extra = {}) {
  const lobby = await openWs(origin, '/ws/lobby');
  sendJson(lobby, { type: 'join', session_id: sessionId, alias, ...extra });
  const joined = await nextJson(lobby, (msg) => msg.type === 'joined');
  return { lobby, id: joined.id };
}

async function identifyGame(origin, sessionId) {
  const game = await openWs(origin, '/ws/game');
  sendGame(game, { type: 'identify', session_id: sessionId, busy: false });
  await nextGame(game, (msg) => msg.type === 'registered');
  return game;
}

test('public lobby updates never include the secret nonce', async () => {
  const tracker = await startTracker();
  try {
    const secret = 'secret-nonce-public-update-test';
    const { lobby, id } = await joinLobby(tracker.origin, secret, 'Alice');
    const update = await nextJson(lobby, (msg) => msg.type === 'lobby_update');
    assert.equal(JSON.stringify(update).includes(secret), false);
    assert.equal(update.players.some((player) => player.id === id), true);
    assert.equal(update.players.some((player) => 'session_id' in player), false);
    await closeWs(lobby);
  } finally {
    await tracker.stop();
  }
});

test('a different nonce cannot claim another public lobby id', async () => {
  const tracker = await startTracker();
  try {
    const alice = await joinLobby(tracker.origin, 'secret-alice', 'Alice');
    const bob = await joinLobby(tracker.origin, 'secret-bob', 'Bob', { id: alice.id });
    assert.notEqual(bob.id, alice.id);
    assert.equal(alice.lobby.readyState, WebSocket.OPEN);
    await closeWs(alice.lobby);
    await closeWs(bob.lobby);
  } finally {
    await tracker.stop();
  }
});

test('the same nonce reconnect intentionally replaces the old lobby socket', async () => {
  const tracker = await startTracker();
  try {
    const first = await joinLobby(tracker.origin, 'secret-reconnect', 'Alice');
    const closed = new Promise((resolve) => first.lobby.once('close', (code) => resolve(code)));
    const second = await joinLobby(tracker.origin, 'secret-reconnect', 'Alice Reloaded');
    assert.equal(second.id, first.id);
    assert.equal(await closed, 4001);
    await closeWs(second.lobby);
  } finally {
    await tracker.stop();
  }
});

test('challenge authority and availability come from bound sessions', async () => {
  const tracker = await startTracker();
  try {
    const alice = await joinLobby(tracker.origin, 'secret-alice-match', 'Alice');
    const bob = await joinLobby(tracker.origin, 'secret-bob-match', 'Bob');
    const carol = await joinLobby(tracker.origin, 'secret-carol-match', 'Carol');
    const aliceGame = await identifyGame(tracker.origin, 'secret-alice-match');
    const bobGame = await identifyGame(tracker.origin, 'secret-bob-match');
    const carolGame = await identifyGame(tracker.origin, 'secret-carol-match');

    sendJson(alice.lobby, { type: 'challenge', target_id: bob.id, amount: '100' });
    const challenge = await nextJson(bob.lobby, (msg) => msg.type === 'challenge_received');

    // Carol cannot accept Bob's challenge (she's not the target)
    sendJson(carol.lobby, {
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
    sendJson(bob.lobby, { type: 'challenge_accept', challenge_id: challenge.challenge_id });
    const advisory = await bobAdvisory;
    assert.equal(advisory.peer_id, alice.id);
    assert.equal(advisory.amount, '100');

    // Bob's client sets busy (simulating what the frontend does on advisory_start)
    sendGame(bobGame, { type: 'set_busy', session_id: 'secret-bob-match', busy: true });
    // Wait for lobby update to propagate
    await nextJson(carol.lobby, (msg) => msg.type === 'lobby_update');

    // Carol cannot challenge Bob (he's now busy)
    const carolError = nextJson(carol.lobby, (msg) => msg.type === 'error');
    const carolResolved = nextJson(carol.lobby, (msg) => msg.type === 'challenge_resolved');
    sendJson(carol.lobby, { type: 'challenge', target_id: bob.id, amount: '100' });
    const error = await carolError;
    assert.match(error.error, /active session/);
    const resolved = await carolResolved;
    assert.equal(resolved.accepted, false);

    await closeWs(alice.lobby);
    await closeWs(bob.lobby);
    await closeWs(carol.lobby);
    await closeWs(aliceGame);
    await closeWs(bobGame);
    await closeWs(carolGame);
  } finally {
    await tracker.stop();
  }
});

test('challenges with out-of-range timeouts are rejected', async () => {
  const tracker = await startTracker();
  try {
    const alice = await joinLobby(tracker.origin, 'secret-alice-timeout', 'Alice');
    const bob = await joinLobby(tracker.origin, 'secret-bob-timeout', 'Bob');
    await identifyGame(tracker.origin, 'secret-alice-timeout');
    await identifyGame(tracker.origin, 'secret-bob-timeout');

    // channel_timeout too low (2 < 3)
    const err1 = nextJson(alice.lobby, (msg) => msg.type === 'error');
    const res1 = nextJson(alice.lobby, (msg) => msg.type === 'challenge_resolved');
    sendJson(alice.lobby, { type: 'challenge', target_id: bob.id, amount: '100', channel_timeout: '2' });
    assert.match((await err1).error, /channel_timeout/);
    assert.equal((await res1).accepted, false);

    // unroll_timeout too high (31 > 30)
    const err2 = nextJson(alice.lobby, (msg) => msg.type === 'error');
    const res2 = nextJson(alice.lobby, (msg) => msg.type === 'challenge_resolved');
    sendJson(alice.lobby, { type: 'challenge', target_id: bob.id, amount: '100', unroll_timeout: '31' });
    assert.match((await err2).error, /unroll_timeout/);
    assert.equal((await res2).accepted, false);

    // valid timeouts at the boundaries succeed
    sendJson(alice.lobby, { type: 'challenge', target_id: bob.id, amount: '100', channel_timeout: '3', unroll_timeout: '30' });
    const challenge = await nextJson(bob.lobby, (msg) => msg.type === 'challenge_received');
    assert.equal(challenge.channel_timeout, '3');
    assert.equal(challenge.unroll_timeout, '30');

    await closeWs(alice.lobby);
    await closeWs(bob.lobby);
  } finally {
    await tracker.stop();
  }
});


