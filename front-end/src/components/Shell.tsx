import { useEffect, useState, useCallback, useRef } from 'react';

import WalletConnectHeading from './WalletConnectHeading';
import GameSession from './GameSession';
import { GameSessionParams, PeerConnectionResult, ChatMessage } from '../types/ChiaGaming';
import { TrackerConnection, MatchedParams, ConnectionStatus } from '../services/TrackerConnection';
import { subscribeDebugLog } from '../services/debugLog';
import {
  getPlayerId,
  getSessionId,
  setBlockchainType as persistBlockchainType,
  getBlockchainType,
  loadSession,
  clearSession,
  hardReset,
  SessionSave,
} from '../hooks/save';
import { blobSingleton } from '../hooks/blobSingleton';
import { walletConnectState } from '../hooks/useWalletConnect';
import { fakeBlockchainInfo } from '../hooks/FakeBlockchainInterface';
import { realBlockchainInfo } from '../hooks/RealBlockchainInterface';
import { setActiveBlockchain } from '../hooks/activeBlockchain';
import { useThemeSyncToIframe } from '../hooks/useThemeSyncToIframe';
import { debugLog } from '../services/debugLog';
import ChatPanel from './ChatPanel';

type TabId = 'tracker' | 'session' | 'chat' | 'game-log' | 'debug-log';

const TAB_DEFS: { id: TabId; label: string }[] = [
  { id: 'tracker', label: 'Tracker' },
  { id: 'session', label: 'Game Session' },
  { id: 'chat', label: 'Chat' },
  { id: 'game-log', label: 'Game Log' },
  { id: 'debug-log', label: 'Debug Log' },
];

const FALLBACK_AMOUNT = 100n;
const FALLBACK_PER_GAME = 10n;

function LogPanel({ lines }: { lines: string[] }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const isNearBottom = useRef(true);

  const handleScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const threshold = 48;
    isNearBottom.current =
      el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
  }, []);

  useEffect(() => {
    if (isNearBottom.current && ref.current) {
      ref.current.scrollTop = ref.current.scrollHeight;
    }
  }, [lines]);

  return (
    <textarea
      ref={ref}
      readOnly
      value={lines.join('\n')}
      onScroll={handleScroll}
      className='w-full h-full resize-none rounded-md border border-canvas-border bg-canvas-bg p-3 text-xs font-mono text-canvas-text focus:outline-none'
    />
  );
}

const Shell = () => {
  const uniqueId = getPlayerId();
  const sessionId = getSessionId();

  const [activeTab, setActiveTab] = useState<TabId>('tracker');
  const [gameParams, setGameParams] = useState<GameSessionParams | null>(null);
  const [peerConn, setPeerConn] = useState<PeerConnectionResult | null>(null);

  const [walletConnected, setWalletConnected] = useState(false);
  const [, setTrackerConnected] = useState<boolean | null>(null);
  const [peerConnected, setPeerConnected] = useState<boolean | null>(null);
  const [pendingRestore, setPendingRestore] = useState<SessionSave | null>(() => loadSession());
  const [restoreDecided, setRestoreDecided] = useState<boolean>(() => !loadSession());
  const [gameLog, setGameLog] = useState<string[]>([]);
  const [debugLogLines, setDebugLogLines] = useState<string[]>([]);

  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [unreadChat, setUnreadChat] = useState(false);
  const [unreadSession, setUnreadSession] = useState(false);
  const [iframeUrl, setIframeUrl] = useState('about:blank');

  const trackerConnRef = useRef<TrackerConnection | null>(null);
  const activeTabRef = useRef<TabId>(activeTab);
  activeTabRef.current = activeTab;
  const sessionSaveRef = useRef<SessionSave | null>(null);
  const activePairingTokenRef = useRef<string | null>(null);
  const blockchainTypeRef = useRef<import('../hooks/save').BlockchainType>('simulator');
  const deferStateUpdate = useCallback((fn: () => void) => {
    if (typeof queueMicrotask === 'function') {
      queueMicrotask(fn);
    } else {
      setTimeout(fn, 0);
    }
  }, []);

  const appendGameLog = useCallback((line: string) => {
    deferStateUpdate(() => {
      setGameLog(prev => [...prev, line]);
    });
  }, [deferStateUpdate]);

  const registerMessageHandler = useCallback((handler: (msgno: number, msg: string) => void, ackHandler: (ack: number) => void, pingHandler: () => void) => {
    if (trackerConnRef.current) {
      trackerConnRef.current.registerMessageHandler(handler, ackHandler, pingHandler);
    }
  }, []);

  useEffect(() => {
    return subscribeDebugLog((line) => {
      deferStateUpdate(() => {
        setDebugLogLines(prev => [...prev, line]);
      });
    });
  }, [deferStateUpdate]);

  useEffect(() => {
    const bcType = getBlockchainType() ?? 'simulator';
    blockchainTypeRef.current = bcType;
    if (bcType === 'walletconnect') {
      setActiveBlockchain(realBlockchainInfo);
    } else {
      setActiveBlockchain(fakeBlockchainInfo);
    }
  }, []);

  // Whether the user has clicked through the initial gate (wallet choice or
  // restore decision).  Only then do we connect to the tracker.
  const [userReady, setUserReady] = useState(false);

  // Fetch tracker URL, set up iframe and TrackerConnection.
  // Runs once the app enters the full UI state.
  useEffect(() => {
    if (!userReady) return;
    let cancelled = false;

    const startSession = (
      conn: TrackerConnection,
      iStarted: boolean,
      amount: bigint,
      perGame: bigint,
      token: string,
      save: SessionSave | null,
      myAlias?: string,
      opponentAlias?: string,
    ) => {
      activePairingTokenRef.current = token;
      sessionSaveRef.current = save;
      const resolvedMyAlias = myAlias ?? save?.myAlias;
      const resolvedOpponentAlias = opponentAlias ?? save?.opponentAlias;
      setGameParams({
        iStarted,
        amount,
        perGameAmount: perGame,
        restoring: save !== null,
        pairingToken: token,
        myAlias: resolvedMyAlias,
        opponentAlias: resolvedOpponentAlias,
      });
      setPeerConn(conn.getPeerConnection());
      if (save) {
        setGameLog(save.gameLog);
        setDebugLogLines(save.debugLog);
      } else {
        setGameLog([]);
      }
      setActiveTab('session');
    };

    fetch('/urls')
      .then((res) => res.json())
      .then((urls: { tracker: string }) => {
        if (cancelled) return;

        const trackerURL = new URL(urls.tracker);
        const trackerOrigin = trackerURL.origin;

        const lobbyUrl = `${trackerOrigin}/?lobby=true&session=${sessionId}&uniqueId=${uniqueId}`;
        setIframeUrl(lobbyUrl);

        const conn = new TrackerConnection(trackerOrigin, sessionId, {
            onMatched: (matched: MatchedParams) => {
              setTrackerConnected(true);
              setPeerConnected(false);
              let amount: bigint;
              let perGame: bigint;
              try { amount = BigInt(matched.amount); } catch { amount = FALLBACK_AMOUNT; }
              try { perGame = BigInt(matched.per_game); } catch { perGame = FALLBACK_PER_GAME; }
              startSession(conn, matched.i_am_initiator, amount, perGame, matched.token, null, matched.my_alias, matched.peer_alias);
            },
            onConnectionStatus: (status: ConnectionStatus) => {
              setTrackerConnected(true);
              setPeerConnected((prev) => {
                if (!status.has_pairing) return false;
                if (typeof status.peer_connected === 'boolean') return status.peer_connected;
                return prev;
              });
              if (activePairingTokenRef.current !== null) {
                if (status.has_pairing && status.token === activePairingTokenRef.current) {
                  console.log('[Shell] mid-session reconnect: token matches, resending un-acked');
                  blobSingleton?.resendUnacked();
                } else {
                  console.warn('[Shell] mid-session reconnect: pairing lost or mismatched, keeping local session active');
                  setPeerConnected(false);
                }
                return;
              }

              const save = loadSession();

              if (status.has_pairing && status.token) {
                if (save && save.pairingToken === status.token) {
                  let amount: bigint;
                  let perGame: bigint;
                  try { amount = BigInt(save.amount); } catch { amount = FALLBACK_AMOUNT; }
                  try { perGame = BigInt(save.perGameAmount); } catch { perGame = FALLBACK_PER_GAME; }
                  startSession(conn, status.i_am_initiator!, amount, perGame, status.token, save, status.my_alias, status.peer_alias);
                } else if (!save) {
                  console.warn('[Shell] connection_status: unrecognized pairing, requesting close');
                  conn.close();
                  clearSession();
                } else {
                  console.warn('[Shell] connection_status: token mismatch (tracker=%s, save=%s), closing unknown pairing', status.token, save.pairingToken);
                  conn.close();
                  let amount: bigint;
                  let perGame: bigint;
                  try { amount = BigInt(save.amount); } catch { amount = FALLBACK_AMOUNT; }
                  try { perGame = BigInt(save.perGameAmount); } catch { perGame = FALLBACK_PER_GAME; }
                  sessionSaveRef.current = save;
                  setGameParams({
                    iStarted: save.iStarted,
                    amount,
                    perGameAmount: perGame,
                    restoring: true,
                    pairingToken: save.pairingToken,
                    myAlias: save.myAlias,
                    opponentAlias: save.opponentAlias,
                  });
                  setPeerConn(conn.getPeerConnection());
                  setGameLog(save.gameLog);
                  setDebugLogLines(save.debugLog);
                  setActiveTab('session');
                }
              } else {
                if (save) {
                  console.warn('[Shell] connection_status: no pairing but have save, going on-chain');
                  let amount: bigint;
                  let perGame: bigint;
                  try { amount = BigInt(save.amount); } catch { amount = FALLBACK_AMOUNT; }
                  try { perGame = BigInt(save.perGameAmount); } catch { perGame = FALLBACK_PER_GAME; }
                  sessionSaveRef.current = save;
                  setGameParams({
                    iStarted: save.iStarted,
                    amount,
                    perGameAmount: perGame,
                    restoring: true,
                    pairingToken: save.pairingToken,
                    myAlias: save.myAlias,
                    opponentAlias: save.opponentAlias,
                  });
                  setPeerConn(conn.getPeerConnection());
                  setGameLog(save.gameLog);
                  setDebugLogLines(save.debugLog);
                  setActiveTab('session');
                }
              }
            },
            onPeerReconnected: () => {
              blobSingleton?.resendUnacked();
            },
            onMessage: (_data: unknown) => { setPeerConnected(true); },
            onAck: (_ack: number) => { setPeerConnected(true); },
            onPing: () => { setPeerConnected(true); },
            onClosed: () => {
              console.log('[Shell] tracker connection closed');
              setPeerConnected(false);
            },
            onTrackerDisconnected: () => {
              console.log('[Shell] tracker disconnected');
              setTrackerConnected(false);
            },
            onTrackerReconnected: () => {
              console.log('[Shell] tracker reconnected');
              setTrackerConnected(true);
            },
            onChat: (msg: ChatMessage) => {
              setChatMessages(prev => [...prev, msg]);
              if (activeTabRef.current !== 'chat') {
                setUnreadChat(true);
              }
            },
          });
        trackerConnRef.current = conn;

        const initialSave = loadSession();
        if (initialSave) {
          let amount: bigint;
          let perGame: bigint;
          try { amount = BigInt(initialSave.amount); } catch { amount = FALLBACK_AMOUNT; }
          try { perGame = BigInt(initialSave.perGameAmount); } catch { perGame = FALLBACK_PER_GAME; }
          startSession(
            conn,
            initialSave.iStarted,
            amount,
            perGame,
            initialSave.pairingToken,
            initialSave,
          );
          setPeerConnected(false);
        }
      })
      .catch(e => {
        if (!cancelled) console.error('[Shell] failed to fetch /urls:', e);
      });

    return () => {
      cancelled = true;
      trackerConnRef.current?.disconnect();
      trackerConnRef.current = null;
    };
  }, [uniqueId, sessionId, userReady]);

  // Blockchain startup is owned by the page lifecycle, not button click handlers.
  useEffect(() => {
    if (!userReady) return;
    let cancelled = false;
    const bcType = blockchainTypeRef.current;

    if (bcType === 'simulator') {
      setWalletConnected(false);
      setActiveBlockchain(fakeBlockchainInfo);
      void walletConnectState.disconnect().catch(() => {});
      fakeBlockchainInfo.registerUser(uniqueId)
        .then(() => {
          if (cancelled) return;
          persistBlockchainType('simulator');
          debugLog('Simulator wallet registered');
          return fakeBlockchainInfo.startMonitoring(uniqueId);
        })
        .then(() => {
          if (!cancelled) setWalletConnected(true);
        })
        .catch((err: unknown) => {
          if (!cancelled) {
            console.error('[blockchain] simulator startup failed', err);
          }
        });
      return () => {
        cancelled = true;
      };
    }

    setActiveBlockchain(realBlockchainInfo);
    walletConnectState.init()
      .then(() => {
        if (cancelled) return;
        const session = walletConnectState.getSession();
        if (session) {
          realBlockchainInfo.startMonitoring().catch((err: unknown) => {
            console.warn('[blockchain] startMonitoring failed on WC startup', err);
          });
          setWalletConnected(true);
        } else {
          setWalletConnected(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          console.warn('[blockchain] walletconnect init failed', err);
          setWalletConnected(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [uniqueId, userReady]);

  const sendChat = useCallback((text: string) => {
    const myAlias = gameParams?.myAlias ?? 'You';
    trackerConnRef.current?.sendChat(text);
    setChatMessages(prev => [...prev, { text, fromAlias: myAlias, timestamp: Date.now(), isMine: true }]);
  }, [gameParams?.myAlias]);

  const onSessionActivity = useCallback(() => {
    if (activeTabRef.current !== 'session') {
      deferStateUpdate(() => {
        setUnreadSession(true);
      });
    }
  }, [deferStateUpdate]);

  const handleTabChange = useCallback((tabId: TabId) => {
    setActiveTab(tabId);
    if (tabId === 'chat') setUnreadChat(false);
    if (tabId === 'session') setUnreadSession(false);
  }, []);

  const handleReset = useCallback(async () => {
    activePairingTokenRef.current = null;
    try { await walletConnectState.disconnect(); } catch (_) {}
    await hardReset();
    window.location.reload();
  }, []);

  useThemeSyncToIframe('tracker-iframe', [iframeUrl]);

  const [resuming, setResuming] = useState(false);

  const handleResume = useCallback(() => {
    const bcType = getBlockchainType() ?? 'simulator';
    setResuming(true);

    const onRegistered = () => {
      fakeBlockchainInfo.startMonitoring(uniqueId).catch((err: unknown) => {
        console.warn('[blockchain] startMonitoring failed on resume', err);
      });
      setActiveBlockchain(fakeBlockchainInfo);
      setPendingRestore(null);
      setResuming(false);
      setRestoreDecided(true);
      blockchainTypeRef.current = bcType;
      setWalletConnected(true);
      setUserReady(true);
    };
    const onFailed = (e: unknown) => {
      console.error('[Shell] wallet register failed on resume:', e);
      setResuming(false);
    };

    if (bcType === 'simulator') {
      // If the saved mode is simulator, keep simulator authoritative on reload.
      void walletConnectState.disconnect().catch(() => {});
      fakeBlockchainInfo.registerUser(uniqueId)
        .then(() => {
          persistBlockchainType('simulator');
          debugLog('Simulator wallet registered (resume)');
          onRegistered();
        })
        .catch(onFailed);
    } else {
      debugLog('WalletConnect resume: initializing client');
      walletConnectState.init()
        .then(() => {
          const session = walletConnectState.getSession();
          if (session) {
            debugLog('WalletConnect resume: restored existing session');
            setActiveBlockchain(realBlockchainInfo);
            realBlockchainInfo.startMonitoring().catch((err: unknown) => {
              console.warn('[blockchain] startMonitoring failed on WC resume', err);
            });
            setPendingRestore(null);
            setResuming(false);
            setRestoreDecided(true);
            blockchainTypeRef.current = 'walletconnect';
            setWalletConnected(true);
            setUserReady(true);
            return;
          }

          debugLog('WalletConnect resume: no existing session, waiting for user reconnect');
          setPendingRestore(null);
          setResuming(false);
          setRestoreDecided(true);
          blockchainTypeRef.current = 'walletconnect';
          setWalletConnected(false);
          setUserReady(true);
        })
        .catch(onFailed);
    }
  }, [uniqueId]);

  const handleStartOver = useCallback(async () => {
    try { await walletConnectState.disconnect(); } catch (_) {}
    await hardReset();
    window.location.reload();
  }, []);

  // --- Three mutually exclusive UI states ---
  // 1. Saved session exists, user hasn't decided yet → restore dialog only
  // 2. No session and no wallet connected yet → wallet/simulator chooser only
  // 3. User has clicked through → full app UI
  const showRestoreDialog = pendingRestore !== null && !restoreDecided;
  const showWalletChooser = !showRestoreDialog && !userReady;

  const tabBar = (
    <div style={{ flexShrink: 0, display: 'flex', alignItems: 'flex-end', gap: '0.25rem', padding: '0.5rem 1rem 0', borderBottom: '1px solid var(--color-canvas-border)', background: 'var(--color-canvas-bg-subtle)' }}>
      {TAB_DEFS.map((tab) => {
        const active = activeTab === tab.id;
        const showDot = !active && (
          (tab.id === 'chat' && unreadChat) ||
          (tab.id === 'session' && unreadSession)
        );
        return (
          <button
            key={tab.id}
            onClick={() => handleTabChange(tab.id)}
            className={
              'relative px-3 py-1.5 text-sm font-medium rounded-t-md transition-colors ' +
              (active
                ? 'bg-canvas-bg text-canvas-text-contrast border border-b-0 border-canvas-border -mb-px'
                : 'text-canvas-text hover:text-canvas-text-contrast hover:bg-canvas-bg-hover')
            }
          >
            {tab.label}
            {showDot && (
              <span className='absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-alert-text' />
            )}
          </button>
        );
      })}
      <div style={{ marginLeft: 'auto', paddingBottom: '0.25rem' }}>
        <button
          onClick={handleReset}
          className='px-2.5 py-1 text-xs font-bold rounded-md bg-alert-bg text-alert-text border border-alert-border hover:bg-alert-bg-hover transition-colors inline-flex items-center gap-1'
        >
          Reset
        </button>
      </div>
    </div>
  );

  const sessionReady = gameParams !== null && peerConn !== null && (walletConnected || gameParams.restoring);

  // --- State 1: Restore dialog (nothing else) ---
  if (showRestoreDialog) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', width: '100vw', height: '100vh' }}
           className='bg-canvas-bg-subtle text-canvas-text'>
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '0.75rem',
          padding: '1.5rem',
          borderRadius: '0.5rem',
          border: '1px solid var(--color-canvas-border)',
          background: 'var(--color-canvas-bg)',
          maxWidth: '24rem',
          width: '90%',
        }}>
          <p className='text-canvas-text-contrast font-semibold text-lg'>Saved session found</p>
          <p className='text-canvas-text text-sm text-center'>
            You have an in-progress game session. Resume where you left off, or start over?
          </p>
          <button
            onClick={handleResume}
            disabled={resuming}
            className='w-full px-4 py-2 rounded-md font-medium text-sm bg-primary-solid text-primary-on-primary hover:bg-primary-solid-hover transition-colors disabled:opacity-50'
          >
            {resuming ? 'Resuming…' : 'Resume Session'}
          </button>
          <button
            onClick={handleStartOver}
            disabled={resuming}
            className='w-full px-4 py-2 rounded-md font-medium text-sm border border-canvas-border text-canvas-text hover:bg-canvas-bg-hover transition-colors disabled:opacity-50'
          >
            Start over
          </button>
        </div>
      </div>
    );
  }

  // --- State 2: Wallet/simulator chooser (nothing else) ---
  if (showWalletChooser) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', width: '100vw', height: '100vh' }}
           className='bg-canvas-bg-subtle text-canvas-text'>
        <WalletConnectHeading
          onConnected={(bcType, source) => {
            if (bcType === 'walletconnect' && source !== 'manual' && blockchainTypeRef.current === 'simulator' && walletConnected) {
              debugLog('Ignoring walletconnect auto-connect while simulator session is active');
              return;
            }
            blockchainTypeRef.current = bcType;
            persistBlockchainType(bcType);
            if (bcType === 'walletconnect') {
              setActiveBlockchain(realBlockchainInfo);
              const hasSession = !!walletConnectState.getSession();
              setWalletConnected(hasSession);
              if (hasSession) {
                realBlockchainInfo.startMonitoring().catch((err: unknown) => {
                  console.warn('[blockchain] startMonitoring failed', err);
                });
              }
            }
            setUserReady(true);
          }}
          initialExpanded
        />
      </div>
    );
  }

  // --- State 3: Full app UI (tracker + wallet connect in background) ---
  return (
    <div style={{ display: 'flex', flexDirection: 'column', position: 'relative', width: '100vw', height: '100vh' }}
         className='bg-canvas-bg-subtle text-canvas-text'>
      <div style={{ width: '100%', flexShrink: 0 }}>
        <WalletConnectHeading
          onConnected={(bcType, source) => {
            if (bcType === 'walletconnect' && source !== 'manual' && blockchainTypeRef.current === 'simulator' && walletConnected) {
              debugLog('Ignoring walletconnect auto-connect while simulator session is active');
              return;
            }
            blockchainTypeRef.current = bcType;
            persistBlockchainType(bcType);
            if (bcType === 'walletconnect') {
              setActiveBlockchain(realBlockchainInfo);
              const hasSession = !!walletConnectState.getSession();
              setWalletConnected(hasSession);
              if (hasSession) {
                realBlockchainInfo.startMonitoring().catch((err: unknown) => {
                  console.warn('[blockchain] startMonitoring failed', err);
                });
              }
            }
          }}
          initialExpanded={false}
        />
      </div>
      {tabBar}
      <div style={{ position: 'relative', flex: '1 1 0%', minHeight: 0, zIndex: 0 }}
           className='bg-canvas-bg-subtle'>
        {/* Tracker tab */}
        <div style={{ position: 'absolute', inset: 0, display: activeTab === 'tracker' ? 'block' : 'none' }}>
          <iframe
            id='tracker-iframe'
            className='bg-canvas-bg-subtle'
            style={{ width: '100%', height: '100%', border: 'none', margin: 0 }}
            src={iframeUrl}
          />
        </div>

        {/* Game Session tab */}
        <div style={{ position: 'absolute', inset: 0, overflow: 'auto', visibility: activeTab === 'session' ? 'visible' : 'hidden' }}>
          {sessionReady ? (
            <GameSession
              params={gameParams}
              peerConn={peerConn}
              peerConnected={peerConnected}
              registerMessageHandler={registerMessageHandler}
              appendGameLog={appendGameLog}
              sessionSave={sessionSaveRef.current ?? undefined}
              blockchainType={blockchainTypeRef.current}
              onSessionActivity={onSessionActivity}
            />
          ) : gameParams && peerConn ? (
            <div className='w-full h-full flex items-center justify-center text-canvas-text/70'>
              Session restored locally. Waiting for wallet connection...
            </div>
          ) : (
            <div className='w-full h-full flex items-center justify-center text-canvas-text/50'>
              No active game session
            </div>
          )}
        </div>

        {/* Chat tab */}
        <div style={{ position: 'absolute', inset: 0, display: activeTab === 'chat' ? 'flex' : 'none', flexDirection: 'column' }}>
          <ChatPanel
            messages={chatMessages}
            onSend={sendChat}
            myAlias={gameParams?.myAlias ?? 'You'}
          />
        </div>

        {/* Game Log tab */}
        <div style={{ position: 'absolute', inset: 0, padding: '1rem', display: activeTab === 'game-log' ? 'block' : 'none' }}>
          <LogPanel lines={gameLog} />
        </div>

        {/* Debug Log tab */}
        <div style={{ position: 'absolute', inset: 0, padding: '1rem', display: activeTab === 'debug-log' ? 'block' : 'none' }}>
          {debugLogLines.length > 0 ? (
            <LogPanel lines={debugLogLines} />
          ) : (
            <div className='w-full h-full flex items-center justify-center text-canvas-text/50'>
              No debug log entries yet
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default Shell;
