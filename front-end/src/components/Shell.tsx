import { useEffect, useState, useCallback, useRef } from 'react';

import GameSession from './GameSession';
import { SimulatorSetupModal } from './SimulatorSetupModal';
import QRCode from 'qrcode';
import { GameSessionParams, PeerConnectionResult, ChatMessage, InternalBlockchainInterface, ConnectionSetup } from '../types/ChiaGaming';
import { TrackerConnection, MatchedParams, ConnectionStatus } from '../services/TrackerConnection';
import { subscribeDebugLog } from '../services/debugLog';
import {
  getPlayerId,
  getSessionId,
  setBlockchainType as persistBlockchainType,
  getBlockchainType,
  getTheme,
  setTheme as saveTheme,
  loadSession,
  clearSession,
  hardReset,
  hasAnySessionInfo,
  SessionSave,
} from '../hooks/save';
import { blobSingleton } from '../hooks/blobSingleton';
import { fakeBlockchainInfo } from '../hooks/FakeBlockchainInterface';
import { realBlockchainInfo } from '../hooks/RealBlockchainInterface';
import { activate, deactivate, getActiveBlockchain } from '../hooks/activeBlockchain';
import { useThemeSyncToIframe } from '../hooks/useThemeSyncToIframe';
import { debugLog } from '../services/debugLog';
import { Button } from './button';

import ChatPanel from './ChatPanel';

type TabId = 'wallet' | 'tracker' | 'session' | 'chat' | 'game-log' | 'debug-log';

const TAB_DEFS: { id: TabId; label: string }[] = [
  { id: 'wallet', label: 'Wallet' },
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

  const [activeTab, setActiveTab] = useState<TabId>('wallet');
  const [gameParams, setGameParams] = useState<GameSessionParams | null>(null);
  const [peerConn, setPeerConn] = useState<PeerConnectionResult | null>(null);

  const [walletConnected, setWalletConnected] = useState(false);
  const [, setTrackerConnected] = useState<boolean | null>(null);
  const [peerConnected, setPeerConnected] = useState<boolean | null>(null);
  const [pendingRestore, setPendingRestore] = useState<SessionSave | null>(() => loadSession());
  const [restoreDecided, setRestoreDecided] = useState<boolean>(() => !hasAnySessionInfo());
  const [gameLog, setGameLog] = useState<string[]>([]);
  const [debugLogLines, setDebugLogLines] = useState<string[]>([]);

  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [unreadChat, setUnreadChat] = useState(false);
  const [unreadSession, setUnreadSession] = useState(false);
  const [walletAlert, setWalletAlert] = useState(false);
  const [iframeUrl, setIframeUrl] = useState('about:blank');
  const [balance, setBalance] = useState<number | undefined>();

  const [blockchainType, setBlockchainType] = useState<'simulator' | 'walletconnect' | undefined>();
  const activeBlockchainRef = useRef<InternalBlockchainInterface | null>(null);

  // Connection state
  const [showSimModal, setShowSimModal] = useState(false);
  const [connectionSetup, setConnectionSetup] = useState<ConnectionSetup | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState('');
  const wcAbortRef = useRef(false);

  // Theme state
  const [isDark, setIsDark] = useState<boolean>(() => {
    const stored = getTheme();
    if (stored === 'dark') return true;
    if (stored === 'light') return false;
    return document.documentElement.classList.contains('dark');
  });

  useEffect(() => {
    if (isDark) {
      document.documentElement.classList.add('dark');
      saveTheme('dark');
    } else {
      document.documentElement.classList.remove('dark');
      saveTheme('light');
    }
  }, [isDark]);

  const trackerConnRef = useRef<TrackerConnection | null>(null);
  const activeTabRef = useRef<TabId>(activeTab);
  activeTabRef.current = activeTab;
  const sessionSaveRef = useRef<SessionSave | null>(null);
  const activePairingTokenRef = useRef<string | null>(null);
  const balanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const [userReady, setUserReady] = useState(false);

  // Balance polling
  const requestBalance = useCallback(() => {
    try {
      getActiveBlockchain().rpc.getBalance()
        .then((bal) => {
          setBalance(bal);
          if (balanceTimerRef.current) clearTimeout(balanceTimerRef.current);
          balanceTimerRef.current = setTimeout(requestBalance, 15000);
        })
        .catch(() => {
          if (balanceTimerRef.current) clearTimeout(balanceTimerRef.current);
          balanceTimerRef.current = setTimeout(requestBalance, 15000);
        });
    } catch {
      // blockchain not set yet
    }
  }, []);

  useEffect(() => {
    return () => {
      if (balanceTimerRef.current) clearTimeout(balanceTimerRef.current);
    };
  }, []);

  // QR code generation (inline in wallet tab, type-agnostic)
  useEffect(() => {
    if (!connectionSetup?.qrUri) {
      setQrDataUrl('');
      return;
    }
    const darkNow = document.documentElement.classList.contains('dark');
    QRCode.toDataURL(connectionSetup.qrUri, {
      width: 250, margin: 2,
      color: { dark: darkNow ? '#FFFFFF' : '#000000', light: darkNow ? '#121212' : '#FFFFFF' },
      errorCorrectionLevel: 'M' as const,
    })
      .then(setQrDataUrl)
      .catch((err: unknown) => console.error('[Shell] QR generation failed', err));
  }, [connectionSetup?.qrUri]);

  // Connection health monitoring
  useEffect(() => {
    const iface = activeBlockchainRef.current;
    if (!iface) return;
    return iface.onConnectionChange((connected) => {
      if (!connected && activeTabRef.current !== 'wallet') {
        setWalletAlert(true);
      }
      if (connected) {
        setWalletAlert(false);
        setWalletConnected(true);
      } else {
        setWalletConnected(false);
      }
    });
  }, [blockchainType]);

  // Tracker setup
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

  // Shared connection completion
  const completeConnection = useCallback((iface: InternalBlockchainInterface, bcType: 'simulator' | 'walletconnect', pollMs: number) => {
    deactivate();
    activate(iface, pollMs);
    persistBlockchainType(bcType);
    activeBlockchainRef.current = iface;
    setBlockchainType(bcType);
    setWalletConnected(true);
    setConnectionSetup(null);
    setUserReady(true);
    requestBalance();
    debugLog(`${bcType} wallet connected`);
    setActiveTab('tracker');
  }, [requestBalance]);

  // --- Simulator flow: modal overlay ---
  const handleChooseSimulator = useCallback(async () => {
    try {
      const setup = await fakeBlockchainInfo.beginConnect(uniqueId);
      setConnectionSetup(setup);
      setShowSimModal(true);
    } catch (err) {
      console.error('[Shell] simulator beginConnect failed', err);
    }
  }, [uniqueId]);

  const handleSimConnect = useCallback(async (values: { balance?: number }) => {
    if (!connectionSetup) return;
    setConnecting(true);
    try {
      await connectionSetup.finalize(values);
      setShowSimModal(false);
      completeConnection(fakeBlockchainInfo, 'simulator', 5000);
    } catch (err) {
      console.error('[Shell] simulator connect failed', err);
    } finally {
      setConnecting(false);
    }
  }, [connectionSetup, completeConnection]);

  // --- WalletConnect flow: inline QR in wallet tab ---
  const handleChooseWalletConnect = useCallback(async () => {
    wcAbortRef.current = false;
    try {
      const setup = await realBlockchainInfo.beginConnect(uniqueId);
      if (wcAbortRef.current) return;
      setConnectionSetup(setup);
      setBlockchainType('walletconnect');
      setConnecting(true);
      await setup.finalize();
      if (wcAbortRef.current) return;
      completeConnection(realBlockchainInfo, 'walletconnect', 10000);
    } catch (err) {
      if (!wcAbortRef.current) {
        console.error('[Shell] WC connect failed', err);
      }
      setBlockchainType(undefined);
      setConnectionSetup(null);
    } finally {
      setConnecting(false);
    }
  }, [uniqueId, completeConnection]);

  const handleCancelConnect = useCallback(async () => {
    wcAbortRef.current = true;
    try { await realBlockchainInfo.disconnect(); } catch { /* ignore */ }
    deactivate();
    activeBlockchainRef.current = null;
    setConnectionSetup(null);
    setBlockchainType(undefined);
    setConnecting(false);
    setWalletConnected(false);
    setShowSimModal(false);
  }, []);

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
    if (tabId === 'wallet') setWalletAlert(false);
  }, []);

  const handleReset = useCallback(async () => {
    activePairingTokenRef.current = null;
    if (activeBlockchainRef.current) {
      try { await activeBlockchainRef.current.disconnect(); } catch (_) {}
    }
    await hardReset();
    window.location.reload();
  }, []);

  useThemeSyncToIframe('tracker-iframe', [iframeUrl]);

  const [resuming, setResuming] = useState(false);

  const handleResume = useCallback(async () => {
    const bcType = getBlockchainType() ?? 'simulator';
    setResuming(true);
    setPendingRestore(null);
    setRestoreDecided(true);

    const iface = bcType === 'walletconnect' ? realBlockchainInfo : fakeBlockchainInfo;
    const pollMs = bcType === 'walletconnect' ? 10000 : 5000;

    try {
      const setup = await iface.beginConnect(uniqueId);
      if (iface.isConnected()) {
        await setup.finalize();
        completeConnection(iface, bcType, pollMs);
      } else if (bcType === 'simulator') {
        setConnectionSetup(setup);
        setShowSimModal(true);
        setUserReady(true);
      } else {
        // WC not connected: show QR inline, finalize in background
        setConnectionSetup(setup);
        setBlockchainType('walletconnect');
        setConnecting(true);
        setUserReady(true);
        wcAbortRef.current = false;
        try {
          await setup.finalize();
          if (!wcAbortRef.current) {
            completeConnection(iface, bcType, pollMs);
          }
        } catch (err2) {
          if (!wcAbortRef.current) {
            console.warn('[Shell] WC resume finalize failed', err2);
          }
          setBlockchainType(undefined);
          setConnectionSetup(null);
        } finally {
          setConnecting(false);
        }
      }
    } catch (err) {
      console.warn('[Shell] resume connect failed, falling back', err);
      setUserReady(true);
    }
    setResuming(false);
  }, [uniqueId, requestBalance, completeConnection]);

  const handleStartOver = useCallback(async () => {
    if (activeBlockchainRef.current) {
      try { await activeBlockchainRef.current.disconnect(); } catch (_) {}
    }
    await hardReset();
    window.location.reload();
  }, []);

  const handleDisconnectWallet = useCallback(async () => {
    if (activeBlockchainRef.current) {
      try { await activeBlockchainRef.current.disconnect(); } catch (_) {}
    }
    deactivate();
    activeBlockchainRef.current = null;
    setWalletConnected(false);
    setBlockchainType(undefined);
    setBalance(undefined);
  }, []);

  const handleReconnect = useCallback(() => {
    if (!blockchainType) return;
    if (blockchainType === 'simulator') {
      handleChooseSimulator();
    } else {
      handleChooseWalletConnect();
    }
  }, [blockchainType, handleChooseSimulator, handleChooseWalletConnect]);

  // --- Restore dialog ---
  if (!restoreDecided) {
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
          <p className='text-canvas-text-contrast font-semibold text-lg'>Previously saved state</p>
          <p className='text-canvas-text text-sm text-center'>
            You have previously saved state. Resume where you left off, or start over?
          </p>
          <button
            onClick={handleResume}
            disabled={resuming}
            className='w-full px-4 py-2 rounded-md font-medium text-sm bg-primary-solid text-primary-on-primary hover:bg-primary-solid-hover transition-colors disabled:opacity-50'
          >
            {resuming ? 'Resuming\u2026' : 'Resume Session'}
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

  const sessionReady = gameParams !== null && peerConn !== null && (walletConnected || gameParams.restoring);

  // --- Main tabbed app ---
  return (
    <div style={{ display: 'flex', flexDirection: 'column', position: 'relative', width: '100vw', height: '100vh' }}
         className='bg-canvas-bg-subtle text-canvas-text'>

      {/* Tab bar with branding */}
      <div style={{ flexShrink: 0, display: 'flex', alignItems: 'flex-end', gap: '0.25rem', padding: '0.5rem 1rem 0', borderBottom: '1px solid var(--color-canvas-border)', background: 'var(--color-canvas-bg-subtle)' }}>
        {/* Branding */}
        <div className='flex items-end gap-1 pr-3 pb-0.5' style={{ flexShrink: 0 }}>
          <img
            src='/images/chia_logo.png'
            alt='Chia Logo'
            className='max-w-16 h-auto rounded-md'
          />
          <span className='font-semibold text-sm text-canvas-text whitespace-nowrap'>Gaming</span>
        </div>

        {/* Tabs */}
        {TAB_DEFS.map((tab) => {
          const active = activeTab === tab.id;
          const showDot = !active && (
            (tab.id === 'chat' && unreadChat) ||
            (tab.id === 'session' && unreadSession) ||
            (tab.id === 'wallet' && walletAlert)
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

        {/* Right side: Reset + Theme */}
        <div style={{ marginLeft: 'auto', paddingBottom: '0.25rem' }} className='flex items-center gap-2'>
          <button
            onClick={() => setIsDark(d => !d)}
            className={`p-1 border border-canvas-border rounded ${isDark ? 'text-warning-solid' : 'text-canvas-text'} hover:bg-canvas-bg-hover`}
            aria-label='toggle theme'
            title='Toggle theme'
          >
            <span className='text-sm leading-none'>{isDark ? '\u2600' : '\u263E'}</span>
          </button>
          <button
            onClick={handleReset}
            className='px-2.5 py-1 text-xs font-bold rounded-md bg-alert-bg text-alert-text border border-alert-border hover:bg-alert-bg-hover transition-colors inline-flex items-center gap-1'
          >
            Reset
          </button>
        </div>
      </div>

      {/* Tab content */}
      <div style={{ position: 'relative', flex: '1 1 0%', minHeight: 0, zIndex: 0 }}
           className='bg-canvas-bg-subtle'>

        {/* Wallet tab */}
        <div style={{ position: 'absolute', inset: 0, display: activeTab === 'wallet' ? 'flex' : 'none', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', overflow: 'auto' }}>
          {walletConnected ? (
            <div className='flex flex-col items-center gap-4 p-6 max-w-md w-full'>
              <div className='flex items-center gap-2'>
                <span className='inline-block w-3 h-3 rounded-full bg-success-solid' />
                <span className='text-lg font-semibold text-canvas-text-contrast'>Connected</span>
              </div>
              {balance !== undefined && (
                <p className='text-2xl font-bold text-canvas-text-contrast'>{balance.toLocaleString()} mojos</p>
              )}
              <Button variant='outline' onClick={handleDisconnectWallet}>
                Disconnect
              </Button>
            </div>
          ) : connectionSetup ? (
            <div className='flex flex-col items-center gap-4 p-6 max-w-md w-full'>
              <p className='text-lg font-semibold text-canvas-text-contrast'>Scan QR Code</p>
              <p className='text-sm text-canvas-text text-center'>
                Open your Chia wallet and scan this QR code to connect
              </p>
              <div className='p-4 rounded-xl border-2 border-canvas-border bg-white shadow-md'>
                {qrDataUrl ? (
                  <img src={qrDataUrl} alt='Connection QR' className='w-[200px] h-auto rounded-md' />
                ) : (
                  <div className='w-[200px] h-[200px] flex items-center justify-center text-canvas-text/50'>
                    Generating…
                  </div>
                )}
              </div>
              <div className='w-full max-w-sm flex gap-2'>
                <textarea
                  readOnly
                  value={connectionSetup.qrUri}
                  rows={3}
                  className='flex-1 text-xs font-mono rounded-md p-2 border border-canvas-border bg-canvas-bg-subtle text-canvas-text resize-none'
                />
                <button
                  onClick={() => navigator.clipboard.writeText(connectionSetup.qrUri)}
                  className='self-start px-2 py-2 text-xs font-medium rounded-md border border-canvas-border text-canvas-text hover:bg-canvas-bg-hover transition-colors'
                  title='Copy URI to clipboard'
                >
                  Copy
                </button>
              </div>
              <p className='text-sm text-canvas-text animate-pulse'>Waiting for wallet to connect…</p>
              <Button variant='outline' onClick={handleCancelConnect}>Cancel</Button>
              <SimulatorSetupModal
                open={showSimModal}
                fields={connectionSetup?.fields}
                onConnect={handleSimConnect}
                connecting={connecting}
              />
            </div>
          ) : !walletConnected && activeBlockchainRef.current ? (
            <div className='flex flex-col items-center gap-4 p-6 max-w-md w-full'>
              <div className='flex items-center gap-2'>
                <span className='inline-block w-3 h-3 rounded-full bg-alert-solid' />
                <span className='text-lg font-semibold text-alert-text'>Disconnected</span>
              </div>
              <p className='text-sm text-canvas-text'>
                Connection was lost
              </p>
              <Button variant='solid' onClick={handleReconnect}>Reconnect</Button>
            </div>
          ) : (
            <div className='flex flex-col justify-center items-center w-full px-4 py-6 gap-4'>
              <p className='text-lg font-semibold text-canvas-text-contrast'>Choose Connection</p>
              <div className='w-full max-w-sm flex flex-col gap-3'>
                <Button variant='solid' fullWidth onClick={handleChooseSimulator}>
                  Continue with Simulator
                </Button>
                <div className='flex items-center gap-2'>
                  <div className='flex-1 border-t border-canvas-border' />
                  <span className='text-canvas-text font-medium text-sm'>OR</span>
                  <div className='flex-1 border-t border-canvas-border' />
                </div>
                <Button variant='solid' color='secondary' fullWidth onClick={handleChooseWalletConnect}>
                  Link Wallet
                </Button>
              </div>
            </div>
          )}
        </div>

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
