import { useEffect, useState, useCallback, useRef, useMemo } from 'react';

import GameSession from './GameSession';
import { GameSessionErrorBoundary } from './GameSession';
import { SimulatorSetupModal } from './SimulatorSetupModal';
import QRCode from 'qrcode';
import { GameSessionParams, PeerConnectionResult, ChatMessage, InternalBlockchainInterface, ConnectionSetup, TrackerLiveness, SessionPhase, CoinOfInterestEntry } from '../types/ChiaGaming';
import { TrackerConnection, MatchedParams, ConnectionStatus } from '../services/TrackerConnection';
import { subscribeLog } from '../services/log';
import {
  getPlayerId,
  getSessionId,
  clearSessionId,
  getBlockchainType,
  getTheme,
  setTheme as saveTheme,
  peekSession,
  saveSession,
  clearSession,
  hardReset,
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
  onFenced,
  offFenced,
} from '../hooks/save';
import { blobSingleton, destroyBlobSingleton } from '../hooks/blobSingleton';
import { fakeBlockchainInfo } from '../hooks/FakeBlockchainInterface';
import { realBlockchainInfo } from '../hooks/RealBlockchainInterface';
import { activate, deactivate, getActiveBlockchain } from '../hooks/activeBlockchain';
import {
  BALANCE_POLL_INTERVAL_MS,
  CHAIN_POLL_INTERVAL_MS,
  type BlockchainPoller,
} from '../hooks/BlockchainPoller';
import { RestoreStatus } from '../hooks/WasmBlobWrapper';
import { useThemeSyncToIframe } from '../hooks/useThemeSyncToIframe';
import { isRestoreBlocked, shouldAdvertiseAvailable, shouldMountGameSession, shouldSwitchToTrackerOnResolved } from '../lib/restoreLifecycle';
import {
  selectGameDashboardView,
  selectStatusBarBalances,
  selectSessionPhase,
  sessionAmountsFromSave,
  sessionModelFromSave,
  DEFAULT_CHANNEL_TIMEOUT_BLOCKS,
  DEFAULT_UNROLL_TIMEOUT_BLOCKS,
  type GameDashboardActionKind,
  type GameDashboardViewModel,
  type SessionModel,
  type StatusBarBalanceSegment,
} from '../lib/session/model';
import { gameDisplayName } from '../lib/gameRegistry';
import { log } from '../services/log';
import { formatMojos } from '../util';
import { Button } from './button';

import ChatPanel from './ChatPanel';
import { TrackerPicker } from './TrackerPicker';

type TabId = 'wallet' | 'tracker' | 'game' | 'chat' | 'history' | 'log';

const MOJOS_PER_XCH = 1_000_000_000_000;

function getInterface(bcType: 'simulator' | 'walletconnect') {
  return bcType === 'walletconnect'
    ? { iface: realBlockchainInfo, pollMs: CHAIN_POLL_INTERVAL_MS }
    : { iface: fakeBlockchainInfo, pollMs: 5000 };
}

function normalizeTrackerOrigin(origin: string): string {
  try {
    const url = new URL(origin);
    if (url.hostname === '127.0.0.1' && url.port === '3003') {
      url.hostname = 'localhost';
      return url.origin;
    }
  } catch {
    return origin;
  }
  return origin;
}

function humanHistoryFromSave(save: SessionState): string[] | undefined {
  return save.humanHistory ?? save.history;
}

function diagnosticLogFromSave(save: SessionState): string[] | undefined {
  return save.diagnosticLog ?? save.log;
}

function reactPropSafeValue<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    const copy = value.map(reactPropSafeValue);
    value.forEach((item, index) => {
      if (typeof item === 'bigint') {
        Object.defineProperty(copy, index, {
          value: item,
          enumerable: false,
          configurable: true,
          writable: true,
        });
      }
    });
    return copy as T;
  }

  const copy = { ...(value as Record<string, unknown>) };
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (typeof nested === 'bigint') {
      Object.defineProperty(copy, key, {
        value: nested,
        enumerable: false,
        configurable: true,
        writable: true,
      });
    } else if (nested !== null && typeof nested === 'object') {
      copy[key] = reactPropSafeValue(nested);
    }
  }
  return copy as T;
}

function sessionSaveForReactProps(save: SessionState | null): SessionState | undefined {
  if (!save) return undefined;
  const propSafeSave = reactPropSafeValue(save);
  if (Object.prototype.hasOwnProperty.call(save, 'handState')) {
    Object.defineProperty(propSafeSave, 'handState', {
      value: save.handState,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
  return propSafeSave;
}

function sessionSaveStartsBusy(save: SessionState | null): boolean {
  if (!save?.serializedCradle && !save?.pairingToken) return false;
  const { perGameAmount } = sessionAmountsFromSave(save, FALLBACK_AMOUNT, FALLBACK_PER_GAME);
  return selectSessionPhase(sessionModelFromSave(save, perGameAmount)) !== 'resolved';
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

const TRACKER_LIVENESS_LABELS: Record<TrackerLiveness, string> = {
  connected: 'Connected',
  reconnecting: 'Reconnecting',
  inactive: 'Inactive',
  disconnected: 'Disconnected',
};

function formatBalanceValue(raw: string): string {
  try {
    return formatMojos(BigInt(raw));
  } catch {
    // Non-numeric sentinel (e.g. the '?' error convention) — show as-is.
    return raw;
  }
}

function GameDashboard({
  view,
  balances,
  onAction,
  getProtocolState,
  getCoins,
}: {
  view: GameDashboardViewModel;
  balances: StatusBarBalanceSegment[] | null;
  onAction: (kind: GameDashboardActionKind) => void;
  getProtocolState: () => string | null;
  getCoins: () => CoinOfInterestEntry[];
}) {
  const [expanded, setExpanded] = useState(false);
  const [protocolText, setProtocolText] = useState<string | null>(null);
  const [coins, setCoins] = useState<CoinOfInterestEntry[]>([]);
  const refreshProtocolState = useCallback(() => {
    setProtocolText(getProtocolState());
    setCoins(getCoins());
  }, [getProtocolState, getCoins]);
  useEffect(() => {
    if (expanded) refreshProtocolState();
  }, [expanded, refreshProtocolState]);

  return (
    <div className='flex-shrink-0 border-b border-canvas-border bg-canvas-bg-subtle px-4 py-2 text-canvas-text sm:px-6 md:px-8'>
      <div className='flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between'>
        <div className='flex min-w-0 items-center gap-2 text-sm'>
          <button
            type='button'
            onClick={() => setExpanded(prev => !prev)}
            aria-expanded={expanded}
            aria-label={expanded ? 'Hide dashboard details' : 'Show dashboard details'}
            className='flex h-6 w-6 shrink-0 items-center justify-center rounded text-canvas-text transition-colors hover:bg-canvas-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-solid'
          >
            <span
              aria-hidden='true'
              className={`text-sm leading-none transition-transform ${expanded ? 'rotate-90' : ''}`}
            >
              ▶
            </span>
          </button>
          <div className='flex min-w-0 flex-col gap-y-0.5'>
            <div className='flex flex-wrap items-center gap-x-4 gap-y-0.5'>
              <span className='flex min-w-0 flex-wrap gap-x-1'>
                <span className='text-canvas-solid'>Channel:</span>
                <span className='font-medium text-canvas-text-contrast'>{view.channelStatusLabel}</span>
                {view.channelDetail && (
                  <span className='text-canvas-text'>{view.channelDetail}</span>
                )}
              </span>
              <span className='flex min-w-0 flex-wrap gap-x-1'>
                <span className='text-canvas-solid'>Hand:</span>
                <span className='font-medium text-canvas-text-contrast'>{view.handStatusLabel}</span>
                {view.handDetail && (
                  <span className='text-canvas-text'>{view.handDetail}</span>
                )}
              </span>
            </div>
            {balances && (
              <div className='flex flex-wrap items-center gap-x-4 gap-y-0.5'>
                {balances.map(seg => (
                  <span key={seg.label} className='flex min-w-0 flex-wrap gap-x-1'>
                    <span className='text-canvas-solid'>{seg.label}:</span>
                    <span className='font-medium text-canvas-text-contrast'>
                      {formatBalanceValue(seg.value)}
                      {seg.value2 !== undefined ? ` / ${formatBalanceValue(seg.value2)}` : ''}
                    </span>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className='flex flex-wrap items-center gap-2'>
          <Button
            variant='solid'
            color='primary'
            size='sm'
            className='min-w-40'
            disabled={!view.actionEnabled}
            onClick={() => onAction(view.actionKind)}
          >
            {view.actionLabel}
          </Button>
        </div>
      </div>
      {expanded && (
        <div className='mt-2'>
          {coins.length > 0 && (
            <div className='mb-2 flex flex-col gap-y-0.5 text-xs'>
              {coins.map(coin => (
                <span key={`${coin.label}:${coin.id}`} className='flex min-w-0 flex-wrap gap-x-1'>
                  <span className='text-canvas-solid'>{coin.label}:</span>
                  <span className='break-all font-mono text-canvas-text-contrast select-text cursor-text'>{coin.id}</span>
                </span>
              ))}
            </div>
          )}
          <div className='mb-1 flex items-center justify-between'>
            <span className='text-xs text-canvas-solid'>Protocol state</span>
            <Button variant='ghost' color='neutral' size='sm' onClick={refreshProtocolState}>
              Refresh
            </Button>
          </div>
          <pre className='max-h-80 overflow-auto whitespace-pre rounded border border-canvas-line bg-canvas-bg p-2 text-[11px] font-mono text-canvas-text-contrast select-text cursor-text'>
            {protocolText ?? 'No active channel.'}
          </pre>
        </div>
      )}
    </div>
  );
}

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
  const uniqueId = getPlayerId();
  const [, setSessionId] = useState(() => getSessionId());

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
  const gameParamsRef = useRef<GameSessionParams | null>(null);
  gameParamsRef.current = gameParams;
  const [peerConn, setPeerConn] = useState<PeerConnectionResult | null>(null);
  const [dashboardSessionModel, setDashboardSessionModel] = useState<SessionModel | null>(null);
  const [cleanShutdownGraceActive, setCleanShutdownGraceActive] = useState(false);
  const cleanShutdownGraceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The dashboard pulls the protocol-state pretty-print on demand (when its
  // detail view is expanded) rather than having it pushed on every change. The
  // live session registers a getter here; the dashboard reads through it.
  const protocolStateGetterRef = useRef<(() => string | null) | null>(null);
  const handleProtocolStateProviderChange = useCallback(
    (getter: (() => string | null) | null) => {
      protocolStateGetterRef.current = getter;
    },
    [],
  );
  const getProtocolState = useCallback(() => protocolStateGetterRef.current?.() ?? null, []);

  const coinsGetterRef = useRef<(() => CoinOfInterestEntry[]) | null>(null);
  const handleCoinsProviderChange = useCallback(
    (getter: (() => CoinOfInterestEntry[]) | null) => {
      coinsGetterRef.current = getter;
    },
    [],
  );
  const getCoins = useCallback(() => coinsGetterRef.current?.() ?? [], []);

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
  const [restoreStatus, setRestoreStatus] = useState<RestoreStatus>('idle');
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoreTrackerReconciled, setRestoreTrackerReconciled] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState<{ title: string; body: string; confirmLabel?: string; onConfirm: () => void } | null>(null);
  const trackerWsUpRef = useRef(false);
  const lastTrackerActivityRef = useRef(0);
  const lastPeerActivityRef = useRef(0);
  // --- Boot state machine ---
  //
  // The boot initializer NEVER claims the lease. Claiming the lease writes
  // to localStorage, which fences any existing tab via the storage event.
  // We must not do that until the user has made a conscious choice.
  //
  //   1. Save exists → 'resumeDialog'.
  //   2. No save → if another tab holds the lease, 'tabConflict'
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
      if (blockchainTypeRef.current !== 'walletconnect') {
        activeBlockchainRef.current?.disconnect().catch(() => {});
      }
      deactivate();
      activeBlockchainRef.current = null;
      setActiveBlockchainPoller(null);
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
      // WalletConnect sessions are intentionally durable across reloads.
      // Calling disconnect() here sends a protocol-level session_delete.
      if (blockchainTypeRef.current !== 'walletconnect') {
        activeBlockchainRef.current?.disconnect().catch(() => {});
      }
    };
    window.addEventListener('beforeunload', cleanup);
    return () => { window.removeEventListener('beforeunload', cleanup); };
  }, []);

  useEffect(() => {
    return () => {
      if (cleanShutdownGraceTimerRef.current !== null) {
        clearTimeout(cleanShutdownGraceTimerRef.current);
        cleanShutdownGraceTimerRef.current = null;
      }
    };
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
  const [balance, setBalance] = useState<bigint | undefined>();

  const [blockchainType, setBlockchainType] = useState<'simulator' | 'walletconnect' | undefined>(() => getBlockchainType());
  const blockchainTypeRef = useRef<'simulator' | 'walletconnect' | undefined>(blockchainType);
  const activeBlockchainRef = useRef<InternalBlockchainInterface | null>(null);
  const [activeBlockchainPoller, setActiveBlockchainPoller] = useState<BlockchainPoller | null>(null);

  useEffect(() => {
    blockchainTypeRef.current = blockchainType;
  }, [blockchainType]);

  // Connection state
  const [showSimModal, setShowSimModal] = useState(false);
  const [connectionSetup, setConnectionSetup] = useState<ConnectionSetup | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState('');
  const wcAbortRef = useRef(false);
  const [defaultFee, setDefaultFee] = useState<bigint>(() => getDefaultFee());
  const [feeUnit, setFeeUnit] = useState<'mojo' | 'xch'>(() => getFeeUnit());
  const [feeEditing, setFeeEditing] = useState(false);
  const [feeInput, setFeeInput] = useState('');
  const feeInputRef = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);

  const mojosToXchStr = (mojos: bigint): string => {
    const s = mojos.toString().padStart(13, '0');
    const whole = s.slice(0, -12).replace(/^0+/, '') || '0';
    const frac = s.slice(-12).replace(/0+$/, '');
    return frac ? `${whole}.${frac}` : whole;
  };

  const feeDisplayText = useCallback(() => {
    if (feeUnit === 'xch') return mojosToXchStr(defaultFee);
    return String(defaultFee);
  }, [defaultFee, feeUnit]);

  const parseFeeInput = useCallback((raw: string): bigint | null => {
    if (/^\s*$/.test(raw)) return 0n;
    const trimmed = raw.trim();
    if (feeUnit === 'xch') {
      if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
      const [whole, frac = ''] = trimmed.split('.');
      if (frac.length > 12) return null;
      const mojoStr = whole + frac.padEnd(12, '0');
      try { const mojos = BigInt(mojoStr); return mojos < 0n ? null : mojos; }
      catch { return null; }
    }
    if (!/^\d+$/.test(trimmed)) return null;
    try { const n = BigInt(trimmed); return n < 0n ? null : n; }
    catch { return null; }
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
  const sessionFinishedCleanupRef = useRef(false);
  const sessionPhaseRef = useRef<SessionPhase>('none');
  const activePairingTokenRef = useRef<string | null>(null);

  const deferStateUpdate = useCallback((fn: () => void) => {
    if (typeof queueMicrotask === 'function') {
      queueMicrotask(fn);
    } else {
      setTimeout(fn, 0);
    }
  }, []);

  const appendHistory = useCallback((line: string) => {
    deferStateUpdate(() => {
      setHistory(prev => {
        const next = [...prev, line];
        saveSession({ humanHistory: next });
        return next;
      });
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
        setLogLines(prev => {
          const next = [...prev, line];
          saveSession({ diagnosticLog: next });
          return next;
        });
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
  const stopBalancePolling = useCallback(() => {
    try {
      getActiveBlockchain().stopBalanceInterest();
    } catch {
      // blockchain not set yet
    }
  }, []);

  const startBalancePolling = useCallback((_bcType: 'simulator' | 'walletconnect') => {
    stopBalancePolling();
    try {
      getActiveBlockchain().startBalanceInterest(BALANCE_POLL_INTERVAL_MS, {
        onBalance: (bal) => setBalance(bal),
        onError: () => {
          // Keep balance polling best-effort; the coordinator schedules the next attempt.
        },
      });
    } catch {
      // blockchain not set yet
    }
  }, [stopBalancePolling]);

  useEffect(() => {
    return () => {
      stopBalancePolling();
    };
  }, [stopBalancePolling]);

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
        const poller = activeBlockchainPoller;
        if (poller && blobSingleton) {
          blobSingleton.attachBlockchain(poller);
        }
        if (blockchainTypeRef.current) {
          startBalancePolling(blockchainTypeRef.current);
        }
      } else {
        setWalletConnected(false);
      }
    });
  }, [activeBlockchainPoller, blockchainType, startBalancePolling]);

  const [trackerOrigin, setTrackerOrigin] = useState<string | null>(null);

  // Connect to a tracker by origin URL. Creates the lobby iframe + game relay WebSocket.
  const connectToTracker = useCallback((rawOrigin: string, options: { resetSession?: boolean } = {}) => {
    const origin = normalizeTrackerOrigin(rawOrigin);
    trackerConnRef.current?.disconnect();
    trackerConnRef.current = null;
    if (options.resetSession) {
      clearSessionId();
    }
    const initialSave = peekSession();
    const trackerSessionId = getSessionId();
    setSessionId(trackerSessionId);

    setTrackerOrigin(origin);
    saveTrackerUrl(origin);
    const lobbyUrl = `${origin}/?lobby=true&session=${trackerSessionId}&uniqueId=${uniqueId}`;
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
      channelTimeout?: bigint,
      unrollTimeout?: bigint,
    ) => {
      console.log('[Shell] startSession: iStarted=%s amount=%s token=%s hasSave=%s channelTimeout=%s unrollTimeout=%s', iStarted, amount, token, !!save, channelTimeout, unrollTimeout);
      sessionFinishedCleanupRef.current = false;
      sessionPhaseRef.current = 'none';
      activePairingTokenRef.current = token;
      const resolvedMyAlias = myAlias ?? save?.myAlias ?? save?.alias;
      conn.setBusy(save ? sessionSaveStartsBusy(save) : true, resolvedMyAlias);
      peerConnTargetRef.current = conn.getPeerConnection();
      if (!save) {
        setRestoreStatus('idle');
        setRestoreError(null);
        setRestoreTrackerReconciled(true);
        setDashboardSessionModel(null);
      } else {
        setDashboardSessionModel(sessionModelFromSave(save, perGame));
      }

      const alreadyHydrated = !!sessionSaveRef.current;
      if (!alreadyHydrated) {
        sessionSaveRef.current = save;
        const resolvedOpponentAlias = opponentAlias ?? save?.opponentAlias;
        setGameParams({
          iStarted,
          amount,
          perGameAmount: perGame,
          restoring: save !== null,
          pairingToken: token,
          myAlias: resolvedMyAlias,
          opponentAlias: resolvedOpponentAlias,
          channelTimeout,
          unrollTimeout,
        });
        setPeerConn(stablePeerConn);
        if (save) {
          const savedHistory = humanHistoryFromSave(save);
          const savedLog = diagnosticLogFromSave(save);
          if (savedHistory) setHistory(savedHistory);
          if (savedLog) setLogLines(savedLog);
          if (save.chatMessages) setChatMessages(save.chatMessages);
        } else {
          destroyBlobSingleton();
          clearSession();
          setHistory([]);
          setChatMessages([]);
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
      conn = new TrackerConnection(origin, trackerSessionId, {
        onMatched: (matched: MatchedParams) => {
          trackerWsUpRef.current = true;
          lastTrackerActivityRef.current = Date.now();
          setTrackerLiveness('connected');
          markPeerActive();
          let amount: bigint;
          try { amount = BigInt(matched.amount); } catch { amount = FALLBACK_AMOUNT; }
          const perGame = amount / 10n || 1n;
          let channelTimeout: bigint | undefined;
          let unrollTimeout: bigint | undefined;
          try { if (matched.channel_timeout) channelTimeout = BigInt(matched.channel_timeout); } catch {}
          try { if (matched.unroll_timeout) unrollTimeout = BigInt(matched.unroll_timeout); } catch {}
          startSession(conn, matched.i_am_initiator, amount, perGame, matched.token, null, matched.my_alias, matched.peer_alias, channelTimeout, unrollTimeout);
        },
        onConnectionStatus: (status: ConnectionStatus) => {
          console.log('[Shell] onConnectionStatus: has_pairing=%s token=%s peer_connected=%s activeToken=%s',
            status.has_pairing, status.token ?? 'none', status.peer_connected, activePairingTokenRef.current ?? 'null');
          trackerWsUpRef.current = true;
          lastTrackerActivityRef.current = Date.now();
          setTrackerLiveness('connected');
          if (sessionSaveRef.current?.serializedCradle) {
            setRestoreTrackerReconciled(true);
          }
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
              const { amount, perGameAmount: perGame } = sessionAmountsFromSave(save, FALLBACK_AMOUNT, FALLBACK_PER_GAME);
              let chTimeout: bigint | undefined;
              let unTimeout: bigint | undefined;
              try { if (status.channel_timeout) chTimeout = BigInt(status.channel_timeout); } catch {}
              try { if (status.unroll_timeout) unTimeout = BigInt(status.unroll_timeout); } catch {}
              startSession(conn, status.i_am_initiator!, amount, perGame, status.token, save, status.my_alias, status.peer_alias, chTimeout, unTimeout);
            } else if (!save) {
              console.warn('[Shell] connection_status: unrecognized pairing, requesting close');
              conn.close();
              clearSession();
            } else if (save.serializedCradle) {
              console.warn('[Shell] connection_status: token mismatch (tracker=%s, save=%s), closing unknown pairing', status.token, save.pairingToken);
              conn.close();
              const { amount, perGameAmount: perGame } = sessionAmountsFromSave(save, FALLBACK_AMOUNT, FALLBACK_PER_GAME);
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
              const savedHistory = humanHistoryFromSave(save);
              const savedLog = diagnosticLogFromSave(save);
              if (savedHistory) setHistory(savedHistory);
              if (savedLog) setLogLines(savedLog);
              if (save.chatMessages) setChatMessages(save.chatMessages);
            }
          } else {
            if (save && save.serializedCradle) {
              console.warn('[Shell] connection_status: no pairing but have full save, restoring session (peer gone; go on-chain manually to resolve)');
              const { amount, perGameAmount: perGame } = sessionAmountsFromSave(save, FALLBACK_AMOUNT, FALLBACK_PER_GAME);
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
              const savedHistory = humanHistoryFromSave(save);
              const savedLog = diagnosticLogFromSave(save);
              if (savedHistory) setHistory(savedHistory);
              if (savedLog) setLogLines(savedLog);
              if (save.chatMessages) setChatMessages(save.chatMessages);
            }
          }
        },
        onPeerReconnected: () => {
          markPeerActive();
          blobSingleton?.resendUnacked();
        },
        onDataMessage: (_msgno: number, _msg: Uint8Array) => { markPeerActive(); },
        onAck: (_ack: number) => { markPeerActive(); },
        onKeepalive: () => { markPeerActive(); },
        onClosed: () => {
          console.log('[Shell] peer pairing ended');
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
          conn.refreshPresence(gameParamsRef.current?.myAlias ?? sessionSaveRef.current?.myAlias ?? sessionSaveRef.current?.alias);
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
      }, {
        initialBusy: sessionSaveStartsBusy(initialSave),
        initialAlias: initialSave?.myAlias ?? initialSave?.alias,
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

  }, [uniqueId, markPeerActive, markPeerInactive]);

  const requestTrackerConnect = useCallback((origin: string) => {
    if (peerConnected && sessionPhase === 'off-chain') {
      setConfirmDialog({
        title: 'Disconnect from tracker?',
        body: 'Disconnecting from this tracker will end your peer connection. Your game stays off-chain — resolve it on-chain from the dashboard if needed.',
        onConfirm: () => { setConfirmDialog(null); connectToTracker(origin, { resetSession: true }); },
      });
    } else if (peerConnected) {
      setConfirmDialog({
        title: 'Disconnect from tracker?',
        body: 'This will end your peer connection.',
        onConfirm: () => { setConfirmDialog(null); connectToTracker(origin, { resetSession: true }); },
      });
    } else {
      connectToTracker(origin, { resetSession: true });
    }
  }, [peerConnected, sessionPhase, connectToTracker]);

  // Auto-connect to saved tracker once this tab owns the app lease. Tracker
  // identity is independent of wallet restore, so do not gate this on userReady.
  useEffect(() => {
    if (bootState.kind !== 'ready') {
      trackerConnRef.current?.disconnect();
      trackerConnRef.current = null;
      return;
    }
    const url = getTrackerUrl();
    console.log('[Shell] tracker-reconnect effect: ready trackerUrl=%s', url ?? 'none');
    if (url && !trackerConnRef.current) {
      connectToTracker(url);
    }
    return () => {
      trackerConnRef.current?.disconnect();
      trackerConnRef.current = null;
    };
  }, [bootState.kind, connectToTracker]);

  // Shared connection completion
  const completeConnection = useCallback((
    iface: InternalBlockchainInterface,
    bcType: 'simulator' | 'walletconnect',
    pollMs: number,
    options: { switchToTracker?: boolean } = {},
  ) => {
    console.log('[Shell] completeConnection: bcType=%s', bcType);
    deactivate();
    const poller = activate(iface, pollMs);
    saveSession({ blockchainType: bcType });
    activeBlockchainRef.current = iface;
    setActiveBlockchainPoller(poller);
    setBlockchainType(bcType);
    setWalletConnected(true);
    setConnecting(false);
    setConnectionSetup(null);
    setUserReady(true);
    if (options.switchToTracker) {
      setActiveTab('tracker');
    }
    startBalancePolling(bcType);
    log(`${bcType} wallet connected`);
  }, [startBalancePolling, setConnecting, setActiveTab]);

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
      const needsWalletPairing = bcType === 'walletconnect' && !setup.skipQr && !setup.fields;
      if (needsWalletPairing) {
        setConnectionSetup(setup);
        setWalletConnected(false);
        setConnecting(false);
        if (silent) {
          setWalletAlert(true);
          return;
        }
      }
      if (!setup.skipQr) setConnectionSetup(setup);
      if (setup.fields && !silent) {
        setShowSimModal(true);
        setConnecting(false);
        return;
      }
      if (silent && !setup.skipQr && !setup.fields) {
        return;
      }
      log(`[Shell] handleConnect: calling finalize`);
      await setup.finalize();
      if (wcAbortRef.current) return;
      log(`[Shell] handleConnect: finalize complete`);
      completeConnection(iface, bcType, pollMs, { switchToTracker: !silent });
    } catch (err) {
      if (!wcAbortRef.current) {
        console.error(`[Shell] ${bcType} connect failed`, err);
      }
      if (silent) {
        // beginConnect may have failed before completeConnection ran.
        if (bcType !== 'walletconnect') {
          completeConnection(iface, bcType, pollMs);
        }
      } else {
        setBlockchainType(undefined);
        clearSession();
        setConnectionSetup(null);
        setConnecting(false);
      }
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
      completeConnection(iface, blockchainType, pollMs, { switchToTracker: true });
    } catch (err) {
      console.error(`[Shell] ${blockchainType} finalize failed`, err);
    } finally {
      setConnecting(false);
    }
  }, [connectionSetup, blockchainType, completeConnection]);

  const handleCancelConnect = useCallback(async () => {
    wcAbortRef.current = true;
    stopBalancePolling();
    if (activeBlockchainRef.current) {
      try { await activeBlockchainRef.current.disconnect(); } catch { /* ignore */ }
    } else if (blockchainType) {
      const { iface } = getInterface(blockchainType);
      try { await iface.disconnect(); } catch { /* ignore */ }
    }
    deactivate();
    activeBlockchainRef.current = null;
    setActiveBlockchainPoller(null);
    setConnectionSetup(null);
    setBlockchainType(undefined);
    clearSession();
    setConnecting(false);
    setWalletConnected(false);
    setShowSimModal(false);
  }, [blockchainType, stopBalancePolling]);

  const sendChat = useCallback((text: string) => {
    const myAlias = gameParams?.myAlias ?? 'You';
    trackerConnRef.current?.sendChat(text);
    setChatMessages(prev => {
      const next = [...prev, { text, fromAlias: myAlias, timestamp: BigInt(Date.now()), isMine: true }];
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
    const previousPhase = sessionPhaseRef.current;
    sessionPhaseRef.current = phase;
    setSessionPhase(phase);
    setSessionError(!!hasError);

    if (phase !== 'resolved' || sessionFinishedCleanupRef.current) return;

    console.log('[Shell] session resolved; marking not busy');
    sessionFinishedCleanupRef.current = true;
    trackerConnRef.current?.setBusy(false, gameParamsRef.current?.myAlias ?? sessionSaveRef.current?.myAlias ?? sessionSaveRef.current?.alias);
    sessionSaveRef.current = null;
    activePairingTokenRef.current = null;
    if (shouldSwitchToTrackerOnResolved(previousPhase, !!hasError)) {
      setActiveTab('tracker');
    }
  }, [setActiveTab]);

  const handleRestoreStatusChange = useCallback((status: RestoreStatus, error: string | null) => {
    setRestoreStatus(status);
    setRestoreError(error);
    setDashboardSessionModel(prev => prev
      ? { ...prev, restore: { ...prev.restore, status, error } }
      : prev
    );
    if (status === 'failed') {
      setSessionError(true);
    }
  }, []);

  const handleSessionModelChange = useCallback((model: SessionModel) => {
    setDashboardSessionModel(model);
  }, []);

  const restoreBlocked = isRestoreBlocked(!!gameParams?.restoring, restoreStatus, restoreTrackerReconciled);

  useEffect(() => {
    trackerConnRef.current?.setBusy(
      !shouldAdvertiseAvailable(sessionPhase, restoreBlocked),
      gameParams?.myAlias ?? sessionSaveRef.current?.myAlias ?? sessionSaveRef.current?.alias,
    );
  }, [sessionPhase, restoreBlocked, gameParams?.myAlias]);

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
  const performResume = useCallback((save: SessionState) => {
    const bcType = save.blockchainType ?? 'simulator';
    console.log('[Shell] performResume: bcType=%s token=%s', bcType, save.pairingToken ?? 'none');
    setActiveTab('game');
    setResuming(true);
    setRestoreStatus('restoring');
    setRestoreError(null);
    setRestoreTrackerReconciled(false);
    setSessionPhase('none');
    setSessionError(false);

    sessionSaveRef.current = save;
    const { amount, perGameAmount: perGame } = sessionAmountsFromSave(save, FALLBACK_AMOUNT, FALLBACK_PER_GAME);
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
    const savedHistory = humanHistoryFromSave(save);
    const savedLog = diagnosticLogFromSave(save);
    if (savedHistory) setHistory(savedHistory);
    if (savedLog) setLogLines(savedLog);
    if (save.chatMessages) setChatMessages(save.chatMessages);

    setBlockchainType(bcType);

    const { iface, pollMs } = getInterface(bcType);
    activeBlockchainRef.current = iface;
    setWalletConnected(iface.isConnected());
    setResuming(false);

    // For WalletConnect restores, finalize performs the first wallet RPC
    // (address lookup). Keep it in the background so local restore can render
    // while the simulator/wallet is unavailable.
    void (async () => {
      try {
        const setup = await iface.beginConnect(uniqueId);
        const needsWalletPairing = bcType === 'walletconnect' && !setup.skipQr && !setup.fields;
        if (needsWalletPairing) {
          setConnectionSetup(setup);
          setWalletConnected(false);
          setConnecting(false);
          setWalletAlert(true);
          return;
        }
        if (setup.skipQr || setup.fields) {
          await setup.finalize();
        }
        completeConnection(iface, bcType, pollMs);
      } catch (err) {
        console.warn('[Shell] performResume connect failed, falling back', err);
        // beginConnect may have failed before completeConnection ran.
        if (!activeBlockchainRef.current && bcType !== 'walletconnect') {
          completeConnection(iface, bcType, pollMs);
        }
      }
      console.log('[Shell] performResume: blockchain connect task done');
    })();
  }, [uniqueId, completeConnection, stablePeerConn, setActiveTab]);

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
    stopBalancePolling();
    trackerConnRef.current?.disconnect();
    trackerConnRef.current = null;
    activeBlockchainRef.current?.disconnect().catch(() => {});
    activeBlockchainRef.current = null;
    setActiveBlockchainPoller(null);
    deactivate();
    setBootState({ kind: 'tabDead' });
  }, [stopBalancePolling]);

  const handleStartOver = useCallback(() => {
    try {
      hardReset();
    } catch (e) {
      console.error('[Shell] start over hard reset failed:', e);
    } finally {
      window.location.reload();
    }
  }, []);

  const doDisconnectWallet = useCallback(async () => {
    stopBalancePolling();
    if (activeBlockchainRef.current) {
      try { await activeBlockchainRef.current.disconnect(); } catch (_) {}
    }
    deactivate();
    activeBlockchainRef.current = null;
    setActiveBlockchainPoller(null);
    setWalletConnected(false);
    setBlockchainType(undefined);
    setBalance(undefined);
  }, [stopBalancePolling]);

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

  const doDisconnectTracker = useCallback(() => {
    trackerConnRef.current?.disconnect();
    trackerConnRef.current = null;
    clearSessionId();
    setSessionId('');
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
        body: 'Disconnecting from this tracker will end your peer connection. Your game stays off-chain — resolve it on-chain from the dashboard if needed.',
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

  const handleEndPeerConnection = useCallback(() => {
    trackerConnRef.current?.close();
    markPeerInactive();
  }, [markPeerInactive]);

  const startCleanShutdownGrace = useCallback(() => {
    if (cleanShutdownGraceTimerRef.current !== null) {
      clearTimeout(cleanShutdownGraceTimerRef.current);
    }
    setCleanShutdownGraceActive(true);
    cleanShutdownGraceTimerRef.current = setTimeout(() => {
      cleanShutdownGraceTimerRef.current = null;
      setCleanShutdownGraceActive(false);
    }, 10_000);
  }, []);

  const cancelDashboardSession = useCallback(() => {
    const alias = gameParamsRef.current?.myAlias ?? sessionSaveRef.current?.myAlias ?? sessionSaveRef.current?.alias;
    trackerConnRef.current?.close();
    markPeerInactive();
    destroyBlobSingleton();
    clearSession();
    sessionSaveRef.current = null;
    activePairingTokenRef.current = null;
    sessionStartedRef.current = false;
    sessionFinishedCleanupRef.current = false;
    sessionPhaseRef.current = 'none';
    setSessionPhase('none');
    setSessionError(false);
    setGameParams(null);
    setPeerConn(null);
    setDashboardSessionModel(null);
    setRestoreStatus('idle');
    setRestoreError(null);
    setRestoreTrackerReconciled(false);
    setHistory([]);
    setChatMessages([]);
    setActiveTab('tracker');
    trackerConnRef.current?.setBusy(false, alias);
  }, [markPeerInactive, setActiveTab]);

  const requestDashboardCleanShutdown = useCallback(() => {
    startCleanShutdownGrace();
    setDashboardSessionModel(prev => prev
      ? { ...prev, channel: { ...prev.channel, cleanShutdownStarted: true } }
      : prev
    );
    blobSingleton?.cleanShutdown();
  }, [startCleanShutdownGrace]);

  const performDashboardGoOnChain = useCallback(() => {
    blobSingleton?.goOnChain();
    sessionPhaseRef.current = 'on-chain';
    setSessionPhase('on-chain');
    trackerConnRef.current?.close();
    markPeerInactive();
    setDashboardSessionModel(prev => prev
      ? { ...prev, channel: { ...prev.channel, goOnChainPressed: true } }
      : prev
    );
  }, [markPeerInactive]);

  const requestDashboardGoOnChain = useCallback(() => {
    const channelState = dashboardSessionModel?.channel.status.state;
    const isShutdownEscalation = channelState === 'ShuttingDown';
    setConfirmDialog({
      title: isShutdownEscalation ? 'Go on-chain?' : 'Resolve on-chain?',
      body: isShutdownEscalation
        ? 'Clean shutdown is waiting for your opponent. Going on-chain abandons the cooperative close and resolves the session on-chain.'
        : 'You are in the middle of a hand. Going on-chain will force moves to happen but they may be much slower. Do you wish to proceed?',
      confirmLabel: 'Go On Chain',
      onConfirm: () => {
        setConfirmDialog(null);
        performDashboardGoOnChain();
      },
    });
  }, [dashboardSessionModel?.channel.status.state, performDashboardGoOnChain]);

  const handleDashboardAction = useCallback((kind: GameDashboardActionKind) => {
    switch (kind) {
      case 'cancel':
        cancelDashboardSession();
        break;
      case 'clean-shutdown':
        requestDashboardCleanShutdown();
        break;
      case 'go-on-chain':
        requestDashboardGoOnChain();
        break;
      case 'none':
        break;
    }
  }, [cancelDashboardSession, requestDashboardCleanShutdown, requestDashboardGoOnChain]);

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
  const { startSession: sessionReadyToStart, keepSession } = shouldMountGameSession(
    sessionCanMount,
    walletConnected,
    !!gameParams?.restoring,
    sessionStartedRef.current,
  );
  if (sessionReadyToStart) sessionStartedRef.current = true;
  console.log('[Shell] render: gameParams=%s peerConn=%s poller=%s walletConnected=%s restoring=%s → keepSession=%s',
    !!gameParams, !!peerConn, !!activeBlockchainPoller, walletConnected, !!gameParams?.restoring, keepSession);

  const dashboardView: GameDashboardViewModel = selectGameDashboardView(dashboardSessionModel, {
    hasSession: dashboardSessionModel !== null,
    cleanShutdownGraceActive,
    chainAvailable: walletConnected,
  });
  const statusBarBalances = selectStatusBarBalances(dashboardSessionModel);

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
              if (sessionPhase === 'none' || sessionPhase === 'resolved') {
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
              <div className='flex items-center justify-between px-4 py-2 border-b border-canvas-border bg-canvas-bg-subtle text-sm text-canvas-text shrink-0'>
                <span>Connected to {trackerOrigin}</span>
                <button
                  onClick={handleDisconnectTracker}
                  className='flex-shrink-0 px-3 py-1.5 rounded-md text-sm font-medium bg-primary-solid text-primary-on-primary hover:bg-primary-solid-hover transition-colors'
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
          <GameDashboard
            view={dashboardView}
            balances={statusBarBalances}
            onAction={handleDashboardAction}
            getProtocolState={getProtocolState}
            getCoins={getCoins}
          />
          <div style={{ flex: '1 1 0%', minHeight: 0, overflow: 'auto' }}>
            {keepSession && restoreStatus === 'failed' ? (
              <div className='w-full h-full flex flex-col items-center justify-center gap-3 text-canvas-text p-8'>
                <h2 className='text-lg font-semibold text-alert-text'>Restore failed</h2>
                <p className='max-w-lg text-sm text-center select-text cursor-text'>
                  {restoreError ?? 'The saved session could not be restored.'}
                </p>
                <button
                  onClick={handleStartOver}
                  className='px-4 py-2 rounded-md font-medium text-sm border border-canvas-border text-canvas-text hover:bg-canvas-bg-hover transition-colors'
                >
                  Start over
                </button>
              </div>
            ) : keepSession ? (
              <GameSessionErrorBoundary>
                <GameSession
                  key={gameParams!.pairingToken}
                  params={gameParams!}
                  peerConn={peerConn!}
                  registerMessageHandler={registerMessageHandler}
                  appendGameLog={appendHistory}
                  sessionSave={sessionSaveForReactProps(sessionSaveRef.current)}
                  blockchain={activeBlockchainPoller}
                  onGameActivity={onGameActivity}
                  onSessionPhaseChange={handleSessionPhaseChange}
                  onRestoreStatusChange={handleRestoreStatusChange}
                  onSessionModelChange={handleSessionModelChange}
                  onProtocolStateProviderChange={handleProtocolStateProviderChange}
                  onCoinsProviderChange={handleCoinsProviderChange}
                  suppressPhaseReporting={restoreBlocked}
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
        </div>

        {/* Chat tab */}
        <div style={{ position: 'absolute', inset: 0, display: activeTab === 'chat' ? 'flex' : 'none', flexDirection: 'column' }}>
          <ChatPanel
            messages={chatMessages}
            onSend={sendChat}
            myAlias={gameParams?.myAlias ?? 'You'}
            peerConnected={!!peerConnected}
            onEndPeer={handleEndPeerConnection}
            opponentAlias={gameParams?.opponentAlias}
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
              className='w-full px-4 py-2 rounded-md font-medium text-sm bg-primary-solid text-primary-on-primary hover:bg-primary-solid-hover transition-colors'
            >
              {confirmDialog.confirmLabel ?? 'Proceed'}
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
