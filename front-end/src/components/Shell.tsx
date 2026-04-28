import { useEffect, useState, useCallback, useRef, useMemo } from 'react';

import GameSession from './GameSession';
import { GameSessionErrorBoundary } from './GameSession';
import { SimulatorSetupModal } from './SimulatorSetupModal';
import QRCode from 'qrcode';
import { GameSessionParams, PeerConnectionResult, ChatMessage, InternalBlockchainInterface, ConnectionSetup, TrackerLiveness, SessionPhase } from '../types/ChiaGaming';
import { TrackerConnection, MatchedParams, ConnectionStatus } from '../services/TrackerConnection';
import { subscribeLog } from '../services/log';
import {
  getPlayerId,
  getSessionId,
  getBlockchainType,
  getTheme,
  setTheme as saveTheme,
  peekSession,
  saveSession,
  clearSession,
  hardReset,
  getBuildNonce,
  SessionState,
  getDefaultFee,
  setDefaultFee as saveDefaultFee,
  getFeeUnit,
  setFeeUnit as saveFeeUnit,
  getActiveTab as getSavedTab,
  setActiveTab as saveActiveTab,
  getUnreadChat as getSavedUnreadChat,
  setUnreadChat as saveUnreadChat,
  getUnreadGame as getSavedUnreadGame,
  setUnreadGame as saveUnreadGame,
  getWalletAlert as getSavedWalletAlert,
  setWalletAlert as saveWalletAlert,
  getTrackerAlert as getSavedTrackerAlert,
  setTrackerAlert as saveTrackerAlert,
  getTrackerUrl,
  setTrackerUrl as saveTrackerUrl,
  isLeaseConflict,
  claimLease,
  clearLease,
  onFenced,
  offFenced,
} from '../hooks/save';
import { blobSingleton, destroyBlobSingleton } from '../hooks/blobSingleton';
import { fakeBlockchainInfo } from '../hooks/FakeBlockchainInterface';
import { realBlockchainInfo } from '../hooks/RealBlockchainInterface';
import { activate, deactivate, getActiveBlockchain } from '../hooks/activeBlockchain';
import { useThemeSyncToIframe } from '../hooks/useThemeSyncToIframe';
import { log } from '../services/log';
import { Button } from './button';

import ChatPanel from './ChatPanel';
import { TrackerPicker } from './TrackerPicker';

type TabId = 'wallet' | 'tracker' | 'game' | 'chat' | 'history' | 'log';

const MOJOS_PER_XCH = 1_000_000_000_000;

function getInterface(bcType: 'simulator' | 'walletconnect') {
  return bcType === 'walletconnect'
    ? { iface: realBlockchainInfo, pollMs: 10000 }
    : { iface: fakeBlockchainInfo, pollMs: 5000 };
}

const TAB_DEFS: { id: TabId; label: string }[] = [
  { id: 'wallet', label: 'Wallet' },
  { id: 'tracker', label: 'Tracker' },
  { id: 'game', label: 'Game' },
  { id: 'chat', label: 'Chat' },
  { id: 'history', label: 'History' },
  { id: 'log', label: 'Log' },
];

const FALLBACK_AMOUNT = 100n;
const FALLBACK_PER_GAME = 10n;

function HistoryPanel({ lines }: { lines: string[] }) {
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

function LogPanel({ lines }: { lines: string[] }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const isNearBottom = useRef(true);
  const [filter, setFilter] = useState('');
  const [copied, setCopied] = useState(false);

  const filtered = useMemo(() => {
    if (!filter) return lines;
    const lower = filter.toLowerCase();
    return lines.filter(line => line.toLowerCase().includes(lower));
  }, [lines, filter]);

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
  }, [filtered]);

  return (
    <div className='flex flex-col h-full gap-2'>
      <div className='flex items-center gap-2 shrink-0'>
        <input
          type='text'
          placeholder='Filter'
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className='flex-1 px-3 py-1.5 text-xs font-mono rounded-md border border-canvas-border bg-canvas-bg text-canvas-text placeholder:text-canvas-solid focus:outline-none'
        />
        {filter && (
          <span className='text-xs text-canvas-solid whitespace-nowrap'>
            {filtered.length}/{lines.length}
          </span>
        )}
        <button
          onClick={() => {
            navigator.clipboard.writeText(filtered.join('\n'));
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className='p-1.5 rounded-md border border-canvas-border text-canvas-text hover:bg-canvas-bg-hover transition-colors'
          title='Copy to clipboard'
        >
          {copied ? (
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
              <path fillRule="evenodd" d="M16.704 4.153a.75.75 0 0 1 .143 1.052l-8 10.5a.75.75 0 0 1-1.127.075l-4.5-4.5a.75.75 0 0 1 1.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 0 1 1.05-.143Z" clipRule="evenodd" />
            </svg>
          ) : (
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
              <path d="M7 3.5A1.5 1.5 0 0 1 8.5 2h3.879a1.5 1.5 0 0 1 1.06.44l3.122 3.12A1.5 1.5 0 0 1 17 6.622V12.5a1.5 1.5 0 0 1-1.5 1.5h-1v-3.379a3 3 0 0 0-.879-2.121L10.5 5.379A3 3 0 0 0 8.379 4.5H7v-1Z" />
              <path d="M4.5 6A1.5 1.5 0 0 0 3 7.5v9A1.5 1.5 0 0 0 4.5 18h7a1.5 1.5 0 0 0 1.5-1.5v-5.879a1.5 1.5 0 0 0-.44-1.06L9.44 6.439A1.5 1.5 0 0 0 8.378 6H4.5Z" />
            </svg>
          )}
        </button>
      </div>
      <textarea
        ref={ref}
        readOnly
        value={filtered.join('\n')}
        onScroll={handleScroll}
        className='flex-1 min-h-0 resize-none rounded-md border border-canvas-border bg-canvas-bg p-3 text-xs font-mono text-canvas-text focus:outline-none'
      />
    </div>
  );
}

const Shell = () => {
  // Wipe stale saves before any useState reads from localStorage, so that
  // hooks like activeTab don't latch values from an old session.
  const staleWipeRef = useRef(false);
  if (!staleWipeRef.current) {
    staleWipeRef.current = true;
    const save = peekSession();
    const currentNonce = getBuildNonce();
    if (save && save.buildNonce !== currentNonce) {
      console.log(
        '[Shell] boot: stale save (build %s != %s), wiping',
        save.buildNonce ?? 'none',
        currentNonce ?? 'none',
      );
      clearSession();
      clearLease();
    }
  }

  const uniqueId = getPlayerId();
  const sessionId = getSessionId();

  const [activeTab, setActiveTabRaw] = useState<TabId>(() => {
    const saved = getSavedTab();
    if (saved === 'session') return 'game';
    const valid: TabId[] = ['wallet', 'tracker', 'game', 'chat', 'history', 'log'];
    return saved && valid.includes(saved as TabId) ? (saved as TabId) : 'wallet';
  });
  const setActiveTab = useCallback((tab: TabId) => {
    setActiveTabRaw(tab);
    saveActiveTab(tab);
  }, []);
  const [gameParams, setGameParams] = useState<GameSessionParams | null>(null);
  const [peerConn, setPeerConn] = useState<PeerConnectionResult | null>(null);

  const peerConnTargetRef = useRef<PeerConnectionResult>({
    sendMessage: () => {},
    sendAck: () => {},
    sendKeepalive: () => {},
    hostLog: (msg) => console.log('[peer-stub]', msg),
    close: () => {},
  });
  const stablePeerConn: PeerConnectionResult = useMemo(() => ({
    sendMessage: (n, m) => peerConnTargetRef.current.sendMessage(n, m),
    sendAck: (n) => peerConnTargetRef.current.sendAck(n),
    sendKeepalive: () => peerConnTargetRef.current.sendKeepalive(),
    hostLog: (m) => peerConnTargetRef.current.hostLog(m),
    close: () => peerConnTargetRef.current.close(),
  }), []);

  const [walletConnected, setWalletConnected] = useState(false);
  const [trackerLiveness, setTrackerLiveness] = useState<TrackerLiveness | null>(null);
  const [peerConnected, setPeerConnected] = useState<boolean | null>(null);
  const [sessionPhase, setSessionPhase] = useState<SessionPhase>('none');
  const [sessionError, setSessionError] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState<{ title: string; body: string; onConfirm: () => void } | null>(null);
  const trackerWsUpRef = useRef(false);
  const lastTrackerActivityRef = useRef(0);
  const lastPeerActivityRef = useRef(0);
  // --- Boot state machine ---
  //
  // The boot initializer NEVER claims the lease. Claiming the lease writes
  // to localStorage, which fences any existing tab via the storage event.
  // We must not do that until the user has made a conscious choice.
  //
  //   1. Save exists with matching nonce → 'resumeDialog'.
  //   2. Save exists but nonce is stale → clearSession(), then fall through
  //      to "no save" logic.
  //   3. No save → if another tab holds the lease, 'tabConflict'
  //      (the other tab is live even if we don't have its save locally);
  //      otherwise claim the lease and go 'ready'.
  //
  // From 'resumeDialog':
  //   - Start over → hardReset() + reload.
  //   - Resume     → if lease conflict, 'tabConflict'; else claim + hydrate.
  //
  // From 'tabConflict':
  //   - Take over → claimLease(), hydrate if save available.
  //   - Close     → 'tabDead' (terminal).
  //
  // A mid-session fenced event (another tab claimed the lease while we were
  // 'ready') also transitions to 'tabConflict' so the user can take control
  // back.
  type BootState =
    | { kind: 'ready' }
    | { kind: 'resumeDialog'; save: SessionState | null }
    | { kind: 'tabConflict'; save: SessionState | null; midSession: boolean }
    | { kind: 'tabDead' };

  const [bootState, setBootState] = useState<BootState>(() => {
    const save = peekSession();
    if (save) {
      console.log('[Shell] boot: save present (bcType=%s token=%s), showing resume dialog',
        save.blockchainType ?? 'none', save.pairingToken ?? 'none');
      return { kind: 'resumeDialog', save };
    }
    if (isLeaseConflict()) {
      console.log('[Shell] boot: no save but another tab holds the lease, showing tabConflict');
      return { kind: 'tabConflict', save: null, midSession: false };
    }
    console.log('[Shell] boot: no state, no conflict, claiming lease');
    claimLease();
    return { kind: 'ready' };
  });

  // Subscribe to mid-session lease loss. Only meaningful once we're 'ready' —
  // if we're still in a dialog, we haven't claimed the lease yet.
  useEffect(() => {
    const handler = () => {
      trackerConnRef.current?.disconnect();
      trackerConnRef.current = null;
      activeBlockchainRef.current?.disconnect().catch(() => {});
      activeBlockchainRef.current = null;
      setBootState(prev => {
        if (prev.kind !== 'ready') return prev;
        return { kind: 'tabConflict', save: peekSession(), midSession: true };
      });
    };
    onFenced(handler);
    return () => { offFenced(handler); };
  }, []);

  // Close WebSocket connections on page unload/reload so the browser doesn't
  // leave stale TCP sockets that block new connections in the reloaded page.
  useEffect(() => {
    const cleanup = () => {
      trackerConnRef.current?.disconnect();
      activeBlockchainRef.current?.disconnect().catch(() => {});
    };
    window.addEventListener('beforeunload', cleanup);
    return () => { window.removeEventListener('beforeunload', cleanup); };
  }, []);

  const [history, setHistory] = useState<string[]>([]);
  const [logLines, setLogLines] = useState<string[]>([]);

  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [unreadChat, setUnreadChatRaw] = useState(() => getSavedUnreadChat());
  const setUnreadChat = useCallback((v: boolean) => { setUnreadChatRaw(v); saveUnreadChat(v); }, []);
  const [unreadGame, setUnreadGameRaw] = useState(() => getSavedUnreadGame());
  const setUnreadGame = useCallback((v: boolean) => { setUnreadGameRaw(v); saveUnreadGame(v); }, []);
  const [walletAlert, setWalletAlertRaw] = useState(() => getSavedWalletAlert());
  const setWalletAlert = useCallback((v: boolean) => { setWalletAlertRaw(v); saveWalletAlert(v); }, []);
  const [trackerAlert, setTrackerAlertRaw] = useState(() => getSavedTrackerAlert());
  const setTrackerAlert = useCallback((v: boolean) => { setTrackerAlertRaw(v); saveTrackerAlert(v); }, []);
  const [iframeUrl, setIframeUrl] = useState('about:blank');
  const [balance, setBalance] = useState<number | undefined>();

  const [blockchainType, setBlockchainType] = useState<'simulator' | 'walletconnect' | undefined>(() => getBlockchainType());
  const activeBlockchainRef = useRef<InternalBlockchainInterface | null>(null);

  // Connection state
  const [showSimModal, setShowSimModal] = useState(false);
  const [connectionSetup, setConnectionSetup] = useState<ConnectionSetup | null>(null);
  const [connecting, setConnecting] = useState(false);
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
  const sessionSaveRef = useRef<SessionState | null>(null);
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

  const appendHistory = useCallback((line: string) => {
    deferStateUpdate(() => {
      setHistory(prev => [...prev, line]);
    });
  }, [deferStateUpdate]);

  const pendingMsgHandlerRef = useRef<{
    handler: (msgno: number, msg: Uint8Array) => void;
    ackHandler: (ack: number) => void;
    keepaliveHandler: () => void;
  } | null>(null);

  const markPeerActive = useCallback(() => {
    lastPeerActivityRef.current = Date.now();
    setPeerConnected(true);
  }, []);

  const markPeerInactive = useCallback(() => {
    lastPeerActivityRef.current = 0;
    setPeerConnected(false);
  }, []);

  const registerMessageHandler = useCallback((handler: (msgno: number, msg: Uint8Array) => void, ackHandler: (ack: number) => void, keepaliveHandler: () => void) => {
    pendingMsgHandlerRef.current = { handler, ackHandler, keepaliveHandler };
    if (trackerConnRef.current) {
      trackerConnRef.current.registerMessageHandler(
        (msgno, msg) => { markPeerActive(); handler(msgno, msg); },
        (ack) => { markPeerActive(); ackHandler(ack); },
        () => { markPeerActive(); keepaliveHandler(); },
      );
    }
  }, [markPeerActive]);

  useEffect(() => {
    return subscribeLog((line) => {
      deferStateUpdate(() => {
        setLogLines(prev => [...prev, line]);
      });
    });
  }, [deferStateUpdate]);

  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now();
      const activityFresh = lastTrackerActivityRef.current > 0 && now - lastTrackerActivityRef.current <= 45_000;
      setTrackerLiveness((prev) => {
        if (prev === null || prev === 'disconnected') return prev;
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

  const [trackerOrigin, setTrackerOrigin] = useState<string | null>(null);

  // Connect to a tracker by origin URL. Creates the lobby iframe + game relay WebSocket.
  const connectToTracker = useCallback((origin: string) => {
    trackerConnRef.current?.disconnect();
    trackerConnRef.current = null;

    setTrackerOrigin(origin);
    saveTrackerUrl(origin);
    const lobbyUrl = `${origin}/?lobby=true&session=${sessionId}&uniqueId=${uniqueId}`;
    setIframeUrl(lobbyUrl);

    const startSession = (
      conn: TrackerConnection,
      iStarted: boolean,
      amount: bigint,
      perGame: bigint,
      token: string,
      save: SessionState | null,
      myAlias?: string,
      opponentAlias?: string,
    ) => {
      console.log('[Shell] startSession: iStarted=%s amount=%s token=%s hasSave=%s', iStarted, amount, token, !!save);
      activePairingTokenRef.current = token;
      peerConnTargetRef.current = conn.getPeerConnection();

      const alreadyHydrated = !!sessionSaveRef.current;
      if (!alreadyHydrated) {
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
        setPeerConn(stablePeerConn);
        if (save) {
          if (save.history) setHistory(save.history);
          if (save.log) setLogLines(save.log);
          if (save.chatMessages) setChatMessages(save.chatMessages);
        } else {
          setHistory([]);
          setActiveTab('game');
        }
      } else {
        console.log('[Shell] startSession: state already hydrated by handleResume, upgrading peer connection only');
        setPeerConn(stablePeerConn);
      }
    };

    setTrackerLiveness('reconnecting');

    let conn: TrackerConnection;
    try {
      conn = new TrackerConnection(origin, sessionId, {
        onMatched: (matched: MatchedParams) => {
          trackerWsUpRef.current = true;
          lastTrackerActivityRef.current = Date.now();
          setTrackerLiveness('connected');
          // Treat successful tracker match as immediate peer activity for UX.
          markPeerActive();
          let amount: bigint;
          let perGame: bigint;
          try { amount = BigInt(matched.amount); } catch { amount = FALLBACK_AMOUNT; }
          try { perGame = BigInt(matched.per_game); } catch { perGame = FALLBACK_PER_GAME; }
          startSession(conn, matched.i_am_initiator, amount, perGame, matched.token, null, matched.my_alias, matched.peer_alias);
        },
        onConnectionStatus: (status: ConnectionStatus) => {
          console.log('[Shell] onConnectionStatus: has_pairing=%s token=%s peer_connected=%s activeToken=%s',
            status.has_pairing, status.token ?? 'none', status.peer_connected, activePairingTokenRef.current ?? 'null');
          trackerWsUpRef.current = true;
          lastTrackerActivityRef.current = Date.now();
          setTrackerLiveness('connected');
          if (!status.has_pairing || status.peer_connected === false) {
            markPeerInactive();
          } else if (status.peer_connected === true) {
            markPeerActive();
          } else {
            setPeerConnected(null);
          }
          if (activePairingTokenRef.current !== null) {
            if (status.has_pairing && status.token === activePairingTokenRef.current) {
              console.log('[Shell] mid-session reconnect: token matches, resending un-acked');
              blobSingleton?.resendUnacked();
            } else {
              console.warn('[Shell] mid-session reconnect: pairing lost or mismatched, keeping local session active');
              markPeerInactive();
            }
            return;
          }

          const save = peekSession();

          if (status.has_pairing && status.token) {
            if (save && save.pairingToken === status.token) {
              let amount: bigint;
              let perGame: bigint;
              try { amount = BigInt(save.amount ?? '0'); } catch { amount = FALLBACK_AMOUNT; }
              try { perGame = BigInt(save.perGameAmount ?? '0'); } catch { perGame = FALLBACK_PER_GAME; }
              startSession(conn, status.i_am_initiator!, amount, perGame, status.token, save, status.my_alias, status.peer_alias);
            } else if (!save) {
              console.warn('[Shell] connection_status: unrecognized pairing, requesting close');
              conn.close();
              clearSession();
            } else if (save.serializedCradle) {
              console.warn('[Shell] connection_status: token mismatch (tracker=%s, save=%s), closing unknown pairing', status.token, save.pairingToken);
              conn.close();
              let amount: bigint;
              let perGame: bigint;
              try { amount = BigInt(save.amount ?? '0'); } catch { amount = FALLBACK_AMOUNT; }
              try { perGame = BigInt(save.perGameAmount ?? '0'); } catch { perGame = FALLBACK_PER_GAME; }
              sessionSaveRef.current = save;
              setGameParams({
                iStarted: save.iStarted ?? false,
                amount,
                perGameAmount: perGame,
                restoring: true,
                pairingToken: save.pairingToken ?? '',
                myAlias: save.myAlias,
                opponentAlias: save.opponentAlias,
              });
              setPeerConn(conn.getPeerConnection());
              if (save.history) setHistory(save.history);
              if (save.log) setLogLines(save.log);
              if (save.chatMessages) setChatMessages(save.chatMessages);
            }
          } else {
            if (save && save.serializedCradle) {
              console.warn('[Shell] connection_status: no pairing but have full save, going on-chain');
              let amount: bigint;
              let perGame: bigint;
              try { amount = BigInt(save.amount ?? '0'); } catch { amount = FALLBACK_AMOUNT; }
              try { perGame = BigInt(save.perGameAmount ?? '0'); } catch { perGame = FALLBACK_PER_GAME; }
              sessionSaveRef.current = save;
              setGameParams({
                iStarted: save.iStarted ?? false,
                amount,
                perGameAmount: perGame,
                restoring: true,
                pairingToken: save.pairingToken ?? '',
                myAlias: save.myAlias,
                opponentAlias: save.opponentAlias,
              });
              setPeerConn(conn.getPeerConnection());
              if (save.history) setHistory(save.history);
              if (save.log) setLogLines(save.log);
              if (save.chatMessages) setChatMessages(save.chatMessages);
            }
          }
        },
        onPeerReconnected: () => {
          markPeerActive();
          blobSingleton?.resendUnacked();
        },
        onMessage: (_data: unknown) => { markPeerActive(); },
        onAck: (_ack: number) => { markPeerActive(); },
        onKeepalive: () => { markPeerActive(); },
        onClosed: () => {
          console.log('[Shell] tracker connection closed');
          trackerWsUpRef.current = false;
          lastTrackerActivityRef.current = 0;
          markPeerInactive();
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
        onLobbyAttention: () => {
          if (activeTabRef.current !== 'tracker') {
            setTrackerAlert(true);
          }
        },
      });
    } catch (err) {
      console.error('[Shell] TrackerConnection failed for origin=%s', origin, err);
      saveTrackerUrl(undefined);
      setTrackerOrigin(null);
      setIframeUrl('about:blank');
      return;
    }
    trackerConnRef.current = conn;

    if (pendingMsgHandlerRef.current) {
      const { handler, ackHandler, keepaliveHandler } = pendingMsgHandlerRef.current;
      conn.registerMessageHandler(
        (msgno, msg) => { markPeerActive(); handler(msgno, msg); },
        (ack) => { markPeerActive(); ackHandler(ack); },
        () => { markPeerActive(); keepaliveHandler(); },
      );
    }

    const initialSave = peekSession();
    if (initialSave && initialSave.pairingToken) {
      let amount: bigint;
      let perGame: bigint;
      try { amount = BigInt(initialSave.amount ?? '0'); } catch { amount = FALLBACK_AMOUNT; }
      try { perGame = BigInt(initialSave.perGameAmount ?? '0'); } catch { perGame = FALLBACK_PER_GAME; }
      startSession(
        conn,
        initialSave.iStarted ?? false,
        amount,
        perGame,
        initialSave.pairingToken,
        initialSave,
      );
      markPeerInactive();
    }
  }, [uniqueId, sessionId, markPeerActive, markPeerInactive]);

  const requestTrackerConnect = useCallback((origin: string) => {
    if (peerConnected && sessionPhase === 'off-chain') {
      setConfirmDialog({
        title: 'Disconnect from tracker?',
        body: 'Disconnecting from this tracker will end your peer connection and force your game on-chain.',
        onConfirm: () => { setConfirmDialog(null); connectToTracker(origin); },
      });
    } else if (peerConnected) {
      setConfirmDialog({
        title: 'Disconnect from tracker?',
        body: 'This will end your peer connection.',
        onConfirm: () => { setConfirmDialog(null); connectToTracker(origin); },
      });
    } else {
      connectToTracker(origin);
    }
  }, [peerConnected, sessionPhase, connectToTracker]);

  // Auto-connect to saved tracker on reload; otherwise wait for user selection
  useEffect(() => {
    if (!userReady) { console.log('[Shell] tracker-reconnect effect: userReady=false, skipping'); return; }
    const url = getTrackerUrl();
    console.log('[Shell] tracker-reconnect effect: userReady=true trackerUrl=%s', url ?? 'none');
    if (url) {
      connectToTracker(url);
    }
    return () => {
      trackerConnRef.current?.disconnect();
      trackerConnRef.current = null;
    };
  }, [userReady, connectToTracker]);

  // Disconnect tracker when we're not in the 'ready' state; reconnect when we become ready again.
  useEffect(() => {
    if (bootState.kind !== 'ready') {
      trackerConnRef.current?.disconnect();
      trackerConnRef.current = null;
    } else if (userReady) {
      const url = getTrackerUrl();
      if (url && !trackerConnRef.current) {
        connectToTracker(url);
      }
    }
  }, [bootState.kind, userReady, connectToTracker]);

  // Shared connection completion
  const completeConnection = useCallback((iface: InternalBlockchainInterface, bcType: 'simulator' | 'walletconnect', pollMs: number) => {
    console.log('[Shell] completeConnection: bcType=%s', bcType);
    deactivate();
    activate(iface, pollMs);
    saveSession({ blockchainType: bcType });
    activeBlockchainRef.current = iface;
    setBlockchainType(bcType);
    setWalletConnected(true);
    setConnecting(false);
    setConnectionSetup(null);
    setUserReady(true);
    setActiveTabRaw(prev => prev === 'wallet' ? 'tracker' : prev);
    requestBalance();
    log(`${bcType} wallet connected`);
  }, [requestBalance, setConnecting]);

  // --- Unified connection flow ---
  // silent: skip the modal on reconnect (e.g. auto-reconnect after completed connection)
  const handleConnect = useCallback(async (bcType: 'simulator' | 'walletconnect', silent = false) => {
    log(`[Shell] handleConnect: bcType=${bcType} silent=${silent}`);
    wcAbortRef.current = false;
    const { iface, pollMs } = getInterface(bcType);
    try {
      saveSession({ blockchainType: bcType });
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
      log(`[Shell] handleConnect: calling finalize`);
      await setup.finalize();
      if (wcAbortRef.current) return;
      log(`[Shell] handleConnect: finalize complete`);
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
    log(`[Shell] handleFinalize: bcType=${blockchainType}`);
    const { iface, pollMs } = getInterface(blockchainType);
    setConnecting(true);
    try {
      await connectionSetup.finalize();
      log(`[Shell] handleFinalize: finalize complete`);
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

  const onGameActivity = useCallback(() => {
    if (activeTabRef.current !== 'game') {
      deferStateUpdate(() => {
        setUnreadGame(true);
      });
    }
  }, [deferStateUpdate]);

  const handleSessionPhaseChange = useCallback((phase: SessionPhase, hasError?: boolean) => {
    setSessionPhase(phase);
    setSessionError(!!hasError);
  }, []);

  useEffect(() => {
    if (sessionPhase !== 'resolved') return;
    clearSession();
    sessionSaveRef.current = null;
  }, [sessionPhase]);

  const closeResolvedSession = useCallback(() => {
    destroyBlobSingleton();
    setGameParams(null);
    setPeerConn(null);
    activePairingTokenRef.current = null;
    setSessionPhase('none');
    setSessionError(false);
    trackerConnRef.current?.setAvailable(true);
  }, []);

  useEffect(() => {
    trackerConnRef.current?.setAvailable(sessionPhase === 'none' || sessionPhase === 'resolved');
  }, [sessionPhase]);

  const handleTabChange = useCallback((tabId: TabId) => {
    setActiveTab(tabId);
    if (tabId === 'chat') setUnreadChat(false);
    if (tabId === 'game') setUnreadGame(false);
    if (tabId === 'wallet') setWalletAlert(false);
    if (tabId === 'tracker') setTrackerAlert(false);
  }, []);

  useThemeSyncToIframe('tracker-iframe', [iframeUrl]);

  const [resuming, setResuming] = useState(false);

  // Hydrate local UI state from a SessionState and kick off a backend connect.
  // Called only after the user has consented (Resume button) and the lease is ours.
  const performResume = useCallback(async (save: SessionState) => {
    const bcType = save.blockchainType ?? 'simulator';
    console.log('[Shell] performResume: bcType=%s token=%s', bcType, save.pairingToken ?? 'none');
    setResuming(true);

    sessionSaveRef.current = save;
    let amount: bigint;
    let perGame: bigint;
    try { amount = BigInt(save.amount ?? '0'); } catch { amount = FALLBACK_AMOUNT; }
    try { perGame = BigInt(save.perGameAmount ?? '0'); } catch { perGame = FALLBACK_PER_GAME; }
    if (save.pairingToken) {
      setGameParams({
        iStarted: save.iStarted ?? false,
        amount,
        perGameAmount: perGame,
        restoring: true,
        pairingToken: save.pairingToken,
        myAlias: save.myAlias,
        opponentAlias: save.opponentAlias,
      });
      setPeerConn(stablePeerConn);
    }
    if (save.history) setHistory(save.history);
    if (save.log) setLogLines(save.log);
    if (save.chatMessages) setChatMessages(save.chatMessages);

    setBlockchainType(bcType);

    const { iface, pollMs } = getInterface(bcType);
    try {
      const setup = await iface.beginConnect(uniqueId);
      await setup.finalize();
      completeConnection(iface, bcType, pollMs);
    } catch (err) {
      console.warn('[Shell] performResume connect failed, falling back', err);
      setUserReady(true);
    }
    console.log('[Shell] performResume: done');
    setResuming(false);
  }, [uniqueId, completeConnection, stablePeerConn]);

  // User clicked "Resume Session" in the resumeDialog.
  // If another tab holds the lease, ask to take over first; otherwise proceed.
  const handleResume = useCallback(() => {
    setBootState(prev => {
      if (prev.kind !== 'resumeDialog') return prev;
      const save = prev.save;
      if (isLeaseConflict()) {
        console.log('[Shell] resume: lease conflict, showing tabConflict dialog');
        return { kind: 'tabConflict', save, midSession: false };
      }
      console.log('[Shell] resume: no conflict, claiming lease and hydrating');
      claimLease();
      if (save && save.serializedCradle) {
        void performResume(save);
      } else {
        const bcType = save?.blockchainType;
        if (bcType) {
          void handleConnect(bcType, true);
        }
      }
      return { kind: 'ready' };
    });
  }, [performResume, handleConnect]);

  // User clicked "Take over" in the tabConflict dialog.
  // Claim the lease in place (this fences the other tab via storage event)
  // and continue with whatever action we were about to take.
  const handleTakeOver = useCallback(() => {
    setBootState(prev => {
      if (prev.kind !== 'tabConflict') return prev;
      console.log('[Shell] takeOver: claiming lease in place (midSession=%s)', prev.midSession);
      claimLease();
      if (prev.midSession) {
        // Our session is already live — just reclaim the lease.
      } else if (prev.save && prev.save.serializedCradle) {
        void performResume(prev.save);
      } else {
        const bcType = prev.save?.blockchainType ?? getBlockchainType();
        if (bcType) {
          void handleConnect(bcType, true);
        }
      }
      return { kind: 'ready' };
    });
  }, [performResume, handleConnect]);

  const handleCloseTab = useCallback(() => {
    trackerConnRef.current?.disconnect();
    trackerConnRef.current = null;
    activeBlockchainRef.current?.disconnect().catch(() => {});
    activeBlockchainRef.current = null;
    setBootState({ kind: 'tabDead' });
  }, []);

  const handleStartOver = useCallback(async () => {
    if (activeBlockchainRef.current) {
      try { await activeBlockchainRef.current.disconnect(); } catch (_) {}
    }
    await hardReset();
    window.location.reload();
  }, []);

  const doDisconnectWallet = useCallback(async () => {
    if (activeBlockchainRef.current) {
      try { await activeBlockchainRef.current.disconnect(); } catch (_) {}
    }
    deactivate();
    activeBlockchainRef.current = null;
    setWalletConnected(false);
    setBlockchainType(undefined);
    setBalance(undefined);
  }, []);

  const handleDisconnectWallet = useCallback(() => {
    if (sessionPhase !== 'none') {
      setConfirmDialog({
        title: 'Disconnect wallet?',
        body: 'You are in a session. Blockchain operations will stall until you reconnect a wallet.',
        onConfirm: () => { setConfirmDialog(null); doDisconnectWallet(); },
      });
    } else {
      doDisconnectWallet();
    }
  }, [sessionPhase, doDisconnectWallet]);

  const doAbandonSession = useCallback(() => {
    destroyBlobSingleton();
    clearSession();
    setGameParams(null);
    setPeerConn(null);
    sessionSaveRef.current = null;
    activePairingTokenRef.current = null;
    setSessionPhase('none');
    setSessionError(false);
    trackerConnRef.current?.setAvailable(true);
  }, []);

  const handleAbandonSession = useCallback(() => {
    setConfirmDialog({
      title: 'Abandon session?',
      body: 'You will lose any funds locked in this channel. This cannot be undone. Are you sure you want to abandon this session?',
      onConfirm: () => { setConfirmDialog(null); doAbandonSession(); },
    });
  }, [doAbandonSession]);

  const doDisconnectTracker = useCallback(() => {
    trackerConnRef.current?.disconnect();
    trackerConnRef.current = null;
    saveTrackerUrl(undefined);
    setTrackerOrigin(null);
    setIframeUrl('about:blank');
    setTrackerLiveness(null);
    markPeerInactive();
  }, [markPeerInactive]);

  const handleDisconnectTracker = useCallback(() => {
    if (peerConnected && sessionPhase === 'off-chain') {
      setConfirmDialog({
        title: 'Disconnect from tracker?',
        body: 'Disconnecting from this tracker will end your peer connection and force your game on-chain.',
        onConfirm: () => { setConfirmDialog(null); doDisconnectTracker(); },
      });
    } else if (peerConnected) {
      setConfirmDialog({
        title: 'Disconnect from tracker?',
        body: 'This will end your peer connection.',
        onConfirm: () => { setConfirmDialog(null); doDisconnectTracker(); },
      });
    } else {
      doDisconnectTracker();
    }
  }, [peerConnected, sessionPhase, doDisconnectTracker]);

  const doEndPeerConnection = useCallback(() => {
    trackerConnRef.current?.close();
  }, []);

  const handleEndPeerConnection = useCallback(() => {
    if (sessionPhase === 'off-chain') {
      setConfirmDialog({
        title: 'End peer connection?',
        body: 'This will force your game on-chain.',
        onConfirm: () => { setConfirmDialog(null); doEndPeerConnection(); },
      });
    } else {
      doEndPeerConnection();
    }
  }, [sessionPhase, doEndPeerConnection]);

  const handleReconnect = useCallback(() => {
    if (!blockchainType) return;
    handleConnect(blockchainType);
  }, [blockchainType, handleConnect]);

  // --- Tab dead (user chose to yield to another tab) ---
  if (bootState.kind === 'tabDead') {
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
          <p className='text-canvas-text-contrast font-semibold text-lg'>Tab inactive</p>
          <p className='text-canvas-text text-sm text-center'>
            This tab is no longer active. You can close it.
          </p>
        </div>
      </div>
    );
  }

  // --- Resume / Start over dialog (checked BEFORE tab-conflict per spec) ---
  if (bootState.kind === 'resumeDialog') {
    const hasFullSave = bootState.save !== null;
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
          <p className='text-canvas-text-contrast font-semibold text-lg'>
            {hasFullSave ? 'Previously saved state' : 'Session in progress'}
          </p>
          <p className='text-canvas-text text-sm text-center'>
            {hasFullSave
              ? 'You have previously saved state. Resume where you left off, or start over?'
              : 'A session is already in progress. Resume it, or start over?'}
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

  // --- Tab conflict dialog (another tab holds the lease) ---
  // Reached from: boot (no save but lease held), resume (lease held),
  // or mid-session fence (another tab stole the lease).
  if (bootState.kind === 'tabConflict') {
    const isMidSession = bootState.midSession;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', width: '100vw', height: '100vh', ...(isMidSession ? { position: 'fixed', inset: 0, zIndex: 9999 } : {}) }}
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
          <p className='text-canvas-text-contrast font-semibold text-lg'>Another tab is active</p>
          <p className='text-canvas-text text-sm text-center'>
            {isMidSession
              ? 'Another tab has taken over this session.'
              : 'It looks like another tab is already running.'}
            {' '}Would you like this tab to take over, or close it?
          </p>
          <button
            onClick={handleTakeOver}
            className='w-full px-4 py-2 rounded-md font-medium text-sm bg-primary-solid text-primary-on-primary hover:bg-primary-solid-hover transition-colors'
          >
            {isMidSession ? 'Take back control' : 'Take over'}
          </button>
          <button
            onClick={handleCloseTab}
            className='w-full px-4 py-2 rounded-md font-medium text-sm border border-canvas-border text-canvas-text hover:bg-canvas-bg-hover transition-colors'
          >
            Close this tab
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
  console.log('[Shell] render: gameParams=%s peerConn=%s activeBlockchain=%s walletConnected=%s restoring=%s → keepSession=%s',
    !!gameParams, !!peerConn, hasActiveBlockchain, walletConnected, !!gameParams?.restoring, keepSession);

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
            (tab.id === 'game' && unreadGame) ||
            (tab.id === 'wallet' && walletAlert) ||
            (tab.id === 'tracker' && trackerAlert)
          );

          let dotColor: string | null = null;
          switch (tab.id) {
            case 'wallet':
              dotColor = walletConnected ? 'var(--color-success-solid)' : 'var(--color-alert-solid)';
              break;
            case 'tracker':
              if (trackerLiveness === 'connected') {
                dotColor = 'var(--color-success-solid)';
              } else if (trackerLiveness === 'reconnecting') {
                dotColor = 'var(--color-warning-solid)';
              } else if (trackerLiveness === 'inactive') {
                dotColor = 'var(--color-alert-solid)';
              } else {
                dotColor = 'var(--color-canvas-text-subtle)';
              }
              break;
            case 'game':
              if (sessionPhase === 'none') {
                dotColor = 'var(--color-canvas-text-subtle)';
              } else if (sessionError) {
                dotColor = 'var(--color-alert-solid)';
              } else if (sessionPhase === 'on-chain') {
                dotColor = 'var(--color-warning-solid)';
              } else if (sessionPhase === 'off-chain' && !peerConnected) {
                dotColor = 'var(--color-alert-solid)';
              } else if (sessionPhase === 'off-chain' && peerConnected) {
                dotColor = 'var(--color-success-solid)';
              } else {
                dotColor = 'var(--color-canvas-text-subtle)';
              }
              break;
            case 'chat':
              dotColor = peerConnected ? 'var(--color-success-solid)' : 'var(--color-canvas-text-subtle)';
              break;
          }

          return (
            <button
              key={tab.id}
              onClick={() => handleTabChange(tab.id)}
              style={active ? { background: 'var(--canvas-bg-subtle)', display: 'inline-flex', alignItems: 'center', gap: '0.35rem' } : { display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}
              className={
                'relative px-3 py-1.5 text-sm font-medium rounded-t-md transition-colors ' +
                (active
                  ? 'text-canvas-text-contrast border border-b-0 border-canvas-border -mb-px'
                  : 'text-canvas-text hover:text-canvas-text-contrast hover:bg-canvas-bg-hover')
              }
            >
              {dotColor && <span style={{ width: 8, height: 8, borderRadius: '50%', background: dotColor, flexShrink: 0 }} />}
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
            src='images/chia_logo.png'
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
              <Button variant='solid' onClick={handleDisconnectWallet}>
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
                  className='self-center p-2 rounded-md border border-canvas-border text-canvas-text hover:bg-canvas-bg-hover transition-colors'
                  title='Copy URI to clipboard'
                >
                  {copied ? (
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                      <path fillRule="evenodd" d="M16.704 4.153a.75.75 0 0 1 .143 1.052l-8 10.5a.75.75 0 0 1-1.127.075l-4.5-4.5a.75.75 0 0 1 1.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 0 1 1.05-.143Z" clipRule="evenodd" />
                    </svg>
                  ) : (
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                      <path d="M7 3.5A1.5 1.5 0 0 1 8.5 2h3.879a1.5 1.5 0 0 1 1.06.44l3.122 3.12A1.5 1.5 0 0 1 17 6.622V12.5a1.5 1.5 0 0 1-1.5 1.5h-1v-3.379a3 3 0 0 0-.879-2.121L10.5 5.379A3 3 0 0 0 8.379 4.5H7v-1Z" />
                      <path d="M4.5 6A1.5 1.5 0 0 0 3 7.5v9A1.5 1.5 0 0 0 4.5 18h7a1.5 1.5 0 0 0 1.5-1.5v-5.879a1.5 1.5 0 0 0-.44-1.06L9.44 6.439A1.5 1.5 0 0 0 8.378 6H4.5Z" />
                    </svg>
                  )}
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
              <Button variant='solid' onClick={handleCancelConnect}>Cancel</Button>
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
              <Button variant='solid' onClick={handleCancelConnect}>Cancel</Button>
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
                <Button variant='solid' fullWidth onClick={() => handleConnect('walletconnect')}>
                  Link Wallet
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* Tracker tab */}
        <div style={{ position: 'absolute', inset: 0, display: activeTab === 'tracker' ? 'flex' : 'none', flexDirection: 'column' }}>
          {trackerOrigin ? (
            <>
              <div className='flex items-center justify-between px-3 py-1 border-b border-canvas-border bg-canvas-bg text-xs text-canvas-text-subtle shrink-0'>
                <span>Connected to {trackerOrigin}</span>
                <button
                  onClick={handleDisconnectTracker}
                  className='px-1.5 py-0 text-xs rounded border border-canvas-border text-canvas-text hover:bg-canvas-bg-hover transition-colors'
                >
                  Disconnect
                </button>
              </div>
              <iframe
                id='tracker-iframe'
                className='bg-canvas-bg-subtle'
                style={{ flex: '1 1 0%', width: '100%', border: 'none', margin: 0 }}
                src={iframeUrl}
              />
            </>
          ) : (
            <TrackerPicker onConnect={requestTrackerConnect} />
          )}
        </div>

        {/* Game Session tab */}
        <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', visibility: activeTab === 'game' ? 'visible' : 'hidden' }}>
          <div style={{ flex: '1 1 0%', minHeight: 0, overflow: 'auto' }}>
            {keepSession ? (
              <GameSessionErrorBoundary>
                <GameSession
                  params={gameParams}
                  peerConn={peerConn}
                  trackerLiveness={trackerLiveness}
                  peerConnected={peerConnected}
                  registerMessageHandler={registerMessageHandler}
                  appendGameLog={appendHistory}
                  sessionSave={sessionSaveRef.current ?? undefined}
                  onGameActivity={onGameActivity}
                  onSessionPhaseChange={handleSessionPhaseChange}
                />
              </GameSessionErrorBoundary>
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
          {sessionPhase !== 'none' && (
            <div className='flex items-center gap-2 px-3 py-1.5 border-t border-canvas-border bg-canvas-bg shrink-0 text-xs'>
              {sessionPhase === 'resolved' ? (
                <button
                  onClick={closeResolvedSession}
                  className='ml-auto px-2 py-0.5 rounded border border-canvas-border text-canvas-text hover:bg-canvas-bg-hover transition-colors'
                >
                  Close Session
                </button>
              ) : (
                <>
                  {peerConnected && (
                    <button
                      onClick={handleEndPeerConnection}
                      className='px-2 py-0.5 rounded border border-canvas-border text-canvas-text hover:bg-canvas-bg-hover transition-colors'
                    >
                      End Peer
                    </button>
                  )}
                  <button
                    onClick={handleAbandonSession}
                    className='ml-auto px-2 py-0.5 rounded border border-alert-solid text-alert-text hover:bg-alert-solid hover:text-primary-on-primary transition-colors'
                  >
                    Abandon Session
                  </button>
                </>
              )}
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

        {/* History tab */}
        <div style={{ position: 'absolute', inset: 0, padding: '1rem', display: activeTab === 'history' ? 'block' : 'none' }}>
          <HistoryPanel lines={history} />
        </div>

        {/* Log tab */}
        <div style={{ position: 'absolute', inset: 0, padding: '1rem', display: activeTab === 'log' ? 'block' : 'none' }}>
          {logLines.length > 0 ? (
            <LogPanel lines={logLines} />
          ) : (
            <div className='w-full h-full flex items-center justify-center text-canvas-solid'>
              No log entries yet
            </div>
          )}
        </div>
      </div>

      {confirmDialog && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', justifyContent: 'center', alignItems: 'center', background: 'rgba(0,0,0,0.5)' }}>
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.75rem',
            padding: '1.5rem', borderRadius: '0.5rem', border: '1px solid var(--color-canvas-border)',
            background: 'var(--color-canvas-bg)', maxWidth: '24rem', width: '90%',
          }}>
            <p className='text-canvas-text-contrast font-semibold text-lg'>{confirmDialog.title}</p>
            <p className='text-canvas-text text-sm text-center'>{confirmDialog.body}</p>
            <button
              onClick={confirmDialog.onConfirm}
              className='w-full px-4 py-2 rounded-md font-medium text-sm bg-alert-solid text-primary-on-primary hover:bg-alert-solid-hover transition-colors'
            >
              Proceed
            </button>
            <button
              onClick={() => setConfirmDialog(null)}
              className='w-full px-4 py-2 rounded-md font-medium text-sm border border-canvas-border text-canvas-text hover:bg-canvas-bg-hover transition-colors'
            >
              Cancel
            </button>
          </div>
        </div>
      )}

    </div>
  );
};

export default Shell;
