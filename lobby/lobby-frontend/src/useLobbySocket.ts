import { useState, useEffect, useCallback, useRef } from 'react';

export interface Player {
  id: string;
  alias: string;
  session_id: string;
  game: string;
  walletAddress?: string;
  status: 'waiting' | 'playing';
  opponent_alias?: string;
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
  | { type: 'alias_result'; alias: string | null }
  | { type: 'keepalive' }
  | { type: 'error'; error?: string };

let nextLobbyConnId = 1;

export function lobbyHsLog(event: string, fields?: Record<string, unknown>) {
  const parts = [
    '[lobby-hs]',
    `ev=${event}`,
    `iso=${new Date().toISOString()}`,
    `mono_ms=${(typeof performance !== 'undefined' ? performance.now() : 0).toFixed(1)}`,
  ];
  if (fields) {
    for (const [k, v] of Object.entries(fields)) {
      parts.push(`${k}=${String(v)}`);
    }
  }
  console.log(parts.join(' '));
}

function toWsUrl(input: string): string {
  const url = new URL(input);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/ws/lobby';
  url.search = '';
  url.hash = '';
  return url.toString();
}

export function useLobbySocket(
  lobbyUrl: string,
  uniqueId: string,
  sessionId: string,
) {
  const connIdRef = useRef<number>(nextLobbyConnId++);
  const [players, setPlayers] = useState<Player[]>([]);
  const [lobbyUpdateReceived, setLobbyUpdateReceived] = useState(false);
  const [pendingChallenge, setPendingChallenge] = useState<ChallengeReceived | null>(null);
  const [challengeSent, setChallengeSent] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [hasConnected, setHasConnected] = useState(false);
  const [reconnectBlocked, setReconnectBlocked] = useState(false);
  const [savedAlias, setSavedAlias] = useState<string | null>(null);
  const [aliasLoaded, setAliasLoaded] = useState(false);
  const uniqueIdRef = useRef(uniqueId);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const keepaliveTimerRef = useRef<number | null>(null);
  const closingRef = useRef(false);
  const pendingOutboundRef = useRef<Record<string, unknown>[]>([]);

  useEffect(() => { uniqueIdRef.current = uniqueId; }, [uniqueId]);

  const send = useCallback((payload: Record<string, unknown>, queueIfClosed = true) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      if (queueIfClosed) {
        pendingOutboundRef.current.push(payload);
        lobbyHsLog('outbound_buffered', {
          conn_id: connIdRef.current,
          session_id: sessionId,
          type: String(payload.type ?? 'unknown'),
          buffered_len: pendingOutboundRef.current.length,
        });
      }
      return false;
    }
    lobbyHsLog('outbound_sent', {
      conn_id: connIdRef.current,
      session_id: sessionId,
      type: String(payload.type ?? 'unknown'),
    });
    ws.send(JSON.stringify(payload));
    return true;
  }, [sessionId]);

  useEffect(() => {
    if (!uniqueId) return;

    const wsUrl = toWsUrl(lobbyUrl);
    lobbyHsLog('connection_init', {
      conn_id: connIdRef.current,
      session_id: sessionId,
      unique_id: uniqueId,
      ws_url: wsUrl,
    });

    closingRef.current = false;
    setReconnectBlocked(false);

    const connect = () => {
      if (closingRef.current) return;
      lobbyHsLog('connect_start', {
        conn_id: connIdRef.current,
        session_id: sessionId,
        ws_url: wsUrl,
      });
      const ws = new WebSocket(wsUrl);
      const connectStartedAt = Date.now();
      const waitThresholdsMs = [2_000, 5_000, 10_000, 20_000, 30_000];
      let waitThresholdIdx = 0;
      const openWaitTimer = window.setInterval(() => {
        if (ws.readyState !== WebSocket.CONNECTING) return;
        const elapsedMs = Date.now() - connectStartedAt;
        while (waitThresholdIdx < waitThresholdsMs.length && elapsedMs >= waitThresholdsMs[waitThresholdIdx]) {
          lobbyHsLog('ws_open_wait', {
            conn_id: connIdRef.current,
            session_id: sessionId,
            elapsed_ms: elapsedMs,
            threshold_ms: waitThresholdsMs[waitThresholdIdx],
            ready_state: ws.readyState,
          });
          waitThresholdIdx += 1;
        }
      }, 250);
      wsRef.current = ws;

      ws.onopen = () => {
        clearInterval(openWaitTimer);
        if (wsRef.current !== ws) return;
        lobbyHsLog('ws_open', {
          conn_id: connIdRef.current,
          session_id: sessionId,
          ready_state: ws.readyState,
          connect_elapsed_ms: Date.now() - connectStartedAt,
        });
        setIsConnected(true);
        setHasConnected(true);
        ws.send(JSON.stringify({ type: 'get_alias', id: uniqueIdRef.current }));
        lobbyHsLog('get_alias_send', {
          conn_id: connIdRef.current,
          session_id: sessionId,
          unique_id: uniqueIdRef.current,
        });
        if (pendingOutboundRef.current.length > 0) {
          const queued = pendingOutboundRef.current.splice(0, pendingOutboundRef.current.length);
          lobbyHsLog('flush_buffered_outbound', {
            conn_id: connIdRef.current,
            session_id: sessionId,
            count: queued.length,
          });
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
            lobbyHsLog('lobby_update_recv', {
              conn_id: connIdRef.current,
              session_id: sessionId,
              players: (msg.players ?? []).length,
            });
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
          case 'alias_result':
            lobbyHsLog('alias_result_recv', {
              conn_id: connIdRef.current,
              session_id: sessionId,
              has_alias: msg.alias !== null,
            });
            setSavedAlias(msg.alias);
            setAliasLoaded(true);
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
        clearInterval(openWaitTimer);
        if (keepaliveTimerRef.current !== null) {
          clearInterval(keepaliveTimerRef.current);
          keepaliveTimerRef.current = null;
        }
        if (wsRef.current !== ws) return;
        lobbyHsLog('ws_close', {
          conn_id: connIdRef.current,
          session_id: sessionId,
          code: event.code,
          reason: event.reason || '',
          clean: event.wasClean,
          closing: closingRef.current,
          connect_elapsed_ms: Date.now() - connectStartedAt,
        });
        setIsConnected(false);
        wsRef.current = null;
        if (closingRef.current) return;
        if (event.code === 4001) {
          setReconnectBlocked(true);
          return;
        }
        lobbyHsLog('reconnect_timer_set', {
          conn_id: connIdRef.current,
          session_id: sessionId,
          delay_ms: 1000,
        });
        reconnectTimerRef.current = window.setTimeout(() => {
          lobbyHsLog('reconnect_timer_fire', {
            conn_id: connIdRef.current,
            session_id: sessionId,
          });
          connect();
        }, 1000);
      };

      ws.onerror = () => {
        clearInterval(openWaitTimer);
        if (wsRef.current !== ws) return;
        lobbyHsLog('ws_error', {
          conn_id: connIdRef.current,
          session_id: sessionId,
          connect_elapsed_ms: Date.now() - connectStartedAt,
        });
        try { ws.close(); } catch {}
      };
    };

    connect();

    return () => {
      closingRef.current = true;
      lobbyHsLog('connection_cleanup', {
        conn_id: connIdRef.current,
        session_id: sessionId,
      });
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

  const joinLobby = useCallback(
    (alias: string) => {
      lobbyHsLog('join_call', {
        conn_id: connIdRef.current,
        session_id: sessionId,
        alias_len: alias.trim().length,
      });
      send({
        type: 'join',
        id: uniqueIdRef.current,
        session_id: sessionId,
        alias: alias.trim(),
      });
    },
    [send, sessionId],
  );

  const setAlias = useCallback(
    (alias: string) => {
      send({ type: 'set_alias', id: uniqueIdRef.current, alias });
    },
    [send],
  );

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
    savedAlias,
    aliasLoaded,
    joinLobby,
    setAlias,
    sendChallenge,
    acceptChallenge,
    declineChallenge,
    cancelChallenge,
    setLobbyAlias,
  };
}
