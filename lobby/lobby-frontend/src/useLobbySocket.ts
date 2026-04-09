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
  | { type: 'challenge_resolved'; challenge_id: string | null; accepted: boolean }
  | { type: 'keepalive' }
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
  const [lobbyUpdateReceived, setLobbyUpdateReceived] = useState(false);
  const [pendingChallenge, setPendingChallenge] = useState<ChallengeReceived | null>(null);
  const [challengeSent, setChallengeSent] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [hasConnected, setHasConnected] = useState(false);
  const [reconnectBlocked, setReconnectBlocked] = useState(false);
  const uniqueIdRef = useRef(uniqueId);
  const aliasRef = useRef(alias);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const keepaliveTimerRef = useRef<number | null>(null);
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
        setHasConnected(true);
        ws.send(JSON.stringify(joinPayload));
        if (pendingOutboundRef.current.length > 0) {
          const queued = pendingOutboundRef.current.splice(0, pendingOutboundRef.current.length);
          for (const payload of queued) {
            ws.send(JSON.stringify(payload));
          }
        }
        if (keepaliveTimerRef.current !== null) clearInterval(keepaliveTimerRef.current);
        keepaliveTimerRef.current = window.setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'keepalive' }));
          }
        }, 15_000);
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
            setLobbyUpdateReceived(true);
            break;
          case 'challenge_received':
            setPendingChallenge(msg);
            break;
          case 'challenge_resolved':
            setChallengeSent(false);
            setPendingChallenge((prev) =>
              prev && msg.challenge_id && prev.challenge_id === msg.challenge_id ? null : prev,
            );
            break;
          case 'error':
            if (msg.error) console.warn('[lobby] tracker error:', msg.error);
            break;
          case 'keepalive':
            break;
          default:
            break;
        }
      };

      ws.onclose = (event: CloseEvent) => {
        if (keepaliveTimerRef.current !== null) {
          clearInterval(keepaliveTimerRef.current);
          keepaliveTimerRef.current = null;
        }
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
      if (keepaliveTimerRef.current !== null) {
        clearInterval(keepaliveTimerRef.current);
        keepaliveTimerRef.current = null;
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

  const cancelChallenge = useCallback(() => {
    send({ type: 'challenge_cancel', from_id: uniqueIdRef.current });
    setChallengeSent(false);
  }, [send]);

  const setLobbyAlias = useCallback(
    async (id: string, newAlias: string) => {
      send({ type: 'change_alias', id, newAlias });
    },
    [send],
  );

    const isReconnecting = hasConnected && !isConnected;

  return {
    players,
    lobbyUpdateReceived,
    pendingChallenge,
    challengeSent,
    isConnected,
    isReconnecting,
    reconnectBlocked,
    sendChallenge,
    acceptChallenge,
    declineChallenge,
    cancelChallenge,
    setLobbyAlias,
  };
}
