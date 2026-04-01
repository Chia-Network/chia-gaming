import { useState, useEffect, useCallback, useRef } from 'react';

export interface Player {
  id: string;
  alias: string;
  session_id: string;
  game: string;
  walletAddress?: string;
  parameters: any;
}

export interface ChallengeReceived {
  challenge_id: string;
  from_id: string;
  from_alias: string;
  game: string;
  amount: string;
  per_game: string;
}

function postJSON(url: string, body: unknown): void {
  fetch(url, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  }).catch((err) => console.error('[lobby] POST failed:', url, err));
}

export function useLobbySocket(
  lobbyUrl: string,
  uniqueId: string,
  sessionId: string,
  alias?: string,
) {
  const [players, setPlayers] = useState<Player[]>([]);
  const [pendingChallenge, setPendingChallenge] = useState<ChallengeReceived | null>(null);
  const [challengeSent, setChallengeSent] = useState(false);
  const lobbyUrlRef = useRef(lobbyUrl);
  const aliasRef = useRef(alias);
  const uniqueIdRef = useRef(uniqueId);

  useEffect(() => { aliasRef.current = alias; }, [alias]);
  useEffect(() => { lobbyUrlRef.current = lobbyUrl; }, [lobbyUrl]);
  useEffect(() => { uniqueIdRef.current = uniqueId; }, [uniqueId]);

  useEffect(() => {
    if (!uniqueId) return;

    const joinPayload = {
      id: uniqueId,
      session_id: sessionId,
      ...(alias?.trim() ? { alias: alias.trim() } : {}),
    };
    const sendJoin = () => {
      postJSON(`${lobbyUrl}/lobby/join`, joinPayload);
    };
    sendJoin();

    const es = new EventSource(`${lobbyUrl}/lobby/events?player_id=${encodeURIComponent(uniqueId)}`);
    es.onopen = () => {
      // Re-assert lobby membership after SSE reconnects (e.g. tracker restart).
      sendJoin();
    };

    es.addEventListener('lobby_update', (e: MessageEvent) => {
      setPlayers(JSON.parse(e.data));
    });

    es.addEventListener('challenge_received', (e: MessageEvent) => {
      setPendingChallenge(JSON.parse(e.data));
    });

    es.addEventListener('challenge_resolved', (e: MessageEvent) => {
      const r = JSON.parse(e.data);
      setChallengeSent(false);
      if (!r.accepted) {
        console.log('[lobby] challenge declined');
      }
    });

    es.onerror = () => {
      console.warn('[lobby] SSE connection error, will auto-reconnect');
    };

    return () => {
      postJSON(`${lobbyUrl}/lobby/leave`, { id: uniqueId });
      es.close();
    };
  }, [uniqueId, lobbyUrl, sessionId, alias]);

  const sendChallenge = useCallback(
    (targetId: string, game: string, amount: string, perGame: string) => {
      postJSON(`${lobbyUrlRef.current}/lobby/challenge`, {
        from_id: uniqueIdRef.current,
        target_id: targetId,
        game,
        amount,
        per_game: perGame,
      });
      setChallengeSent(true);
    },
    [],
  );

  const acceptChallenge = useCallback(
    (challengeId: string) => {
      postJSON(`${lobbyUrlRef.current}/lobby/challenge/accept`, {
        challenge_id: challengeId,
        accepter_id: uniqueIdRef.current,
      });
      setPendingChallenge(null);
    },
    [],
  );

  const declineChallenge = useCallback(
    (challengeId: string) => {
      postJSON(`${lobbyUrlRef.current}/lobby/challenge/decline`, {
        challenge_id: challengeId,
      });
      setPendingChallenge(null);
    },
    [],
  );

  const setLobbyAlias = useCallback(
    async (id: string, newAlias: string) => {
      await fetch(`${lobbyUrlRef.current}/lobby/change-alias`, {
        method: 'POST',
        body: JSON.stringify({ id, newAlias }),
        headers: { 'Content-Type': 'application/json' },
      });
    },
    [],
  );

  return {
    players,
    pendingChallenge,
    challengeSent,
    sendChallenge,
    acceptChallenge,
    declineChallenge,
    setLobbyAlias,
  };
}
