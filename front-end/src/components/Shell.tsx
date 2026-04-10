import { useEffect, useState, useCallback, useRef } from 'react';

import GameSession from './GameSession';
import { SimulatorSetupModal } from './SimulatorSetupModal';
import QRCode from 'qrcode';
import { GameSessionParams, PeerConnectionResult, ChatMessage, InternalBlockchainInterface, ConnectionSetup, TrackerLiveness } from '../types/ChiaGaming';
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
  getDefaultFee,
  setDefaultFee as saveDefaultFee,
  getFeeUnit,
  setFeeUnit as saveFeeUnit,
  getActiveTab as getSavedTab,
  setActiveTab as saveActiveTab,
  getConnecting as getSavedConnecting,
  setConnecting as saveConnecting,
  getUnreadChat as getSavedUnreadChat,
  setUnreadChat as saveUnreadChat,
  getUnreadSession as getSavedUnreadSession,
  setUnreadSession as saveUnreadSession,
  getWalletAlert as getSavedWalletAlert,
  setWalletAlert as saveWalletAlert,
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

const MOJOS_PER_XCH = 1_000_000_000_000;

function getInterface(bcType: 'simulator' | 'walletconnect') {
  return bcType === 'walletconnect'
    ? { iface: realBlockchainInfo, pollMs: 10000 }
    : { iface: fakeBlockchainInfo, pollMs: 5000 };
}

const TAB_DEFS: { id: TabId; label: string }[] = [
  { id: 'wallet', label: 'Wallet' },
  { id: 'tracker', label: 'Tracker' },
  { id: 'session', label: 'Game' },
  { id: 'chat', label: 'Chat' },
  { id: 'game-log', label: 'Log' },
  { id: 'debug-log', label: 'Debug' },
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

  const [activeTab, setActiveTabRaw] = useState<TabId>(() => {
    const saved = getSavedTab();
    const valid: TabId[] = ['wallet', 'tracker', 'session', 'chat', 'game-log', 'debug-log'];
    return saved && valid.includes(saved as TabId) ? (saved as TabId) : 'wallet';
  });
  const setActiveTab = useCallback((tab: TabId) => {
    setActiveTabRaw(tab);
    saveActiveTab(tab);
  }, []);
  const [gameParams, setGameParams] = useState<GameSessionParams | null>(null);
  const [peerConn, setPeerConn] = useState<PeerConnectionResult | null>(null);

  const [walletConnected, setWalletConnected] = useState(false);
  const [trackerLiveness, setTrackerLiveness] = useState<TrackerLiveness | null>(null);
  const [peerConnected, setPeerConnected] = useState<boolean | null>(null);
  const trackerWsUpRef = useRef(false);
  const lastTrackerActivityRef = useRef(0);
  const lastPeerActivityRef = useRef(0);
  const [pendingRestore, setPendingRestore] = useState<SessionSave | null>(() => loadSession());
  const [restoreDecided, setRestoreDecided] = useState<boolean>(() => {
    return !hasAnySessionInfo();
  });
  const [gameLog, setGameLog] = useState<string[]>([]);
  const [debugLogLines, setDebugLogLines] = useState<string[]>([]);

  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [unreadChat, setUnreadChatRaw] = useState(() => getSavedUnreadChat());
  const setUnreadChat = useCallback((v: boolean) => { setUnreadChatRaw(v); saveUnreadChat(v); }, []);
  const [unreadSession, setUnreadSessionRaw] = useState(() => getSavedUnreadSession());
  const setUnreadSession = useCallback((v: boolean) => { setUnreadSessionRaw(v); saveUnreadSession(v); }, []);
  const [walletAlert, setWalletAlertRaw] = useState(() => getSavedWalletAlert());
  const setWalletAlert = useCallback((v: boolean) => { setWalletAlertRaw(v); saveWalletAlert(v); }, []);
  const [iframeUrl, setIframeUrl] = useState('about:blank');
  const [balance, setBalance] = useState<number | undefined>();

  const [blockchainType, setBlockchainType] = useState<'simulator' | 'walletconnect' | undefined>(() => getBlockchainType());
  const activeBlockchainRef = useRef<InternalBlockchainInterface | null>(null);

  // Connection state
  const [showSimModal, setShowSimModal] = useState(false);
  const [connectionSetup, setConnectionSetup] = useState<ConnectionSetup | null>(null);
  const [connecting, setConnectingRaw] = useState(() => getSavedConnecting());
  const setConnecting = useCallback((v: boolean) => { setConnectingRaw(v); saveConnecting(v); }, []);
  const [qrDataUrl, setQrDataUrl] = useState('');
  const wcAbortRef = useRef(false);
  const [defaultFee, setDefaultFee] = useState<number>(() => getDefaultFee());
  const [feeUnit, setFeeUnit] = useState<'mojo' | 'xch'>(() => getFeeUnit());
  const [feeEditing, setFeeEditing] = useState(false);
  const [feeInput, setFeeInput] = useState('');
  const feeInputRef = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);

  const mojosToXchStr = (mojos: number): string => {
    const s = String(mojos).padStart(13, '0');
    const whole = s.slice(0, -12).replace(/^0+/, '') || '0';
    const frac = s.slice(-12).replace(/0+$/, '');
    return frac ? `${whole}.${frac}` : whole;
  };

  const feeDisplayText = useCallback(() => {
    if (feeUnit === 'xch') return mojosToXchStr(defaultFee);
    return String(defaultFee);
  }, [defaultFee, feeUnit]);

  const parseFeeInput = useCallback((raw: string): number | null => {
    if (/^\s*$/.test(raw)) return 0;
    const trimmed = raw.trim();
    if (feeUnit === 'xch') {
      if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
      const [whole, frac = ''] = trimmed.split('.');
      if (frac.length > 12) return null;
      const mojoStr = whole + frac.padEnd(12, '0');
      const mojos = Number(mojoStr);
      if (!Number.isSafeInteger(mojos) || mojos < 0) return null;
      return mojos;
    }
    if (!/^\d+$/.test(trimmed)) return null;
    const n = Number(trimmed);
    if (!Number.isSafeInteger(n) || n < 0) return null;
    return n;
  }, [feeUnit]);

  const feeInputValid = parseFeeInput(feeInput) !== null;

  const startEditingFee = useCallback(() => {
    setFeeInput(feeDisplayText());
    setFeeEditing(true);
    setTimeout(() => feeInputRef.current?.select(), 0);
  }, [feeDisplayText]);

  const commitFee = useCallback(() => {
    const mojos = parseFeeInput(feeInput);
    if (mojos === null) return;
    setDefaultFee(mojos);
    saveDefaultFee(mojos);
    setFeeEditing(false);
  }, [feeInput, parseFeeInput]);

  const cancelEditFee = useCallback(() => {
    setFeeEditing(false);
  }, []);

  const handleFeeUnitChange = useCallback((unit: 'mojo' | 'xch') => {
    setFeeUnit(unit);
    saveFeeUnit(unit);
    if (feeEditing) {
      const currentMojos = parseFeeInput(feeInput);
      if (currentMojos !== null) {
        setFeeInput(unit === 'xch' ? mojosToXchStr(currentMojos) : String(currentMojos));
      }
    }
  }, [feeEditing, feeInput, parseFeeInput]);

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
  const sessionStartedRef = useRef(false);
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

  const registerMessageHandler = useCallback((handler: (msgno: number, msg: string) => void, ackHandler: (ack: number) => void, keepaliveHandler: () => void) => {
    if (trackerConnRef.current) {
      trackerConnRef.current.registerMessageHandler(
        (msgno, msg) => { lastPeerActivityRef.current = Date.now(); handler(msgno, msg); },
        (ack) => { lastPeerActivityRef.current = Date.now(); ackHandler(ack); },
        () => { lastPeerActivityRef.current = Date.now(); keepaliveHandler(); },
      );
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
    const id = setInterval(() => {
      const now = Date.now();
      const activityFresh = lastTrackerActivityRef.current > 0 && now - lastTrackerActivityRef.current <= 45_000;
      setTrackerLiveness((prev) => {
        if (prev === 'disconnected') return prev;
        if (!trackerWsUpRef.current) return 'reconnecting';
        return activityFresh ? 'connected' : 'inactive';
      });
      const peerLive = lastPeerActivityRef.current > 0 && now - lastPeerActivityRef.current <= 60_000;
      setPeerConnected(peerLive);
    }, 5_000);
    return () => clearInterval(id);
  }, []);

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
        if (save.chatMessages) setChatMessages(save.chatMessages);
      } else {
        setGameLog([]);
        setActiveTab('session');
      }
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
              trackerWsUpRef.current = true;
              lastTrackerActivityRef.current = Date.now();
              setTrackerLiveness('connected');
              lastPeerActivityRef.current = 0;
              let amount: bigint;
              let perGame: bigint;
              try { amount = BigInt(matched.amount); } catch { amount = FALLBACK_AMOUNT; }
              try { perGame = BigInt(matched.per_game); } catch { perGame = FALLBACK_PER_GAME; }
              startSession(conn, matched.i_am_initiator, amount, perGame, matched.token, null, matched.my_alias, matched.peer_alias);
            },
            onConnectionStatus: (status: ConnectionStatus) => {
              trackerWsUpRef.current = true;
              lastTrackerActivityRef.current = Date.now();
              setTrackerLiveness('connected');
              if (!status.has_pairing || status.peer_connected === false) {
                lastPeerActivityRef.current = 0;
              } else if (status.peer_connected === true) {
                lastPeerActivityRef.current = Date.now();
              }
              if (activePairingTokenRef.current !== null) {
                if (status.has_pairing && status.token === activePairingTokenRef.current) {
                  console.log('[Shell] mid-session reconnect: token matches, resending un-acked');
                  blobSingleton?.resendUnacked();
                } else {
                  console.warn('[Shell] mid-session reconnect: pairing lost or mismatched, keeping local session active');
                  lastPeerActivityRef.current = 0;
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
                  if (save.chatMessages) setChatMessages(save.chatMessages);
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
                  if (save.chatMessages) setChatMessages(save.chatMessages);
                }
              }
            },
            onPeerReconnected: () => {
              lastPeerActivityRef.current = Date.now();
              blobSingleton?.resendUnacked();
            },
            onMessage: (_data: unknown) => { lastPeerActivityRef.current = Date.now(); },
            onAck: (_ack: number) => { lastPeerActivityRef.current = Date.now(); },
            onKeepalive: () => { lastPeerActivityRef.current = Date.now(); },
            onClosed: () => {
              console.log('[Shell] tracker connection closed');
              trackerWsUpRef.current = false;
              lastTrackerActivityRef.current = 0;
              lastPeerActivityRef.current = 0;
            },
            onTrackerDisconnected: () => {
              console.log('[Shell] tracker disconnected');
              trackerWsUpRef.current = false;
              setTrackerLiveness('reconnecting');
            },
            onTrackerReconnected: () => {
              console.log('[Shell] tracker reconnected');
              trackerWsUpRef.current = true;
              lastTrackerActivityRef.current = Date.now();
              setTrackerLiveness('connected');
            },
            onTrackerActivity: () => {
              lastTrackerActivityRef.current = Date.now();
            },
            onChat: (msg: ChatMessage) => {
              setChatMessages(prev => {
                const next = [...prev, msg];
                if (blobSingleton) { blobSingleton.chatMessages = next; blobSingleton.scheduleSave(); }
                return next;
              });
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
          lastPeerActivityRef.current = 0;
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
    setConnecting(false);
    setConnectionSetup(null);
    setUserReady(true);
    setActiveTabRaw(prev => prev === 'wallet' ? 'tracker' : prev);
    requestBalance();
    debugLog(`${bcType} wallet connected`);
  }, [requestBalance, setConnecting]);

  // --- Unified connection flow ---
  // silent: skip the modal on reconnect (e.g. auto-reconnect after completed connection)
  const handleConnect = useCallback(async (bcType: 'simulator' | 'walletconnect', silent = false) => {
    wcAbortRef.current = false;
    const { iface, pollMs } = getInterface(bcType);
    try {
      persistBlockchainType(bcType);
      setBlockchainType(bcType);
      setConnecting(true);
      const setup = await iface.beginConnect(uniqueId);
      if (wcAbortRef.current) return;
      setConnectionSetup(setup);
      if (setup.fields && !silent) {
        setShowSimModal(true);
        setConnecting(false);
        return;
      }
      await setup.finalize();
      if (wcAbortRef.current) return;
      completeConnection(iface, bcType, pollMs);
    } catch (err) {
      if (!wcAbortRef.current) {
        console.error(`[Shell] ${bcType} connect failed`, err);
      }
      setBlockchainType(undefined);
      clearSession();
      setConnectionSetup(null);
      setConnecting(false);
    }
  }, [uniqueId, completeConnection, setConnecting]);

  const handleFinalize = useCallback(async () => {
    if (!connectionSetup || !blockchainType) return;
    const { iface, pollMs } = getInterface(blockchainType);
    setConnecting(true);
    try {
      await connectionSetup.finalize();
      setShowSimModal(false);
      completeConnection(iface, blockchainType, pollMs);
    } catch (err) {
      console.error(`[Shell] ${blockchainType} finalize failed`, err);
    } finally {
      setConnecting(false);
    }
  }, [connectionSetup, blockchainType, completeConnection]);

  const handleCancelConnect = useCallback(async () => {
    wcAbortRef.current = true;
    if (activeBlockchainRef.current) {
      try { await activeBlockchainRef.current.disconnect(); } catch { /* ignore */ }
    } else if (blockchainType) {
      const { iface } = getInterface(blockchainType);
      try { await iface.disconnect(); } catch { /* ignore */ }
    }
    deactivate();
    activeBlockchainRef.current = null;
    setConnectionSetup(null);
    setBlockchainType(undefined);
    clearSession();
    setConnecting(false);
    setWalletConnected(false);
    setShowSimModal(false);
  }, [blockchainType]);

  const sendChat = useCallback((text: string) => {
    const myAlias = gameParams?.myAlias ?? 'You';
    trackerConnRef.current?.sendChat(text);
    setChatMessages(prev => {
      const next = [...prev, { text, fromAlias: myAlias, timestamp: Date.now(), isMine: true }];
      if (blobSingleton) { blobSingleton.chatMessages = next; blobSingleton.scheduleSave(); }
      return next;
    });
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

  useThemeSyncToIframe('tracker-iframe', [iframeUrl]);

  const [resuming, setResuming] = useState(false);

  const handleResume = useCallback(async () => {
    const bcType = getBlockchainType() ?? 'simulator';
    setResuming(true);
    setPendingRestore(null);
    setRestoreDecided(true);

    const { iface, pollMs } = getInterface(bcType);

    try {
      const setup = await iface.beginConnect(uniqueId);
      if (iface.isConnected() || !setup.fields) {
        await setup.finalize();
        completeConnection(iface, bcType, pollMs);
      } else {
        // Not connected and has fields (e.g. WC needing QR scan):
        // show connection UI, finalize in background.
        deactivate();
        activate(iface, pollMs);
        activeBlockchainRef.current = iface;
        setConnectionSetup(setup);
        setBlockchainType(bcType);
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
            console.warn('[Shell] resume finalize failed', err2);
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
  }, [uniqueId, completeConnection]);

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
    clearSession();
    setBalance(undefined);
  }, []);

  const handleReconnect = useCallback(() => {
    if (!blockchainType) return;
    handleConnect(blockchainType);
  }, [blockchainType, handleConnect]);

  // Auto-reconnect on load when blockchainType is persisted but no game session.
  // If `connecting` was persisted (mid-handshake reload), use non-silent mode so
  // the QR code / modal reappears. Otherwise silently reconnect.
  const autoReconnectRef = useRef(false);
  useEffect(() => {
    if (autoReconnectRef.current) return;
    const bcType = getBlockchainType();
    if (bcType && !loadSession()) {
      autoReconnectRef.current = true;
      const wasConnecting = getSavedConnecting();
      handleConnect(bcType, !wasConnecting);
    }
  }, [handleConnect]);

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

  const sessionCanMount = gameParams !== null && peerConn !== null;
  const hasActiveBlockchain = activeBlockchainRef.current !== null;
  const sessionReadyToStart =
    sessionCanMount &&
    hasActiveBlockchain &&
    (walletConnected || !!gameParams?.restoring);
  if (sessionReadyToStart) sessionStartedRef.current = true;
  const keepSession = sessionCanMount && hasActiveBlockchain && sessionStartedRef.current;

  // --- Main tabbed app ---
  return (
    <div style={{ display: 'flex', flexDirection: 'column', position: 'relative', width: '100vw', height: '100vh' }}
         className='bg-canvas-bg-subtle text-canvas-text'>

      {/* Tab bar with branding */}
      <div style={{ flexShrink: 0, display: 'flex', alignItems: 'flex-end', gap: '0.25rem', padding: '0.5rem 1rem 0', borderBottom: '1px solid var(--color-canvas-border)', background: 'var(--color-canvas-bg-active)' }}>
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
              style={active ? { background: 'var(--canvas-bg-subtle)' } : undefined}
              className={
                'relative px-3 py-1.5 text-sm font-medium rounded-t-md transition-colors ' +
                (active
                  ? 'text-canvas-text-contrast border border-b-0 border-canvas-border -mb-px'
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

        {/* Right side: Branding + Theme */}
        <div style={{ marginLeft: 'auto', paddingBottom: '0.25rem' }} className='flex items-center gap-2'>
          <img
            src='/images/chia_logo.png'
            alt='Chia Logo'
            className='max-w-12 h-auto'
            style={{ filter: isDark ? 'brightness(2.1) contrast(1.1)' : 'none' }}
          />
          <button
            onClick={() => setIsDark(d => !d)}
            className={`p-1 border border-canvas-border rounded ${isDark ? 'text-warning-solid' : 'text-canvas-text'} hover:bg-canvas-bg-hover`}
            aria-label='toggle theme'
            title='Toggle theme'
          >
            <span className='text-sm leading-none'>{isDark ? '\u2600' : '\u263E'}</span>
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
              <div className='w-full max-w-xs text-sm text-canvas-text'>
                <div className='flex items-center gap-2 mb-1'>
                  <span>Transaction fee</span>
                  <div className='flex rounded-md border border-canvas-border overflow-hidden text-xs'>
                    <button
                      onClick={() => handleFeeUnitChange('mojo')}
                      className={`px-2 py-0.5 transition-colors ${feeUnit === 'mojo' ? 'bg-canvas-bg-active font-semibold' : 'hover:bg-canvas-bg-hover'}`}
                    >
                      mojo
                    </button>
                    <button
                      onClick={() => handleFeeUnitChange('xch')}
                      className={`px-2 py-0.5 transition-colors border-l border-canvas-border ${feeUnit === 'xch' ? 'bg-canvas-bg-active font-semibold' : 'hover:bg-canvas-bg-hover'}`}
                    >
                      XCH
                    </button>
                  </div>
                </div>
                {feeEditing ? (
                  <div className='flex gap-2'>
                    <input
                      ref={feeInputRef}
                      type='text'
                      inputMode={feeUnit === 'xch' ? 'decimal' : 'numeric'}
                      value={feeInput}
                      onChange={(e) => setFeeInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && feeInputValid) commitFee();
                        if (e.key === 'Escape') cancelEditFee();
                      }}
                      className='flex-1 px-3 py-2 rounded-md bg-canvas-bg-subtle text-canvas-text border border-canvas-border outline-none'
                    />
                    <button
                      onClick={commitFee}
                      disabled={!feeInputValid}
                      className='px-3 py-2 text-sm font-medium rounded-md border border-canvas-border text-canvas-text hover:bg-canvas-bg-hover transition-colors disabled:opacity-40 disabled:cursor-default'
                    >
                      Set
                    </button>
                    <button
                      onClick={cancelEditFee}
                      className='px-3 py-2 text-sm font-medium rounded-md border border-canvas-border text-canvas-text hover:bg-canvas-bg-hover transition-colors'
                    >
                      ✕
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={startEditingFee}
                    className='w-full text-left px-3 py-2 rounded-md bg-canvas-bg-subtle text-canvas-text border border-canvas-border hover:bg-canvas-bg-hover transition-colors cursor-pointer'
                  >
                    {feeDisplayText()} {feeUnit === 'xch' ? 'XCH' : 'mojos'}
                  </button>
                )}
              </div>
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
                    <div className='w-[200px] h-[200px] flex items-center justify-center text-canvas-solid'>
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
                  onClick={() => {
                    navigator.clipboard.writeText(connectionSetup.qrUri);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  }}
                  className='self-start px-2 py-2 text-xs font-medium rounded-md border border-canvas-border text-canvas-text hover:bg-canvas-bg-hover transition-colors'
                  title='Copy URI to clipboard'
                >
                  {copied ? 'Copied!' : 'Copy'}
                </button>
              </div>
              <div className='w-full max-w-sm text-sm text-canvas-text'>
                <div className='flex items-center gap-2 mb-1'>
                  <span>Transaction fee</span>
                  <div className='flex rounded-md border border-canvas-border overflow-hidden text-xs'>
                    <button
                      onClick={() => handleFeeUnitChange('mojo')}
                      className={`px-2 py-0.5 transition-colors ${feeUnit === 'mojo' ? 'bg-canvas-bg-active font-semibold' : 'hover:bg-canvas-bg-hover'}`}
                    >
                      mojo
                    </button>
                    <button
                      onClick={() => handleFeeUnitChange('xch')}
                      className={`px-2 py-0.5 transition-colors border-l border-canvas-border ${feeUnit === 'xch' ? 'bg-canvas-bg-active font-semibold' : 'hover:bg-canvas-bg-hover'}`}
                    >
                      XCH
                    </button>
                  </div>
                </div>
                {feeEditing ? (
                  <div className='flex gap-2'>
                    <input
                      ref={feeInputRef}
                      type='text'
                      inputMode={feeUnit === 'xch' ? 'decimal' : 'numeric'}
                      value={feeInput}
                      onChange={(e) => setFeeInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && feeInputValid) commitFee();
                        if (e.key === 'Escape') cancelEditFee();
                      }}
                      className='flex-1 px-3 py-2 rounded-md bg-canvas-bg-subtle text-canvas-text border border-canvas-border outline-none'
                    />
                    <button
                      onClick={commitFee}
                      disabled={!feeInputValid}
                      className='px-3 py-2 text-sm font-medium rounded-md border border-canvas-border text-canvas-text hover:bg-canvas-bg-hover transition-colors disabled:opacity-40 disabled:cursor-default'
                    >
                      Set
                    </button>
                    <button
                      onClick={cancelEditFee}
                      className='px-3 py-2 text-sm font-medium rounded-md border border-canvas-border text-canvas-text hover:bg-canvas-bg-hover transition-colors'
                    >
                      ✕
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={startEditingFee}
                    className='w-full text-left px-3 py-2 rounded-md bg-canvas-bg-subtle text-canvas-text border border-canvas-border hover:bg-canvas-bg-hover transition-colors cursor-pointer'
                  >
                    {feeDisplayText()} {feeUnit === 'xch' ? 'XCH' : 'mojos'}
                  </button>
                )}
              </div>
              <p className='text-sm text-canvas-text animate-pulse'>Waiting for wallet to connect…</p>
              <Button variant='outline' onClick={handleCancelConnect}>Cancel</Button>
              <SimulatorSetupModal
                open={showSimModal}
                onConnect={handleFinalize}
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
          ) : connecting ? (
            <div className='flex flex-col items-center gap-4 p-6 max-w-md w-full'>
              <div className='w-6 h-6 border-2 border-canvas-border border-t-canvas-text-contrast rounded-full animate-spin' />
              <p className='text-sm text-canvas-text animate-pulse'>Connecting…</p>
              <Button variant='outline' onClick={handleCancelConnect}>Cancel</Button>
            </div>
          ) : (
            <div className='flex flex-col justify-center items-center w-full px-4 py-6 gap-4'>
              <p className='text-lg font-semibold text-canvas-text-contrast'>Choose Connection</p>
              <div className='w-full max-w-sm flex flex-col gap-3'>
                <Button variant='solid' fullWidth onClick={() => handleConnect('simulator')}>
                  Continue with Simulator
                </Button>
                <div className='flex items-center gap-2'>
                  <div className='flex-1 border-t border-canvas-border' />
                  <span className='text-canvas-text font-medium text-sm'>OR</span>
                  <div className='flex-1 border-t border-canvas-border' />
                </div>
                <Button variant='solid' color='secondary' fullWidth onClick={() => handleConnect('walletconnect')}>
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
          {keepSession ? (
            <GameSession
              params={gameParams}
              peerConn={peerConn}
              trackerLiveness={trackerLiveness}
              peerConnected={peerConnected}
              registerMessageHandler={registerMessageHandler}
              appendGameLog={appendGameLog}
              sessionSave={sessionSaveRef.current ?? undefined}
              onSessionActivity={onSessionActivity}
            />
          ) : sessionCanMount ? (
            <div className='w-full h-full flex items-center justify-center text-canvas-solid'>
              Restoring session...
            </div>
          ) : (
            <div className='w-full h-full flex items-center justify-center text-canvas-solid'>
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
            <div className='w-full h-full flex items-center justify-center text-canvas-solid'>
              No debug log entries yet
            </div>
          )}
        </div>
      </div>

    </div>
  );
};

export default Shell;
