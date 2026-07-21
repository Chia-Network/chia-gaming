import { useState, useEffect, useCallback, useRef } from 'react';

export interface Player {
  id: string;
  alias: string;
  walletAddress?: string;
  status: 'waiting' | 'playing' | 'busy';
  opponent_alias?: string;
  parameters: any;
}

export interface ChallengeReceived {
  challenge_id: string;
  from_id: string;
  from_alias: string;
  challenger_amount: string;
  target_amount: string;
  channel_timeout?: string;
  unroll_timeout?: string;
}

type InboundMessage =
  | { type: 'hub_update'; players: Player[] }
  | { type: 'joined'; id: string; alias: string }
  | { type: 'challenge_received'; challenge_id: string; from_id: string; from_alias: string; challenger_amount: string; target_amount: string; channel_timeout?: string; unroll_timeout?: string }
  | { type: 'challenge_resolved'; challenge_id: string | null; accepted: boolean }
  | { type: 'alias_result'; alias: string | null }
  | { type: 'keepalive' }
  | { type: 'error'; error?: string };

let nextHubConnId = 1;

export function hubHsLog(event: string, fields?: Record<string, unknown>) {
  const parts = [
    '[hub-hs]',
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
  url.pathname = '/ws/hub';
  url.search = '';
  url.hash = '';
  return url.toString();
}

export function useHubSocket(
  hubUrl: string,
  uniqueId: string,
  sessionId: string,
) {
  const connIdRef = useRef<number>(nextHubConnId++);
  const [players, setPlayers] = useState<Player[]>([]);
  const [hubUpdateReceived, setHubUpdateReceived] = useState(false);
  const [pendingChallenge, setPendingChallenge] = useState<ChallengeReceived | null>(null);
  const [challengeSent, setChallengeSent] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [hasConnected, setHasConnected] = useState(false);
  const [reconnectBlocked, setReconnectBlocked] = useState(false);
  const [savedAlias, setSavedAlias] = useState<string | null>(null);
  const [aliasLoaded, setAliasLoaded] = useState(false);
  const [publicId, setPublicId] = useState<string | null>(null);
  const uniqueIdRef = useRef(uniqueId);
  const wsRef = useRef<WebSocket | null>(null);
  const pendingWsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const keepaliveTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const closingRef = useRef(false);
  const pendingOutboundRef = useRef<Record<string, unknown>[]>([]);
  const joinedAliasRef = useRef<string | null>(null);

  useEffect(() => { uniqueIdRef.current = uniqueId; }, [uniqueId]);

  const send = useCallback((payload: Record<string, unknown>, queueIfClosed = true) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      if (queueIfClosed) {
        pendingOutboundRef.current.push(payload);
        hubHsLog('outbound_buffered', {
          conn_id: connIdRef.current,
          session_id: sessionId,
          type: String(payload.type ?? 'unknown'),
          buffered_len: pendingOutboundRef.current.length,
        });
      }
      return false;
    }
    hubHsLog('outbound_sent', {
      conn_id: connIdRef.current,
      session_id: sessionId,
      type: String(payload.type ?? 'unknown'),
    });
    ws.send(JSON.stringify(payload));
    return true;
  }, [sessionId]);

  useEffect(() => {
    if (!uniqueId) return;

    const wsUrl = toWsUrl(hubUrl);
    hubHsLog('connection_init', {
      conn_id: connIdRef.current,
      session_id: sessionId,
      unique_id: uniqueId,
      ws_url: wsUrl,
    });

    closingRef.current = false;
    setReconnectBlocked(false);

    // Monotonic backoff: stay out of Firefox's failure queue during cutovers.
    // Connect timeout is long for the same reason: FF may delay the TCP
    // attempt for seconds after a reload interrupt; aborting early worsens it.
    const RECONNECT_DELAYS = [5000, 10000, 20000, 30000, 60000];
    const CONNECT_TIMEOUT_MS = 30_000;

    const connect = () => {
      if (closingRef.current) return;
      hubHsLog('connect_start', {
        conn_id: connIdRef.current,
        session_id: sessionId,
        ws_url: wsUrl,
      });
      const ws = new WebSocket(wsUrl);
      const connectStartedAt = Date.now();
      pendingWsRef.current = ws;

      const connectTimeout = window.setTimeout(() => {
        if (ws.readyState !== WebSocket.CONNECTING) return;
        hubHsLog('ws_connect_timeout', {
          conn_id: connIdRef.current,
          session_id: sessionId,
          elapsed_ms: Date.now() - connectStartedAt,
        });
        try { ws.close(); } catch { /* ignore */ }
      }, CONNECT_TIMEOUT_MS);

      ws.onopen = () => {
        clearTimeout(connectTimeout);
        if (pendingWsRef.current !== ws) return;
        pendingWsRef.current = null;
        wsRef.current = ws;
        reconnectAttemptRef.current = 0;
        hubHsLog('ws_open', {
          conn_id: connIdRef.current,
          session_id: sessionId,
          ready_state: ws.readyState,
          connect_elapsed_ms: Date.now() - connectStartedAt,
        });
        setIsConnected(true);
        setHasConnected(true);
        ws.send(JSON.stringify({ type: 'get_alias', session_id: sessionId }));
        hubHsLog('get_alias_send', {
          conn_id: connIdRef.current,
          session_id: sessionId,
          unique_id: uniqueIdRef.current,
        });
        if (joinedAliasRef.current) {
          const payload = {
            type: 'join',
            session_id: sessionId,
            alias: joinedAliasRef.current,
          };
          hubHsLog('join_resend_on_open', {
            conn_id: connIdRef.current,
            session_id: sessionId,
            alias_len: joinedAliasRef.current.length,
          });
          ws.send(JSON.stringify(payload));
        }
        if (pendingOutboundRef.current.length > 0) {
          const queued = pendingOutboundRef.current.splice(0, pendingOutboundRef.current.length);
          hubHsLog('flush_buffered_outbound', {
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
          case 'joined':
            setPublicId(msg.id);
            setSavedAlias(msg.alias);
            break;
          case 'hub_update':
            if (!Array.isArray(msg.players)) {
              console.error('[hub] hub_update missing players array', msg);
              break;
            }
            hubHsLog('hub_update_recv', {
              conn_id: connIdRef.current,
              session_id: sessionId,
              players: msg.players.length,
            });
            setPlayers(msg.players);
            setHubUpdateReceived(true);
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
            hubHsLog('alias_result_recv', {
              conn_id: connIdRef.current,
              session_id: sessionId,
              has_alias: msg.alias !== null,
            });
            setSavedAlias(msg.alias);
            setAliasLoaded(true);
            break;
          case 'error':
            if (msg.error) console.warn('[hub] hub error:', msg.error);
            break;
          case 'keepalive':
            break;
          default:
            break;
        }
      };

      ws.onclose = (event: CloseEvent) => {
        clearTimeout(connectTimeout);
        if (keepaliveTimerRef.current !== null) {
          clearInterval(keepaliveTimerRef.current);
          keepaliveTimerRef.current = null;
        }
        const isCurrentWs = wsRef.current === ws || pendingWsRef.current === ws;
        if (!isCurrentWs) return;
        hubHsLog('ws_close', {
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
        pendingWsRef.current = null;
        if (closingRef.current) return;
        if (event.code === 4001) {
          setReconnectBlocked(true);
          return;
        }
        const base = RECONNECT_DELAYS[
          Math.min(reconnectAttemptRef.current, RECONNECT_DELAYS.length - 1)
        ];
        const delay = Math.round(base * (0.75 + Math.random() * 0.5));
        reconnectAttemptRef.current++;
        hubHsLog('reconnect_timer_set', {
          conn_id: connIdRef.current,
          session_id: sessionId,
          delay_ms: delay,
          attempt: reconnectAttemptRef.current,
        });
        reconnectTimerRef.current = window.setTimeout(() => {
          hubHsLog('reconnect_timer_fire', {
            conn_id: connIdRef.current,
            session_id: sessionId,
          });
          connect();
        }, delay);
      };

      ws.onerror = () => {
        clearTimeout(connectTimeout);
        const isCurrentWs = wsRef.current === ws || pendingWsRef.current === ws;
        if (!isCurrentWs) return;
        hubHsLog('ws_error', {
          conn_id: connIdRef.current,
          session_id: sessionId,
          connect_elapsed_ms: Date.now() - connectStartedAt,
        });
        try { ws.close(); } catch { /* ignore */ }
      };
    };

    connect();

    const onBeforeUnload = () => {
      try { wsRef.current?.close(); } catch { /* ignore */ }
      try { pendingWsRef.current?.close(); } catch { /* ignore */ }
    };
    window.addEventListener('beforeunload', onBeforeUnload);

    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      closingRef.current = true;
      hubHsLog('connection_cleanup', {
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
      try { wsRef.current?.close(); } catch { /* ignore */ }
      try { pendingWsRef.current?.close(); } catch { /* ignore */ }
      wsRef.current = null;
      pendingWsRef.current = null;
      pendingOutboundRef.current = [];
    };
  }, [uniqueId, hubUrl, sessionId, send]);

  const joinHub = useCallback(
    (alias: string) => {
      const trimmed = alias.trim();
      if (!trimmed) return;
      joinedAliasRef.current = trimmed;
      hubHsLog('join_call', {
        conn_id: connIdRef.current,
        session_id: sessionId,
        alias_len: trimmed.length,
      });
      send({
        type: 'join',
        session_id: sessionId,
        alias: trimmed,
      }, false);
    },
    [send, sessionId],
  );

  const setAlias = useCallback(
    (alias: string) => {
      send({ type: 'set_alias', session_id: sessionId, alias });
    },
    [send, sessionId],
  );

  const sendChallenge = useCallback(
    (targetId: string, challengerAmount: string, targetAmount: string, channelTimeout?: string, unrollTimeout?: string) => {
      const payload: Record<string, unknown> = {
        type: 'challenge',
        target_id: targetId,
        challenger_amount: challengerAmount,
        target_amount: targetAmount,
      };
      if (channelTimeout) payload.channel_timeout = channelTimeout;
      if (unrollTimeout) payload.unroll_timeout = unrollTimeout;
      send(payload);
      setChallengeSent(true);
    },
    [send],
  );

  const acceptChallenge = useCallback(
    (challengeId: string) => {
      send({
        type: 'challenge_accept',
        challenge_id: challengeId,
      });
      // Clear pending only on challenge_resolved from the hub.
    },
    [send],
  );

  const declineChallenge = useCallback(
    (challengeId: string) => {
      send({
        type: 'challenge_decline',
        challenge_id: challengeId,
      });
      // Clear pending only on challenge_resolved from the hub.
    },
    [send],
  );

  const cancelChallenge = useCallback(() => {
    send({ type: 'challenge_cancel' });
    setChallengeSent(false);
  }, [send]);

  const setHubAlias = useCallback(
    async (id: string, newAlias: string) => {
      const trimmed = newAlias.trim();
      if (id === publicId && trimmed) {
        joinedAliasRef.current = trimmed;
      }
      send({ type: 'change_alias', newAlias: trimmed });
    },
    [send, publicId],
  );

  const isReconnecting = hasConnected && !isConnected;

  return {
    players,
    publicId,
    hubUpdateReceived,
    pendingChallenge,
    challengeSent,
    isConnected,
    isReconnecting,
    reconnectBlocked,
    savedAlias,
    aliasLoaded,
    joinHub,
    setAlias,
    sendChallenge,
    acceptChallenge,
    declineChallenge,
    cancelChallenge,
    setHubAlias,
  };
}
