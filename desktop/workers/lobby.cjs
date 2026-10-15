// The peer-to-peer lobby: presence, challenges and game relay over Hyperswarm.
//
// Presence scales by gossip rather than a full mesh. Each player keeps a
// bounded number of lobby connections and publishes a small signed presence
// entry (alias, busy, preferred buy-in) that peers forward to a few of their
// own connections. Entries expire unless refreshed, so everyone sees everyone
// who is online without being connected to them. Challenges and the game relay
// use a direct connection, dialled by public key on demand.
//
// Runs unchanged in Bare (the Pear worker, workers/main.cjs) and in Node (the
// load test), so it touches nothing runtime-specific. Everything a remote peer
// sends is untrusted and validated here.

const crypto = require('hypercore-crypto');
const b4a = require('b4a');

const LOBBY_TOPIC_CONTEXT = 'chia-gaming/pear-lobby/v2/';
const PRESENCE_CONTEXT = 'chia-gaming/pear-presence/v2';
const NETWORKS = new Set(['mainnet', 'testnet', 'simulator']);

const DEFAULTS = {
  refreshMs: 20_000, // republish our own presence
  ttlMs: 70_000, // an entry expires this long after the time it was signed
  maxSkewMs: 30_000, // reject entries stamped this far in the future
  minUpdateMs: 1_000, // per-player presence update rate
  lobbyTarget: 6, // outgoing lobby connections (others' dials add about as many incoming)
  lobbyMax: 20, // prune unprotected connections above this
  directHeadroom: 8, // extra slots for challenge / game connections
  fanout: 6, // neighbours a presence refresh is forwarded to (changes go to all)
  flushMs: 200, // presence batching interval
  emitMs: 500, // lobby snapshot throttle towards the UI
  sweepMs: 5_000,
  rediscoverMs: 30_000,
  dialTimeoutMs: 30_000, // above Hyperswarm's ~13 s dead-connection timeout plus its redial
  relayProtectMs: 10 * 60_000, // a connection that carried game traffic is never pruned
  pruneGraceMs: 15_000, // a new connection is not pruned before its first messages arrive
  maxEntries: 10_000,
  maxBatch: 200,
};

const MAX_ALIAS_BYTES = 128;
const MAX_RELAY_BYTES = 1024 * 1024;
const MAX_PEER_MESSAGE_BYTES = 2 * MAX_RELAY_BYTES;
const MAX_CHALLENGES_PER_PEER = 4;

// Hyperswarm's own cap. The lobby bounds its connections itself (exact top-up
// plus pruning); Hyperswarm divides its cap by up to 4 while explicit
// (joinPeer) peers exist, which would otherwise block challenge dials.
function swarmMaxPeers(o = DEFAULTS) {
  return 4 * (o.lobbyMax + o.directHeadroom);
}

function lobbyTopic(network) {
  return crypto.hash(b4a.from(LOBBY_TOPIC_CONTEXT + network));
}

// The hub's player ids are `p_` plus 16 bytes of hex; here they are the first
// 16 bytes of the player's public key, so persisted pairings keep working.
function playerIdOf(publicKeyHex) {
  return 'p_' + publicKeyHex.slice(0, 32);
}

function isAmount(value) {
  return typeof value === 'string' && /^[1-9][0-9]{0,30}$/.test(value);
}

function isOptionalTimeout(value) {
  return value === undefined || (typeof value === 'string' && /^[1-9][0-9]{0,9}$/.test(value));
}

function isAlias(value) {
  return typeof value === 'string' && value.length > 0 && b4a.byteLength(value) <= MAX_ALIAS_BYTES;
}

function isChallengeId(value) {
  return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
}

function presenceSignable(e) {
  return b4a.from(JSON.stringify([PRESENCE_CONTEXT, e.n, e.k, e.s, e.a, e.b, e.st, e.g]));
}

function isPresenceShape(e, network) {
  return (
    e !== null &&
    typeof e === 'object' &&
    typeof e.k === 'string' &&
    /^[0-9a-f]{64}$/.test(e.k) &&
    e.n === network &&
    Number.isSafeInteger(e.s) &&
    isAlias(e.a) &&
    typeof e.b === 'boolean' &&
    (e.st === null || isAmount(e.st)) &&
    typeof e.g === 'boolean' &&
    typeof e.sig === 'string' &&
    /^[0-9a-f]{128}$/.test(e.sig)
  );
}

function pickRandom(items, count) {
  const copy = items.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = copy[i];
    copy[i] = copy[j];
    copy[j] = t;
  }
  return copy.slice(0, count);
}

class Lobby {
  constructor({
    swarm,
    keyPair,
    network,
    emit,
    log = () => {},
    alias,
    busy,
    stake = null,
    options = {},
  }) {
    if (!NETWORKS.has(network)) throw new Error('unknown lobby network ' + network);
    this.o = { ...DEFAULTS, ...options };
    this.swarm = swarm;
    this.keyPair = keyPair;
    this.network = network;
    this.emit = emit;
    this.log = log;
    this.myKey = b4a.toString(keyPair.publicKey, 'hex');
    this.myId = playerIdOf(this.myKey);
    this.alias = alias;
    this.busy = busy;
    this.stake = stake;

    this.conns = new Map(); // id -> { id, key, conn, info, outbox, openedAt, lastRelayAt }
    this.presence = new Map(); // id -> { e, at }, insertion-ordered by receipt
    this.challenges = new Map(); // challengeId -> challenge
    this.pendingDials = new Map(); // id -> timer: players we are dialling to challenge
    this.pinned = new Set(); // ids we hold a joinPeer on

    this.ownEntry = null;
    this.ownSeq = 0;
    this.lastPublishAt = 0;
    this.publishTimer = null;
    this.emitTimer = null;
    this.timers = [];
    this.degreeDirty = false;
    this.discovery = null;
    this.destroyed = false;
    this.stats = {
      bytesIn: 0,
      bytesOut: 0,
      framesIn: 0,
      framesOut: 0,
      presenceAccepted: 0,
      presenceRejected: 0,
      pruned: 0,
      opened: 0,
      prunedBy: 0,
    };
  }

  start() {
    this.swarm.on('connection', (conn, info) => this._onConnection(conn, info));
    // Hyperswarm dials the lobby peers it discovers; capping its outgoing
    // connections keeps the lobby graph's degree bounded without dialling
    // anyone explicitly (explicit peers shrink Hyperswarm's own cap).
    this._updateClientCap();
    this.discovery = this.swarm.join(lobbyTopic(this.network), { client: true, server: true });
    this._publish(true);
    const every = (ms, fn) => this.timers.push(setInterval(fn, ms));
    every(this.o.refreshMs, () => this._publish(true));
    every(this.o.sweepMs, () => {
      this._sweep();
      this._pruneIfNeeded(null); // connections that were too young to prune on arrival
    });
    every(this.o.flushMs, () => this._flushOutboxes());
    every(this.o.rediscoverMs, () => this._rediscover());
    // A lookup only finds players who announced before it, so look again once
    // our own announce is out instead of waiting for the periodic refresh.
    this.discovery.flushed().then(() => {
      if (this.destroyed) return;
      this.log('lobby topic announced');
      this._rediscover();
    });
    this._scheduleEmit();
  }

  async destroy() {
    if (this.destroyed) return;
    // Tell the lobby we are leaving rather than letting our entry time out.
    this._publish(true, true);
    this._flushOutboxes();
    this.destroyed = true;
    for (const t of this.timers) clearInterval(t);
    clearTimeout(this.publishTimer);
    clearTimeout(this.emitTimer);
    for (const timer of this.pendingDials.values()) clearTimeout(timer);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // --- Own presence --------------------------------------------------------

  _publish(force, gone = false) {
    if (this.destroyed) return;
    const now = Date.now();
    if (!force && now - this.lastPublishAt < this.o.minUpdateMs) {
      if (!this.publishTimer) {
        this.publishTimer = setTimeout(
          () => {
            this.publishTimer = null;
            this._publish(true);
          },
          this.o.minUpdateMs - (now - this.lastPublishAt),
        );
      }
      return;
    }
    clearTimeout(this.publishTimer);
    this.publishTimer = null;
    this.ownSeq = Math.max(now, this.ownSeq + 1);
    const e = {
      k: this.myKey,
      n: this.network,
      s: this.ownSeq,
      a: this.alias,
      b: this.busy,
      st: this.stake,
      g: gone,
    };
    e.sig = b4a.toString(crypto.sign(presenceSignable(e), this.keyPair.secretKey), 'hex');
    this.ownEntry = e;
    this.lastPublishAt = now;
    for (const peer of this.conns.values()) peer.outbox.push(e);
  }

  setAlias(alias) {
    if (!isAlias(alias)) return;
    this.alias = alias;
    this._publish(false);
    this.emit({ t: 'alias_updated', alias });
    this._scheduleEmit();
  }

  setBusy(busy) {
    this.busy = busy;
    if (busy) {
      for (const c of [...this.challenges.values()]) {
        this._withdraw(c.id, c.from === this.myId ? 'challenge_cancel' : 'challenge_decline');
      }
    } else {
      // Session over: release the direct connections we were holding open.
      for (const id of [...this.pinned]) {
        if (!this._hasChallengeWith(id)) this._unpin(id);
      }
    }
    this._publish(false);
    this._scheduleEmit();
  }

  setStake(stake) {
    if (stake !== null && !isAmount(stake)) return;
    this.stake = stake;
    this._publish(false);
    this._scheduleEmit();
  }

  // --- Connections ---------------------------------------------------------

  _onConnection(conn, info) {
    const key = b4a.toString(info.publicKey, 'hex');
    const id = playerIdOf(key);
    const peer = {
      id,
      key,
      conn,
      info,
      outbox: [],
      openedAt: Date.now(),
      lastRelayAt: this.conns.get(id)?.lastRelayAt ?? 0,
      degree: null, // the neighbour's own connection count, as it reports it
      pruning: false,
    };
    this.conns.set(id, peer);
    this.stats.opened++;
    this.degreeDirty = true;

    conn.on('error', () => {});
    conn.on('close', () => {
      if (this.conns.get(id) !== peer) return; // superseded by a newer connection
      this.conns.delete(id);
      this.degreeDirty = true;
      // A player we are dialling or holding is expected back (Hyperswarm
      // redials it), and its challenges are resent on the next connection.
      if (!this.pinned.has(id)) this._dropChallengesWith(id);
      if (!this.destroyed) {
        this.emit({ t: 'peer_unavailable', player_id: id });
        this._scheduleEmit();
        this._rediscover();
      }
    });
    // Data from a superseded duplicate connection is still processed: when two
    // players dial each other at once, the other end may have written to it.
    conn.on('data', (data) => {
      this.stats.bytesIn += data.byteLength;
      this.stats.framesIn++;
      if (data.byteLength > MAX_PEER_MESSAGE_BYTES) return;
      let message;
      try {
        message = JSON.parse(b4a.toString(data));
      } catch {
        return;
      }
      if (message !== null && typeof message === 'object') this._onPeerMessage(peer, message);
    });

    // Bring the new neighbour up to date: our entry plus everyone we know.
    if (this.ownEntry) peer.outbox.push(this.ownEntry);
    const now = Date.now();
    for (const rec of this.presence.values()) {
      if (now - rec.e.s <= this.o.ttlMs) peer.outbox.push(rec.e);
    }

    const dialTimer = this.pendingDials.get(id);
    if (dialTimer) {
      this.pendingDials.delete(id);
      clearTimeout(dialTimer);
    }
    // (Re)send our open challenges to this player on every new connection: a
    // first connection can look open and still be dead (a failed relay), and
    // the receiver ignores a challenge id it already has.
    for (const c of this.challenges.values()) {
      if (c.from === this.myId && c.to === id) this._write(peer, this._challengeMessage(c));
    }

    this.emit({ t: 'peer_available', player_id: id });
    this._pruneIfNeeded(peer);
  }

  _isProtected(peer) {
    return (
      this.pinned.has(peer.id) ||
      this.pendingDials.has(peer.id) ||
      Date.now() - peer.openedAt < this.o.pruneGraceMs ||
      this._hasChallengeWith(peer.id) ||
      Date.now() - peer.lastRelayAt < this.o.relayProtectMs
    );
  }

  // Keep the lobby graph bounded: above lobbyMax, drop an unprotected
  // connection to the best-connected neighbour, which can afford to lose it
  // without falling below its target and dialling again (a random victim
  // cascades into churn). Never the connection that just arrived, so newcomers
  // can join.
  //
  // Hyperswarm redials a topic peer whenever a connection it dialled closes,
  // whatever the discovery mode, so both ends switch reconnecting off for the
  // pruned pair (`prune` tells the other end). Not a ban: a ban would also
  // refuse that player's challenges.
  _pruneIfNeeded(newest) {
    let candidates = [...this.conns.values()].filter((p) => !p.pruning && !this._isProtected(p));
    while (candidates.length > this.o.lobbyMax) {
      const eligible = candidates.filter((p) => p !== newest);
      if (!eligible.length) return;
      const top = Math.max(...eligible.map((p) => p.degree ?? 0));
      const victim = pickRandom(
        eligible.filter((p) => (p.degree ?? 0) === top),
        1,
      )[0];
      if (!victim) return;
      candidates = candidates.filter((p) => p !== victim);
      this.stats.pruned++;
      victim.pruning = true;
      victim.info.reconnect(false);
      this._write(victim, { t: 'prune' });
      // The other end closes on `prune`; force it if it does not.
      victim.conn.end();
      setTimeout(() => victim.conn.destroy(), 5_000);
    }
  }

  _outgoing() {
    let n = 0;
    for (const p of this.conns.values()) if (p.info.client) n++;
    return n;
  }

  _rediscover() {
    if (this.destroyed || !this.discovery) return;
    if (this._outgoing() < this.o.lobbyTarget) this.discovery.refresh().catch(() => {});
  }

  // Outgoing slots: lobbyTarget for the lobby plus one per pinned (challenge or
  // game) peer, so dialling a player we want to play is never blocked.
  _updateClientCap() {
    this.swarm.maxClientConnections = this.o.lobbyTarget + this.pinned.size;
    // Hyperswarm only drains its dial queue on its own events, and joinPeer
    // does not enqueue a peer that topic discovery already queued, so a raised
    // cap would leave a challenge target waiting. There is no public re-drain.
    this.swarm._attemptClientConnections?.();
  }

  _keyOf(id) {
    const key = this.conns.get(id)?.key ?? this.presence.get(id)?.e.k;
    return key ? b4a.from(key, 'hex') : null;
  }

  _pin(id) {
    const key = this._keyOf(id);
    if (!key) return false;
    this.swarm.peers.get(b4a.toString(key, 'hex'))?.reconnect(true);
    this.pinned.add(id);
    this._updateClientCap();
    this.swarm.joinPeer(key);
    return true;
  }

  _unpin(id) {
    const key = this._keyOf(id);
    this.pinned.delete(id);
    this._updateClientCap();
    if (key) this.swarm.leavePeer(key);
  }

  _challengeMessage(c) {
    return {
      t: 'challenge',
      id: c.id,
      challenger_amount: c.challenger_amount,
      target_amount: c.target_amount,
      channel_timeout: c.channel_timeout,
      unroll_timeout: c.unroll_timeout,
    };
  }

  // Dial a player by key for a challenge; _onConnection sends it.
  _dial(id) {
    if (this.pendingDials.has(id)) return;
    this._pin(id);
    this.pendingDials.set(
      id,
      setTimeout(() => this._dialFailed(id), this.o.dialTimeoutMs),
    );
  }

  _dialFailed(id) {
    this.pendingDials.delete(id);
    let dropped = false;
    for (const [cid, c] of this.challenges) {
      if (c.from === this.myId && c.to === id) {
        this.challenges.delete(cid);
        dropped = true;
      }
    }
    if (!this._hasChallengeWith(id)) this._unpin(id);
    if (dropped) {
      this.emit({ t: 'error', error: `Could not reach ${this._aliasOf(id)}.` });
      this._scheduleEmit();
    }
  }

  _write(peer, message) {
    const data = b4a.from(JSON.stringify(message));
    this.stats.bytesOut += data.byteLength;
    this.stats.framesOut++;
    peer.conn.write(data);
  }

  _flushOutboxes() {
    const d = this.conns.size;
    const announceDegree = this.degreeDirty;
    this.degreeDirty = false;
    for (const peer of this.conns.values()) {
      if (!peer.outbox.length && announceDegree) this._write(peer, { t: 'presence', e: [], d });
      while (peer.outbox.length) {
        this._write(peer, { t: 'presence', e: peer.outbox.splice(0, this.o.maxBatch), d });
      }
    }
  }

  // --- Presence gossip -----------------------------------------------------

  _receivePresence(e, from) {
    if (!isPresenceShape(e, this.network)) {
      this.stats.presenceRejected++;
      return;
    }
    if (e.k === this.myKey) return;
    const now = Date.now();
    // Expiry follows the signed timestamp, not receipt: a neighbour re-sending
    // an old entry (e.g. in a full sync) must not bring a departed player back.
    if (now - e.s > this.o.ttlMs || e.s - now > this.o.maxSkewMs) return;
    const id = playerIdOf(e.k);
    const existing = this.presence.get(id);
    if (existing && existing.e.s >= e.s) return; // already seen: this ends the flood
    if (existing && !e.g && e.s - existing.e.s < this.o.minUpdateMs) return;
    if (!crypto.verify(presenceSignable(e), b4a.from(e.sig, 'hex'), b4a.from(e.k, 'hex'))) {
      this.stats.presenceRejected++;
      return;
    }
    this.stats.presenceAccepted++;

    // Re-insert so Map order tracks freshness and eviction takes the stalest.
    this.presence.delete(id);
    this.presence.set(id, { e, at: now });
    if (this.presence.size > this.o.maxEntries) {
      this.presence.delete(this.presence.keys().next().value);
    }
    if (e.g || e.b) this._dropChallengesWith(id);

    // A change (busy, alias, buy-in, leaving) is a one-shot event and goes to
    // every neighbour; a plain refresh repeats every refreshMs, so a random
    // sample of neighbours is enough and keeps steady-state traffic down.
    const changed =
      !existing ||
      existing.e.g !== e.g ||
      existing.e.b !== e.b ||
      existing.e.a !== e.a ||
      existing.e.st !== e.st;
    const targets = [...this.conns.values()].filter((p) => p !== from);
    for (const peer of changed ? targets : pickRandom(targets, this.o.fanout)) peer.outbox.push(e);
    this._scheduleEmit();
  }

  _sweep() {
    const now = Date.now();
    let changed = false;
    for (const [id, rec] of this.presence) {
      if (now - rec.e.s <= this.o.ttlMs) continue;
      this.presence.delete(id);
      if (!rec.e.g) changed = true;
      if (!this.conns.has(id)) this._dropChallengesWith(id);
    }
    if (changed) this._scheduleEmit();
  }

  // --- Lobby view ----------------------------------------------------------

  _aliasOf(id) {
    const rec = this.presence.get(id);
    return rec && !rec.e.g ? rec.e.a : id;
  }

  snapshot() {
    const players = [];
    for (const [id, rec] of this.presence) {
      if (rec.e.g) continue;
      players.push({
        id,
        alias: rec.e.a,
        busy: rec.e.b,
        stake: rec.e.st,
        connected: this.conns.has(id),
      });
    }
    return {
      t: 'lobby',
      me: { id: this.myId, alias: this.alias, busy: this.busy, stake: this.stake },
      online: players.length + 1,
      connections: this.conns.size,
      players,
      challenges: [...this.challenges.values()],
    };
  }

  _scheduleEmit() {
    if (this.emitTimer || this.destroyed) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      if (!this.destroyed) this.emit(this.snapshot());
    }, this.o.emitMs);
  }

  // --- Challenges and relay ------------------------------------------------

  _hasChallengeWith(id) {
    for (const c of this.challenges.values()) {
      if (c.from === id || c.to === id) return true;
    }
    return false;
  }

  _dropChallengesWith(id) {
    let dropped = false;
    for (const [cid, c] of this.challenges) {
      if (c.from === id || c.to === id) {
        this.challenges.delete(cid);
        dropped = true;
      }
    }
    if (dropped) this._scheduleEmit();
  }

  _onPeerMessage(peer, message) {
    const id = peer.id;
    switch (message.t) {
      case 'presence': {
        if (!Array.isArray(message.e) || message.e.length > this.o.maxBatch) return;
        if (Number.isSafeInteger(message.d) && message.d >= 0 && message.d <= 1000)
          peer.degree = message.d;
        for (const e of message.e) this._receivePresence(e, peer);
        return;
      }
      case 'prune':
        // The other end is dropping this lobby connection; do not redial it.
        if (!this.pinned.has(id)) peer.info.reconnect(false);
        this.stats.prunedBy++;
        peer.conn.destroy();
        return;
      case 'challenge': {
        if (
          !isChallengeId(message.id) ||
          this.challenges.has(message.id) ||
          !isAmount(message.challenger_amount) ||
          !isAmount(message.target_amount) ||
          !isOptionalTimeout(message.channel_timeout) ||
          !isOptionalTimeout(message.unroll_timeout)
        ) {
          return;
        }
        const fromThisPeer = [...this.challenges.values()].filter((c) => c.from === id).length;
        if (this.busy || fromThisPeer >= MAX_CHALLENGES_PER_PEER) {
          this._write(peer, { t: 'challenge_decline', id: message.id });
          return;
        }
        this.challenges.set(message.id, {
          id: message.id,
          from: id,
          to: this.myId,
          challenger_amount: message.challenger_amount,
          target_amount: message.target_amount,
          channel_timeout: message.channel_timeout,
          unroll_timeout: message.unroll_timeout,
        });
        this.emit({ t: 'hub_attention' });
        this._scheduleEmit();
        return;
      }
      case 'challenge_accept': {
        // The accepter starts the session (it gets the advisory), as with the hub.
        const c = this.challenges.get(message.id);
        if (!c || c.from !== this.myId || c.to !== id) return;
        this.challenges.delete(message.id);
        this._pin(id); // hold the game connection open
        this.emit({ t: 'challenge_resolved', id: message.id, accepted: true, peer_id: id });
        this._scheduleEmit();
        return;
      }
      case 'challenge_decline':
      case 'challenge_cancel': {
        const c = this.challenges.get(message.id);
        if (!c || (c.from !== id && c.to !== id)) return;
        this.challenges.delete(message.id);
        if (!this._hasChallengeWith(id) && !this.busy) this._unpin(id);
        this.emit({ t: 'challenge_resolved', id: message.id, accepted: false, peer_id: id });
        this._scheduleEmit();
        return;
      }
      case 'relay': {
        if (typeof message.p !== 'string') return;
        const payload = b4a.from(message.p, 'base64');
        if (payload.byteLength === 0 || payload.byteLength > MAX_RELAY_BYTES) return;
        peer.lastRelayAt = Date.now();
        this.emit({ t: 'relay', from: id, alias: this._aliasOf(id), payload: message.p });
        return;
      }
      default:
        return;
    }
  }

  relay(to, payload) {
    const peer = this.conns.get(to);
    if (!peer || typeof payload !== 'string') {
      // Hub semantics: report the failure; meanwhile dial the player so the
      // session layer's resend finds a connection.
      this.emit({ t: 'delivery_failure', to });
      this._pin(to);
      return;
    }
    peer.lastRelayAt = Date.now();
    this._write(peer, { t: 'relay', p: payload });
  }

  challenge({ to, challenger_amount, target_amount, channel_timeout, unroll_timeout }) {
    const target = this.presence.get(to);
    if (
      !target ||
      target.e.g ||
      target.e.b ||
      this.busy ||
      !isAmount(challenger_amount) ||
      !isAmount(target_amount) ||
      !isOptionalTimeout(channel_timeout) ||
      !isOptionalTimeout(unroll_timeout)
    ) {
      this.emit({ t: 'error', error: 'That player cannot be challenged right now.' });
      return;
    }
    for (const c of this.challenges.values()) {
      if (c.from === this.myId && c.to === to) {
        this.emit({ t: 'error', error: 'You already challenged that player.' });
        return;
      }
    }
    const id = b4a.toString(crypto.randomBytes(16), 'hex');
    const c = {
      id,
      from: this.myId,
      to,
      challenger_amount,
      target_amount,
      channel_timeout,
      unroll_timeout,
    };
    this.challenges.set(id, c);
    const peer = this.conns.get(to);
    if (peer) this._write(peer, this._challengeMessage(c));
    else this._dial(to);
    this._scheduleEmit();
  }

  acceptChallenge(challengeId) {
    const c = this.challenges.get(challengeId);
    const peer = c && this.conns.get(c.from);
    if (!c || c.to !== this.myId || !peer || this.busy) {
      if (c) this.challenges.delete(challengeId);
      this.emit({ t: 'error', error: 'That challenge is no longer available.' });
      this._scheduleEmit();
      return;
    }
    this.challenges.delete(challengeId);
    // Accepting clears every other pending challenge, as the hub does.
    for (const other of [...this.challenges.values()]) {
      this._withdraw(other.id, other.from === this.myId ? 'challenge_cancel' : 'challenge_decline');
    }
    this._pin(c.from);
    this._write(peer, { t: 'challenge_accept', id: c.id });
    this._scheduleEmit();
    // Accepter's perspective, matching the hub's advisory_start.
    this.emit({
      t: 'advisory_start',
      peer_id: c.from,
      peer_alias: this._aliasOf(c.from),
      my_amount: c.target_amount,
      their_amount: c.challenger_amount,
      channel_timeout: c.channel_timeout,
      unroll_timeout: c.unroll_timeout,
    });
  }

  _withdraw(challengeId, kind) {
    const c = this.challenges.get(challengeId);
    if (!c) return;
    this.challenges.delete(challengeId);
    const other = c.from === this.myId ? c.to : c.from;
    const peer = this.conns.get(other);
    if (peer) this._write(peer, { t: kind, id: c.id });
    if (!this._hasChallengeWith(other) && !this.busy) this._unpin(other);
    this._scheduleEmit();
  }

  declineChallenge(challengeId) {
    this._withdraw(challengeId, 'challenge_decline');
  }

  cancelChallenge(challengeId) {
    this._withdraw(challengeId, 'challenge_cancel');
  }
}

module.exports = {
  Lobby,
  lobbyTopic,
  playerIdOf,
  presenceSignable,
  swarmMaxPeers,
  DEFAULTS,
  NETWORKS,
};
