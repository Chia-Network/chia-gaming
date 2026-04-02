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

type InboundMessage =
  | { type: 'lobby_update'; players: Player[] }
  | { type: 'challenge_received'; challenge_id: string; from_id: string; from_alias: string; game: string; amount: string; per_game: string }
  | { type: 'challenge_resolved'; challenge_id: string; accepted: boolean }
  | { type: 'game_update' }
  | { type: 'error'; error?: string };

function toWsUrl(input: string): string {
  const url = new URL(input);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/ws';
  url.search = '';
  url.hash = '';
  return url.toString();
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
  const [isConnected, setIsConnected] = useState(false);
  const [reconnectBlocked, setReconnectBlocked] = useState(false);
  const uniqueIdRef = useRef(uniqueId);
  const aliasRef = useRef(alias);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const closingRef = useRef(false);
  const pendingOutboundRef = useRef<Record<string, unknown>[]>([]);

  useEffect(() => { uniqueIdRef.current = uniqueId; }, [uniqueId]);
  useEffect(() => { aliasRef.current = alias; }, [alias]);

  const send = useCallback((payload: Record<string, unknown>, queueIfClosed = true) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      if (queueIfClosed) pendingOutboundRef.current.push(payload);
      return false;
    }
    ws.send(JSON.stringify(payload));
    return true;
  }, []);

  useEffect(() => {
    if (!uniqueId) return;

    const wsUrl = toWsUrl(lobbyUrl);
    const joinPayload: Record<string, unknown> = {
      type: 'join',
      id: uniqueId,
      session_id: sessionId,
      ...(aliasRef.current?.trim() ? { alias: aliasRef.current.trim() } : {}),
    };

    closingRef.current = false;
    setReconnectBlocked(false);

    const connect = () => {
      if (closingRef.current) return;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (wsRef.current !== ws) return;
        setIsConnected(true);
        ws.send(JSON.stringify(joinPayload));
        if (pendingOutboundRef.current.length > 0) {
          const queued = pendingOutboundRef.current.splice(0, pendingOutboundRef.current.length);
          for (const payload of queued) {
            ws.send(JSON.stringify(payload));
          }
        }
      };

      ws.onmessage = (event: MessageEvent<string>) => {
        if (wsRef.current !== ws) return;
        let msg: InboundMessage | null = null;
        try {
          msg = JSON.parse(event.data) as InboundMessage;
        } catch {
          return;
        }
        if (!msg || typeof msg !== 'object' || !('type' in msg)) return;
        switch (msg.type) {
          case 'lobby_update':
            setPlayers(msg.players ?? []);
            break;
          case 'challenge_received':
            setPendingChallenge(msg);
            break;
          case 'challenge_resolved':
            setChallengeSent(false);
            if (!msg.accepted) {
              console.log('[lobby] challenge declined');
            }
            break;
          case 'error':
            if (msg.error) console.warn('[lobby] tracker error:', msg.error);
            break;
          default:
            break;
        }
      };

      ws.onclose = (event: CloseEvent) => {
        if (wsRef.current !== ws) return;
        setIsConnected(false);
        wsRef.current = null;
        if (closingRef.current) return;
        if (event.code === 4001) {
          setReconnectBlocked(true);
          return;
        }
        reconnectTimerRef.current = window.setTimeout(connect, 1000);
      };

      ws.onerror = () => {
        if (wsRef.current !== ws) return;
        try { ws.close(); } catch {}
      };
    };

    connect();

    return () => {
      closingRef.current = true;
      setIsConnected(false);
      if (reconnectTimerRef.current !== null) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      send({ type: 'leave', id: uniqueId }, false);
      try { wsRef.current?.close(); } catch {}
      wsRef.current = null;
      pendingOutboundRef.current = [];
    };
  }, [uniqueId, lobbyUrl, sessionId, send]);

  const sendChallenge = useCallback(
    (targetId: string, game: string, amount: string, perGame: string) => {
      send({
        type: 'challenge',
        from_id: uniqueIdRef.current,
        target_id: targetId,
        game,
        amount,
        per_game: perGame,
      });
      setChallengeSent(true);
    },
    [send],
  );

  const acceptChallenge = useCallback(
    (challengeId: string) => {
      send({
        type: 'challenge_accept',
        challenge_id: challengeId,
        accepter_id: uniqueIdRef.current,
      });
      setPendingChallenge(null);
    },
    [send],
  );

  const declineChallenge = useCallback(
    (challengeId: string) => {
      send({
        type: 'challenge_decline',
        challenge_id: challengeId,
      });
      setPendingChallenge(null);
    },
    [send],
  );

  const setLobbyAlias = useCallback(
    async (id: string, newAlias: string) => {
      send({ type: 'change_alias', id, newAlias });
    },
    [send],
  );

  return {
    players,
    pendingChallenge,
    challengeSent,
    isConnected,
    reconnectBlocked,
    sendChallenge,
    acceptChallenge,
    declineChallenge,
    setLobbyAlias,
  };
}
