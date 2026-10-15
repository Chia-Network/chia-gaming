// Lobby behaviour on a local HyperDHT testnet (no public network).
// Run: pnpm --filter chia-gaming-desktop run test:lobby

const test = require('node:test');
const assert = require('node:assert/strict');
const Hyperswarm = require('hyperswarm');
const crypto = require('hypercore-crypto');
const b4a = require('b4a');
const createTestnet = require('hyperdht/testnet');

const { Lobby, presenceSignable, swarmMaxPeers, DEFAULTS } = require('./lobby.cjs');

// Small limits so a handful of nodes already exercises gossip and pruning.
const OPTIONS = {
  lobbyTarget: 2,
  lobbyMax: 3,
  directHeadroom: 4,
  refreshMs: 2_000,
  ttlMs: 6_000,
  sweepMs: 500,
  rediscoverMs: 1_000,
  emitMs: 50,
  flushMs: 50,
  dialTimeoutMs: 30_000,
};

async function until(predicate, timeoutMs, label) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function makeNode(testnet, index) {
  const keyPair = crypto.keyPair();
  const swarm = new Hyperswarm({
    keyPair,
    bootstrap: testnet.bootstrap,
    maxPeers: swarmMaxPeers({ ...DEFAULTS, ...OPTIONS }),
  });
  const events = [];
  const lobby = new Lobby({
    swarm,
    keyPair,
    network: 'simulator',
    emit: (m) => events.push(m),
    alias: `node-${index}`,
    busy: false,
    options: OPTIONS,
  });
  lobby.start();
  return { swarm, lobby, events, keyPair };
}

async function closeAll(nodes, testnet) {
  for (const n of nodes) {
    await n.lobby.destroy();
    await n.swarm.destroy();
  }
  await testnet.destroy();
}

test('presence reaches every player through bounded connections', async () => {
  const testnet = await createTestnet(3);
  const nodes = [];
  try {
    for (let i = 0; i < 10; i++) nodes.push(makeNode(testnet, i));
    await until(
      () => nodes.every((n) => n.lobby.snapshot().players.length === nodes.length - 1),
      30_000,
      'every node sees every other node',
    );
    for (const n of nodes) {
      const unpinned = [...n.lobby.conns.values()].filter(
        (p) => !p.pruning && !n.lobby._isProtected(p),
      );
      assert.ok(unpinned.length <= OPTIONS.lobbyMax, `connections bounded (${unpinned.length})`);
    }
    // Not everyone is directly connected, yet everyone is visible.
    assert.ok(nodes.some((n) => n.lobby.conns.size < nodes.length - 1));
  } finally {
    await closeAll(nodes, testnet);
  }
});

test('a departing player disappears promptly', async () => {
  const testnet = await createTestnet(3);
  const nodes = [];
  try {
    for (let i = 0; i < 4; i++) nodes.push(makeNode(testnet, i));
    await until(
      () => nodes.every((n) => n.lobby.snapshot().players.length === 3),
      30_000,
      'full visibility',
    );
    const leaving = nodes.pop();
    const leavingId = leaving.lobby.myId;
    await leaving.lobby.destroy();
    await leaving.swarm.destroy();
    await until(
      () => nodes.every((n) => !n.lobby.snapshot().players.some((p) => p.id === leavingId)),
      OPTIONS.ttlMs,
      'departure observed before the TTL',
    );
  } finally {
    await closeAll(nodes, testnet);
  }
});

test('forged and tampered presence is rejected', () => {
  const keyPair = crypto.keyPair();
  const lobby = new Lobby({
    swarm: { on() {}, join() {} },
    keyPair,
    network: 'simulator',
    emit: () => {},
    alias: 'me',
    busy: false,
  });
  const other = crypto.keyPair();
  const entry = {
    k: b4a.toString(other.publicKey, 'hex'),
    n: 'simulator',
    s: Date.now(),
    a: 'mallory',
    b: false,
    st: null,
    g: false,
  };
  entry.sig = b4a.toString(crypto.sign(presenceSignable(entry), other.secretKey), 'hex');

  lobby._receivePresence({ ...entry, a: 'alice' }, null); // tampered alias
  lobby._receivePresence({ ...entry, s: entry.s - 10 * 60_000 }, null); // stale replay
  lobby._receivePresence({ ...entry, n: 'mainnet' }, null); // other network
  assert.equal(lobby.presence.size, 0);

  lobby._receivePresence(entry, null);
  assert.equal(lobby.presence.size, 1);
  assert.equal(lobby.snapshot().players[0].alias, 'mallory');
});

test('a player can be challenged without a prior connection', async () => {
  const testnet = await createTestnet(3);
  const nodes = [];
  try {
    for (let i = 0; i < 8; i++) nodes.push(makeNode(testnet, i));
    await until(
      () => nodes.every((n) => n.lobby.snapshot().players.length === nodes.length - 1),
      30_000,
      'full visibility',
    );
    let pair = null;
    for (const a of nodes) {
      const b = nodes.find((n) => n !== a && !a.lobby.conns.has(n.lobby.myId));
      if (b) {
        pair = [a, b];
        break;
      }
    }
    assert.ok(pair, 'found two players without a direct connection');
    const [a, b] = pair;
    a.lobby.challenge({
      to: b.lobby.myId,
      challenger_amount: '100',
      target_amount: '100',
      channel_timeout: '15',
      unroll_timeout: '15',
    });
    await until(() => b.lobby.challenges.size === 1, 30_000, 'challenge delivered by dialling');
    b.lobby.acceptChallenge([...b.lobby.challenges.keys()][0]);
    const advisory = b.events.find((m) => m.t === 'advisory_start');
    assert.equal(advisory.peer_id, a.lobby.myId);
    await until(
      () => a.events.some((m) => m.t === 'challenge_resolved' && m.accepted),
      10_000,
      'challenger sees the accept',
    );
    // The game relay now runs over the direct connection.
    b.lobby.relay(a.lobby.myId, b4a.toString(b4a.from('potato'), 'base64'));
    await until(() => a.events.some((m) => m.t === 'relay'), 10_000, 'relay delivered');
  } finally {
    await closeAll(nodes, testnet);
  }
});
