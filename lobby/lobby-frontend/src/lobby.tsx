import { useState, useEffect, useRef } from 'react';
import { useLobbySocket, ChallengeReceived, lobbyHsLog } from './useLobbySocket';
import { getSearchParams } from './util';
import { Edit, Cross, User, Crown, Swords } from 'lucide-react';
import { Button } from './button';

const LobbyScreen = () => {
  const params = getSearchParams();
  const uniqueId = params.uniqueId || '';
  const sessionId = params.session || '';

  const [myAlias, setMyAlias] = useState('');
  const [aliasConfirmed, setAliasConfirmed] = useState(false);
  const [editingAlias, setEditingAlias] = useState(false);

  const {
    players,
    lobbyUpdateReceived,
    pendingChallenge,
    challengeSent,
    isConnected,
    isReconnecting,
    reconnectBlocked,
    savedAlias,
    aliasLoaded,
    joinLobby,
    setAlias,
    sendChallenge,
    acceptChallenge,
    declineChallenge,
    cancelChallenge,
    setLobbyAlias,
  } = useLobbySocket(
    window.location.origin,
    uniqueId,
    sessionId,
  );

  const autoJoinedRef = useRef(false);
  useEffect(() => {
    if (!aliasLoaded || autoJoinedRef.current) return;
    if (savedAlias) {
      lobbyHsLog('alias_autojoin', {
        session_id: sessionId,
        unique_id: uniqueId,
        alias_len: savedAlias.length,
      });
      autoJoinedRef.current = true;
      setMyAlias(savedAlias);
      setAliasConfirmed(true);
      joinLobby(savedAlias);
    } else {
      lobbyHsLog('alias_missing_waiting_for_user', {
        session_id: sessionId,
        unique_id: uniqueId,
      });
    }
  }, [aliasLoaded, savedAlias, joinLobby]);

  function confirmAlias() {
    const trimmed = myAlias.trim();
    if (!trimmed) return;
    lobbyHsLog('alias_confirm', {
      session_id: sessionId,
      unique_id: uniqueId,
      alias_len: trimmed.length,
    });
    setAlias(trimmed);
    setMyAlias(trimmed);
    setAliasConfirmed(true);
    joinLobby(trimmed);
  }

  function commitEdit(e: any) {
    const value = e.target.value;
    setEditingAlias(false);
    setMyAlias(value);
    setLobbyAlias(uniqueId, value);
  }

  const [challengeTarget, setChallengeTarget] = useState<{ id: string; alias: string } | null>(null);
  const [challengeGame, setChallengeGame] = useState('calpoker');
  const [challengeAmount, setChallengeAmount] = useState('100');
  const [challengePerGame, setChallengePerGame] = useState('10');

  function openChallengeDialog(targetId: string, targetAlias: string) {
    setChallengeTarget({ id: targetId, alias: targetAlias });
  }

  function submitChallenge() {
    if (!challengeTarget) return;
    sendChallenge(challengeTarget.id, challengeGame, challengeAmount, challengePerGame);
    setChallengeTarget(null);
  }

  if (!aliasLoaded) {
    return (
      <div className="p-4 sm:p-6 min-h-screen bg-canvas-bg-subtle flex items-center justify-center">
        <p className="text-canvas-text">Loading...</p>
      </div>
    );
  }

  if (!aliasConfirmed) {
    return (
      <div className="p-4 sm:p-6 min-h-screen bg-canvas-bg-subtle flex flex-col items-center justify-center">
        <div className="w-full max-w-sm space-y-4">
          <h2 className="text-xl font-bold text-canvas-text-contrast text-center">
            Choose a Display Name
          </h2>
          <p className="text-sm text-canvas-text text-center">
            Pick a name other players will see in the tracker.
          </p>
          <input
            autoFocus
            className="w-full px-3 py-2 rounded bg-canvas-bg text-canvas-text border border-canvas-border outline-none text-center text-lg"
            placeholder="Your name"
            value={myAlias}
            onChange={(e) => setMyAlias(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && confirmAlias()}
          />
          <Button
            variant="solid"
            color="primary"
            size="default"
            onClick={confirmAlias}
            fullWidth
          >
            Join Tracker
          </Button>
        </div>
      </div>
    );
  }

  const iAmPlaying = players.find((p) => p.id === uniqueId)?.status === 'playing';

  return (
    <div className="p-4 sm:p-6 min-h-screen bg-canvas-bg-subtle">
      <div className="mb-4">
        <h2 className="text-xl font-bold text-canvas-text-contrast">Game Tracker</h2>
      </div>

      <div className="mb-4">
        {editingAlias ? (
          <div className="flex flex-row gap-2 items-center">
            <input
              aria-label="alias-input"
              className="px-3 py-2 rounded bg-canvas-bg text-canvas-text border border-canvas-border outline-none"
              placeholder="Enter new alias"
              value={myAlias}
              onChange={(e) => setMyAlias(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && commitEdit(e)}
              onBlur={commitEdit}
            />
            <button
              onClick={commitEdit}
              aria-label="save-alias"
              className="px-4 py-2 rounded bg-primary-solid text-primary-on-primary hover:bg-primary-solid-hover font-medium"
            >
              Save
            </button>
            <button
              onClick={() => setEditingAlias(false)}
              className="w-8 h-8 flex items-center justify-center text-primary-solid hover:text-primary-solid-hover"
            >
              <Cross className="w-5 h-5" />
            </button>
          </div>
        ) : (
          <div className="flex flex-row items-center gap-2">
            <p className="text-canvas-text">
              Your name:&nbsp;
              <strong className="text-canvas-text-contrast font-bold">{myAlias}</strong>
            </p>
            <button
              aria-label="edit-alias"
              onClick={() => setEditingAlias(true)}
              className="text-canvas-solid w-6 h-6 flex items-center justify-center"
            >
              <Edit className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>

      <div className="border-b border-canvas-line mb-4" />

      {pendingChallenge && (
        <IncomingChallengeDialog
          challenge={pendingChallenge}
          onAccept={() => acceptChallenge(pendingChallenge.challenge_id)}
          onDecline={() => declineChallenge(pendingChallenge.challenge_id)}
        />
      )}

      {challengeTarget && (
        <div className="mb-4 p-4 rounded-lg bg-canvas-bg border border-canvas-border space-y-3">
          <p className="text-canvas-text-contrast font-medium">
            Challenge <strong>{challengeTarget.alias}</strong>
          </p>
          <div className="space-y-2">
            <label className="block text-sm text-canvas-text">
              Game
              <select
                value={challengeGame}
                onChange={(e) => setChallengeGame(e.target.value)}
                className="mt-1 block w-full px-3 py-2 rounded bg-canvas-bg-subtle text-canvas-text border border-canvas-border outline-none"
              >
                <option value="calpoker">California Poker</option>
              </select>
            </label>
            <label className="block text-sm text-canvas-text">
              Total buy-in (mojos)
              <input
                type="number"
                min="1"
                value={challengeAmount}
                onChange={(e) => setChallengeAmount(e.target.value)}
                className="mt-1 block w-full px-3 py-2 rounded bg-canvas-bg-subtle text-canvas-text border border-canvas-border outline-none"
              />
            </label>
            <label className="block text-sm text-canvas-text">
              Per-hand amount (mojos)
              <input
                type="number"
                min="1"
                value={challengePerGame}
                onChange={(e) => setChallengePerGame(e.target.value)}
                className="mt-1 block w-full px-3 py-2 rounded bg-canvas-bg-subtle text-canvas-text border border-canvas-border outline-none"
              />
            </label>
          </div>
          <div className="flex gap-2">
            <Button variant="solid" color="primary" size="sm" onClick={submitChallenge}>
              Send Challenge
            </Button>
            <Button variant="solid" size="sm" onClick={() => setChallengeTarget(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {challengeSent && (
        <div className="mb-4 p-3 rounded-lg theme-force-light bg-white border border-canvas-border text-canvas-text text-sm flex items-center justify-between">
          <span>Waiting for opponent to respond to your challenge...</span>
          <Button variant="solid" size="sm" onClick={cancelChallenge}>
            Cancel
          </Button>
        </div>
      )}
      {reconnectBlocked ? (
        <div className="mb-4 p-3 rounded-lg theme-force-light bg-white border border-canvas-border text-canvas-text text-sm">
          This player is active in another tab/window. Close the other tab or use a separate browser profile for Alice/Bob.
        </div>
      ) : isReconnecting && (
        <div className="mb-4 p-3 rounded-lg theme-force-light bg-white border border-canvas-border text-canvas-text text-sm">
          Reconnecting to tracker...
        </div>
      )}

      <h3 className="text-lg font-semibold text-canvas-text-contrast mb-3">
        Connected Players
      </h3>

      {players.length === 0 ? (
        <div className="text-center py-8 text-canvas-text">
          <User
            className="mx-auto mb-2"
            style={{ fontSize: 48, color: 'var(--color-canvas-solid)' }}
          />
          {lobbyUpdateReceived ? (
            <>
              <h6 className="text-lg font-medium text-canvas-text-contrast">
                No Other Players Connected
              </h6>
              <p className="text-sm text-canvas-text">Waiting for others to join...</p>
            </>
          ) : (
            <>
              <h6 className="text-lg font-medium text-canvas-text-contrast">
                Waiting for Tracker
              </h6>
              <p className="text-sm text-canvas-text">No tracker update received yet...</p>
            </>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {players.map((player) => {
            const isMe = player.id === uniqueId;
            const isPlaying = player.status === 'playing';

            return (
              <div
                key={player.id}
                className="flex items-center justify-between p-3 rounded-lg bg-canvas-bg border border-canvas-border"
              >
                <div className="flex items-center gap-2">
                  {isMe ? (
                    <span className="inline-flex items-center gap-1 text-canvas-text-contrast font-medium">
                      <Crown className="w-4 h-4" style={{ color: 'var(--color-warning-solid)' }} />
                      {player.alias} (You)
                    </span>
                  ) : (
                    <span className="text-canvas-text">{player.alias}</span>
                  )}
                </div>

                {isPlaying ? (
                  <span className="text-sm text-canvas-text italic">
                    Playing vs {player.opponent_alias}
                  </span>
                ) : !isMe && (
                  <Button
                    variant="solid"
                    color="primary"
                    size="sm"
                    disabled={reconnectBlocked || !isConnected || challengeSent || !!challengeTarget || iAmPlaying}
                    onClick={() => openChallengeDialog(player.id, player.alias)}
                    leadingIcon={<Swords className="w-4 h-4" />}
                  >
                    Challenge
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

function IncomingChallengeDialog({
  challenge,
  onAccept,
  onDecline,
}: {
  challenge: ChallengeReceived;
  onAccept: () => void;
  onDecline: () => void;
}) {
  return (
    <div className="mb-4 p-4 rounded-lg theme-force-light bg-white border border-canvas-border">
      <p className="text-canvas-text-contrast font-medium mb-2">
        <strong>{challenge.from_alias}</strong> challenges you to{' '}
        <strong>{challenge.game}</strong>
      </p>
      <p className="text-sm text-canvas-text mb-3">
        Buy-in: {challenge.amount} mojos &middot; Per hand: {challenge.per_game} mojos
      </p>
      <div className="flex gap-2">
        <Button variant="solid" color="primary" size="sm" onClick={onAccept}>
          Accept
        </Button>
        <Button variant="solid" size="sm" onClick={onDecline}>
          Decline
        </Button>
      </div>
    </div>
  );
}

export default LobbyScreen;
