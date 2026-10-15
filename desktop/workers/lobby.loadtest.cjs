// Lobby load test: N players on a local HyperDHT testnet, one process, real
// lobby timings. Reports how long players take to see the whole lobby, how
// many connections each holds, steady-state gossip traffic, and how quickly
// departures (clean and abrupt) disappear.
//
// Usage: node workers/lobby.loadtest.cjs [players=200] [joinsPerSecond=20]

const Hyperswarm = require('hyperswarm');
const crypto = require('hypercore-crypto');
const createTestnet = require('hyperdht/testnet');

const { Lobby, DEFAULTS, swarmMaxPeers } = require('./lobby.cjs');

const PLAYERS = Number(process.argv[2] ?? 200);
const JOINS_PER_SECOND = Number(process.argv[3] ?? 20);
const STEADY_WINDOW_MS = 60_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function summary(values, unit = '') {
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  return `min ${Math.min(...values)}${unit} · p50 ${percentile(values, 50)}${unit} · p95 ${percentile(values, 95)}${unit} · max ${Math.max(...values)}${unit} · avg ${avg.toFixed(1)}${unit}`;
}

async function main() {
  const testnet = await createTestnet(5);
  const nodes = [];
  const start = Date.now();
  console.log(`joining ${PLAYERS} players at ${JOINS_PER_SECOND}/s …`);

  for (let i = 0; i < PLAYERS; i++) {
    const keyPair = crypto.keyPair();
    const swarm = new Hyperswarm({
      keyPair,
      bootstrap: testnet.bootstrap,
      maxPeers: swarmMaxPeers(),
    });
    const node = { swarm, joinedAt: Date.now(), sawAllAt: null };
    node.lobby = new Lobby({
      swarm,
      keyPair,
      network: 'simulator',
      emit: () => {},
      alias: `p${i}`,
      busy: i % 5 === 0,
      stake: String(100 * (1 + (i % 4))),
    });
    node.lobby.start();
    nodes.push(node);
    await sleep(1000 / JOINS_PER_SECOND);
  }
  console.log(`all joined after ${((Date.now() - start) / 1000).toFixed(1)}s`);

  // Convergence: every player sees every other player.
  const deadline = Date.now() + 180_000;
  for (;;) {
    const now = Date.now();
    for (const n of nodes) {
      if (n.sawAllAt === null && n.lobby.snapshot().players.length === PLAYERS - 1)
        n.sawAllAt = now;
    }
    const done = nodes.filter((n) => n.sawAllAt !== null).length;
    if (done === PLAYERS || now > deadline) break;
    await sleep(500);
  }
  const lastJoin = nodes[nodes.length - 1].joinedAt;
  const converged = nodes.filter((n) => n.sawAllAt !== null);
  const visible = nodes.map((n) => n.lobby.snapshot().players.length);
  console.log(
    `\nfull visibility: ${converged.length}/${PLAYERS} players see all ${PLAYERS - 1} others`,
  );
  console.log(`  players visible per node: ${summary(visible)}`);
  if (converged.length) {
    console.log(
      `  time from last join to seeing everyone: ${summary(
        converged.map((n) => Math.round((n.sawAllAt - lastJoin) / 100) / 10),
        's',
      )}`,
    );
  }
  console.log(`  connections per node: ${summary(nodes.map((n) => n.lobby.conns.size))}`);
  console.log(`  prunes total: ${nodes.reduce((a, n) => a + n.lobby.stats.pruned, 0)}`);

  // Steady-state gossip cost.
  const before = nodes.map((n) => ({ ...n.lobby.stats }));
  await sleep(STEADY_WINDOW_MS);
  const perSecond = (key) =>
    nodes.map((n, i) =>
      Math.round((n.lobby.stats[key] - before[i][key]) / (STEADY_WINDOW_MS / 1000)),
    );
  const kbIn = perSecond('bytesIn').map((b) => Math.round(b / 102.4) / 10);
  console.log(`\nsteady state over ${STEADY_WINDOW_MS / 1000}s:`);
  console.log(`  inbound KB/s per node: ${summary(kbIn)}`);
  console.log(`  inbound frames/s per node: ${summary(perSecond('framesIn'))}`);
  console.log(`  presence entries accepted/s per node: ${summary(perSecond('presenceAccepted'))}`);
  const total = (key) => nodes.reduce((a, n, i) => a + n.lobby.stats[key] - before[i][key], 0);
  console.log(
    `  connections opened in window: ${total('opened')} · prunes in window: ${total('pruned')}`,
  );

  // Departures: 5% leave cleanly, 5% vanish without a goodbye.
  const leaveCount = Math.max(1, Math.floor(PLAYERS * 0.05));
  const clean = nodes.splice(0, leaveCount);
  const abrupt = nodes.splice(0, leaveCount);
  const goneIds = new Set([...clean, ...abrupt].map((n) => n.lobby.myId));
  const cleanIds = new Set(clean.map((n) => n.lobby.myId));
  const leftAt = Date.now();
  await Promise.all(
    clean.map(async (n) => {
      await n.lobby.destroy();
      await n.swarm.destroy();
    }),
  );
  await Promise.all(
    abrupt.map(async (n) => {
      n.lobby.destroyed = true; // no goodbye entry
      for (const t of n.lobby.timers) clearInterval(t);
      await n.swarm.destroy();
    }),
  );
  let cleanGoneAt = null;
  let allGoneAt = null;
  while (Date.now() - leftAt < DEFAULTS.ttlMs + 30_000) {
    const seen = (ids) => nodes.some((n) => n.lobby.snapshot().players.some((p) => ids.has(p.id)));
    if (cleanGoneAt === null && !seen(cleanIds)) cleanGoneAt = Date.now();
    if (!seen(goneIds)) {
      allGoneAt = Date.now();
      break;
    }
    await sleep(500);
  }
  console.log(`\ndepartures (${leaveCount} clean, ${leaveCount} abrupt):`);
  console.log(
    `  clean leavers gone everywhere after: ${cleanGoneAt ? ((cleanGoneAt - leftAt) / 1000).toFixed(1) + 's' : 'not within window'}`,
  );
  console.log(
    `  abrupt leavers gone everywhere after: ${allGoneAt ? ((allGoneAt - leftAt) / 1000).toFixed(1) + 's' : 'not within window'} (TTL ${DEFAULTS.ttlMs / 1000}s)`,
  );

  for (const n of nodes) {
    await n.lobby.destroy();
    await n.swarm.destroy();
  }
  await testnet.destroy();
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
