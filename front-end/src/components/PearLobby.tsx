import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import timeoutBounds from 'chia-gaming-protocol-constants';

import { Button } from './button';
import type {
  PearHubConnection,
  PearLobbyChallenge,
  PearLobbyPlayer,
} from '../services/PearHubConnection';

const MIN_TIMEOUT_BLOCKS = timeoutBounds.sessionTimeoutBlocks.min;
const MAX_TIMEOUT_BLOCKS = timeoutBounds.sessionTimeoutBlocks.max;

function isTimeoutInRange(value: string | undefined): boolean {
  if (!value) return true;
  const n = Number(value);
  return Number.isInteger(n) && n >= MIN_TIMEOUT_BLOCKS && n <= MAX_TIMEOUT_BLOCKS;
}

function isAmountValid(value: string): boolean {
  return /^[1-9][0-9]*$/.test(value);
}

/** Rows shown before "Show all": the lobby can hold far more players than fit. */
const PAGE_SIZE = 50;

const inputClass =
  'mt-1 block w-full px-3 py-2 rounded bg-canvas-bg-subtle text-canvas-text border border-canvas-border outline-none';

/**
 * The peer-to-peer counterpart of the hub's lobby iframe: the same alias,
 * player list and challenge flow, fed by the Pear worker instead of a hub.
 */
export function PearLobby({ conn }: { conn: PearHubConnection }) {
  const lobby = useSyncExternalStore(
    (onChange) => conn.subscribeLobby(onChange),
    () => conn.getLobby(),
  );
  const me = lobby.me;

  const [editingAlias, setEditingAlias] = useState(false);
  const [aliasDraft, setAliasDraft] = useState('');
  const [target, setTarget] = useState<{ id: string; alias: string } | null>(null);
  const [amount, setAmount] = useState('100');
  const [channelTimeout, setChannelTimeout] = useState('15');
  const [unrollTimeout, setUnrollTimeout] = useState('15');
  const [stakeDraft, setStakeDraft] = useState('');
  const [showAll, setShowAll] = useState(false);

  const incoming = useMemo(
    () => lobby.challenges.filter((c) => me && c.to === me.id),
    [lobby.challenges, me],
  );
  const outgoing = lobby.challenges.filter((c) => me && c.from === me.id);
  const aliasOf = (id: string) => lobby.players.find((p) => p.id === id)?.alias ?? id;

  // Players you can play right now first, those looking for your buy-in first
  // among them; busy players last.
  const myStake = me?.stake ?? null;
  const sortedPlayers = useMemo(() => {
    const rank = (p: PearLobbyPlayer) =>
      p.busy ? 2 : myStake !== null && p.stake === myStake ? 0 : 1;
    return [...lobby.players].sort((a, b) => rank(a) - rank(b) || a.alias.localeCompare(b.alias));
  }, [lobby.players, myStake]);
  const available = lobby.players.filter((p) => !p.busy).length;
  const atMyStake =
    myStake === null ? 0 : lobby.players.filter((p) => !p.busy && p.stake === myStake).length;

  // Untrusted peers can send anything the worker's shape check lets through;
  // decline what the session layer would refuse anyway, as the hub lobby does.
  useEffect(() => {
    for (const c of incoming) {
      if (
        !isTimeoutInRange(c.channel_timeout) ||
        !isTimeoutInRange(c.unroll_timeout) ||
        !isAmountValid(c.challenger_amount) ||
        !isAmountValid(c.target_amount)
      ) {
        conn.declineChallenge(c.id);
      }
    }
  }, [conn, incoming]);

  if (!me) {
    return (
      <div className="flex flex-1 items-center justify-center text-canvas-text">
        Joining the peer-to-peer lobby…
      </div>
    );
  }

  const formValid =
    isAmountValid(amount) && isTimeoutInRange(channelTimeout) && isTimeoutInRange(unrollTimeout);

  function commitAlias() {
    const trimmed = aliasDraft.trim();
    if (trimmed) conn.setAlias(trimmed);
    setEditingAlias(false);
  }

  function commitStake() {
    const trimmed = stakeDraft.trim();
    if (trimmed === '') conn.setStake(null);
    else if (isAmountValid(trimmed)) conn.setStake(trimmed);
  }

  function openChallenge(id: string, alias: string) {
    setTarget({ id, alias });
    if (myStake !== null) setAmount(myStake);
  }

  function submitChallenge() {
    if (!target || !formValid) return;
    conn.challenge(target.id, amount, amount, channelTimeout, unrollTimeout);
    setTarget(null);
  }

  return (
    <div className="flex-1 overflow-auto p-4 sm:p-6 bg-canvas-bg-subtle">
      <div className="mb-4 flex items-baseline justify-between">
        <h2 className="text-xl font-bold text-canvas-text-contrast">Peer-to-peer lobby</h2>
        <span className="text-xs text-canvas-solid">{me.id}</span>
      </div>

      <div className="mb-4 flex items-center gap-2 text-canvas-text">
        {editingAlias ? (
          <>
            <input
              autoFocus
              aria-label="alias-input"
              className="px-3 py-2 rounded bg-canvas-bg text-canvas-text border border-canvas-border outline-none"
              value={aliasDraft}
              onChange={(e) => setAliasDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && commitAlias()}
            />
            <Button variant="solid" onClick={commitAlias}>
              Save
            </Button>
          </>
        ) : (
          <>
            <span>
              Your name: <strong className="text-canvas-text-contrast">{me.alias}</strong>
            </span>
            <button
              type="button"
              aria-label="edit-alias"
              className="text-xs underline text-canvas-solid"
              onClick={() => {
                setAliasDraft(me.alias);
                setEditingAlias(true);
              }}
            >
              edit
            </button>
          </>
        )}
      </div>

      <p className="mb-2 text-sm text-canvas-text">
        <strong className="text-canvas-text-contrast">{lobby.online}</strong> players online ·{' '}
        <strong className="text-canvas-text-contrast">{available}</strong> available
        {myStake !== null && (
          <>
            {' '}
            · <strong className="text-canvas-text-contrast">{atMyStake}</strong> looking for{' '}
            {myStake} mojos
          </>
        )}
      </p>

      <div className="mb-4 flex items-center gap-2 text-sm text-canvas-text">
        <label htmlFor="pear-stake">Looking to play for</label>
        <input
          id="pear-stake"
          type="number"
          min="1"
          placeholder={myStake ?? 'any'}
          value={stakeDraft}
          onChange={(e) => setStakeDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && commitStake()}
          className="w-32 px-2 py-1 rounded bg-canvas-bg text-canvas-text border border-canvas-border outline-none"
        />
        <span>mojos</span>
        <Button variant="outline" onClick={commitStake}>
          Set
        </Button>
      </div>

      {lobby.error && (
        <p className="mb-4 text-sm text-alert-text">
          {lobby.error}{' '}
          <button type="button" className="underline" onClick={() => conn.clearLobbyError()}>
            dismiss
          </button>
        </p>
      )}

      {incoming.map((c: PearLobbyChallenge) => (
        <div
          key={c.id}
          className="mb-4 p-4 rounded-lg bg-canvas-bg border border-primary-border space-y-3"
        >
          <p className="text-canvas-text-contrast">
            <strong>{aliasOf(c.from)}</strong> challenges you: you put in {c.target_amount} mojos,
            they put in {c.challenger_amount} mojos (timeouts {c.channel_timeout ?? '—'}/
            {c.unroll_timeout ?? '—'} blocks).
          </p>
          <div className="flex gap-2">
            <Button variant="solid" onClick={() => conn.acceptChallenge(c.id)}>
              Accept
            </Button>
            <Button variant="outline" onClick={() => conn.declineChallenge(c.id)}>
              Decline
            </Button>
          </div>
        </div>
      ))}

      {target && (
        <div className="mb-4 p-4 rounded-lg bg-canvas-bg border border-canvas-border space-y-3">
          <p className="text-canvas-text-contrast font-medium">
            Challenge <strong>{target.alias}</strong>
          </p>
          <label className="block text-sm text-canvas-text">
            Buy-in per player (mojos)
            <input
              type="number"
              min="1"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className={inputClass}
            />
          </label>
          <label className="block text-sm text-canvas-text">
            Channel timeout (blocks, {MIN_TIMEOUT_BLOCKS}–{MAX_TIMEOUT_BLOCKS})
            <input
              type="number"
              value={channelTimeout}
              onChange={(e) => setChannelTimeout(e.target.value)}
              className={inputClass}
            />
          </label>
          <label className="block text-sm text-canvas-text">
            Unroll timeout (blocks, {MIN_TIMEOUT_BLOCKS}–{MAX_TIMEOUT_BLOCKS})
            <input
              type="number"
              value={unrollTimeout}
              onChange={(e) => setUnrollTimeout(e.target.value)}
              className={inputClass}
            />
          </label>
          <div className="flex gap-2">
            <Button variant="solid" disabled={!formValid} onClick={submitChallenge}>
              Send challenge
            </Button>
            <Button variant="outline" onClick={() => setTarget(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      <h3 className="mb-2 font-semibold text-canvas-text-contrast">Players</h3>
      {lobby.players.length === 0 ? (
        <p className="text-sm text-canvas-solid">
          Looking for other players on the network… This can take a few seconds.
        </p>
      ) : (
        <ul className="space-y-2">
          {(showAll ? sortedPlayers : sortedPlayers.slice(0, PAGE_SIZE)).map((player) => {
            const pending = outgoing.find((c) => c.to === player.id);
            return (
              <li
                key={player.id}
                className="flex items-center justify-between p-3 rounded-lg bg-canvas-bg border border-canvas-border"
              >
                <span className="text-canvas-text">
                  <strong className="text-canvas-text-contrast">{player.alias}</strong>
                  {player.busy && <span className="ml-2 text-xs text-canvas-solid">busy</span>}
                  {!player.busy && player.stake !== null && (
                    <span className="ml-2 text-xs text-canvas-solid">
                      looking for {player.stake} mojos
                    </span>
                  )}
                </span>
                {pending ? (
                  <Button variant="outline" onClick={() => conn.cancelChallenge(pending.id)}>
                    Cancel challenge
                  </Button>
                ) : (
                  <Button
                    variant="solid"
                    disabled={player.busy || me.busy}
                    onClick={() => openChallenge(player.id, player.alias)}
                  >
                    Challenge
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {!showAll && sortedPlayers.length > PAGE_SIZE && (
        <button
          type="button"
          className="mt-2 text-sm underline text-canvas-solid"
          onClick={() => setShowAll(true)}
        >
          Show all {sortedPlayers.length} players
        </button>
      )}
    </div>
  );
}
