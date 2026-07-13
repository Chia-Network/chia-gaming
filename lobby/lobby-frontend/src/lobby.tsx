import { useState, useEffect, useRef } from 'react';
import { useLobbySocket, ChallengeReceived, lobbyHsLog } from './useLobbySocket';
import { getSearchParams } from './util';
import { Edit, Cross, User, Crown, Swords } from 'lucide-react';
import { Button } from './button';

const MIN_TIMEOUT_BLOCKS = 3;
const MAX_TIMEOUT_BLOCKS = 30;
const MOJOS_PER_XCH = 1_000_000_000_000n;
const MOJO_DISPLAY_THRESHOLD = 1_000_000n;

function isTimeoutInRange(value: string | undefined): boolean {
  if (!value) return true;
  const n = Number(value);
  return Number.isInteger(n) && n >= MIN_TIMEOUT_BLOCKS && n <= MAX_TIMEOUT_BLOCKS;
}

function isAmountValid(value: string | undefined): boolean {
  return !!value && /^[1-9][0-9]*$/.test(value);
}

function formatAmount(mojoStr: string): string {
  let mojos: bigint;
  try {
    mojos = BigInt(mojoStr);
  } catch {
    return `${mojoStr} mojos`;
  }
  if (mojos < MOJO_DISPLAY_THRESHOLD) {
    return `${mojos.toLocaleString()} mojos`;
  }
  const whole = mojos / MOJOS_PER_XCH;
  const frac = mojos % MOJOS_PER_XCH;
  if (frac === 0n) {
    return `${whole.toLocaleString()} XCH`;
  }
  const fracStr = frac.toString().padStart(12, '0').replace(/0+$/, '');
  return `${whole.toLocaleString()}.${fracStr} XCH`;
}

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
    publicId,
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
    setLobbyAlias(publicId ?? '', value);
  }

  useEffect(() => {
    if (!pendingChallenge) return;
    const { channel_timeout, unroll_timeout, challenger_amount, target_amount } = pendingChallenge;
    if (!isTimeoutInRange(channel_timeout) || !isTimeoutInRange(unroll_timeout)) {
      console.warn(
        `[lobby] auto-declining challenge ${pendingChallenge.challenge_id}: ` +
        `timeouts out of range (channel=${channel_timeout}, unroll=${unroll_timeout}, ` +
        `allowed=${MIN_TIMEOUT_BLOCKS}–${MAX_TIMEOUT_BLOCKS})`,
      );
      declineChallenge(pendingChallenge.challenge_id);
      return;
    }
    if (!isAmountValid(challenger_amount) || !isAmountValid(target_amount)) {
      console.warn(
        `[lobby] auto-declining challenge ${pendingChallenge.challenge_id}: ` +
        `invalid amounts (challenger=${challenger_amount}, target=${target_amount})`,
      );
      declineChallenge(pendingChallenge.challenge_id);
    }
  }, [pendingChallenge, declineChallenge]);

  const [challengeTarget, setChallengeTarget] = useState<{ id: string; alias: string } | null>(null);
  const [challengeAmount, setChallengeAmount] = useState('100');
  const [asymmetricAmounts, setAsymmetricAmounts] = useState(false);
  const [challengerAmount, setChallengerAmount] = useState('100');
  const [targetAmount, setTargetAmount] = useState('100');
  const [challengeChannelTimeout, setChallengeChannelTimeout] = useState('15');
  const [challengeUnrollTimeout, setChallengeUnrollTimeout] = useState('15');

  function openChallengeDialog(targetId: string, targetAlias: string) {
    setChallengeTarget({ id: targetId, alias: targetAlias });
    setAsymmetricAmounts(false);
    setChallengerAmount(challengeAmount);
    setTargetAmount(challengeAmount);
  }

  function submitChallenge() {
    if (!challengeTarget || !timeoutsValid) return;
    const myAmt = asymmetricAmounts ? challengerAmount : challengeAmount;
    const theirAmt = asymmetricAmounts ? targetAmount : challengeAmount;
    sendChallenge(challengeTarget.id, myAmt, theirAmt, challengeChannelTimeout, challengeUnrollTimeout);
    setChallengeTarget(null);
  }

  const timeoutsValid = isTimeoutInRange(challengeChannelTimeout) && isTimeoutInRange(challengeUnrollTimeout);

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

  const myStatus = players.find((p) => p.id === publicId)?.status;
  const iAmUnavailable = myStatus === 'playing' || myStatus === 'busy';

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

      {pendingChallenge
        && isTimeoutInRange(pendingChallenge.channel_timeout)
        && isTimeoutInRange(pendingChallenge.unroll_timeout)
        && isAmountValid(pendingChallenge.challenger_amount)
        && isAmountValid(pendingChallenge.target_amount)
        && (
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
            {asymmetricAmounts ? (
              <>
                <label className="block text-sm text-canvas-text">
                  Your buy-in (mojos)
                  <input
                    type="number"
                    min="1"
                    value={challengerAmount}
                    onChange={(e) => setChallengerAmount(e.target.value)}
                    className="mt-1 block w-full px-3 py-2 rounded bg-canvas-bg-subtle text-canvas-text border border-canvas-border outline-none"
                  />
                </label>
                <label className="block text-sm text-canvas-text">
                  Their buy-in (mojos)
                  <input
                    type="number"
                    min="1"
                    value={targetAmount}
                    onChange={(e) => setTargetAmount(e.target.value)}
                    className="mt-1 block w-full px-3 py-2 rounded bg-canvas-bg-subtle text-canvas-text border border-canvas-border outline-none"
                  />
                </label>
              </>
            ) : (
              <label className="block text-sm text-canvas-text">
                Buy-in per player (mojos)
                <input
                  type="number"
                  min="1"
                  value={challengeAmount}
                  onChange={(e) => setChallengeAmount(e.target.value)}
                  className="mt-1 block w-full px-3 py-2 rounded bg-canvas-bg-subtle text-canvas-text border border-canvas-border outline-none"
                />
              </label>
            )}
            <label className="flex items-center gap-2 text-sm text-canvas-text cursor-pointer">
              <input
                type="checkbox"
                checked={asymmetricAmounts}
                onChange={(e) => {
                  setAsymmetricAmounts(e.target.checked);
                  if (e.target.checked) {
                    setChallengerAmount(challengeAmount);
                    setTargetAmount(challengeAmount);
                  }
                }}
                className="rounded border-canvas-border"
              />
              Different amounts for each player
            </label>
            <label className="block text-sm text-canvas-text">
              Channel timeout (blocks, {MIN_TIMEOUT_BLOCKS}–{MAX_TIMEOUT_BLOCKS})
              <input
                type="number"
                min={MIN_TIMEOUT_BLOCKS}
                max={MAX_TIMEOUT_BLOCKS}
                value={challengeChannelTimeout}
                onChange={(e) => setChallengeChannelTimeout(e.target.value)}
                className={`mt-1 block w-full px-3 py-2 rounded bg-canvas-bg-subtle text-canvas-text border outline-none ${
                  isTimeoutInRange(challengeChannelTimeout) ? 'border-canvas-border' : 'border-red-500'
                }`}
              />
            </label>
            <label className="block text-sm text-canvas-text">
              Unroll timeout (blocks, {MIN_TIMEOUT_BLOCKS}–{MAX_TIMEOUT_BLOCKS})
              <input
                type="number"
                min={MIN_TIMEOUT_BLOCKS}
                max={MAX_TIMEOUT_BLOCKS}
                value={challengeUnrollTimeout}
                onChange={(e) => setChallengeUnrollTimeout(e.target.value)}
                className={`mt-1 block w-full px-3 py-2 rounded bg-canvas-bg-subtle text-canvas-text border outline-none ${
                  isTimeoutInRange(challengeUnrollTimeout) ? 'border-canvas-border' : 'border-red-500'
                }`}
              />
            </label>
          </div>
          {!timeoutsValid && (
            <p className="text-sm text-red-500">
              Timeouts must be between {MIN_TIMEOUT_BLOCKS} and {MAX_TIMEOUT_BLOCKS} blocks.
            </p>
          )}
          <div className="flex gap-2">
            <Button variant="solid" color="primary" size="sm" onClick={submitChallenge} disabled={!timeoutsValid}>
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
            const isMe = player.id === publicId;
            const isUnavailable = player.status === 'playing' || player.status === 'busy';

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

                {isUnavailable ? (
                  <span className="text-sm text-canvas-text italic">
                    {player.status === 'playing' ? `Playing vs ${player.opponent_alias}` : 'In Session'}
                  </span>
                ) : !isMe && (
                  <Button
                    variant="solid"
                    color="primary"
                    size="sm"
                    disabled={reconnectBlocked || !isConnected || challengeSent || !!challengeTarget || iAmUnavailable}
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
  const symmetric = challenge.challenger_amount === challenge.target_amount;
  return (
    <div className="mb-4 p-4 rounded-lg theme-force-light bg-white border border-canvas-border">
      <p className="text-canvas-text-contrast font-medium mb-2">
        <strong>{challenge.from_alias}</strong> challenges you
      </p>
      <p className="text-sm text-canvas-text mb-3">
        {symmetric ? (
          <>Buy-in: {formatAmount(challenge.challenger_amount)} each</>
        ) : (
          <>
            Their buy-in: {formatAmount(challenge.challenger_amount)}
            <br />Your buy-in: {formatAmount(challenge.target_amount)}
          </>
        )}
        {challenge.channel_timeout && <><br />Channel timeout: {challenge.channel_timeout} blocks</>}
        {challenge.unroll_timeout && <><br />Unroll timeout: {challenge.unroll_timeout} blocks</>}
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
