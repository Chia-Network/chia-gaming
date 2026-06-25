import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { test } from 'node:test';

import { WebSocket } from 'ws';

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
  sendJson(game, { type: 'identify', session_id: sessionId, available: true });
  await nextJson(game, (msg) => msg.type === 'connection_status');
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

    sendJson(carol.lobby, {
      type: 'challenge_accept',
      challenge_id: challenge.challenge_id,
      accepter_id: bob.id,
    });
    await assert.rejects(
      nextJson(aliceGame, (msg) => msg.type === 'matched', 250),
      /timed out/,
    );

    const aliceMatched = nextJson(aliceGame, (msg) => msg.type === 'matched');
    const bobMatched = nextJson(bobGame, (msg) => msg.type === 'matched');
    sendJson(bob.lobby, { type: 'challenge_accept', challenge_id: challenge.challenge_id });
    await Promise.all([aliceMatched, bobMatched]);

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
