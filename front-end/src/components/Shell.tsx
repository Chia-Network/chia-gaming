import { useEffect, useState, useCallback, useRef, useMemo } from 'react';

import GameSession from './GameSession';
import { GameSessionErrorBoundary } from './GameSession';
import { SimulatorSetupModal } from './SimulatorSetupModal';
import QRCode from 'qrcode';
import { GameSessionParams, PeerConnectionResult, InternalBlockchainInterface, ConnectionSetup, TrackerLiveness, SessionPhase, PeerLiveness, CoinOfInterestEntry } from '../types/ChiaGaming';
import { TrackerConnection, AdvisoryStartParams, type PeerAppMessage } from '../services/TrackerConnection';
import { PeerSession, generateSessionId } from '../services/PeerSession';
import { subscribeLog } from '../services/log';
import { reactPropSafeValue } from '../lib/reactPropSafe';
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
  hasSavedSessionMarker,
  hydrateSessionCacheFromDisk,
  markSavedSession,
  clearSavedSessionMarker,
  SessionState,
  getDefaultFee,
  setDefaultFee as saveDefaultFee,
  getFeeUnit,
  setFeeUnit as saveFeeUnit,
  getActiveTab as getSavedTab,
  setActiveTab as saveActiveTab,
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
  peekAlias,
  setAlias,
} from '../hooks/save';
import { sessionController, destroySessionController } from '../hooks/blobSingleton';
import { fakeBlockchainInfo } from '../hooks/FakeBlockchainInterface';
import { realBlockchainInfo } from '../hooks/RealBlockchainInterface';
import { activate, deactivate, getActiveBlockchain } from '../hooks/activeBlockchain';
import {
  BALANCE_POLL_INTERVAL_MS,
  CHAIN_POLL_INTERVAL_MS,
  type BlockchainPoller,
} from '../hooks/BlockchainPoller';
import { RestoreStatus } from '../hooks/SessionController';
import { useThemeSyncToIframe } from '../hooks/useThemeSyncToIframe';
import { isRestoreBlocked, isTerminalChannelState, shouldMountGameSession, shouldReportTrackerBusy, shouldSwitchToTrackerOnResolved } from '../lib/restoreLifecycle';
import {
  ABANDON_WAITING_STATES,
  isCleanShutdownInProgress,
  selectGameDashboardView,
  selectGameTabDotColor,
  selectStatusBarBalances,
  sessionAmountsFromSave,
  sessionModelFromSave,
  snapshotFromSessionModel,
  DEFAULT_CHANNEL_TIMEOUT_BLOCKS,
  DEFAULT_UNROLL_TIMEOUT_BLOCKS,
  type GameDashboardActionKind,
  type GameDashboardViewModel,
  type GameTabDotColor,
  type SessionModel,
  type StatusBarBalanceSegment,
} from '../lib/session/model';
import { gameDisplayName } from '../lib/gameRegistry';
import {
  appendRecent,
  DIAGNOSTIC_LOG_LIMIT,
  HUMAN_HISTORY_LIMIT,
  recentEntries,
} from '../lib/session/historyLimits';
import { log } from '../services/log';
import { formatMojos } from '../util';
import { Button } from './button';

import { TrackerPicker } from './TrackerPicker';

type TabId = 'wallet' | 'tracker' | 'game' | 'history' | 'log';

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
  return save.humanHistory;
}

function diagnosticLogFromSave(save: SessionState): string[] | undefined {
  return save.diagnosticLog;
}

/**
 * Build a React-safe SessionState without deep-walking binary fields.
 * Spreading/cloning a degraded cradle (`{0:n,1:n,...}`) OOMs the tab.
 */
function sessionSaveForReactProps(save: SessionState | null): SessionState | undefined {
  if (!save) return undefined;
  const {
    serializedCradle,
    unackedMessages,
    handState,
    ...rest
  } = save;
  const propSafeSave = reactPropSafeValue(rest) as SessionState;
  // Attach binaries by reference and keep them non-enumerable so React/dev
  // tools never walk millions of numeric keys.
  if (serializedCradle !== undefined) {
    Object.defineProperty(propSafeSave, 'serializedCradle', {
      value: serializedCradle,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
  if (unackedMessages !== undefined) {
    Object.defineProperty(propSafeSave, 'unackedMessages', {
      value: unackedMessages,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
  if (Object.prototype.hasOwnProperty.call(save, 'handState')) {
    Object.defineProperty(propSafeSave, 'handState', {
      value: handState,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
  return propSafeSave;
}

type PendingSessionProposal = {
  from_id: string;
  from_alias: string;
  proposer_amount: string;
  responder_amount: string;
  channel_timeout?: string;
  unroll_timeout?: string;
  game_session_id?: string;
};

type SessionStartRequest = {
  peerId: string;
  opponentAlias?: string;
  myAmount: string;
  theirAmount: string;
  channel_timeout?: string;
  unroll_timeout?: string;
  iStarted: boolean;
};

function parseSessionAmount(raw: string): bigint {
  try {
    return BigInt(raw);
  } catch {
    return FALLBACK_AMOUNT;
  }
}

function SessionBuyIn({ myAmount, theirAmount }: { myAmount: string; theirAmount: string }) {
  if (myAmount === theirAmount) {
    return <><br />Buy-in: <strong>{myAmount}</strong> mojos</>;
  }

  return (
    <>
      <br />Your buy-in: <strong>{myAmount}</strong> mojos
      <br />Their buy-in: <strong>{theirAmount}</strong> mojos
    </>
  );
}

function parseOptionalBigInt(raw: string | undefined): bigint | undefined {
  if (!raw) return undefined;
  try {
    return BigInt(raw);
  } catch {
    return undefined;
  }
}

const IDLE_PEER_CONNECTION: PeerConnectionResult = {
  sendMessage: () => {},
  sendAck: () => {},
  sendKeepalive: () => {},
  hostLog: () => {},
  close: () => {},
};

const TAB_DEFS: { id: TabId; label: string }[] = [
  { id: 'wallet', label: 'Wallet' },
  { id: 'tracker', label: 'Tracker' },
  { id: 'game', label: 'Game' },
  { id: 'history', label: 'History' },
  { id: 'log', label: 'Log' },
];

const FALLBACK_AMOUNT = 100n;
const ABANDON_DELAY_MS = 120_000n;
const GRACE_DELAY_MS = 10_000n;

const PRE_ACTIVE_CHANNEL_STATES: ReadonlySet<string> = new Set([
  'Handshaking', 'WaitingForHeightToOffer', 'WaitingForHeightToAccept',
  'MakingOffer', 'MakingOfferAcceptance', 'OfferSent', 'TransactionPending',
]);

const MIN_TIMEOUT_BLOCKS = 3;
const MAX_TIMEOUT_BLOCKS = 30;

function isAbandonWaitingState(state: SessionModel['channel']['status']['state'] | null | undefined): state is SessionModel['channel']['status']['state'] {
  return !!state && ABANDON_WAITING_STATES.has(state);
}

function isSessionAbandonable(model: SessionModel | null, abandonEnabled: boolean): boolean {
  return abandonEnabled && isAbandonWaitingState(model?.channel.status.state);
}

function savedChannelState(save: SessionState): SessionModel['channel']['status']['state'] | null {
  if (save.channelStatus) return save.channelStatus.state;
  if (save.channelReady) return 'Active';
  return null;
}

function isValidTimeoutString(v: string | undefined): boolean {
  if (v === undefined) return true;
  const n = Number(v);
  return Number.isInteger(n) && n >= MIN_TIMEOUT_BLOCKS && n <= MAX_TIMEOUT_BLOCKS;
}

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
              {view.lifecycleRows.map(row => (
                <span key={row.id} className='flex min-w-0 flex-wrap gap-x-1'>
                  <span className='text-canvas-solid'>{row.label}:</span>
                  <span className='font-medium text-canvas-text-contrast'>{row.statusLabel}</span>
                  {row.detail && (
                    <span className='text-canvas-text'>{row.detail}</span>
                  )}
                </span>
              ))}
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
    const valid: TabId[] = ['wallet', 'tracker', 'game', 'history', 'log'];
    return saved && valid.includes(saved as TabId) ? (saved as TabId) : 'wallet';
  });
  const setActiveTab = useCallback((tab: TabId) => {
    setActiveTabRaw(tab);
    saveActiveTab(tab);
  }, []);
  const [sessionConfig, setSessionConfig] = useState<GameSessionParams | null>(null);
  const sessionConfigRef = useRef<GameSessionParams | null>(null);
  sessionConfigRef.current = sessionConfig;
  const [peerConn, setPeerConn] = useState<PeerConnectionResult | null>(null);
  const [dashboardSessionModel, setDashboardSessionModel] = useState<SessionModel | null>(null);
  const [cleanShutdownGraceActive, setCleanShutdownGraceActive] = useState(false);
  const cleanShutdownGraceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [abandonEnabled, setAbandonEnabled] = useState(false);
  const abandonEnabledRef = useRef(false);
  abandonEnabledRef.current = abandonEnabled;
  const abandonTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const waitingEnteredAtRef = useRef<bigint | null>(null);
  const waitingStateRef = useRef<SessionModel['channel']['status']['state'] | null>(null);

  // Consent prompt state for the new tracker protocol
  const [pendingAdvisory, setPendingAdvisory] = useState<AdvisoryStartParams | null>(null);
  const pendingAdvisoryRef = useRef<AdvisoryStartParams | null>(null);
  const setPendingAdvisoryState = useCallback((next: AdvisoryStartParams | null) => {
    pendingAdvisoryRef.current = next;
    setPendingAdvisory(next);
  }, []);
  const [pendingProposal, setPendingProposal] = useState<PendingSessionProposal | null>(null);
  const pendingProposalRef = useRef<PendingSessionProposal | null>(null);
  const setPendingProposalState = useCallback((next: PendingSessionProposal | null) => {
    pendingProposalRef.current = next;
    setPendingProposal(next);
  }, []);
  const peerSessionRef = useRef<PeerSession | null>(null);
  const peerMessageHandlerRef = useRef<import('../services/PeerSession').MessageHandler | null>(null);

  const bindPeerMessageHandler = useCallback((ps: PeerSession | null) => {
    if (!ps || !peerMessageHandlerRef.current) return;
    ps.registerMessageHandler(peerMessageHandlerRef.current);
  }, []);

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

  const stablePeerConn: PeerConnectionResult = useMemo(() => ({
    sendMessage: (n, m) => (peerSessionRef.current ?? IDLE_PEER_CONNECTION).sendMessage(n, m),
    sendAck: (n) => (peerSessionRef.current ?? IDLE_PEER_CONNECTION).sendAck(n),
    sendKeepalive: () => (peerSessionRef.current ?? IDLE_PEER_CONNECTION).sendKeepalive(),
    hostLog: (m) => (peerSessionRef.current ?? IDLE_PEER_CONNECTION).hostLog(m),
    close: () => (peerSessionRef.current ?? IDLE_PEER_CONNECTION).close(),
  }), []);

  const [walletConnected, setWalletConnected] = useState(false);
  const [trackerLiveness, setTrackerLiveness] = useState<TrackerLiveness | null>(null);
  const [peerLiveness, setPeerLiveness] = useState<PeerLiveness>(null);
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
  //   1. Saved-session marker exists → 'resumeDialog' without reading IndexedDB.
  //   2. No marker → if another tab holds the lease, 'tabConflict'
  //      (the other tab is live even if we don't have its save locally);
  //      otherwise claim the lease and go 'ready'.
  //
  // From 'resumeDialog':
  //   - Start over → hardReset() + reload.
  //   - Resume     → load IndexedDB, then if lease conflict, 'tabConflict';
  //                  otherwise claim + hydrate.
  //
  // From 'tabConflict':
  //   - Take over → claimLease(), hydrate if save available.
  //   - Close     → 'tabDead' (terminal).
  //
  // A mid-session fenced event (another tab claimed the lease while we were
  // 'ready') also transitions to 'tabConflict' so the user can take control
  // back.
  type BootState =
    | { kind: 'loading' }
    | { kind: 'ready' }
    | { kind: 'resumeDialog'; loadError: string | null }
    | { kind: 'tabConflict'; save: SessionState | null; midSession: boolean }
    | { kind: 'tabDead' };

  const [bootState, setBootState] = useState<BootState>({ kind: 'loading' });

  useEffect(() => {
    if (hasSavedSessionMarker()) {
      console.log('[Shell] boot: saved-session marker present, showing resume dialog');
      // Hydrate IndexedDB into the in-memory cache immediately so incidental
      // saveSession patches (logs, alerts) cannot clobber the durable cradle
      // while the dialog is open.
      void hydrateSessionCacheFromDisk();
      setBootState({ kind: 'resumeDialog', loadError: null });
      return;
    }
    if (isLeaseConflict()) {
      console.log('[Shell] boot: no save but another tab holds the lease, showing tabConflict');
      setBootState({ kind: 'tabConflict', save: null, midSession: false });
      return;
    }
    console.log('[Shell] boot: no state, no conflict, claiming lease');
    claimLease();
    setBootState({ kind: 'ready' });
  }, []);

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
      void peekSession().then((save) => {
        setBootState(prev => prev.kind === 'ready'
          ? { kind: 'tabConflict', save, midSession: true }
          : prev);
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
      if (abandonTimerRef.current !== null) {
        clearTimeout(abandonTimerRef.current);
        abandonTimerRef.current = null;
      }
    };
  }, []);

  // Abandon timer: track when the channel enters a waiting state and enable
  // the abandon action after ABANDON_DELAY_MS.
  const channelState = dashboardSessionModel?.channel.status.state ?? null;
  useEffect(() => {
    if (isAbandonWaitingState(channelState)) {
      if (waitingEnteredAtRef.current === null || waitingStateRef.current !== channelState) {
        if (abandonTimerRef.current !== null) {
          clearTimeout(abandonTimerRef.current);
          abandonTimerRef.current = null;
        }
        const now = BigInt(Date.now());
        waitingEnteredAtRef.current = now;
        waitingStateRef.current = channelState;
        setAbandonEnabled(false);
        saveSession({ waitingStateEnteredAt: now });
        abandonTimerRef.current = setTimeout(() => {
          abandonTimerRef.current = null;
          if (dashboardSessionModelRef.current?.channel.status.state !== channelState) return;
          setAbandonEnabled(true);
        }, Number(ABANDON_DELAY_MS));
      }
    } else if (channelState !== null) {
      if (abandonTimerRef.current !== null) {
        clearTimeout(abandonTimerRef.current);
        abandonTimerRef.current = null;
      }
      if (waitingEnteredAtRef.current !== null) {
        waitingEnteredAtRef.current = null;
        waitingStateRef.current = null;
        saveSession({ waitingStateEnteredAt: undefined });
      }
      setAbandonEnabled(false);
    }
  }, [channelState]);

  const [history, setHistory] = useState<string[]>([]);
  const [logLines, setLogLines] = useState<string[]>([]);

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
  /** Stable prop-safe save — recomputing every render deep-clones and can OOM. */
  const sessionSavePropRef = useRef<SessionState | undefined>(undefined);
  const historyRef = useRef<string[]>(history);
  historyRef.current = history;
  const sessionStartedRef = useRef(false);
  const sessionFinishedCleanupRef = useRef(false);
  const sessionPhaseRef = useRef<SessionPhase>('none');
  const dashboardSessionModelRef = useRef<SessionModel | null>(null);

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
        const next = appendRecent(prev, line, HUMAN_HISTORY_LIMIT);
        historyRef.current = next;
        saveSession({ humanHistory: next });
        return next;
      });
    });
  }, [deferStateUpdate]);

  const clearSessionPreservingHistory = useCallback(() => {
    const humanHistory = historyRef.current;
    const peerId = peerSessionRef.current?.peerId ?? null;
    const gameSessionId = peerSessionRef.current?.sessionId ?? null;
    clearSession();
    const preserved: Record<string, unknown> = {};
    if (humanHistory.length > 0) preserved.humanHistory = humanHistory;
    if (peerId) preserved.sessionPeerId = peerId;
    if (gameSessionId) preserved.gameSessionId = gameSessionId;
    if (Object.keys(preserved).length > 0) saveSession(preserved as any);
  }, []);



  const syncPeerLiveness = useCallback(() => {
    setPeerLiveness(peerSessionRef.current?.liveness ?? null);
  }, []);

  const markPeerActive = useCallback(() => {
    peerSessionRef.current?.notePeerActivity();
    syncPeerLiveness();
  }, [syncPeerLiveness]);

  const markPeerInactive = useCallback(() => {
    peerSessionRef.current?.markInactive();
    syncPeerLiveness();
  }, [syncPeerLiveness]);

  const markPeerDead = useCallback(() => {
    peerSessionRef.current?.markDead();
    syncPeerLiveness();
  }, [syncPeerLiveness]);

  const registerMessageHandler = useCallback((handler: (msgno: number, msg: Uint8Array) => void, ackHandler: (ack: number) => void, keepaliveHandler: () => void) => {
    peerMessageHandlerRef.current = { handler, ackHandler, keepaliveHandler };
    bindPeerMessageHandler(peerSessionRef.current);
  }, [bindPeerMessageHandler]);

  const isAvailableForNewSessionPrompt = useCallback(() => {
    const phase = sessionPhaseRef.current;
    return (phase === 'none' || phase === 'resolved') &&
      pendingAdvisoryRef.current === null &&
      pendingProposalRef.current === null &&
      peerSessionRef.current === null &&
      !sessionSaveRef.current?.sessionPeerId;
  }, []);

  const sendSessionReject = useCallback((peerId: string) => {
    trackerConnRef.current?.sendPeerAppMessage(peerId, { type: 'session_reject' });
  }, []);

  const resetPeerRelayState = useCallback(() => {
    peerSessionRef.current?.destroy();
    peerSessionRef.current = null;
    peerMessageHandlerRef.current = null;
    saveSession({ sessionPeerId: undefined, gameSessionId: undefined });
    setPeerLiveness(null);
  }, []);

  const cancelAttemptedSession = useCallback(() => {
    setPendingAdvisoryState(null);
    setPendingProposalState(null);
    resetPeerRelayState();
    destroySessionController();
    clearSessionPreservingHistory();
    try { getActiveBlockchain().stop(); } catch { /* not connected */ }
    sessionSaveRef.current = null;
    sessionSavePropRef.current = undefined;
    sessionStartedRef.current = false;
    sessionFinishedCleanupRef.current = false;
    sessionPhaseRef.current = 'none';
    if (cleanShutdownGraceTimerRef.current !== null) {
      clearTimeout(cleanShutdownGraceTimerRef.current);
      cleanShutdownGraceTimerRef.current = null;
    }
    if (abandonTimerRef.current !== null) {
      clearTimeout(abandonTimerRef.current);
      abandonTimerRef.current = null;
    }
    waitingEnteredAtRef.current = null;
    waitingStateRef.current = null;
    setAbandonEnabled(false);
    setCleanShutdownGraceActive(false);
    setSessionPhase('none');
    setSessionError(false);
    setSessionConfig(null);
    setPeerConn(null);
    dashboardSessionModelRef.current = null;
    setDashboardSessionModel(null);
    setRestoreStatus('idle');
    setRestoreError(null);
    setRestoreTrackerReconciled(false);
    trackerConnRef.current?.setBusy(false);
  }, [clearSessionPreservingHistory, resetPeerRelayState, setPendingAdvisoryState, setPendingProposalState]);

  const startFreshSessionWithPeer = useCallback((request: SessionStartRequest & { gameSessionId?: string }) => {
    const conn = trackerConnRef.current;
    if (!conn) return;

    const myContribution = parseSessionAmount(request.myAmount);
    const theirContribution = parseSessionAmount(request.theirAmount);
    const minContribution = myContribution < theirContribution ? myContribution : theirContribution;
    const perGame = minContribution / 10n || 1n;
    const sessionId = request.gameSessionId ?? generateSessionId();
    const token = `peer_${request.peerId}_${Date.now()}`;

    const existing = peerSessionRef.current;
    if (existing && !existing.isDestroyed() && existing.peerId === request.peerId && existing.sessionId === sessionId) {
      // Reuse provisional PeerSession created when the proposal arrived (preserves buffered messages).
    } else {
      existing?.destroy();
      peerSessionRef.current = new PeerSession(request.peerId, sessionId, conn);
      bindPeerMessageHandler(peerSessionRef.current);
    }
    saveSession({ sessionPeerId: request.peerId, gameSessionId: sessionId });
    sessionStartedRef.current = false;
    sessionFinishedCleanupRef.current = false;
    sessionPhaseRef.current = 'none';
    if (cleanShutdownGraceTimerRef.current !== null) {
      clearTimeout(cleanShutdownGraceTimerRef.current);
      cleanShutdownGraceTimerRef.current = null;
    }
    if (abandonTimerRef.current !== null) {
      clearTimeout(abandonTimerRef.current);
      abandonTimerRef.current = null;
    }
    waitingEnteredAtRef.current = null;
    waitingStateRef.current = null;
    setAbandonEnabled(false);
    setCleanShutdownGraceActive(false);

    setSessionPhase('none');
    setSessionError(false);
    setRestoreStatus('idle');
    setRestoreError(null);
    setRestoreTrackerReconciled(true);
    dashboardSessionModelRef.current = null;
    setDashboardSessionModel(null);
    destroySessionController();
    clearSessionPreservingHistory();
    try { getActiveBlockchain().start(); } catch { /* not connected */ }
    setSessionConfig({
      iStarted: request.iStarted,
      myContribution,
      theirContribution,
      perGameAmount: perGame,
      restoring: false,
      pairingToken: token,
      myAlias: undefined,
      opponentAlias: request.opponentAlias,
      channelTimeout: parseOptionalBigInt(request.channel_timeout),
      unrollTimeout: parseOptionalBigInt(request.unroll_timeout),
    });
    setPeerConn(stablePeerConn);
    setPeerLiveness(null);
    conn.setBusy(true);
  }, [clearSessionPreservingHistory, stablePeerConn, bindPeerMessageHandler]);

  const acceptPendingAdvisory = useCallback((advisory: AdvisoryStartParams) => {
    const conn = trackerConnRef.current;
    if (!conn) return;
    setPendingAdvisoryState(null);
    const gameSessionId = generateSessionId();
    conn.sendPeerAppMessage(advisory.peer_id, {
      type: 'session_proposal',
      proposer_amount: advisory.my_amount,
      responder_amount: advisory.their_amount,
      // Lobby-synced alias only — never getAlias(), which invents Player_*.
      from_alias: peekAlias(),
      channel_timeout: advisory.channel_timeout,
      unroll_timeout: advisory.unroll_timeout,
      game_session_id: gameSessionId,
    });
    startFreshSessionWithPeer({
      peerId: advisory.peer_id,
      opponentAlias: advisory.peer_alias,
      myAmount: advisory.my_amount,
      theirAmount: advisory.their_amount,
      channel_timeout: advisory.channel_timeout,
      unroll_timeout: advisory.unroll_timeout,
      iStarted: true,
      gameSessionId,
    });
  }, [setPendingAdvisoryState, startFreshSessionWithPeer]);

  const declinePendingAdvisory = useCallback((advisory: AdvisoryStartParams) => {
    setPendingAdvisoryState(null);
    sendSessionReject(advisory.peer_id);
  }, [sendSessionReject, setPendingAdvisoryState]);

  const acceptPendingProposal = useCallback((proposal: PendingSessionProposal) => {
    setPendingProposalState(null);
    startFreshSessionWithPeer({
      peerId: proposal.from_id,
      opponentAlias: proposal.from_alias,
      myAmount: proposal.responder_amount,
      theirAmount: proposal.proposer_amount,
      channel_timeout: proposal.channel_timeout,
      unroll_timeout: proposal.unroll_timeout,
      iStarted: false,
      gameSessionId: proposal.game_session_id,
    });
  }, [setPendingProposalState, startFreshSessionWithPeer]);

  const declinePendingProposal = useCallback((proposal: PendingSessionProposal) => {
    setPendingProposalState(null);
    resetPeerRelayState();
    sendSessionReject(proposal.from_id);
  }, [resetPeerRelayState, sendSessionReject, setPendingProposalState]);

  useEffect(() => {
    return subscribeLog((line) => {
      deferStateUpdate(() => {
        setLogLines(prev => {
          const next = appendRecent(prev, line, DIAGNOSTIC_LOG_LIMIT);
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
      const ps = peerSessionRef.current;
      if (ps && ps.liveness !== 'dead' && ps.liveness !== null) {
        const stale = ps.lastActivity > 0 && now - ps.lastActivity > 30_000;
        if (stale && ps.liveness === 'connected') {
          ps.markDegraded();
          setPeerLiveness('degraded');
        }
      }
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
        if (poller && sessionController) {
          sessionController.attachBlockchain(poller);
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
    const trackerSessionId = getSessionId();
    setSessionId(trackerSessionId);

    setTrackerOrigin(origin);
    saveTrackerUrl(origin);
    const lobbyUrl = `${origin}/?lobby=true&session=${trackerSessionId}&uniqueId=${uniqueId}`;
    setIframeUrl(lobbyUrl);

    setTrackerLiveness('reconnecting');

    let conn: TrackerConnection;
    try {
      conn = new TrackerConnection(origin, trackerSessionId, {
        onAdvisoryStart: (params: AdvisoryStartParams) => {
          trackerWsUpRef.current = true;
          lastTrackerActivityRef.current = Date.now();
          setTrackerLiveness('connected');
          console.log('[Shell] advisory_start: peer=%s alias=%s my_amount=%s their_amount=%s', params.peer_id, params.peer_alias, params.my_amount, params.their_amount);
          if (!isAvailableForNewSessionPrompt()) {
            console.log('[Shell] advisory_start declined: client unavailable for new session');
            sendSessionReject(params.peer_id);
            return;
          }
          if (!isValidTimeoutString(params.channel_timeout) || !isValidTimeoutString(params.unroll_timeout)) {
            console.log('[Shell] advisory_start declined: timeout out of range channel=%s unroll=%s', params.channel_timeout, params.unroll_timeout);
            sendSessionReject(params.peer_id);
            return;
          }
          setPendingAdvisoryState(params);
          setActiveTab('game');
        },
        onPeerMessage: (fromId: string, _fromAlias: string, payload: Uint8Array) => {
          peerSessionRef.current?.deliverRawPeerMessage(fromId, payload);
          syncPeerLiveness();
        },
        onPeerAppMessage: (fromId: string, fromAlias: string, msg: PeerAppMessage) => {
          const ps = peerSessionRef.current;
          if (ps && ps.liveness === 'dead') return;
          if (ps) ps.notePeerActivity();
          syncPeerLiveness();
          console.log('[Shell] onPeerAppMessage type=%s from=%s', msg.type, fromId);
          if (msg.type === 'session_proposal') {
            const peerAlias = fromAlias || msg.from_alias || fromId;
            console.log('[Shell] session_proposal from=%s alias=%s proposer_amount=%s responder_amount=%s', fromId, peerAlias, msg.proposer_amount, msg.responder_amount);
            if (!isAvailableForNewSessionPrompt()) {
              console.log('[Shell] session_proposal declined: client unavailable for new session');
              sendSessionReject(fromId);
              return;
            }
            if (!isValidTimeoutString(msg.channel_timeout) || !isValidTimeoutString(msg.unroll_timeout)) {
              console.log('[Shell] session_proposal declined: timeout out of range channel=%s unroll=%s', msg.channel_timeout, msg.unroll_timeout);
              sendSessionReject(fromId);
              return;
            }
            const proposalSessionId = msg.game_session_id ?? generateSessionId();
            peerSessionRef.current?.destroy();
            peerSessionRef.current = new PeerSession(fromId, proposalSessionId, conn);
            bindPeerMessageHandler(peerSessionRef.current);
            setPendingProposalState({
              from_id: fromId,
              from_alias: peerAlias,
              proposer_amount: msg.proposer_amount,
              responder_amount: msg.responder_amount,
              channel_timeout: msg.channel_timeout,
              unroll_timeout: msg.unroll_timeout,
              game_session_id: proposalSessionId,
            });
            setActiveTab('game');
          } else if (msg.type === 'session_reject') {
            console.log('[Shell] session_reject from=%s sessionPeer=%s match=%s', fromId, ps?.peerId, ps?.peerId === fromId);
            if (ps?.peerId === fromId) {
              markPeerDead();
              const channelState = dashboardSessionModelRef.current?.channel.status.state;
              const isPreActive = !channelState || PRE_ACTIVE_CHANNEL_STATES.has(channelState);
              if (sessionPhaseRef.current === 'none' || isPreActive) {
                cancelAttemptedSession();
              }
            }
          }
        },
        onDeliveryFailure: (to: string) => {
          console.warn('[Shell] delivery_failure to=%s', to);
          const ps = peerSessionRef.current;
          if (ps && to === ps.peerId) {
            ps.markDegraded();
            syncPeerLiveness();
          }
        },
        onRegistered: (playerId: string) => {
          trackerWsUpRef.current = true;
          lastTrackerActivityRef.current = Date.now();
          setTrackerLiveness('connected');
          console.log('[Shell] registered as player_id=%s', playerId);
          const save = sessionSaveRef.current;
          const terminalSave = !!save && isTerminalChannelState(savedChannelState(save));
          if (!peerSessionRef.current && save?.sessionPeerId && conn) {
            peerSessionRef.current = new PeerSession(save.sessionPeerId, save.gameSessionId ?? generateSessionId(), conn);
            bindPeerMessageHandler(peerSessionRef.current);
            setRestoreTrackerReconciled(true);
            // Restore never goes through startFreshSessionWithPeer, which is
            // otherwise the only place that marks the tracker busy. Terminal
            // (Failed/Resolved*) saves must stay available in the lobby.
            conn.setBusy(!terminalSave, save.myAlias ?? peekAlias());
          } else if (save?.serializedCradle || save?.pairingToken) {
            setRestoreTrackerReconciled(true);
            conn.setBusy(!terminalSave, save.myAlias ?? peekAlias());
          }
          if (peerSessionRef.current && sessionController) {
            sessionController.resendUnacked();
          }
        },
        onLobbyAttention: () => {
          if (activeTabRef.current !== 'tracker') {
            setTrackerAlert(true);
          }
        },
        onClosed: () => {
          console.log('[Shell] tracker connection ended');
          trackerWsUpRef.current = false;
          markPeerInactive();
          setTrackerLiveness('disconnected');
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
        getPresence: () => {
          const phase = sessionPhaseRef.current;
          const save = sessionSaveRef.current;
          const restoring = !!sessionConfigRef.current?.restoring;
          const terminalSave = !!save && isTerminalChannelState(savedChannelState(save));
          // A leftover cradle must not keep us busy after the session resolved
          // (wallet/handshake failures often leave Failed + persisted cradle).
          const busy = shouldReportTrackerBusy(phase)
            || (restoring && !terminalSave && !!(save?.serializedCradle || save?.pairingToken));
          return {
            busy,
            // Prefer session aliases, then the lobby-synced prefs alias. Never call
            // getAlias() here — inventing Player_* would pollute identify/set_busy.
            alias: sessionConfigRef.current?.myAlias
              ?? save?.myAlias
              ?? peekAlias(),
          };
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

  }, [uniqueId, syncPeerLiveness, markPeerActive, markPeerInactive, markPeerDead, cancelAttemptedSession, clearSessionPreservingHistory, isAvailableForNewSessionPrompt, sendSessionReject, setPendingAdvisoryState, setPendingProposalState, bindPeerMessageHandler]);

  const requestTrackerConnect = useCallback((origin: string) => {
    if ((peerLiveness === 'connected' || peerLiveness === 'degraded') && sessionPhase === 'off-chain') {
      setConfirmDialog({
        title: 'Disconnect from tracker?',
        body: 'Disconnecting from this tracker will end your peer connection. Your game stays off-chain — resolve it on-chain from the dashboard if needed.',
        onConfirm: () => { setConfirmDialog(null); connectToTracker(origin, { resetSession: true }); },
      });
    } else if (peerLiveness === 'connected' || peerLiveness === 'degraded') {
      setConfirmDialog({
        title: 'Disconnect from tracker?',
        body: 'This will end your peer connection.',
        onConfirm: () => { setConfirmDialog(null); connectToTracker(origin, { resetSession: true }); },
      });
    } else {
      connectToTracker(origin, { resetSession: true });
    }
  }, [peerLiveness, sessionPhase, connectToTracker]);

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
    // Pre-game wallet connection: force Resume/Start Over on reload even
    // before a cradle exists. Preference writes must not clear this marker.
    markSavedSession();
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
  // fresh: wipe stale WC storage before connecting (user explicitly starting a new pairing)
  const handleConnect = useCallback(async (bcType: 'simulator' | 'walletconnect', silent = false, fresh = false) => {
    log(`[Shell] handleConnect: bcType=${bcType} silent=${silent} fresh=${fresh}`);
    wcAbortRef.current = false;
    const { iface, pollMs } = getInterface(bcType);
    try {
      markSavedSession();
      saveSession({ blockchainType: bcType });
      setBlockchainType(bcType);
      setConnecting(true);
      const setup = await iface.beginConnect(uniqueId, fresh);
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
        } else {
          setConnecting(false);
        }
      } else if (activeBlockchainRef.current) {
        // Reconnect failed — keep blockchainType so Reconnect stays usable.
        setConnectionSetup(null);
        setConnecting(false);
      } else {
        setBlockchainType(undefined);
        clearSessionPreservingHistory();
        setConnectionSetup(null);
        setConnecting(false);
      }
    }
  }, [uniqueId, clearSessionPreservingHistory, completeConnection, setConnecting]);

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
    clearSessionPreservingHistory();
    setConnecting(false);
    setWalletConnected(false);
    setShowSimModal(false);
  }, [blockchainType, clearSessionPreservingHistory, stopBalancePolling]);

  const onGameActivity = useCallback(() => {
    if (activeTabRef.current !== 'game') {
      deferStateUpdate(() => {
        setUnreadGame(true);
      });
    }
  }, [deferStateUpdate]);

  const clearSessionTimers = useCallback(() => {
    if (cleanShutdownGraceTimerRef.current !== null) {
      clearTimeout(cleanShutdownGraceTimerRef.current);
      cleanShutdownGraceTimerRef.current = null;
    }
    if (abandonTimerRef.current !== null) {
      clearTimeout(abandonTimerRef.current);
      abandonTimerRef.current = null;
    }
    waitingEnteredAtRef.current = null;
    waitingStateRef.current = null;
    setAbandonEnabled(false);
    setCleanShutdownGraceActive(false);
  }, []);

  const cancelDashboardSession = useCallback((options?: { retainFinishedGuard?: boolean }) => {
    const alias = sessionConfigRef.current?.myAlias ?? sessionSaveRef.current?.myAlias ?? peekAlias();
    const peerId = peerSessionRef.current?.peerId ?? sessionSaveRef.current?.sessionPeerId;
    // Terminal/clean finish must not send session_reject — that signal means
    // decline/abort. Cooperative close already completed through the protocol;
    // the peer should keep pinging until its own local shutdown finishes.
    if (peerId && !options?.retainFinishedGuard) sendSessionReject(peerId);
    resetPeerRelayState();
    destroySessionController();
    clearSessionPreservingHistory();
    sessionSaveRef.current = null;
    sessionSavePropRef.current = undefined;
    sessionStartedRef.current = false;
    sessionFinishedCleanupRef.current = !!options?.retainFinishedGuard;
    sessionPhaseRef.current = 'none';
    clearSessionTimers();
    setSessionPhase('none');
    setSessionError(false);
    setSessionConfig(null);
    setPeerConn(null);
    dashboardSessionModelRef.current = null;
    setDashboardSessionModel(null);
    setRestoreStatus('idle');
    setRestoreError(null);
    setRestoreTrackerReconciled(false);
    setPendingAdvisoryState(null);
    setPendingProposalState(null);
    trackerConnRef.current?.setBusy(false, alias);
  }, [clearSessionPreservingHistory, clearSessionTimers, resetPeerRelayState, sendSessionReject, setPendingAdvisoryState, setPendingProposalState]);

  /**
   * End live protocol for a terminal channel but keep the dashboard freeze
   * (Resolved Clean / balances / last status) so the game tab still shows how
   * the session finished. Persist that freeze + boot marker so reload shows
   * Resume/Start Over instead of silently booting into tracker prefs alone.
   */
  const finishResolvedSessionDisplay = useCallback((hasError: boolean) => {
    const alias = sessionConfigRef.current?.myAlias ?? sessionSaveRef.current?.myAlias ?? peekAlias();
    const model = dashboardSessionModelRef.current;
    sessionFinishedCleanupRef.current = true;
    sessionPhaseRef.current = 'resolved';
    setSessionPhase('resolved');
    setSessionError(hasError);
    trackerConnRef.current?.setBusy(false, alias);

    // Stop the live peer route and cradle; do not send session_reject and do
    // not wipe the dashboard model (that would flash "No Session").
    resetPeerRelayState();
    destroySessionController();

    // Clear only live protocol fields. clearSession() would drop the boot
    // marker and finished channel snapshot — then reload skips Resume while
    // still auto-connecting the saved tracker.
    if (model) {
      const status = model.channel.status;
      void saveSession({
        ...snapshotFromSessionModel(model),
        serializedCradle: undefined,
        cradleSchemaVersion: undefined,
        pairingToken: undefined,
        sessionPeerId: undefined,
        gameSessionId: undefined,
        channelReady: false,
        channelStatus: {
          state: status.state,
          advisory: status.advisory,
          coin: null,
          our_balance: status.ourBalance,
          their_balance: status.theirBalance,
          game_allocated: status.gameAllocated,
          have_potato: status.havePotato,
        },
        cleanShutdownStarted: model.channel.cleanShutdownStarted || undefined,
      });
    } else {
      void saveSession({
        serializedCradle: undefined,
        cradleSchemaVersion: undefined,
        pairingToken: undefined,
        sessionPeerId: undefined,
        gameSessionId: undefined,
      });
    }
    markSavedSession();

    sessionSaveRef.current = null;
    sessionSavePropRef.current = undefined;
    sessionStartedRef.current = false;
    clearSessionTimers();
    setSessionConfig(null);
    setPeerConn(null);
    setRestoreStatus('idle');
    setRestoreError(null);
    setRestoreTrackerReconciled(false);
  }, [clearSessionTimers, resetPeerRelayState]);

  const handleSessionPhaseChange = useCallback((phase: SessionPhase, hasError?: boolean) => {
    if (phase === 'resolved') {
      if (sessionFinishedCleanupRef.current) return;
      const previousPhase = sessionPhaseRef.current;
      const switchTracker = shouldSwitchToTrackerOnResolved(previousPhase, !!hasError);
      finishResolvedSessionDisplay(!!hasError);
      if (switchTracker) {
        setActiveTab('tracker');
      }
      return;
    }

    sessionPhaseRef.current = phase;
    setSessionPhase(phase);
    setSessionError(!!hasError);
    trackerConnRef.current?.setBusy(shouldReportTrackerBusy(phase));
  }, [finishResolvedSessionDisplay, setActiveTab]);

  const handleRestoreStatusChange = useCallback((status: RestoreStatus, error: string | null) => {
    setRestoreStatus(status);
    setRestoreError(error);
    setDashboardSessionModel(prev => prev
      ? { ...prev, restore: { ...prev.restore, status, error } }
      : prev
    );
    if (status === 'failed') {
      markSavedSession();
      setSessionError(true);
    }
  }, []);

  const handleSessionModelChange = useCallback((model: SessionModel) => {
    dashboardSessionModelRef.current = model;
    setDashboardSessionModel(model);
  }, []);

  const handleTerminal = useCallback(() => {
    // Phase→resolved owns soft finish (preserves dashboard + sessionError).
    // Terminal only stops balance polling once the cradle reports done.
    stopBalancePolling();
  }, [stopBalancePolling]);

  const restoreBlocked = isRestoreBlocked(!!sessionConfig?.restoring, restoreStatus, restoreTrackerReconciled);

  const handleTabChange = useCallback((tabId: TabId) => {
    setActiveTab(tabId);
    if (tabId === 'game') setUnreadGame(false);
    if (tabId === 'wallet') setWalletAlert(false);
    if (tabId === 'tracker') setTrackerAlert(false);
  }, []);

  useThemeSyncToIframe('tracker-iframe', [iframeUrl]);

  // Lobby owns the display name; keep local prefs aligned so presence and
  // session_proposal do not invent a Player_* fallback that later overwrites
  // the tracker.
  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      const data = ev.data;
      if (!data || data.type !== 'lobby-alias' || typeof data.alias !== 'string') return;
      const trimmed = data.alias.trim();
      if (!trimmed) return;
      if (peekAlias() === trimmed) return;
      setAlias(trimmed);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const [resuming, setResuming] = useState(false);
  const [startingOver, setStartingOver] = useState(false);

  /** Restore a finished/terminal session freeze without remounting live WASM. */
  const restoreFinishedSessionFromSave = useCallback((save: SessionState) => {
    const channelState = savedChannelState(save);
    const hasError = channelState === 'Failed' || channelState === 'ResolvedStale';
    sessionFinishedCleanupRef.current = true;
    sessionPhaseRef.current = 'resolved';
    setSessionPhase('resolved');
    setSessionError(hasError);
    const model = sessionModelFromSave(save);
    dashboardSessionModelRef.current = model;
    setDashboardSessionModel(model);
    sessionSaveRef.current = save;
    sessionSavePropRef.current = undefined;
    sessionStartedRef.current = false;
    setSessionConfig(null);
    setPeerConn(null);
    setRestoreStatus('idle');
    setRestoreError(null);
    setRestoreTrackerReconciled(true);
    trackerConnRef.current?.setBusy(false, save.myAlias ?? peekAlias());
    setActiveTab('game');
    setResuming(false);
  }, [setActiveTab]);

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
    sessionSavePropRef.current = sessionSaveForReactProps(save);
    const { myContribution, theirContribution, perGameAmount: perGame } = sessionAmountsFromSave(save);
    if (save.pairingToken) {
      setSessionConfig({
        iStarted: save.iStarted ?? false,
        myContribution,
        theirContribution,
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
    if (savedHistory) setHistory(recentEntries(savedHistory, HUMAN_HISTORY_LIMIT));
    if (savedLog) setLogLines(recentEntries(savedLog, DIAGNOSTIC_LOG_LIMIT));
    setBlockchainType(bcType);

    const { iface, pollMs } = getInterface(bcType);
    activeBlockchainRef.current = iface;
    setWalletConnected(iface.isConnected());
    setResuming(false);

    // Restore abandon timer only if the persisted channel is still in that waiting state.
    if (abandonTimerRef.current !== null) {
      clearTimeout(abandonTimerRef.current);
      abandonTimerRef.current = null;
    }
    const restoredChannelState = savedChannelState(save);
    if (save.waitingStateEnteredAt != null && isAbandonWaitingState(restoredChannelState)) {
      const elapsed = BigInt(Date.now()) - save.waitingStateEnteredAt;
      waitingEnteredAtRef.current = save.waitingStateEnteredAt;
      waitingStateRef.current = restoredChannelState;
      if (elapsed >= ABANDON_DELAY_MS) {
        setAbandonEnabled(true);
      } else {
        abandonTimerRef.current = setTimeout(() => {
          abandonTimerRef.current = null;
          const currentState = dashboardSessionModelRef.current?.channel.status.state ?? restoredChannelState;
          if (currentState !== restoredChannelState) return;
          setAbandonEnabled(true);
        }, Number(ABANDON_DELAY_MS - elapsed));
      }
    } else {
      waitingEnteredAtRef.current = null;
      waitingStateRef.current = null;
      setAbandonEnabled(false);
      if (save.waitingStateEnteredAt != null) {
        saveSession({ waitingStateEnteredAt: undefined });
      }
    }

    // Restore clean shutdown grace from persisted timestamp
    if (save.cleanShutdownGraceStartedAt != null) {
      const elapsed = BigInt(Date.now()) - save.cleanShutdownGraceStartedAt;
      if (elapsed < GRACE_DELAY_MS) {
        setCleanShutdownGraceActive(true);
        cleanShutdownGraceTimerRef.current = setTimeout(() => {
          cleanShutdownGraceTimerRef.current = null;
          setCleanShutdownGraceActive(false);
          saveSession({ cleanShutdownGraceStartedAt: undefined });
        }, Number(GRACE_DELAY_MS - elapsed));
      }
    }

    // For WalletConnect restores, finalize performs the first wallet RPC
    // (address lookup). Keep it in the background so local restore can render
    // while the simulator/wallet is unavailable.
    setConnecting(true);
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
        } else {
          setConnecting(false);
        }
      }
      console.log('[Shell] performResume: blockchain connect task done');
    })();
  }, [uniqueId, completeConnection, stablePeerConn, setActiveTab]);

  // User clicked "Resume Session" in the resumeDialog.
  // If another tab holds the lease, ask to take over first; otherwise proceed.
  const handleResume = useCallback(async () => {
    if (bootState.kind !== 'resumeDialog' || bootState.loadError !== null) return;
    setResuming(true);
    let save: SessionState | null;
    try {
      save = await peekSession();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[Shell] resume session load failed:', error);
      markSavedSession();
      setBootState({ kind: 'resumeDialog', loadError: message });
      setResuming(false);
      return;
    }
    if (!save) {
      // peekSession clears orphan markers when no record exists. Re-arm so a
      // failed Resume cannot fall through to leftover preference state on the
      // next reload — the user must Start Over.
      markSavedSession();
      setBootState({
        kind: 'resumeDialog',
        loadError: 'The saved session is unsupported or could not be loaded.',
      });
      setResuming(false);
      return;
    }
    if (isLeaseConflict()) {
      console.log('[Shell] resume: lease conflict, showing tabConflict dialog');
      setBootState({ kind: 'tabConflict', save, midSession: false });
      setResuming(false);
      return;
    }
    console.log('[Shell] resume: no conflict, claiming lease and hydrating');
    claimLease();
    setBootState({ kind: 'ready' });
    if (save.serializedCradle) {
      void performResume(save);
    } else if (isTerminalChannelState(savedChannelState(save))) {
      restoreFinishedSessionFromSave(save);
      if (save.blockchainType) {
        void handleConnect(save.blockchainType, true);
      }
    } else if (save.blockchainType) {
      void handleConnect(save.blockchainType, true);
    } else {
      setResuming(false);
    }
  }, [bootState, performResume, handleConnect, restoreFinishedSessionFromSave]);

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
      } else if (prev.save && isTerminalChannelState(savedChannelState(prev.save))) {
        restoreFinishedSessionFromSave(prev.save);
        const bcType = prev.save.blockchainType ?? getBlockchainType();
        if (bcType) {
          void handleConnect(bcType, true);
        }
      } else {
        const bcType = prev.save?.blockchainType ?? getBlockchainType();
        if (bcType) {
          void handleConnect(bcType, true);
        }
      }
      return { kind: 'ready' };
    });
  }, [performResume, handleConnect, restoreFinishedSessionFromSave]);

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

  const handleStartOver = useCallback(async () => {
    setStartingOver(true);
    // Close live connections before wiping storage. Open WalletConnect /
    // tracker sockets can block IndexedDB deleteDatabase and hang Start Over.
    try {
      trackerConnRef.current?.disconnect();
      trackerConnRef.current = null;
      if (activeBlockchainRef.current) {
        try { await activeBlockchainRef.current.disconnect(); } catch { /* ignore */ }
      }
      deactivate();
      activeBlockchainRef.current = null;
      setActiveBlockchainPoller(null);
    } catch (e) {
      console.error('[Shell] start over connection teardown failed:', e);
    }
    try {
      await hardReset();
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
    // Pre-game wallet disconnect: drop the boot marker so reload does not
    // force Resume just for a prior blockchainType. Mid-session / resumable
    // state must keep the marker — otherwise boot skips Resume while the
    // cradle remains in IDB and can be clobbered by incidental saves.
    const hasResumableSession =
      sessionPhaseRef.current !== 'none'
      || !!(sessionSaveRef.current?.serializedCradle || sessionSaveRef.current?.pairingToken)
      || !!sessionConfigRef.current?.pairingToken;
    if (!hasResumableSession) {
      clearSavedSessionMarker();
    }
    saveSession({ blockchainType: undefined });
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
    if ((peerLiveness === 'connected' || peerLiveness === 'degraded') && sessionPhase === 'off-chain') {
      setConfirmDialog({
        title: 'Disconnect from tracker?',
        body: 'Disconnecting from this tracker will end your peer connection. Your game stays off-chain — resolve it on-chain from the dashboard if needed.',
        onConfirm: () => { setConfirmDialog(null); doDisconnectTracker(); },
      });
    } else if (peerLiveness === 'connected' || peerLiveness === 'degraded') {
      setConfirmDialog({
        title: 'Disconnect from tracker?',
        body: 'This will end your peer connection.',
        onConfirm: () => { setConfirmDialog(null); doDisconnectTracker(); },
      });
    } else {
      doDisconnectTracker();
    }
  }, [peerLiveness, sessionPhase, doDisconnectTracker]);

  const handleEndPeerConnection = useCallback(() => {
    resetPeerRelayState();
    trackerConnRef.current?.setBusy(shouldReportTrackerBusy(sessionPhaseRef.current));
  }, [resetPeerRelayState]);

  const startCleanShutdownGrace = useCallback(() => {
    if (cleanShutdownGraceTimerRef.current !== null) {
      clearTimeout(cleanShutdownGraceTimerRef.current);
    }
    setCleanShutdownGraceActive(true);
    saveSession({ cleanShutdownGraceStartedAt: BigInt(Date.now()) });
    cleanShutdownGraceTimerRef.current = setTimeout(() => {
      cleanShutdownGraceTimerRef.current = null;
      setCleanShutdownGraceActive(false);
      saveSession({ cleanShutdownGraceStartedAt: undefined });
    }, Number(GRACE_DELAY_MS));
  }, []);

  const requestDashboardCleanShutdown = useCallback(() => {
    startCleanShutdownGrace();
    setDashboardSessionModel(prev => prev
      ? { ...prev, channel: { ...prev.channel, cleanShutdownStarted: true } }
      : prev
    );
    sessionController?.cleanShutdown();
  }, [startCleanShutdownGrace]);

  const performDashboardGoOnChain = useCallback(() => {
    sessionController?.goOnChain();
    sessionPhaseRef.current = 'on-chain';
    setSessionPhase('on-chain');
    trackerConnRef.current?.setBusy(shouldReportTrackerBusy('on-chain'));
    peerSessionRef.current?.markDead();
    syncPeerLiveness();
    setDashboardSessionModel(prev => prev
      ? { ...prev, channel: { ...prev.channel, goOnChainPressed: true } }
      : prev
    );
  }, [syncPeerLiveness]);

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
      case 'abandon':
        if (!isSessionAbandonable(dashboardSessionModelRef.current, abandonEnabledRef.current)) {
          setConfirmDialog(null);
          break;
        }
        setConfirmDialog({
          title: 'Abandon session?',
          body: 'This will end the session immediately. Abandoning may result in a loss of funds if the on-chain resolution requires your participation.',
          confirmLabel: 'Abandon',
          onConfirm: () => {
            setConfirmDialog(null);
            if (!isSessionAbandonable(dashboardSessionModelRef.current, abandonEnabledRef.current)) return;
            cancelDashboardSession();
          },
        });
        break;
      case 'none':
        break;
    }
  }, [cancelDashboardSession, requestDashboardCleanShutdown, requestDashboardGoOnChain]);

  const handleReconnect = useCallback(() => {
    if (!blockchainType || connecting) return;
    handleConnect(blockchainType);
  }, [blockchainType, connecting, handleConnect]);

  if (bootState.kind === 'loading') {
    return null;
  }

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
    const loadFailed = bootState.loadError !== null;
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
            {loadFailed ? 'Saved session unavailable' : 'Previously saved state'}
          </p>
          <p className='text-canvas-text text-sm text-center'>
            {loadFailed
              ? `${bootState.loadError} Start over to clear it.`
              : 'You have previously saved state. Resume where you left off, or start over?'}
          </p>
          {!loadFailed && (
            <button
              onClick={handleResume}
              disabled={resuming || startingOver}
              className='w-full px-4 py-2 rounded-md font-medium text-sm bg-primary-solid text-primary-on-primary hover:bg-primary-solid-hover transition-colors disabled:opacity-50'
            >
              {resuming ? 'Resuming\u2026' : 'Resume Session'}
            </button>
          )}
          <button
            onClick={handleStartOver}
            disabled={resuming || startingOver}
            className='w-full px-4 py-2 rounded-md font-medium text-sm border border-canvas-border text-canvas-text hover:bg-canvas-bg-hover transition-colors disabled:opacity-50'
          >
            {startingOver ? 'Starting over\u2026' : 'Start over'}
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

  const sessionCanMount = sessionConfig !== null && peerConn !== null;
  const { startSession: sessionReadyToStart, keepSession } = shouldMountGameSession(
    sessionCanMount,
    walletConnected,
    !!sessionConfig?.restoring,
    sessionStartedRef.current,
  );
  if (sessionReadyToStart) sessionStartedRef.current = true;
  console.log('[Shell] render: sessionConfig=%s peerConn=%s poller=%s walletConnected=%s restoring=%s → keepSession=%s',
    !!sessionConfig, !!peerConn, !!activeBlockchainPoller, walletConnected, !!sessionConfig?.restoring, keepSession);

  const dashboardView: GameDashboardViewModel = selectGameDashboardView(dashboardSessionModel, {
    hasSession: dashboardSessionModel !== null,
    cleanShutdownGraceActive,
    abandonEnabled,
  });
  const statusBarBalances = selectStatusBarBalances(dashboardSessionModel);
  const sessionConsentOverlay = pendingAdvisory ? (
    <div className='absolute inset-0 flex items-center justify-center bg-canvas-bg/80 backdrop-blur-sm z-50'>
      <div className='bg-canvas-bg border border-canvas-border rounded-lg p-6 shadow-lg max-w-sm text-center'>
        <h2 className='text-lg font-semibold text-canvas-text mb-2'>New Session</h2>
        <p className='text-sm text-canvas-text mb-4'>
          <strong>{pendingAdvisory.peer_alias}</strong> would like to play.
          <SessionBuyIn myAmount={pendingAdvisory.my_amount} theirAmount={pendingAdvisory.their_amount} />
        </p>
        <div className='flex gap-3 justify-center'>
          <button
            onClick={() => acceptPendingAdvisory(pendingAdvisory)}
            className='px-4 py-2 rounded-md font-medium text-sm bg-primary-solid text-primary-on-primary hover:bg-primary-solid-hover transition-colors'
          >
            Accept
          </button>
          <button
            onClick={() => declinePendingAdvisory(pendingAdvisory)}
            className='px-4 py-2 rounded-md font-medium text-sm border border-canvas-border text-canvas-text hover:bg-canvas-bg-hover transition-colors'
          >
            Decline
          </button>
        </div>
      </div>
    </div>
  ) : pendingProposal ? (
    <div className='absolute inset-0 flex items-center justify-center bg-canvas-bg/80 backdrop-blur-sm z-50'>
      <div className='bg-canvas-bg border border-canvas-border rounded-lg p-6 shadow-lg max-w-sm text-center'>
        <h2 className='text-lg font-semibold text-canvas-text mb-2'>New Session</h2>
        <p className='text-sm text-canvas-text mb-4'>
          <strong>{pendingProposal.from_alias}</strong> is proposing a session.
          <SessionBuyIn myAmount={pendingProposal.responder_amount} theirAmount={pendingProposal.proposer_amount} />
        </p>
        <div className='flex gap-3 justify-center'>
          <button
            onClick={() => acceptPendingProposal(pendingProposal)}
            className='px-4 py-2 rounded-md font-medium text-sm bg-primary-solid text-primary-on-primary hover:bg-primary-solid-hover transition-colors'
          >
            Accept
          </button>
          <button
            onClick={() => declinePendingProposal(pendingProposal)}
            className='px-4 py-2 rounded-md font-medium text-sm border border-canvas-border text-canvas-text hover:bg-canvas-bg-hover transition-colors'
          >
            Decline
          </button>
        </div>
      </div>
    </div>
  ) : null;

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
            case 'game': {
              const gameDot: GameTabDotColor = selectGameTabDotColor({
                sessionPhase,
                sessionError,
                peerLiveness,
                cleanShutdownInProgress: isCleanShutdownInProgress(dashboardSessionModel),
              });
              const gameDotCss: Record<GameTabDotColor, string> = {
                green: 'var(--color-success-solid)',
                yellow: 'var(--color-warning-solid)',
                red: 'var(--color-alert-solid)',
                gray: 'var(--color-canvas-text-subtle)',
              };
              dotColor = gameDotCss[gameDot];
              break;
            }
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
          ) : connecting ? (
            <div className='flex flex-col items-center gap-4 p-6 max-w-md w-full'>
              <div className='w-6 h-6 border-2 border-canvas-border border-t-canvas-text-contrast rounded-full animate-spin' />
              <p className='text-sm text-canvas-text animate-pulse'>Connecting…</p>
              <Button variant='solid' onClick={handleCancelConnect}>Cancel</Button>
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
                <Button variant='solid' fullWidth onClick={() => handleConnect('simulator', false, true)}>
                  Continue with Simulator
                </Button>
                <div className='flex items-center gap-2'>
                  <div className='flex-1 border-t border-canvas-border' />
                  <span className='text-canvas-text font-medium text-sm'>OR</span>
                  <div className='flex-1 border-t border-canvas-border' />
                </div>
                <Button variant='solid' fullWidth onClick={() => handleConnect('walletconnect', false, true)}>
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
                  disabled={startingOver}
                  className='px-4 py-2 rounded-md font-medium text-sm border border-canvas-border text-canvas-text hover:bg-canvas-bg-hover transition-colors disabled:opacity-50'
                >
                  {startingOver ? 'Starting over\u2026' : 'Start over'}
                </button>
              </div>
            ) : keepSession ? (
              <div className='relative w-full h-full'>
                <GameSessionErrorBoundary>
                  <GameSession
                    key={sessionConfig!.pairingToken}
                    params={sessionConfig!}
                    peerConn={peerConn!}
                    registerMessageHandler={registerMessageHandler}
                    appendGameLog={appendHistory}
                    sessionSave={sessionSavePropRef.current}
                    blockchain={activeBlockchainPoller}
                    onGameActivity={onGameActivity}
                    onSessionPhaseChange={handleSessionPhaseChange}
                    onRestoreStatusChange={handleRestoreStatusChange}
                    onSessionModelChange={handleSessionModelChange}
                    onProtocolStateProviderChange={handleProtocolStateProviderChange}
                    onCoinsProviderChange={handleCoinsProviderChange}
                    suppressPhaseReporting={restoreBlocked}
                    onTerminal={handleTerminal}
                  />
                </GameSessionErrorBoundary>
                {sessionConsentOverlay}
              </div>
            ) : sessionCanMount ? (
              <div className='w-full h-full flex items-center justify-center text-canvas-solid'>
                Restoring session...
              </div>
            ) : (
              <div className='relative w-full h-full'>
                <div className='w-full h-full flex items-center justify-center text-canvas-solid'>
                  {sessionPhase === 'resolved' && dashboardSessionModel
                    ? 'Session finished'
                    : 'No active game session'}
                </div>
                {sessionConsentOverlay}
              </div>
            )}
          </div>
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
