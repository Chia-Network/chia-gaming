/* global Bare */
// Pear worker: the peer-to-peer replacement for the hub.
//
// Runs in Bare, spawned by pear-runtime from the Electron main process in the
// same shape as holepunchto/hello-pear-worker. The lobby itself (presence
// gossip, challenges, game relay) lives in ./lobby.cjs; this file is the glue
// between it and the renderer, plus Pear's OTA updater.
//
// The renderer drives it over the framed IPC pipe with JSON messages that
// mirror the hub's game-socket protocol (identify / set_busy / relay /
// advisory_start / peer_available / delivery_failure ...), plus lobby messages
// (challenge / challenge_accept / ... / lobby).

const Hyperswarm = require('hyperswarm');
const crypto = require('hypercore-crypto');
const b4a = require('b4a');
const FramedStream = require('framed-stream');
const PearRuntime = require('pear-runtime');
const Corestore = require('corestore');
const path = require('bare-path');

const { Lobby, NETWORKS, swarmMaxPeers } = require('./lobby.cjs');

// Same positional contract as hello-pear-worker: Bare.argv[0] is the bare
// executable, [1] this file, then updates, version, upgrade, name, dir, app.
const argv = (index) => Bare.argv[index + 2];
const updaterConfig = {
  updates: argv(0) !== 'false',
  version: argv(1),
  upgrade: argv(2),
  name: argv(3),
  dir: argv(4),
  app: argv(5),
};

const KEY_SEED_CONTEXT = 'chia-gaming/pear-identity/v1/';

const pipe = new FramedStream(Bare.IPC);

function emit(message) {
  pipe.write(b4a.from(JSON.stringify(message)));
}

function log(text) {
  emit({ t: 'log', text });
}

// ---------------------------------------------------------------------------
// Pear OTA. Only active when the build carries a real `pear://` upgrade link;
// a dev build or an unprovisioned one runs the lobby without an updater.

let pear = null;
let store = null;

function startUpdater(swarm) {
  if (!updaterConfig.upgrade || !updaterConfig.upgrade.startsWith('pear://')) return;
  store = new Corestore(path.join(updaterConfig.dir, 'pear-runtime', 'corestore'));
  pear = new PearRuntime({ ...updaterConfig, swarm, store });
  pear.updater.on('error', (err) => emit({ t: 'updater', event: 'error', detail: err.message }));
  pear.updater.on('updating', () => emit({ t: 'updater', event: 'updating' }));
  pear.updater.on('updated', () => emit({ t: 'updater', event: 'updated' }));
  if (updaterConfig.updates) {
    swarm.join(pear.updater.drive.core.discoveryKey, { client: true, server: false });
  }
}

// ---------------------------------------------------------------------------
// Lobby lifecycle

let swarm = null;
let lobby = null;
let identity = null; // { sessionId, network }
// Latest presence from the renderer. Kept here as well as in the lobby so a
// set_busy that arrives while identify is still tearing down an old lobby is
// not lost.
let busy = true;

async function identify(message) {
  if (!/^[0-9a-f]{32}$/.test(message.session_id) || !NETWORKS.has(message.network)) {
    log('ignoring malformed identify');
    return;
  }
  busy = message.busy === true;
  if (lobby && identity.sessionId === message.session_id && identity.network === message.network) {
    // A renderer reload re-identifies against the running lobby.
    emit({ t: 'registered', player_id: lobby.myId });
    lobby.setBusy(busy);
    emit(lobby.snapshot());
    return;
  }

  await leave();
  // The Hyperswarm identity is derived from the per-"hub" session credential,
  // so a restart reconnects as the same player id and a live channel's peer
  // can find us again.
  const keyPair = crypto.keyPair(crypto.hash(b4a.from(KEY_SEED_CONTEXT + message.session_id)));
  identity = { sessionId: message.session_id, network: message.network };
  swarm = new Hyperswarm({ keyPair, maxPeers: swarmMaxPeers() });
  if (!pear) startUpdater(swarm);
  const alias =
    typeof message.alias === 'string' && message.alias
      ? message.alias
      : 'player-' + b4a.toString(keyPair.publicKey, 'hex').slice(0, 6);
  lobby = new Lobby({ swarm, keyPair, network: message.network, emit, log, alias, busy });
  lobby.start();
  emit({ t: 'registered', player_id: lobby.myId });
  log(`joined lobby topic for ${message.network} as ${lobby.myId}`);
}

async function leave() {
  if (!lobby) return;
  const oldLobby = lobby;
  const oldSwarm = swarm;
  lobby = null;
  swarm = null;
  identity = null;
  await oldLobby.destroy();
  await oldSwarm.destroy();
}

const commands = {
  identify,
  set_busy(m) {
    busy = m.busy === true;
    lobby?.setBusy(busy);
  },
  set_alias: (m) => lobby?.setAlias(m.alias),
  set_stake: (m) => lobby?.setStake(m.stake ?? null),
  relay(m) {
    if (lobby) lobby.relay(m.to, m.payload);
    else emit({ t: 'delivery_failure', to: m.to });
  },
  challenge: (m) => lobby?.challenge(m),
  challenge_accept: (m) => lobby?.acceptChallenge(m.id),
  challenge_decline: (m) => lobby?.declineChallenge(m.id),
  challenge_cancel: (m) => lobby?.cancelChallenge(m.id),
  async close() {
    await leave();
    emit({ t: 'closed' });
  },
  async apply_update() {
    if (!pear) return;
    try {
      await pear.ready();
      await pear.updater.applyUpdate();
      emit({ t: 'updater', event: 'applied' });
    } catch (err) {
      emit({ t: 'updater', event: 'error', detail: err.message });
    }
  },
};

pipe.on('data', (data) => {
  let message;
  try {
    message = JSON.parse(b4a.toString(data));
  } catch {
    log('ignoring malformed command');
    return;
  }
  const command = message && commands[message.t];
  if (!command) {
    log(`ignoring unknown command ${message?.t}`);
    return;
  }
  Promise.resolve(command(message)).catch((err) => log(`${message.t} failed: ${err.stack}`));
});

// The parent going away ends the pipe's readable side; that alone must stop
// the worker, or an orphan keeps announcing this player on the lobby topic.
let exiting = false;
function exitWorker() {
  if (exiting) return;
  exiting = true;
  shutdown().finally(() => Bare.exit(0));
}
pipe.on('end', exitWorker);
pipe.on('close', exitWorker);
pipe.on('error', exitWorker);

async function shutdown() {
  await leave();
  if (pear) await pear.close();
  if (store) await store.close();
}

emit({ t: 'ready' });
