import { useState, useEffect, useCallback, useRef } from 'react';
import io, { Socket } from 'socket.io-client';

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

export function useLobbySocket(
  lobbyUrl: string,
  uniqueId: string,
  sessionId: string,
  alias?: string,
) {
  const [players, setPlayers] = useState<Player[]>([]);
  const [pendingChallenge, setPendingChallenge] = useState<ChallengeReceived | null>(null);
  const [challengeSent, setChallengeSent] = useState(false);
  const socketRef = useRef<Socket>(undefined);
  const aliasRef = useRef(alias);

  useEffect(() => {
    aliasRef.current = alias;
  }, [alias]);

  useEffect(() => {
    if (!uniqueId) return;

    const socket = io(lobbyUrl, {
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 30000,
      randomizationFactor: 0.5,
    });
    socketRef.current = socket;

    let joined = false;
    let lastTrackerHeardFrom = Date.now();
    const joinPayload = () => ({
      id: uniqueId,
      session_id: sessionId,
      ...(aliasRef.current?.trim() ? { alias: aliasRef.current.trim() } : {}),
    });

    socket.on('connect', () => {
      lastTrackerHeardFrom = Date.now();
      if (joined) {
        socket.emit('join', joinPayload());
      }
    });

    socket.emit('join', joinPayload());
    joined = true;

    socket.on('tracker_ping', () => {
      lastTrackerHeardFrom = Date.now();
      socket.emit('tracker_pong');
    });

    socket.on('tracker_pong', () => {
      lastTrackerHeardFrom = Date.now();
    });

    socket.on('lobby_update', (q: Player[]) => {
      lastTrackerHeardFrom = Date.now();
      setPlayers(q);
    });

    socket.on('challenge_received', (c: ChallengeReceived) => {
      lastTrackerHeardFrom = Date.now();
      setPendingChallenge(c);
    });

    socket.on('challenge_resolved', (r: { challenge_id: string; accepted: boolean }) => {
      lastTrackerHeardFrom = Date.now();
      setChallengeSent(false);
      if (!r.accepted) {
        console.log('[lobby] challenge declined');
      }
    });

    const pingTimer = setInterval(() => {
      socket.emit('tracker_ping');
      if (Date.now() - lastTrackerHeardFrom > 60_000) {
        console.warn('[lobby] tracker liveness timeout, disconnecting');
        socket.disconnect();
      }
    }, 15_000);

    return () => {
      clearInterval(pingTimer);
      socket.emit('leave', { id: uniqueId });
      socket.disconnect();
    };
  }, [uniqueId, lobbyUrl, sessionId]);

  const sendChallenge = useCallback(
    (targetId: string, game: string, amount: string, perGame: string) => {
      socketRef.current?.emit('challenge', { target_id: targetId, game, amount, per_game: perGame });
      setChallengeSent(true);
    },
    [],
  );

  const acceptChallenge = useCallback(
    (challengeId: string) => {
      socketRef.current?.emit('challenge_accept', { challenge_id: challengeId });
      setPendingChallenge(null);
    },
    [],
  );

  const declineChallenge = useCallback(
    (challengeId: string) => {
      socketRef.current?.emit('challenge_decline', { challenge_id: challengeId });
      setPendingChallenge(null);
    },
    [],
  );

  const setLobbyAlias = useCallback(
    async (id: string, newAlias: string) => {
      await fetch(`${lobbyUrl}/lobby/change-alias`, {
        method: 'POST',
        body: JSON.stringify({ id, newAlias }),
        headers: { 'Content-Type': 'application/json' },
      });
    },
    [lobbyUrl],
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
