import { useState, useEffect, useCallback, useRef } from 'react';
import io, { Socket } from 'socket.io-client';

export const GameTypes = {
  CALIFORNIA_POKER: 'california_poker',
  KRUNK: 'krunk',
  EXOTIC_POKER: 'exotic_poker',
};
export type GameType = 'california_poker' | 'krunk' | 'exotic_poker';

export interface GameDefinition {
  game: string;
  target: string;
  expiration: number;
}

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

export interface ChallengeResolved {
  challenge_id: string;
  accepted: boolean;
}

export interface UseLobbySocketReturn {
  players: Player[];
  pendingChallenge: ChallengeReceived | null;
  challengeSent: boolean;
  sendChallenge: (targetId: string, game: string, amount: string, perGame: string) => void;
  acceptChallenge: (challengeId: string) => void;
  declineChallenge: (challengeId: string) => void;
  setLobbyAlias: (id: string, alias: string) => void;
  uniqueId: string;
  lobbyGames: GameDefinition[];
}

export function useLobbySocket(
  lobbyUrl: string,
  uniqueId: string,
  sessionId: string,
): UseLobbySocketReturn {
  const [players, setPlayers] = useState<Player[]>([]);
  const [pendingChallenge, setPendingChallenge] = useState<ChallengeReceived | null>(null);
  const [challengeSent, setChallengeSent] = useState(false);
  const [lobbyGames, setLobbyGames] = useState<GameDefinition[]>([]);
  const socketRef = useRef<Socket>(undefined);

  useEffect(() => {
    if (!uniqueId) return;

    const socket = io(lobbyUrl);
    socketRef.current = socket;

    socket.emit('join', { id: uniqueId, session_id: sessionId });

    socket.on('lobby_update', (q: Player[]) => setPlayers(q));
    socket.on('game_update', (g: GameDefinition[]) => setLobbyGames(g));

    socket.on('challenge_received', (c: ChallengeReceived) => {
      setPendingChallenge(c);
    });

    socket.on('challenge_resolved', (r: ChallengeResolved) => {
      setChallengeSent(false);
      if (!r.accepted) {
        console.log('[lobby] challenge declined');
      }
    });

    return () => {
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
    uniqueId,
    lobbyGames,
  };
}
