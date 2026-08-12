import { useEffect, useState, useCallback, useRef, useMemo } from 'react';

import { useShellSessionTransition } from '../hooks/useShellSessionTransition';
import {
  PendingSessionProposal,
  ShellSessionTransitionReason,
} from '../lib/session/shellSessionState';
import GameSession from './GameSession';
import { GameSessionErrorBoundary, UncaughtClientErrorReporter } from './GameSession';
import { SessionTransitionSurface } from './SessionTransitionSurface';
import FinishedSessionGameView from './FinishedSessionGameView';
import { SimulatorSetupModal } from './SimulatorSetupModal';
import QRCode from 'qrcode';
import {
  GameSessionParams,
  PeerConnectionResult,
  InternalBlockchainInterface,
  ConnectionSetup,
  HubLiveness,
  SessionPhase,
  PeerLiveness,
  CoinOfInterestEntry,
} from '../types/ChiaGaming';
import { HubConnection, AdvisoryStartParams, type PeerAppMessage } from '../services/HubConnection';
import { PeerSession, generateSessionId } from '../services/PeerSession';
import { subscribeLog } from '../services/log';
import { reactPropSafeValue } from '../lib/reactPropSafe';
import {
  getPlayerId,
  getSessionId,
  ensureHubIdentity,
  clearSessionId,
  getBlockchainType,
  getTheme,
  setTheme as saveTheme,
  peekSession,
  saveSession,
  patchLiveSessionPresentation,
  replaceSession,
  clearSession,
  clearSessionPairing,
  hardReset,
  shouldOfferResumeOrStartOver,
  hydrateSessionCacheFromDisk,
  markSavedSession,
  clearSavedSessionMarker,
  peekAutoResumeOnce,
  clearAutoResumeOnce,
  loadState,
  LiveSessionSave,
  SessionSave,
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
  getHubAlert as getSavedHubAlert,
  setHubAlert as saveHubAlert,
  getHubUrl,
  setHubUrl as saveHubUrl,
  isLeaseConflict,
  claimLease,
  onFenced,
  offFenced,
  peekAlias,
  setAlias,
} from '../hooks/save';
import {
  sessionController,
  destroySessionController,
  isTransactionPublishNerfed,
  setTransactionPublishNerfed as setTransactionPublishNerf,
  subscribeTransactionPublishNerfed,
} from '../hooks/blobSingleton';
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
import {
  isRestoreBlocked,
  restoreGateAfterTerminalFinalization,
  shouldCancelAttemptOnDisconnect,
  shouldCancelOnPeerUnreachable,
  shouldMountGameSession,
  shouldReportHubBusy,
  shouldReportHubBusyPresence,
  shouldSuppressPhaseReporting,
  shouldSwitchToHubOnResolved,
  shouldSynthesizeSetupPending,
  transitionToFreshSession,
} from '../lib/restoreLifecycle';
import {
  ABANDON_WAITING_STATES,
  isChannelAbandonable,
  isCleanShutdownInProgress,
  PRE_ACTIVE_CHANNEL_STATES,
  selectGameDashboardView,
  selectGameTabDotColor,
  selectStatusBarBalances,
  sessionAmountsFromSave,
  sessionModelFromSave,
  DEFAULT_CHANNEL_TIMEOUT_BLOCKS,
  DEFAULT_UNROLL_TIMEOUT_BLOCKS,
  type GameDashboardActionKind,
  type GameDashboardViewModel,
  type GameTabDotColor,
  type SessionModel,
  type StatusBarBalanceSegment,
} from '../lib/session/model';
import { sessionModelForReactProps } from '../lib/session/finishedSessionDisplay';
import { finalizeTerminalSession } from '../lib/session/terminalFinalization';
import type { TerminalSessionPresentation } from '../lib/session/sessionResult';
import {
  appendRecent,
  DIAGNOSTIC_LOG_LIMIT,
  HUMAN_HISTORY_LIMIT,
  recentEntries,
} from '../lib/session/historyLimits';
import { log } from '../services/log';
import { formatMojos } from '../util';
import { Button } from './button';

import { HubPicker } from './HubPicker';

type TabId = 'wallet' | 'hub' | 'game' | 'history' | 'log';

function getInterface(bcType: 'simulator' | 'walletconnect') {
  return bcType === 'walletconnect'
    ? { iface: realBlockchainInfo, pollMs: CHAIN_POLL_INTERVAL_MS }
    : { iface: fakeBlockchainInfo, pollMs: 5000 };
}

function normalizeHubOrigin(origin: string): string {
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

function humanHistoryFromSave(save: SessionSave): string[] | undefined {
  return save.history.humanHistory;
}

function diagnosticLogFromSave(save: SessionSave): string[] | undefined {
  return save.history.diagnosticLog;
}

/**
 * Build a React-safe SessionSave without deep-walking binary fields.
 * Spreading/cloning a degraded cradle (`{0:n,1:n,...}`) OOMs the tab.
 */
function sessionSaveForReactProps(save: SessionSave | null): SessionSave | undefined {
  if (!save) return undefined;
  if (save.phase !== 'live') return reactPropSafeValue(save) as SessionSave;
  const { serializedGameSession, unackedMessages, ...liveRest } = save.live;
  const handState = save.presentation.handState;
  const propSafeSave = reactPropSafeValue({
    ...save,
    live: {
      ...liveRest,
      serializedGameSession: new Uint8Array(),
      unackedMessages: [],
    },
    presentation: { ...save.presentation, handState: null },
  }) as LiveSessionSave;
  // Attach binaries by reference and keep them non-enumerable so React/dev
  // tools never walk millions of numeric keys.
  if (serializedGameSession !== undefined) {
    Object.defineProperty(propSafeSave.live, 'serializedGameSession', {
      value: serializedGameSession,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
  if (unackedMessages !== undefined) {
    Object.defineProperty(propSafeSave.live, 'unackedMessages', {
      value: unackedMessages,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
  if (Object.prototype.hasOwnProperty.call(save.presentation, 'handState')) {
    Object.defineProperty(propSafeSave.presentation, 'handState', {
      value: handState,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
  return propSafeSave;
}

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
    const amount = BigInt(raw);
    if (amount <= 0n) {
      throw new Error(`session amount must be positive, got ${raw}`);
    }
    return amount;
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('session amount')) throw e;
    throw new Error(`invalid session amount: ${raw}`, { cause: e });
  }
}

function SessionBuyIn({
  myAmount,
  theirAmount,
  channelTimeout,
  unrollTimeout,
}: {
  myAmount: string;
  theirAmount: string;
  channelTimeout?: string;
  unrollTimeout?: string;
}) {
  const effectiveChannelTimeout =
    parseOptionalBigInt(channelTimeout) ?? DEFAULT_CHANNEL_TIMEOUT_BLOCKS;
  const effectiveUnrollTimeout =
    parseOptionalBigInt(unrollTimeout) ?? DEFAULT_UNROLL_TIMEOUT_BLOCKS;
  if (myAmount === theirAmount) {
    return (
      <>
        <br />
        Buy-in: <strong>{myAmount}</strong> mojos
        <br />
        Channel timeout: <strong>{effectiveChannelTimeout.toString()}</strong> blocks
        <br />
        Unroll timeout: <strong>{effectiveUnrollTimeout.toString()}</strong> blocks
      </>
    );
  }

  return (
    <>
      <br />
      Your buy-in: <strong>{myAmount}</strong> mojos
      <br />
      Their buy-in: <strong>{theirAmount}</strong> mojos
      <br />
      Channel timeout: <strong>{effectiveChannelTimeout.toString()}</strong> blocks
      <br />
      Unroll timeout: <strong>{effectiveUnrollTimeout.toString()}</strong> blocks
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
  sendMessage: () => false,
  sendAck: () => false,
  sendKeepalive: () => false,
  hostLog: () => {},
  close: () => {},
};

const TAB_DEFS: { id: TabId; label: string }[] = [
  { id: 'wallet', label: 'Wallet' },
  { id: 'hub', label: 'Hub' },
  { id: 'game', label: 'Game' },
  { id: 'history', label: 'History' },
  { id: 'log', label: 'Log' },
];

const ABANDON_DELAY_MS = 120_000n;
const GRACE_DELAY_MS = 10_000n;

const MIN_TIMEOUT_BLOCKS = 3;
const MAX_TIMEOUT_BLOCKS = 30;

function isAbandonWaitingState(
  state: SessionModel['channel']['status']['state'] | null | undefined,
): state is SessionModel['channel']['status']['state'] {
  return !!state && ABANDON_WAITING_STATES.has(state);
}

function isSessionAbandonable(model: SessionModel | null, abandonEnabled: boolean): boolean {
  return isChannelAbandonable(model?.channel.status, abandonEnabled);
}

function savedChannelStatus(save: SessionSave): SessionModel['channel']['status']['state'] | null {
  if ((save.phase === 'live' || save.phase === 'terminal') && save.presentation.channelStatus) {
    return save.presentation.channelStatus.state;
  }
  return null;
}

function isTerminalSavedChannel(save: SessionSave): boolean {
  return save.phase === 'terminal';
}

function savedMyAlias(save: SessionSave | null | undefined): string | undefined {
  if (save?.phase === 'live' || save?.phase === 'pre-handshake') return save.pairing.myAlias;
  if (save?.phase === 'terminal') return save.terminal.myAlias ?? undefined;
  return undefined;
}

function savedOpponentAlias(save: SessionSave | null | undefined): string | undefined {
  if (save?.phase === 'live' || save?.phase === 'pre-handshake') {
    return save.pairing.opponentAlias;
  }
  if (save?.phase === 'terminal') return save.terminal.opponentAlias ?? undefined;
  return undefined;
}

/** Hub busy from phase, wallet, and any in-progress non-terminal restore cradle. */
function hubBusyFromSessionState(
  phase: SessionPhase,
  walletConnected: boolean,
  restoring: boolean,
  save: SessionSave | null | undefined,
): boolean {
  return shouldReportHubBusyPresence(phase, walletConnected, {
    restoring,
    terminalSave: !!save && isTerminalSavedChannel(save),
    hasCradle: save?.phase === 'live' || save?.phase === 'pre-handshake',
  });
}

/** Tab to show before any resume hydrate — session restores always open on Game. */
function tabForResumedSave(save: SessionSave): TabId | null {
  if (save.phase !== 'preferences') return 'game';
  return null;
}

function isValidTimeoutString(v: string | undefined): boolean {
  if (v === undefined) return true;
  const n = parseOptionalBigInt(v);
  return n !== undefined && n >= BigInt(MIN_TIMEOUT_BLOCKS) && n <= BigInt(MAX_TIMEOUT_BLOCKS);
}

const TRACKER_LIVENESS_LABELS: Record<HubLiveness, string> = {
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
    <div className="flex-shrink-0 border-b border-canvas-border bg-canvas-bg-subtle px-4 py-2 text-canvas-text sm:px-6 md:px-8">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <button
            type="button"
            onClick={() => setExpanded((prev) => !prev)}
            aria-expanded={expanded}
            aria-label={expanded ? 'Hide dashboard details' : 'Show dashboard details'}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-canvas-text transition-colors hover:bg-canvas-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-solid"
          >
            <span
              aria-hidden="true"
              className={`text-sm leading-none transition-transform ${expanded ? 'rotate-90' : ''}`}
            >
              ▶
            </span>
          </button>
          <div className="flex min-w-0 flex-col gap-y-0.5">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-0.5">
              <span className="flex min-w-0 flex-wrap gap-x-1">
                <span className="text-canvas-solid">Channel:</span>
                <span className="font-medium text-canvas-text-contrast">
                  {view.channelStatusLabel}
                </span>
                {view.havePotato && (
                  <span aria-label="You have the potato" title="You have the potato">
                    🥔
                  </span>
                )}
                {view.channelDetail && (
                  <span className="text-canvas-text">{view.channelDetail}</span>
                )}
              </span>
              {view.lifecycleRows.length === 0 &&
                view.handStatusLabel !== 'Active' &&
                view.handStatusLabel !== 'No hand' && (
                  <span className="flex min-w-0 flex-wrap gap-x-1">
                    <span className="text-canvas-solid">Hand:</span>
                    <span className="font-medium text-canvas-text-contrast">
                      {view.handStatusLabel}
                    </span>
                    {view.handDetail && <span className="text-canvas-text">{view.handDetail}</span>}
                  </span>
                )}
              {view.lifecycleRows.map((row) => (
                <span key={row.id} className="flex min-w-0 flex-wrap gap-x-1">
                  <span className="text-canvas-solid">{row.label}:</span>
                  <span className="font-medium text-canvas-text-contrast">{row.statusLabel}</span>
                  {row.detail && <span className="text-canvas-text">{row.detail}</span>}
                </span>
              ))}
            </div>
            {balances && (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-0.5">
                {balances.map((seg) => (
                  <span key={seg.label} className="flex min-w-0 flex-wrap gap-x-1">
                    <span className="text-canvas-solid">{seg.label}:</span>
                    <span className="font-medium text-canvas-text-contrast">
                      {formatBalanceValue(seg.value)}
                      {seg.value2 !== undefined ? ` / ${formatBalanceValue(seg.value2)}` : ''}
                    </span>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="solid"
            color="primary"
            size="sm"
            className="min-w-40"
            disabled={!view.actionEnabled}
            onClick={() => onAction(view.actionKind)}
          >
            {view.actionLabel}
          </Button>
        </div>
      </div>
      {expanded && (
        <div className="mt-2">
          {coins.length > 0 && (
            <div className="mb-2 flex flex-col gap-y-0.5 text-xs">
              {coins.map((coin) => (
                <span key={`${coin.label}:${coin.id}`} className="flex min-w-0 flex-wrap gap-x-1">
                  <span className="text-canvas-solid">{coin.label}:</span>
                  <span className="break-all font-mono text-canvas-text-contrast select-text cursor-text">
                    {coin.id}
                  </span>
                </span>
              ))}
            </div>
          )}
          <div className="mb-1 flex items-center justify-between">
            <span className="text-xs text-canvas-solid">Protocol state</span>
            <Button variant="ghost" color="neutral" size="sm" onClick={refreshProtocolState}>
              Refresh
            </Button>
          </div>
          <pre className="max-h-80 overflow-auto whitespace-pre rounded border border-canvas-line bg-canvas-bg p-2 text-[11px] font-mono text-canvas-text-contrast select-text cursor-text">
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
    isNearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
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
      className="w-full h-full resize-none rounded-md border border-canvas-border bg-canvas-bg p-3 text-xs font-mono text-canvas-text focus:outline-none"
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
    return lines.filter((line) => line.toLowerCase().includes(lower));
  }, [lines, filter]);

  const handleScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const threshold = 48;
    isNearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
  }, []);

  useEffect(() => {
    if (isNearBottom.current && ref.current) {
      ref.current.scrollTop = ref.current.scrollHeight;
    }
  }, [filtered]);

  return (
    <div className="flex flex-col h-full gap-2">
      <div className="flex items-center gap-2 shrink-0">
        <input
          type="text"
          placeholder="Filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="flex-1 px-3 py-1.5 text-xs font-mono rounded-md border border-canvas-border bg-canvas-bg text-canvas-text placeholder:text-canvas-solid focus:outline-none"
        />
        {filter && (
          <span className="text-xs text-canvas-solid whitespace-nowrap">
            {filtered.length}/{lines.length}
          </span>
        )}
        <button
          onClick={() => {
            navigator.clipboard.writeText(filtered.join('\n'));
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="p-1.5 rounded-md border border-canvas-border text-canvas-text hover:bg-canvas-bg-hover transition-colors"
          title="Copy to clipboard"
        >
          {copied ? (
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              className="w-4 h-4"
            >
              <path
                fillRule="evenodd"
                d="M16.704 4.153a.75.75 0 0 1 .143 1.052l-8 10.5a.75.75 0 0 1-1.127.075l-4.5-4.5a.75.75 0 0 1 1.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 0 1 1.05-.143Z"
                clipRule="evenodd"
              />
            </svg>
          ) : (
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              className="w-4 h-4"
            >
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
        className="flex-1 min-h-0 resize-none rounded-md border border-canvas-border bg-canvas-bg p-3 text-xs font-mono text-canvas-text focus:outline-none"
      />
    </div>
  );
}

function SessionTransitionOverlay({ reason }: { reason: ShellSessionTransitionReason }) {
  const labels: Record<ShellSessionTransitionReason, string> = {
    'accept-advisory': 'Starting session…',
    'accept-proposal': 'Starting session…',
    resume: 'Resuming…',
    'start-over': 'Starting over…',
    disconnect: 'Disconnecting…',
    finish: 'Finishing session…',
  };
  return (
    <div className="min-h-screen flex items-center justify-center bg-canvas-bg-subtle text-canvas-text">
      <div className="flex flex-col items-center gap-2">
        <p className="text-lg font-semibold">{labels[reason]}</p>
      </div>
    </div>
  );
}

const Shell = () => {
  const uniqueId = getPlayerId();
  // Do not mint hub sessionId here — boot must hydrate IndexedDB first
  // when a saved-session marker is present, or a remint poisons preferences.
  const [, setSessionId] = useState(() => loadState().identity.sessionId ?? '');

  const [activeTab, setActiveTabRaw] = useState<TabId>(() => {
    const saved = getSavedTab();
    if (saved === 'session') return 'game';
    const valid: TabId[] = ['wallet', 'hub', 'game', 'history', 'log'];
    return saved && valid.includes(saved as TabId) ? (saved as TabId) : 'wallet';
  });
  const setActiveTab = useCallback((tab: TabId) => {
    setActiveTabRaw(tab);
    saveActiveTab(tab);
  }, []);
  // Shell-level session lifecycle state and transition guard.
  const {
    state: shellState,
    dispatch: shellDispatch,
    runTransition,
    completeTransition,
    cancelTransition,
  } = useShellSessionTransition();
  const shellDispatchRef = useRef(shellDispatch);
  shellDispatchRef.current = shellDispatch;
  const sessionConfig = shellState.sessionConfig;
  const sessionConfigRef = useRef<GameSessionParams | null>(null);
  sessionConfigRef.current = sessionConfig;
  const [transactionPublishNerfed, setTransactionPublishNerfed] = useState(false);
  const peerConn = shellState.peerConn;
  const dashboardSessionModel = shellState.dashboardSessionModel;
  const dashboardSessionModelRef = useRef<SessionModel | null>(null);
  dashboardSessionModelRef.current = dashboardSessionModel;
  const [terminalPresentation, setTerminalPresentation] =
    useState<TerminalSessionPresentation | null>(null);
  const [finishedSessionIdentity, setFinishedSessionIdentity] = useState<{
    myName: string;
    opponentName?: string;
    iStarted: boolean;
  } | null>(null);
  const [cleanShutdownGraceActive, setCleanShutdownGraceActive] = useState(false);
  const cleanShutdownGraceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [abandonEnabled, setAbandonEnabled] = useState(false);
  const abandonEnabledRef = useRef(false);
  abandonEnabledRef.current = abandonEnabled;
  const abandonTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abandonPendingRef = useRef(false);
  const waitingEnteredAtRef = useRef<bigint | null>(null);
  const waitingStateRef = useRef<SessionModel['channel']['status']['state'] | null>(null);

  // Consent prompt state for the new hub protocol
  const pendingAdvisory = shellState.pendingAdvisory;
  const pendingAdvisoryRef = useRef<AdvisoryStartParams | null>(null);
  pendingAdvisoryRef.current = pendingAdvisory;
  const setPendingAdvisoryState = useCallback((next: AdvisoryStartParams | null) => {
    pendingAdvisoryRef.current = next;
    shellDispatchRef.current({ type: 'setPendingAdvisory', value: next });
  }, []);
  const pendingProposal = shellState.pendingProposal;
  const pendingProposalRef = useRef<PendingSessionProposal | null>(null);
  pendingProposalRef.current = pendingProposal;
  const setPendingProposalState = useCallback((next: PendingSessionProposal | null) => {
    pendingProposalRef.current = next;
    shellDispatchRef.current({ type: 'setPendingProposal', value: next });
  }, []);
  const peerSessionRef = useRef<PeerSession | null>(null);
  const peerMessageHandlerRef = useRef<import('../services/PeerSession').MessageHandler | null>(
    null,
  );

  const bindPeerMessageHandler = useCallback((ps: PeerSession | null) => {
    if (!ps || !peerMessageHandlerRef.current) return;
    ps.registerMessageHandler(peerMessageHandlerRef.current);
  }, []);

  // The dashboard pulls the protocol-state pretty-print on demand (when its
  // detail view is expanded) rather than having it pushed on every change. The
  // live session registers a getter here; the dashboard reads through it.
  const protocolStateGetterRef = useRef<(() => string | null) | null>(null);
  const handleProtocolStateProviderChange = useCallback((getter: (() => string | null) | null) => {
    protocolStateGetterRef.current = getter;
  }, []);
  const getProtocolState = useCallback(() => protocolStateGetterRef.current?.() ?? null, []);

  const coinsGetterRef = useRef<(() => CoinOfInterestEntry[]) | null>(null);
  const [frozenCoins, setFrozenCoins] = useState<CoinOfInterestEntry[]>([]);
  const handleCoinsProviderChange = useCallback((getter: (() => CoinOfInterestEntry[]) | null) => {
    coinsGetterRef.current = getter;
    if (getter) setFrozenCoins([]);
  }, []);
  const getCoins = useCallback(() => coinsGetterRef.current?.() ?? frozenCoins, [frozenCoins]);

  const setSessionConfig = useCallback((value: GameSessionParams | null) => {
    sessionConfigRef.current = value;
    shellDispatchRef.current({ type: 'setSessionConfig', value });
  }, []);

  const setPeerConn = useCallback((value: PeerConnectionResult | null) => {
    shellDispatchRef.current({ type: 'setPeerConn', value });
  }, []);

  const setDashboardSessionModel = useCallback(
    (value: SessionModel | null | ((prev: SessionModel | null) => SessionModel | null)) => {
      const next = typeof value === 'function' ? value(dashboardSessionModelRef.current) : value;
      dashboardSessionModelRef.current = next;
      shellDispatchRef.current({ type: 'setDashboardSessionModel', value: next });
    },
    [],
  );

  const setSessionPhase = useCallback((value: SessionPhase) => {
    shellDispatchRef.current({ type: 'setSessionPhase', value });
  }, []);

  const sessionPhase = shellState.sessionPhase;

  const setSessionError = useCallback((value: boolean) => {
    shellDispatchRef.current({ type: 'setSessionError', value });
  }, []);

  const sessionError = shellState.sessionError;

  const setRestoreStatus = useCallback((value: RestoreStatus) => {
    shellDispatchRef.current({ type: 'setRestoreStatus', value });
  }, []);

  const restoreStatus = shellState.restoreStatus;

  const setRestoreError = useCallback((value: string | null) => {
    shellDispatchRef.current({ type: 'setRestoreError', value });
  }, []);

  const restoreError = shellState.restoreError;

  const setRestoreHubReconciled = useCallback((value: boolean) => {
    shellDispatchRef.current({ type: 'setRestoreHubReconciled', value });
  }, []);

  const restoreHubReconciled = shellState.restoreHubReconciled;

  const stablePeerConn: PeerConnectionResult = useMemo(
    () => ({
      sendMessage: (n, m) => (peerSessionRef.current ?? IDLE_PEER_CONNECTION).sendMessage(n, m),
      sendAck: (n) => (peerSessionRef.current ?? IDLE_PEER_CONNECTION).sendAck(n),
      sendKeepalive: () => (peerSessionRef.current ?? IDLE_PEER_CONNECTION).sendKeepalive(),
      hostLog: (m) => (peerSessionRef.current ?? IDLE_PEER_CONNECTION).hostLog(m),
      close: () => (peerSessionRef.current ?? IDLE_PEER_CONNECTION).close(),
    }),
    [],
  );

  const [walletConnected, setWalletConnected] = useState(false);
  const [hubLiveness, setHubLiveness] = useState<HubLiveness | null>(null);
  const [peerLiveness, setPeerLiveness] = useState<PeerLiveness>(null);
  const [confirmDialog, setConfirmDialog] = useState<{
    title: string;
    body: string;
    confirmLabel?: string;
    onConfirm: () => void;
  } | null>(null);
  useEffect(() => {
    setTransactionPublishNerfed(isTransactionPublishNerfed());
    return subscribeTransactionPublishNerfed(setTransactionPublishNerfed);
  }, []);
  const toggleTransactionPublishNerf = useCallback(() => {
    if (isTransactionPublishNerfed()) {
      setTransactionPublishNerf(false);
      setTransactionPublishNerfed(false);
      return;
    }
    setConfirmDialog({
      title: 'Nerf transaction publishing?',
      body: 'Dropping transaction publications can leave your game unresolved and may cause you to lose money.',
      confirmLabel: 'Enable nerfing',
      onConfirm: () => {
        setTransactionPublishNerf(true);
        setTransactionPublishNerfed(true);
        setConfirmDialog(null);
      },
    });
  }, []);
  const hubWsUpRef = useRef(false);
  const lastHubActivityRef = useRef(0);
  // --- Boot state machine ---
  //
  // The boot initializer NEVER claims the lease. Claiming the lease writes
  // to localStorage, which fences any existing tab via the storage event.
  // We must not do that until the user has made a conscious choice.
  //
  //   1. Anything to resume or discard (marker, wallet choice, and/or
  //      remembered hub) → 'resumeDialog', or 'autoResuming' when the
  //      prior navigation was a stale-deploy reload (one-shot, no prompt).
  //   2. Otherwise if another tab holds the lease → 'tabConflict'
  //      (the other tab is live even if we don't have its save locally);
  //      otherwise claim the lease and go 'ready'.
  //
  // From 'resumeDialog':
  //   - Start over → hardReset() + reload.
  //   - Resume     → load IndexedDB, then if lease conflict, 'tabConflict';
  //                  otherwise claim + hydrate.
  // From 'autoResuming':
  //   - Hydrate + mount the real shell invisibly (hub/GameSession run).
  //   - Flip to 'ready' only once restore is presentable — one visible paint.
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
    | { kind: 'autoResuming' }
    | { kind: 'resumeDialog'; loadError: string | null }
    | { kind: 'tabConflict'; save: SessionSave | null; midSession: boolean }
    | { kind: 'tabDead' };

  const [bootState, setBootState] = useState<BootState>(() => {
    // Decide auto-resume synchronously so the first paint never flashes the
    // Resume/Start Over dialog (async boot used to clear the flag then remount
    // into resumeDialog under Strict Mode).
    if (peekAutoResumeOnce() && shouldOfferResumeOrStartOver()) {
      return { kind: 'autoResuming' };
    }
    return { kind: 'loading' };
  });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // Restore hub session_id from disk before any mint / identify.
      const sid = await ensureHubIdentity();
      if (cancelled) return;
      setSessionId(sid);

      if (shouldOfferResumeOrStartOver()) {
        // Hydrate IndexedDB into the in-memory cache immediately so incidental
        // saveSession patches (logs, alerts) cannot clobber the durable cradle
        // while the dialog is open (or while auto-resume runs).
        await hydrateSessionCacheFromDisk();
        if (cancelled) return;
        markSavedSession();
        if (peekAutoResumeOnce()) {
          setBootState({ kind: 'autoResuming' });
          return;
        }
        setBootState({ kind: 'resumeDialog', loadError: null });
        return;
      }
      if (isLeaseConflict()) {
        setBootState({ kind: 'tabConflict', save: null, midSession: false });
        return;
      }
      claimLease();
      setBootState({ kind: 'ready' });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Subscribe to mid-session lease loss. Only meaningful once we're 'ready' —
  // if we're still in a dialog, we haven't claimed the lease yet.
  useEffect(() => {
    const handler = () => {
      hubConnRef.current?.disconnect();
      hubConnRef.current = null;
      // Drop the hub iframe immediately so its reconnect loop stops now,
      // not only after the async peekSession → tabConflict re-render.
      setIframeUrl('about:blank');
      setHubOrigin(null);
      setHubLiveness(null);
      if (blockchainTypeRef.current !== 'walletconnect') {
        activeBlockchainRef.current?.disconnect().catch(() => {});
      }
      deactivate();
      activeBlockchainRef.current = null;
      setActiveBlockchainPoller(null);
      void peekSession().then((save) => {
        setBootState((prev) =>
          prev.kind === 'ready' ? { kind: 'tabConflict', save, midSession: true } : prev,
        );
      });
    };
    onFenced(handler);
    return () => {
      offFenced(handler);
    };
  }, []);

  // Close WebSocket connections on page unload/reload so the browser doesn't
  // leave stale TCP sockets that block new connections in the reloaded page.
  useEffect(() => {
    const cleanup = () => {
      hubConnRef.current?.disconnect();
      // WalletConnect sessions are intentionally durable across reloads.
      // Calling disconnect() here sends a protocol-level session_delete.
      if (blockchainTypeRef.current !== 'walletconnect') {
        activeBlockchainRef.current?.disconnect().catch(() => {});
      }
    };
    window.addEventListener('beforeunload', cleanup);
    return () => {
      window.removeEventListener('beforeunload', cleanup);
    };
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
        patchLiveSessionPresentation({ waitingStateEnteredAt: now });
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
        patchLiveSessionPresentation({ waitingStateEnteredAt: null });
      }
      setAbandonEnabled(false);
    }
  }, [channelState]);

  const [history, setHistory] = useState<string[]>([]);
  const [logLines, setLogLines] = useState<string[]>([]);

  const [unreadGame, setUnreadGameRaw] = useState(() => getSavedUnreadGame());
  const setUnreadGame = useCallback((v: boolean) => {
    setUnreadGameRaw(v);
    saveUnreadGame(v);
  }, []);
  const [walletAlert, setWalletAlertRaw] = useState(() => getSavedWalletAlert());
  const setWalletAlert = useCallback((v: boolean) => {
    setWalletAlertRaw(v);
    saveWalletAlert(v);
  }, []);
  const [hubAlert, setHubAlertRaw] = useState(() => getSavedHubAlert());
  const setHubAlert = useCallback((v: boolean) => {
    setHubAlertRaw(v);
    saveHubAlert(v);
  }, []);
  const [iframeUrl, setIframeUrl] = useState('about:blank');
  const [balance, setBalance] = useState<bigint | undefined>();

  const [blockchainType, setBlockchainType] = useState<'simulator' | 'walletconnect' | undefined>(
    () => getBlockchainType(),
  );
  const blockchainTypeRef = useRef<'simulator' | 'walletconnect' | undefined>(blockchainType);
  const activeBlockchainRef = useRef<InternalBlockchainInterface | null>(null);
  const [activeBlockchainPoller, setActiveBlockchainPoller] = useState<BlockchainPoller | null>(
    null,
  );

  useEffect(() => {
    blockchainTypeRef.current = blockchainType;
  }, [blockchainType]);

  // Mirror walletConnected into a ref so presence callbacks (getPresence,
  // session cleanup, phase change) can report busy while walletless without
  // re-subscribing. Disconnect/connect paths also set this synchronously so an
  // immediate setBusy is accurate before the effect runs.
  const walletConnectedRef = useRef(walletConnected);
  useEffect(() => {
    walletConnectedRef.current = walletConnected;
  }, [walletConnected]);

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

  const parseFeeInput = useCallback(
    (raw: string): bigint | null => {
      if (/^\s*$/.test(raw)) return 0n;
      const trimmed = raw.trim();
      if (feeUnit === 'xch') {
        if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
        const [whole, frac = ''] = trimmed.split('.');
        if (frac.length > 12) return null;
        const mojoStr = whole + frac.padEnd(12, '0');
        try {
          const mojos = BigInt(mojoStr);
          return mojos < 0n ? null : mojos;
        } catch {
          return null;
        }
      }
      if (!/^\d+$/.test(trimmed)) return null;
      try {
        const n = BigInt(trimmed);
        return n < 0n ? null : n;
      } catch {
        return null;
      }
    },
    [feeUnit],
  );

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

  const handleFeeUnitChange = useCallback(
    (unit: 'mojo' | 'xch') => {
      setFeeUnit(unit);
      saveFeeUnit(unit);
      if (feeEditing) {
        const currentMojos = parseFeeInput(feeInput);
        if (currentMojos !== null) {
          setFeeInput(unit === 'xch' ? mojosToXchStr(currentMojos) : String(currentMojos));
        }
      }
    },
    [feeEditing, feeInput, parseFeeInput],
  );

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

  const hubConnRef = useRef<HubConnection | null>(null);
  const activeTabRef = useRef<TabId>(activeTab);
  activeTabRef.current = activeTab;
  const sessionSaveRef = useRef<SessionSave | null>(null);
  /** Stable prop-safe save — recomputing every render deep-clones and can OOM. */
  const sessionSavePropRef = useRef<SessionSave | undefined>(undefined);
  const historyRef = useRef<string[]>(history);
  const logLinesRef = useRef<string[]>(logLines);
  historyRef.current = history;
  logLinesRef.current = logLines;
  const sessionStartedRef = useRef(false);
  const sessionFinishedCleanupRef = useRef(false);
  const sessionPhaseRef = useRef<SessionPhase>('none');
  sessionPhaseRef.current = sessionPhase;
  /** Bumped on cancel so in-flight startFreshSessionWithPeer aborts after awaits. */
  const sessionStartEpochRef = useRef(0);

  const deferStateUpdate = useCallback((fn: () => void) => {
    if (typeof queueMicrotask === 'function') {
      queueMicrotask(fn);
    } else {
      setTimeout(fn, 0);
    }
  }, []);

  const appendHistory = useCallback(
    (line: string) => {
      deferStateUpdate(() => {
        const next = appendRecent(historyRef.current, line, HUMAN_HISTORY_LIMIT);
        historyRef.current = next;
        setHistory(next);
        saveSession({ scope: 'common', history: { humanHistory: next } });
      });
    },
    [deferStateUpdate],
  );

  const clearSessionPreservingHistory = useCallback(() => {
    const humanHistory = historyRef.current;
    const diagnosticLog = loadState().history.diagnosticLog;
    const wasmNotificationHistory = loadState().history.wasmNotificationHistory;
    clearSession();
    if (humanHistory.length > 0 || diagnosticLog || wasmNotificationHistory) {
      saveSession({
        scope: 'common',
        history: { humanHistory, diagnosticLog, wasmNotificationHistory },
      });
    }
  }, []);

  const syncPeerLiveness = useCallback(() => {
    setPeerLiveness(peerSessionRef.current?.liveness ?? null);
  }, []);

  const markPeerInactive = useCallback(() => {
    peerSessionRef.current?.markInactive();
    syncPeerLiveness();
  }, [syncPeerLiveness]);

  const markPeerDead = useCallback(() => {
    peerSessionRef.current?.markDead();
    syncPeerLiveness();
  }, [syncPeerLiveness]);

  const registerMessageHandler = useCallback(
    (
      handler: (msgno: number, msg: Uint8Array) => void,
      ackHandler: (ack: number) => void,
      keepaliveHandler: () => void,
    ) => {
      peerMessageHandlerRef.current = { handler, ackHandler, keepaliveHandler };
      bindPeerMessageHandler(peerSessionRef.current);
    },
    [bindPeerMessageHandler],
  );

  const isAvailableForNewSessionPrompt = useCallback(() => {
    const phase = sessionPhaseRef.current;
    return (
      walletConnectedRef.current &&
      (phase === 'none' || phase === 'resolved') &&
      pendingAdvisoryRef.current === null &&
      pendingProposalRef.current === null &&
      peerSessionRef.current === null &&
      !(
        (sessionSaveRef.current?.phase === 'live' ||
          sessionSaveRef.current?.phase === 'pre-handshake') &&
        sessionSaveRef.current.pairing.peerId
      )
    );
  }, []);

  const sendSessionReject = useCallback((peerId: string) => {
    hubConnRef.current?.sendPeerAppMessage(peerId, { type: 'session_reject' });
  }, []);

  const resetPeerRelayState = useCallback((options?: { persistSession?: boolean }) => {
    peerSessionRef.current?.destroy();
    peerSessionRef.current = null;
    peerMessageHandlerRef.current = null;
    if (options?.persistSession !== false) {
      clearSessionPairing();
    }
    setPeerLiveness(null);
  }, []);

  const cancelAttemptedSession = useCallback(
    (options?: { error?: boolean }) => {
      sessionStartEpochRef.current += 1;
      abandonPendingRef.current = false;
      setPendingAdvisoryState(null);
      setPendingProposalState(null);
      resetPeerRelayState();
      destroySessionController();
      clearSessionPreservingHistory();
      try {
        getActiveBlockchain().stop();
      } catch {
        /* not connected */
      }
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
      setSessionError(!!options?.error);
      setSessionConfig(null);
      setPeerConn(null);
      dashboardSessionModelRef.current = null;
      setDashboardSessionModel(null);
      setTerminalPresentation(null);
      setRestoreStatus('idle');
      setRestoreError(null);
      setRestoreHubReconciled(false);
      cancelTransition();
      hubConnRef.current?.setBusy(shouldReportHubBusy('none', walletConnectedRef.current));
    },
    [
      cancelTransition,
      clearSessionPreservingHistory,
      resetPeerRelayState,
      setPendingAdvisoryState,
      setPendingProposalState,
      setDashboardSessionModel,
      setPeerConn,
      setRestoreError,
      setRestoreHubReconciled,
      setRestoreStatus,
      setSessionConfig,
      setSessionError,
      setSessionPhase,
    ],
  );

  const startFreshSessionWithPeer = useCallback(
    async (
      request: SessionStartRequest & {
        gameSessionId?: string;
        pairingToken: string;
      },
    ) => {
      try {
        const conn = hubConnRef.current;
        if (!conn) throw new Error('hub connection unavailable during session start');
        const epoch = sessionStartEpochRef.current;
        const myContribution = parseSessionAmount(request.myAmount);
        const theirContribution = parseSessionAmount(request.theirAmount);
        const minContribution =
          myContribution < theirContribution ? myContribution : theirContribution;
        const perGame = minContribution / 10n || 1n;
        const sessionId = request.gameSessionId ?? generateSessionId();
        const token = request.pairingToken;
        const hubSessionId = getSessionId();

        const existing = peerSessionRef.current;
        if (
          existing &&
          !existing.isDestroyed() &&
          existing.peerId === request.peerId &&
          existing.sessionId === sessionId
        ) {
          // Reuse provisional PeerSession created when the proposal arrived (preserves buffered messages).
        } else {
          existing?.destroy();
          peerSessionRef.current = new PeerSession(request.peerId, sessionId, conn);
          bindPeerMessageHandler(peerSessionRef.current);
        }
        const channelTimeout = parseOptionalBigInt(request.channel_timeout);
        const unrollTimeout = parseOptionalBigInt(request.unroll_timeout);
        const diagnosticLog = loadState().history.diagnosticLog;
        const wasmNotificationHistory = loadState().history.wasmNotificationHistory;

        const outcome = await transitionToFreshSession({
          reportBusy: () => conn.setBusy(true),
          shouldAbort: () => epoch !== sessionStartEpochRef.current,
          retireTerminalDisplay: () => {
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
            setRestoreHubReconciled(true);
            dashboardSessionModelRef.current = null;
            setDashboardSessionModel(null);
            setTerminalPresentation(null);
            setSessionConfig(null);
            setPeerConn(null);
            destroySessionController();
          },
          persistLiveCheckpoint: async () => {
            // Atomically replace the terminal envelope with the full pre-cradle
            // handshake before GameSession mounts and fetches hex assets. A
            // stale-deploy reload mid-fetch must Resume with the same
            // pairing/amounts/peer ids and hub session_id.
            await replaceSession({
              pairing: {
                token,
                peerId: request.peerId,
                gameSessionId: sessionId,
                iStarted: request.iStarted,
                myContribution: myContribution.toString(),
                theirContribution: theirContribution.toString(),
                perGameAmount: perGame.toString(),
                opponentAlias: request.opponentAlias,
                ...(channelTimeout !== undefined
                  ? { channelTimeout: channelTimeout.toString() }
                  : {}),
                ...(unrollTimeout !== undefined ? { unrollTimeout: unrollTimeout.toString() } : {}),
              },
              identity: {
                sessionId: hubSessionId,
                ...(conn.getPlayerId() ? { myHubPlayerId: conn.getPlayerId()! } : {}),
              },
              history: {
                ...(historyRef.current.length > 0 ? { humanHistory: historyRef.current } : {}),
                ...(diagnosticLog && diagnosticLog.length > 0 ? { diagnosticLog } : {}),
                ...(wasmNotificationHistory && wasmNotificationHistory.length > 0
                  ? { wasmNotificationHistory }
                  : {}),
              },
            });
            // Cancel can interleave after replaceSession's awaits and still leave
            // a durable pre-handshake checkpoint on the write chain. Drop it.
            if (epoch !== sessionStartEpochRef.current) {
              clearSessionPreservingHistory();
            }
          },
          mountLiveSession: () => {
            if (epoch !== sessionStartEpochRef.current) {
              log(
                `[Shell] startFreshSessionWithPeer aborted: cancelled during persist peer=${request.peerId}`,
              );
              return;
            }
            try {
              getActiveBlockchain().start();
            } catch {
              /* not connected */
            }
            setSessionConfig({
              iStarted: request.iStarted,
              myContribution,
              theirContribution,
              perGameAmount: perGame,
              restoring: false,
              pairingToken: token,
              myAlias: undefined,
              opponentAlias: request.opponentAlias,
              channelTimeout,
              unrollTimeout,
            });
            setPeerConn(stablePeerConn);
            setPeerLiveness(null);
          },
        });
        if (outcome === 'aborted') {
          log(
            `[Shell] startFreshSessionWithPeer aborted: cancelled after persist peer=${request.peerId}`,
          );
          return;
        }
      } catch (error) {
        console.error('[Shell] session start failed', error);
        sendSessionReject(request.peerId);
        cancelAttemptedSession({ error: true });
      }
    },
    [
      stablePeerConn,
      bindPeerMessageHandler,
      cancelAttemptedSession,
      clearSessionPreservingHistory,
      sendSessionReject,
      setDashboardSessionModel,
      setPeerConn,
      setRestoreError,
      setRestoreHubReconciled,
      setRestoreStatus,
      setSessionConfig,
      setSessionError,
      setSessionPhase,
    ],
  );

  const acceptPendingAdvisory = useCallback(
    (advisory: AdvisoryStartParams) => {
      const conn = hubConnRef.current;
      if (!conn || pendingAdvisoryRef.current !== advisory) return;
      const pairingToken = `peer_${advisory.peer_id}_${Date.now()}`;
      void runTransition(
        'accept-advisory',
        async () => {
          setPendingAdvisoryState(null);
          const gameSessionId = generateSessionId();
          // Reserve the peer relay before sending so a delivery_failure for this
          // proposal can cancel the attempt (PeerSession must already exist).
          peerSessionRef.current?.destroy();
          peerSessionRef.current = new PeerSession(advisory.peer_id, gameSessionId, conn);
          bindPeerMessageHandler(peerSessionRef.current);
          conn.sendPeerAppMessage(advisory.peer_id, {
            type: 'session_proposal',
            proposer_amount: advisory.my_amount,
            responder_amount: advisory.their_amount,
            // Hub-synced alias only — never getAlias(), which invents Player_*.
            from_alias: peekAlias(),
            channel_timeout: advisory.channel_timeout,
            unroll_timeout: advisory.unroll_timeout,
            game_session_id: gameSessionId,
          });
          await startFreshSessionWithPeer({
            peerId: advisory.peer_id,
            opponentAlias: advisory.peer_alias,
            myAmount: advisory.my_amount,
            theirAmount: advisory.their_amount,
            channel_timeout: advisory.channel_timeout,
            unroll_timeout: advisory.unroll_timeout,
            iStarted: true,
            gameSessionId,
            pairingToken,
          });
        },
        { scope: 'session-pane', waitForReady: true, readyKey: pairingToken },
      );
    },
    [runTransition, setPendingAdvisoryState, startFreshSessionWithPeer, bindPeerMessageHandler],
  );

  const declinePendingAdvisory = useCallback(
    (advisory: AdvisoryStartParams) => {
      setPendingAdvisoryState(null);
      sendSessionReject(advisory.peer_id);
    },
    [sendSessionReject, setPendingAdvisoryState],
  );

  const acceptPendingProposal = useCallback(
    (proposal: PendingSessionProposal) => {
      if (pendingProposalRef.current !== proposal) return;
      const pairingToken = `peer_${proposal.from_id}_${Date.now()}`;
      void runTransition(
        'accept-proposal',
        async () => {
          setPendingProposalState(null);
          await startFreshSessionWithPeer({
            peerId: proposal.from_id,
            opponentAlias: proposal.from_alias,
            myAmount: proposal.responder_amount,
            theirAmount: proposal.proposer_amount,
            channel_timeout: proposal.channel_timeout,
            unroll_timeout: proposal.unroll_timeout,
            iStarted: false,
            gameSessionId: proposal.game_session_id,
            pairingToken,
          });
        },
        { scope: 'session-pane', waitForReady: true, readyKey: pairingToken },
      );
    },
    [runTransition, setPendingProposalState, startFreshSessionWithPeer],
  );

  const declinePendingProposal = useCallback(
    (proposal: PendingSessionProposal) => {
      setPendingProposalState(null);
      resetPeerRelayState();
      sendSessionReject(proposal.from_id);
    },
    [resetPeerRelayState, sendSessionReject, setPendingProposalState],
  );

  useEffect(() => {
    return subscribeLog((line) => {
      deferStateUpdate(() => {
        const next = appendRecent(logLinesRef.current, line, DIAGNOSTIC_LOG_LIMIT);
        logLinesRef.current = next;
        setLogLines(next);
        saveSession({ scope: 'common', history: { diagnosticLog: next } });
      });
    });
  }, [deferStateUpdate]);

  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now();
      const activityFresh =
        lastHubActivityRef.current > 0 && now - lastHubActivityRef.current <= 45_000;
      setHubLiveness((prev) => {
        if (prev === null || prev === 'disconnected') return prev;
        if (!hubWsUpRef.current) return 'reconnecting';
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

  // Balance polling
  const stopBalancePolling = useCallback(() => {
    try {
      getActiveBlockchain().stopBalanceInterest();
    } catch {
      // blockchain not set yet
    }
  }, []);

  const startBalancePolling = useCallback(
    (_bcType: 'simulator' | 'walletconnect') => {
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
    },
    [stopBalancePolling],
  );

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
      width: 250,
      margin: 2,
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
        walletConnectedRef.current = true;
        // Wallet reconnected: recompute presence (phase + restore cradle) so the
        // walletless busy override is lifted once we can fund/resolve again —
        // but stay busy mid-resume while phase is still none.
        hubConnRef.current?.setBusy(
          hubBusyFromSessionState(
            sessionPhaseRef.current,
            true,
            !!sessionConfigRef.current?.restoring,
            sessionSaveRef.current,
          ),
          sessionConfigRef.current?.myAlias ?? savedMyAlias(sessionSaveRef.current) ?? peekAlias(),
        );
        const poller = activeBlockchainPoller;
        if (poller && sessionController) {
          sessionController.attachBlockchain(poller);
        }
        if (blockchainTypeRef.current) {
          startBalancePolling(blockchainTypeRef.current);
        }
      } else {
        setWalletConnected(false);
        walletConnectedRef.current = false;
        // Wallet dropped mid-session (not a user disconnect): stay on the hub
        // but advertise busy so the lobby will not offer new matches.
        hubConnRef.current?.setBusy(
          shouldReportHubBusy(sessionPhaseRef.current, false),
          sessionConfigRef.current?.myAlias ?? savedMyAlias(sessionSaveRef.current) ?? peekAlias(),
        );
      }
    });
  }, [activeBlockchainPoller, blockchainType, setWalletAlert, startBalancePolling]);

  const [hubOrigin, setHubOrigin] = useState<string | null>(null);
  const [hubConnectionError, setHubConnectionError] = useState<string | null>(null);

  // Connect to a hub by origin URL. Creates the hub iframe + game relay WebSocket.
  const connectToHub = useCallback(
    (rawOrigin: string, options: { resetSession?: boolean } = {}) => {
      const origin = normalizeHubOrigin(rawOrigin);
      hubConnRef.current?.disconnect();
      hubConnRef.current = null;
      setHubConnectionError(null);
      if (options.resetSession) {
        clearSessionId();
      }
      const hubSessionId = getSessionId();
      setSessionId(hubSessionId);

      setHubOrigin(origin);
      saveHubUrl(origin);
      const hubUrl = `${origin}/?session=${hubSessionId}&uniqueId=${uniqueId}`;
      setIframeUrl(hubUrl);

      setHubLiveness('reconnecting');

      let conn: HubConnection;
      try {
        conn = new HubConnection(origin, hubSessionId, {
          onAdvisoryStart: (params: AdvisoryStartParams) => {
            hubWsUpRef.current = true;
            lastHubActivityRef.current = Date.now();
            setHubLiveness('connected');
            // Hub advisory while we are already mid-matchmaking/session: ignore.
            // Do not session_reject the peer — advisory is not a peer request.
            if (!isAvailableForNewSessionPrompt()) {
              log(
                `[Shell] advisory_start ignored: unavailable peer=${params.peer_id} phase=${sessionPhaseRef.current}`,
              );
              return;
            }
            if (
              !isValidTimeoutString(params.channel_timeout) ||
              !isValidTimeoutString(params.unroll_timeout)
            ) {
              log(`[Shell] advisory_start ignored: invalid timeouts peer=${params.peer_id}`);
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
            if (msg.type === 'session_proposal') {
              const peerAlias = fromAlias || msg.from_alias || fromId;
              if (!isAvailableForNewSessionPrompt()) {
                log(
                  `[Shell] session_reject to=${fromId}: proposal while unavailable phase=${sessionPhaseRef.current}`,
                );
                sendSessionReject(fromId);
                return;
              }
              if (
                !isValidTimeoutString(msg.channel_timeout) ||
                !isValidTimeoutString(msg.unroll_timeout)
              ) {
                log(`[Shell] session_reject to=${fromId}: proposal invalid timeouts`);
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
              if (ps?.peerId === fromId) {
                log(`[Shell] session_reject from=${fromId}: cancelling attempted session`);
                markPeerDead();
                const channelState = dashboardSessionModelRef.current?.channel.status.state;
                if (
                  shouldCancelOnPeerUnreachable(
                    sessionPhaseRef.current,
                    channelState,
                    abandonPendingRef.current,
                  )
                ) {
                  cancelAttemptedSession({ error: true });
                }
              }
            }
          },
          onDeliveryFailure: (to: string) => {
            console.warn('[Shell] delivery_failure to=%s', to);
            const ps = peerSessionRef.current;
            if (!ps || to !== ps.peerId) return;
            const channelState = dashboardSessionModelRef.current?.channel.status.state;
            if (
              shouldCancelOnPeerUnreachable(
                sessionPhaseRef.current,
                channelState,
                abandonPendingRef.current,
              )
            ) {
              // Matchmaking / channel setup: abandon the attempt.
              markPeerDead();
              cancelAttemptedSession();
              return;
            }
            // Live or settling session: peer may be mid-reload. Degrade only —
            // CONNECTIVITY: delivery failures do not auto-kill or go on-chain.
            // notePeerActivity recovers when traffic resumes.
            ps.markDegraded();
            syncPeerLiveness();
          },
          onRegistered: (playerId: string) => {
            hubWsUpRef.current = true;
            lastHubActivityRef.current = Date.now();
            setHubLiveness('connected');
            const save = sessionSaveRef.current;
            const pairing =
              save?.phase === 'live' || save?.phase === 'pre-handshake' ? save.pairing : undefined;
            const prevMine = save?.identity.myHubPlayerId ?? loadState().identity.myHubPlayerId;
            // Pre-cradle routing is by peer player_id. If *we* remapped (hub
            // restart or session_id churn), abort rather than handshaking at a
            // stale sessionPeerId. First-ever register (no prior id) is fine.
            if (
              prevMine &&
              prevMine !== playerId &&
              (pairing?.token || sessionConfigRef.current?.pairingToken) &&
              save?.phase !== 'live' &&
              shouldCancelOnPeerUnreachable(
                sessionPhaseRef.current,
                dashboardSessionModelRef.current?.channel.status.state,
                abandonPendingRef.current,
              )
            ) {
              console.warn(
                '[Shell] hub player_id remapped during pre-cradle handshake (%s → %s); rematch required',
                prevMine,
                playerId,
              );
              log(
                `[hub] player_id remapped during pre-cradle handshake (${prevMine} → ${playerId}); rematch required`,
              );
              saveSession({ scope: 'common', identity: { myHubPlayerId: playerId } });
              cancelAttemptedSession();
              return;
            }
            saveSession({ scope: 'common', identity: { myHubPlayerId: playerId } });
            if (save) save.identity.myHubPlayerId = playerId;
            const terminalSave = !!save && isTerminalSavedChannel(save);
            if (!peerSessionRef.current && pairing?.peerId && conn) {
              peerSessionRef.current = new PeerSession(
                pairing.peerId,
                pairing.gameSessionId ?? generateSessionId(),
                conn,
              );
              bindPeerMessageHandler(peerSessionRef.current);
              setRestoreHubReconciled(true);
              // Restore never goes through startFreshSessionWithPeer, which is
              // otherwise the only place that marks the hub busy. Terminal
              // (Failed/Resolved*) saves stay available — unless the wallet is
              // gone, in which case we cannot play and must report busy.
              conn.setBusy(
                !terminalSave || !walletConnectedRef.current,
                pairing.myAlias ?? peekAlias(),
              );
            } else if (save?.phase === 'live' || save?.phase === 'pre-handshake') {
              setRestoreHubReconciled(true);
              conn.setBusy(
                !terminalSave || !walletConnectedRef.current,
                pairing?.myAlias ?? peekAlias(),
              );
            }
            if (peerSessionRef.current && sessionController) {
              sessionController.resendUnacked();
            }
          },
          onHubAttention: () => {
            if (activeTabRef.current !== 'hub') {
              setHubAlert(true);
            }
          },
          onClosed: () => {
            hubWsUpRef.current = false;
            markPeerInactive();
            setHubLiveness('disconnected');
            setHubConnectionError(`Unable to connect to hub at ${origin}.`);
          },
          onHubDisconnected: () => {
            hubWsUpRef.current = false;
            setHubLiveness('reconnecting');
          },
          onHubReconnected: () => {
            hubWsUpRef.current = true;
            lastHubActivityRef.current = Date.now();
            setHubLiveness('connected');
            // Retry outbound/acks that failed while the hub WS was down.
            sessionController?.resendUnacked();
          },
          onHubActivity: () => {
            lastHubActivityRef.current = Date.now();
          },
          getPresence: () => {
            const save = sessionSaveRef.current;
            // A leftover cradle must not keep us busy after the session resolved
            // (wallet/handshake failures often leave Failed + persisted cradle).
            return {
              busy: hubBusyFromSessionState(
                sessionPhaseRef.current,
                walletConnectedRef.current,
                !!sessionConfigRef.current?.restoring,
                save,
              ),
              // Prefer session aliases, then the hub-synced prefs alias. Never call
              // getAlias() here — inventing Player_* would pollute identify/set_busy.
              alias: sessionConfigRef.current?.myAlias ?? savedMyAlias(save) ?? peekAlias(),
            };
          },
        });
      } catch (err) {
        console.error('[Shell] HubConnection failed for origin=%s', origin, err);
        saveHubUrl(undefined);
        setHubOrigin(null);
        setIframeUrl('about:blank');
        setHubLiveness(null);
        setHubConnectionError(
          err instanceof Error ? err.message : `Unable to connect to hub at ${origin}.`,
        );
        return;
      }
      hubConnRef.current = conn;
    },
    [
      uniqueId,
      syncPeerLiveness,
      markPeerInactive,
      markPeerDead,
      cancelAttemptedSession,
      isAvailableForNewSessionPrompt,
      sendSessionReject,
      setPendingAdvisoryState,
      setPendingProposalState,
      bindPeerMessageHandler,
      setActiveTab,
      setHubAlert,
      setRestoreHubReconciled,
    ],
  );

  const requestHubConnect = useCallback(
    (origin: string) => {
      if (
        (peerLiveness === 'connected' || peerLiveness === 'degraded') &&
        sessionPhase === 'off-chain'
      ) {
        setConfirmDialog({
          title: 'Disconnect from hub?',
          body: 'Disconnecting from this hub will end your peer connection. Your game stays off-chain — resolve it on-chain from the dashboard if needed.',
          onConfirm: () => {
            setConfirmDialog(null);
            connectToHub(origin, { resetSession: true });
          },
        });
      } else if (peerLiveness === 'connected' || peerLiveness === 'degraded') {
        setConfirmDialog({
          title: 'Disconnect from hub?',
          body: 'This will end your peer connection.',
          onConfirm: () => {
            setConfirmDialog(null);
            connectToHub(origin, { resetSession: true });
          },
        });
      } else {
        connectToHub(origin, { resetSession: true });
      }
    },
    [peerLiveness, sessionPhase, connectToHub],
  );

  // Auto-connect to saved hub once this tab owns the app lease. Also while
  // autoResuming (blank UI) so cradle restore can reconcile before first paint.
  useEffect(() => {
    if (bootState.kind !== 'ready' && bootState.kind !== 'autoResuming') {
      hubConnRef.current?.disconnect();
      hubConnRef.current = null;
      return;
    }
    const url = getHubUrl();
    if (url && !hubConnRef.current) {
      connectToHub(url);
    }
    return () => {
      hubConnRef.current?.disconnect();
      hubConnRef.current = null;
    };
  }, [bootState.kind, connectToHub]);

  // Shared connection completion
  const completeConnection = useCallback(
    (
      iface: InternalBlockchainInterface,
      bcType: 'simulator' | 'walletconnect',
      pollMs: number,
      options: { switchToHub?: boolean } = {},
    ) => {
      deactivate();
      const poller = activate(iface, pollMs);
      // Pre-game wallet connection: force Resume/Start Over on reload even
      // before a cradle exists. Preference writes must not clear this marker.
      markSavedSession();
      saveSession({ scope: 'common', preferences: { blockchainType: bcType } });
      activeBlockchainRef.current = iface;
      setActiveBlockchainPoller(poller);
      setBlockchainType(bcType);
      setWalletConnected(true);
      walletConnectedRef.current = true;
      setConnecting(false);
      setConnectionSetup(null);
      if (options.switchToHub) {
        setActiveTab('hub');
      }
      // Wallet is back: drop the walletless busy override and recompute presence
      // from phase + any in-progress non-terminal restore cradle (phase alone is
      // often still `none` mid-resume).
      hubConnRef.current?.setBusy(
        hubBusyFromSessionState(
          sessionPhaseRef.current,
          true,
          !!sessionConfigRef.current?.restoring,
          sessionSaveRef.current,
        ),
        sessionConfigRef.current?.myAlias ?? savedMyAlias(sessionSaveRef.current) ?? peekAlias(),
      );
      startBalancePolling(bcType);
      log(`${bcType} wallet connected`);
    },
    [startBalancePolling, setConnecting, setActiveTab],
  );

  // --- Unified connection flow ---
  // silent: skip the modal on reconnect (e.g. auto-reconnect after completed connection)
  // fresh: wipe stale WC storage before connecting (user explicitly starting a new pairing)
  const handleConnect = useCallback(
    async (bcType: 'simulator' | 'walletconnect', silent = false, fresh = false) => {
      log(`[Shell] handleConnect: bcType=${bcType} silent=${silent} fresh=${fresh}`);
      wcAbortRef.current = false;
      const { iface, pollMs } = getInterface(bcType);
      try {
        markSavedSession();
        saveSession({ scope: 'common', preferences: { blockchainType: bcType } });
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
        completeConnection(iface, bcType, pollMs, { switchToHub: !silent });
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
    },
    [uniqueId, clearSessionPreservingHistory, completeConnection, setConnecting, setWalletAlert],
  );

  const handleFinalize = useCallback(async () => {
    if (!connectionSetup || !blockchainType) return;
    log(`[Shell] handleFinalize: bcType=${blockchainType}`);
    const { iface, pollMs } = getInterface(blockchainType);
    setConnecting(true);
    try {
      await connectionSetup.finalize();
      log(`[Shell] handleFinalize: finalize complete`);
      setShowSimModal(false);
      completeConnection(iface, blockchainType, pollMs, { switchToHub: true });
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
      try {
        await activeBlockchainRef.current.disconnect();
      } catch {
        /* ignore */
      }
    } else if (blockchainType) {
      const { iface } = getInterface(blockchainType);
      try {
        await iface.disconnect();
      } catch {
        /* ignore */
      }
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
  }, [deferStateUpdate, setUnreadGame]);

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

  const cancelDashboardSession = useCallback(
    (options?: { retainFinishedGuard?: boolean }) => {
      sessionStartEpochRef.current += 1;
      abandonPendingRef.current = false;
      const alias =
        sessionConfigRef.current?.myAlias ?? savedMyAlias(sessionSaveRef.current) ?? peekAlias();
      const saved = sessionSaveRef.current;
      const peerId =
        peerSessionRef.current?.peerId ??
        (saved?.phase === 'live' || saved?.phase === 'pre-handshake'
          ? saved.pairing.peerId
          : undefined);
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
      setTerminalPresentation(null);
      setRestoreStatus('idle');
      setRestoreError(null);
      setRestoreHubReconciled(false);
      setPendingAdvisoryState(null);
      setPendingProposalState(null);
      cancelTransition();
      hubConnRef.current?.setBusy(shouldReportHubBusy('none', walletConnectedRef.current), alias);
    },
    [
      cancelTransition,
      clearSessionPreservingHistory,
      clearSessionTimers,
      resetPeerRelayState,
      sendSessionReject,
      setPendingAdvisoryState,
      setPendingProposalState,
      setDashboardSessionModel,
      setPeerConn,
      setRestoreError,
      setRestoreHubReconciled,
      setRestoreStatus,
      setSessionConfig,
      setSessionError,
      setSessionPhase,
    ],
  );

  const abandonActiveChannel = useCallback(() => {
    abandonPendingRef.current = true;
    const state = dashboardSessionModelRef.current?.channel.status.state;
    if (state && PRE_ACTIVE_CHANNEL_STATES.has(state)) {
      const saved = sessionSaveRef.current;
      const peerId =
        peerSessionRef.current?.peerId ??
        (saved?.phase === 'live' || saved?.phase === 'pre-handshake'
          ? saved.pairing.peerId
          : undefined);
      if (peerId) sendSessionReject(peerId);
    }
    sessionController?.abandon();
  }, [sendSessionReject]);

  /**
   * End live protocol for a terminal channel but keep the dashboard freeze
   * (Resolved Clean / balances / last status) so the game tab still shows how
   * the session finished. Persist that freeze + boot marker so reload shows
   * Resume/Start Over instead of silently booting into hub prefs alone.
   */
  const finishResolvedSessionDisplay = useCallback(
    async (hasError: boolean): Promise<boolean> => {
      const controller = sessionController;
      const model = dashboardSessionModelRef.current;
      if (!controller || !model) {
        setSessionError(true);
        return false;
      }
      const alias =
        sessionConfigRef.current?.myAlias ?? savedMyAlias(sessionSaveRef.current) ?? peekAlias();
      const terminalCoins = coinsGetterRef.current?.() ?? frozenCoins;
      const identity = {
        myName: alias ?? '',
        opponentName:
          sessionConfigRef.current?.opponentAlias ?? savedOpponentAlias(sessionSaveRef.current),
        iStarted:
          sessionConfigRef.current?.iStarted ??
          (sessionSaveRef.current?.phase === 'live' ||
          sessionSaveRef.current?.phase === 'pre-handshake'
            ? sessionSaveRef.current.pairing.iStarted
            : false),
      };
      let terminal;
      try {
        terminal = await finalizeTerminalSession({
          controller,
          model,
          identity,
          coins: terminalCoins,
        });
      } catch (error) {
        controller.reportDurabilityError(error);
        setSessionError(true);
        return false;
      }

      setFrozenCoins(terminal.coins);
      dashboardSessionModelRef.current = terminal.model;
      setDashboardSessionModel(terminal.model);
      setFinishedSessionIdentity(terminal.identity);
      setTerminalPresentation({
        model: terminal.model,
        myName: terminal.identity.myName,
        opponentName: terminal.identity.opponentName,
        iStarted: terminal.identity.iStarted,
      });
      abandonPendingRef.current = false;
      sessionFinishedCleanupRef.current = true;
      sessionPhaseRef.current = 'resolved';
      setSessionPhase('resolved');
      setSessionError(hasError);
      hubConnRef.current?.setBusy(
        shouldReportHubBusy('resolved', walletConnectedRef.current),
        alias,
      );

      // Stop the live peer route and cradle; do not send session_reject and do
      // not wipe the dashboard model (that would flash "No Session").
      resetPeerRelayState({ persistSession: false });

      sessionSaveRef.current = null;
      sessionSavePropRef.current = undefined;
      clearSessionTimers();
      // Drop the restore mount flag before resetting status/hub gates. A resumed
      // session keeps params.restoring=true; resetting gates alone would re-arm
      // restoreBlocked and GameSession would show "Restoring session..." over
      // the terminal presentation (visible on slash because hasError stays on game).
      const restoreGate = restoreGateAfterTerminalFinalization();
      const liveConfig = sessionConfigRef.current;
      if (liveConfig?.restoring) {
        setSessionConfig({ ...liveConfig, restoring: restoreGate.restoring });
      }
      setRestoreStatus(restoreGate.restoreStatus);
      setRestoreError(null);
      setRestoreHubReconciled(restoreGate.hubReconciled);
      return true;
    },
    [
      clearSessionTimers,
      frozenCoins,
      resetPeerRelayState,
      setDashboardSessionModel,
      setRestoreError,
      setRestoreHubReconciled,
      setRestoreStatus,
      setSessionConfig,
      setSessionError,
      setSessionPhase,
    ],
  );

  const handleSessionPhaseChange = useCallback(
    (phase: SessionPhase, hasError?: boolean) => {
      if (phase === 'resolved') {
        if (sessionFinishedCleanupRef.current) return;
        const previousPhase = sessionPhaseRef.current;
        const switchHub = shouldSwitchToHubOnResolved(previousPhase, !!hasError);
        const bcType = blockchainTypeRef.current;
        if (bcType) startBalancePolling(bcType);
        void finishResolvedSessionDisplay(!!hasError).then((finished) => {
          if (finished && switchHub) setActiveTab('hub');
        });
        return;
      }

      sessionPhaseRef.current = phase;
      setSessionPhase(phase);
      setSessionError(!!hasError);
      hubConnRef.current?.setBusy(shouldReportHubBusy(phase, walletConnectedRef.current));
    },
    [
      finishResolvedSessionDisplay,
      setActiveTab,
      setSessionError,
      setSessionPhase,
      startBalancePolling,
    ],
  );

  const handleRestoreStatusChange = useCallback(
    (status: RestoreStatus, error: string | null) => {
      setRestoreStatus(status);
      setRestoreError(error);
      setDashboardSessionModel((prev) =>
        prev ? { ...prev, restore: { ...prev.restore, status, error } } : prev,
      );
      if (status === 'failed') {
        markSavedSession();
        setSessionError(true);
      }
    },
    [setDashboardSessionModel, setRestoreError, setRestoreStatus, setSessionError],
  );

  const handleSessionModelChange = useCallback(
    (model: SessionModel) => {
      dashboardSessionModelRef.current = model;
      setDashboardSessionModel(model);
      const pairingToken = sessionConfigRef.current?.pairingToken;
      if (pairingToken && selectGameDashboardView(model).actionKind !== 'cancel') {
        completeTransition(pairingToken);
      }
    },
    [completeTransition, setDashboardSessionModel],
  );

  const restoreBlocked = isRestoreBlocked(
    !!sessionConfig?.restoring,
    restoreStatus,
    restoreHubReconciled,
  );

  const handleTabChange = useCallback(
    (tabId: TabId) => {
      setActiveTab(tabId);
      if (tabId === 'game') setUnreadGame(false);
      if (tabId === 'wallet') setWalletAlert(false);
      if (tabId === 'hub') setHubAlert(false);
    },
    [setActiveTab, setHubAlert, setUnreadGame, setWalletAlert],
  );

  useThemeSyncToIframe('hub-iframe', [iframeUrl]);

  // Hub owns the display name; keep local prefs aligned so presence and
  // session_proposal do not invent a Player_* fallback that later overwrites
  // the hub.
  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      const data = ev.data;
      if (!data || data.type !== 'hub-alias' || typeof data.alias !== 'string') return;
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
  const restoreFinishedSessionFromSave = useCallback(
    (save: SessionSave) => {
      if (save.phase !== 'terminal' || !Array.isArray(save.terminal.coinsOfInterest)) {
        throw new Error('Garbled terminal save: missing frozen coin list');
      }
      setActiveTab('game');
      const channelState = savedChannelStatus(save);
      const hasError = channelState === 'Failed' || channelState === 'ResolvedStale';
      sessionFinishedCleanupRef.current = true;
      sessionPhaseRef.current = 'resolved';
      setSessionPhase('resolved');
      setSessionError(hasError);
      const model = sessionModelFromSave(save);
      dashboardSessionModelRef.current = model;
      setDashboardSessionModel(model);
      setFrozenCoins(save.terminal.coinsOfInterest);
      setFinishedSessionIdentity({
        myName: save.terminal.myAlias ?? peekAlias() ?? '',
        opponentName: save.terminal.opponentAlias ?? undefined,
        iStarted: save.terminal.iStarted,
      });
      setTerminalPresentation(null);
      sessionSaveRef.current = save;
      sessionSavePropRef.current = undefined;
      sessionStartedRef.current = false;
      setSessionConfig(null);
      setPeerConn(null);
      setRestoreStatus('idle');
      setRestoreError(null);
      setRestoreHubReconciled(true);
      hubConnRef.current?.setBusy(
        shouldReportHubBusy('resolved', walletConnectedRef.current),
        save.terminal.myAlias ?? peekAlias(),
      );
      setResuming(false);
    },
    [
      setActiveTab,
      setDashboardSessionModel,
      setPeerConn,
      setRestoreError,
      setRestoreHubReconciled,
      setRestoreStatus,
      setSessionConfig,
      setSessionError,
      setSessionPhase,
    ],
  );

  // Hydrate local UI state from a SessionSave and kick off a backend connect.
  // Called only after the user has consented (Resume button) and the lease is ours.
  // Tab is switched first so the first paint after ready is already on Game.
  const performResume = useCallback(
    (save: SessionSave) => {
      setActiveTab('game');
      const bcType = save.preferences.blockchainType ?? 'simulator';
      setResuming(true);
      setRestoreStatus('restoring');
      setRestoreError(null);
      setRestoreHubReconciled(false);
      setSessionPhase('none');
      setSessionError(false);

      sessionSaveRef.current = save;
      // Cradle-less pairingToken saves are a pre-handshake checkpoint: mount
      // GameSession without sessionSave so getOrCreate runs newSession, not restore.
      sessionSavePropRef.current =
        save.phase === 'live' ? sessionSaveForReactProps(save) : undefined;
      const {
        myContribution,
        theirContribution,
        perGameAmount: perGame,
      } = sessionAmountsFromSave(save);
      if (save.phase === 'live' || save.phase === 'pre-handshake') {
        const pairing = save.pairing;
        setSessionConfig({
          iStarted: pairing.iStarted,
          myContribution,
          theirContribution,
          perGameAmount: perGame,
          restoring: save.phase === 'live',
          pairingToken: pairing.token,
          myAlias: pairing.myAlias,
          opponentAlias: pairing.opponentAlias,
          channelTimeout: parseOptionalBigInt(pairing.channelTimeout),
          unrollTimeout: parseOptionalBigInt(pairing.unrollTimeout),
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
      const restoredChannelStatus = savedChannelStatus(save);
      const restoredPresentation = save.phase === 'live' ? save.presentation : null;
      if (
        restoredPresentation?.waitingStateEnteredAt != null &&
        isAbandonWaitingState(restoredChannelStatus)
      ) {
        const elapsed = BigInt(Date.now()) - restoredPresentation.waitingStateEnteredAt;
        waitingEnteredAtRef.current = restoredPresentation.waitingStateEnteredAt;
        waitingStateRef.current = restoredChannelStatus;
        if (elapsed >= ABANDON_DELAY_MS) {
          setAbandonEnabled(true);
        } else {
          abandonTimerRef.current = setTimeout(
            () => {
              abandonTimerRef.current = null;
              const currentState =
                dashboardSessionModelRef.current?.channel.status.state ?? restoredChannelStatus;
              if (currentState !== restoredChannelStatus) return;
              setAbandonEnabled(true);
            },
            Number(ABANDON_DELAY_MS - elapsed),
          );
        }
      } else {
        waitingEnteredAtRef.current = null;
        waitingStateRef.current = null;
        setAbandonEnabled(false);
        if (restoredPresentation?.waitingStateEnteredAt != null) {
          patchLiveSessionPresentation({ waitingStateEnteredAt: null });
        }
      }

      // Restore clean shutdown grace from persisted timestamp
      if (restoredPresentation?.cleanShutdownGraceStartedAt != null) {
        const elapsed = BigInt(Date.now()) - restoredPresentation.cleanShutdownGraceStartedAt;
        if (elapsed < GRACE_DELAY_MS) {
          setCleanShutdownGraceActive(true);
          cleanShutdownGraceTimerRef.current = setTimeout(
            () => {
              cleanShutdownGraceTimerRef.current = null;
              setCleanShutdownGraceActive(false);
              patchLiveSessionPresentation({ cleanShutdownGraceStartedAt: null });
            },
            Number(GRACE_DELAY_MS - elapsed),
          );
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
      })();
    },
    [
      uniqueId,
      completeConnection,
      stablePeerConn,
      setActiveTab,
      setWalletAlert,
      setPeerConn,
      setRestoreError,
      setRestoreHubReconciled,
      setRestoreStatus,
      setSessionConfig,
      setSessionError,
      setSessionPhase,
    ],
  );

  // User clicked "Resume Session" in the resumeDialog, or boot landed on
  // autoResuming after a stale-deploy reload.
  // If another tab holds the lease, ask to take over first; otherwise proceed.
  const handleResume = useCallback(async () => {
    if (bootState.kind === 'resumeDialog' && bootState.loadError !== null) return;
    if (bootState.kind !== 'resumeDialog' && bootState.kind !== 'autoResuming') return;
    const fromAutoResume = bootState.kind === 'autoResuming';
    setResuming(true);
    let save: SessionSave | null;
    try {
      save = await peekSession();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[Shell] resume session load failed:', error);
      clearAutoResumeOnce();
      markSavedSession();
      setBootState({ kind: 'resumeDialog', loadError: message });
      setResuming(false);
      return;
    }
    if (!save) {
      // peekSession clears orphan markers when no record exists. Re-arm so a
      // failed Resume cannot fall through to leftover preference state on the
      // next reload — the user must Start Over.
      clearAutoResumeOnce();
      markSavedSession();
      setBootState({
        kind: 'resumeDialog',
        loadError: 'The saved session is unsupported or could not be loaded.',
      });
      setResuming(false);
      return;
    }
    if (isLeaseConflict()) {
      clearAutoResumeOnce();
      setBootState({ kind: 'tabConflict', save, midSession: false });
      setResuming(false);
      return;
    }
    claimLease();
    // Select the destination tab before any hydrate so the first ready paint
    // is already on the right tab.
    const resumeTab = tabForResumedSave(save);
    if (resumeTab) setActiveTab(resumeTab);

    const hasLiveSession = save.phase === 'live' || save.phase === 'pre-handshake';
    if (hasLiveSession) {
      performResume(save);
    } else if (isTerminalSavedChannel(save)) {
      restoreFinishedSessionFromSave(save);
      if (save.preferences.blockchainType) {
        void handleConnect(save.preferences.blockchainType, true);
      }
    } else if (save.preferences.blockchainType) {
      void handleConnect(save.preferences.blockchainType, true);
    } else {
      setResuming(false);
    }

    clearAutoResumeOnce();
    // Auto-resume with a live session: stay blank until restore is presentable.
    // Manual Resume can show the shell immediately (user just confirmed).
    if (fromAutoResume && hasLiveSession) {
      return;
    }
    setBootState({ kind: 'ready' });
  }, [bootState, performResume, handleConnect, restoreFinishedSessionFromSave, setActiveTab]);

  // Stale-deploy reload: resume without prompting.
  const autoResumeStartedRef = useRef(false);
  useEffect(() => {
    if (bootState.kind !== 'autoResuming') return;
    if (autoResumeStartedRef.current) return;
    autoResumeStartedRef.current = true;
    void handleResume();
  }, [bootState.kind, handleResume]);

  // After invisible restore finishes, reveal the shell in one paint.
  useEffect(() => {
    if (bootState.kind !== 'autoResuming') return;
    if (!sessionConfig || !peerConn) return;
    if (restoreStatus === 'failed') {
      setBootState({ kind: 'ready' });
      return;
    }
    const restoring = !!sessionConfig.restoring;
    const blocked = isRestoreBlocked(restoring, restoreStatus, restoreHubReconciled);
    const { keepSession } = shouldMountGameSession(
      true,
      walletConnected,
      restoring,
      sessionStartedRef.current,
    );
    if (keepSession && !blocked) {
      setBootState({ kind: 'ready' });
    }
  }, [
    bootState.kind,
    sessionConfig,
    peerConn,
    walletConnected,
    restoreStatus,
    restoreHubReconciled,
  ]);

  // User clicked "Take over" in the tabConflict dialog.
  // Claim the lease in place (this fences the other tab via storage event)
  // and continue with whatever action we were about to take.
  const handleTakeOver = useCallback(() => {
    setBootState((prev) => {
      if (prev.kind !== 'tabConflict') return prev;
      claimLease();
      if (prev.midSession) {
        // Our session is already live — just reclaim the lease.
      } else if (prev.save) {
        const resumeTab = tabForResumedSave(prev.save);
        if (resumeTab) setActiveTab(resumeTab);
        if (prev.save.phase === 'live' || prev.save.phase === 'pre-handshake') {
          performResume(prev.save);
        } else if (isTerminalSavedChannel(prev.save)) {
          restoreFinishedSessionFromSave(prev.save);
          const bcType = prev.save.preferences.blockchainType ?? getBlockchainType();
          if (bcType) {
            void handleConnect(bcType, true);
          }
        } else {
          const bcType = prev.save.preferences.blockchainType ?? getBlockchainType();
          if (bcType) {
            void handleConnect(bcType, true);
          }
        }
      } else {
        const bcType = getBlockchainType();
        if (bcType) {
          void handleConnect(bcType, true);
        }
      }
      return { kind: 'ready' };
    });
  }, [performResume, handleConnect, restoreFinishedSessionFromSave, setActiveTab]);

  const handleCloseTab = useCallback(() => {
    stopBalancePolling();
    hubConnRef.current?.disconnect();
    hubConnRef.current = null;
    activeBlockchainRef.current?.disconnect().catch(() => {});
    activeBlockchainRef.current = null;
    setActiveBlockchainPoller(null);
    deactivate();
    setBootState({ kind: 'tabDead' });
  }, [stopBalancePolling]);

  const handleStartOver = useCallback(async () => {
    setStartingOver(true);
    // Close live connections before wiping storage. Open WalletConnect /
    // hub sockets can block IndexedDB deleteDatabase and hang Start Over.
    try {
      hubConnRef.current?.disconnect();
      hubConnRef.current = null;
      if (activeBlockchainRef.current) {
        try {
          await activeBlockchainRef.current.disconnect();
        } catch {
          /* ignore */
        }
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

  // Reject/cancel any pending consent prompt or pre-active matchmaking attempt.
  // Shared by wallet and hub disconnect. Active off-chain sessions stay mounted
  // (only pre-Active attempts cancel); resolved finished sessions keep their
  // dashboard freeze + terminal save — a pending invite after a game is
  // consent-only and must not trigger cancelAttemptedSession. While restore is
  // blocked, phase is still 'none' and the live dashboard model is not yet
  // populated, so fall back to the persisted channel status when deciding whether
  // the attempt is pre-Active. When the hub is being torn down (preserveHub=false),
  // hubUrl is dropped before clearSession so clearSession's async tail does not
  // re-mark Resume from a stale hub pref.
  const cancelPendingMatchmaking = useCallback(
    ({ preserveHub }: { preserveHub: boolean }) => {
      const channelState =
        dashboardSessionModelRef.current?.channel.status.state ??
        (sessionSaveRef.current ? savedChannelStatus(sessionSaveRef.current) : null);
      const hasPendingPrompt =
        pendingAdvisoryRef.current !== null || pendingProposalRef.current !== null;
      const hasAttempt =
        peerSessionRef.current !== null ||
        !!sessionConfigRef.current?.pairingToken ||
        sessionSaveRef.current?.phase === 'live' ||
        sessionSaveRef.current?.phase === 'pre-handshake';
      const shouldCancel = shouldCancelAttemptOnDisconnect(
        hasAttempt,
        sessionPhaseRef.current,
        channelState,
        abandonPendingRef.current,
      );
      if (hasPendingPrompt || shouldCancel) {
        const peerId =
          peerSessionRef.current?.peerId ??
          pendingProposalRef.current?.from_id ??
          pendingAdvisoryRef.current?.peer_id ??
          (sessionSaveRef.current?.phase === 'live' ||
          sessionSaveRef.current?.phase === 'pre-handshake'
            ? sessionSaveRef.current.pairing.peerId
            : undefined);
        if (peerId) sendSessionReject(peerId);
      }
      if (shouldCancel) {
        if (!preserveHub) saveHubUrl(undefined);
        cancelAttemptedSession();
      } else {
        if (hasPendingPrompt) {
          setPendingAdvisoryState(null);
          setPendingProposalState(null);
          // Proposal path creates PeerSession before accept; drop it without
          // clearSessionPreservingHistory (keeps terminal snapshot / freeze).
          resetPeerRelayState();
        }
        if (!preserveHub) saveHubUrl(undefined);
      }
    },
    [
      cancelAttemptedSession,
      resetPeerRelayState,
      sendSessionReject,
      setPendingAdvisoryState,
      setPendingProposalState,
    ],
  );

  const doDisconnectHub = useCallback(() => {
    cancelPendingMatchmaking({ preserveHub: false });
    hubConnRef.current?.disconnect();
    hubConnRef.current = null;
    clearSessionId();
    setSessionId('');
    setHubOrigin(null);
    setIframeUrl('about:blank');
    setHubLiveness(null);
    markPeerInactive();
  }, [cancelPendingMatchmaking, markPeerInactive]);

  const doDisconnectWallet = useCallback(async () => {
    stopBalancePolling();
    if (activeBlockchainRef.current) {
      try {
        await activeBlockchainRef.current.disconnect();
      } catch (_) {}
    }
    deactivate();
    activeBlockchainRef.current = null;
    setActiveBlockchainPoller(null);
    setWalletConnected(false);
    walletConnectedRef.current = false;
    setBlockchainType(undefined);
    setBalance(undefined);
    // Pre-game wallet disconnect: drop the boot marker so reload does not
    // force Resume just for a prior blockchainType. Mid-session / resumable
    // state must keep the marker — otherwise boot skips Resume while the
    // cradle remains in IDB and can be clobbered by incidental saves.
    const hasResumableSession =
      sessionPhaseRef.current !== 'none' ||
      sessionSaveRef.current?.phase === 'live' ||
      sessionSaveRef.current?.phase === 'pre-handshake' ||
      !!sessionConfigRef.current?.pairingToken;
    if (!hasResumableSession) {
      clearSavedSessionMarker();
    }
    // Clear blockchainType before cancel so clearSession's async tail does not
    // re-mark Resume from a wallet preference this disconnect is dropping.
    saveSession({ scope: 'common', preferences: { blockchainType: undefined } });
    // Wallet is orthogonal to the hub: stay connected and only cancel pending
    // matchmaking (no hub teardown). Then advertise busy — without a wallet we
    // cannot fund or resolve a channel, so the lobby must not offer matches.
    cancelPendingMatchmaking({ preserveHub: true });
    hubConnRef.current?.setBusy(
      shouldReportHubBusy(sessionPhaseRef.current, false),
      sessionConfigRef.current?.myAlias ?? savedMyAlias(sessionSaveRef.current) ?? peekAlias(),
    );
  }, [stopBalancePolling, cancelPendingMatchmaking]);

  const handleDisconnectWallet = useCallback(() => {
    // Wallet disconnect no longer cascades to the hub or peer: the session
    // stays mounted and we appear busy. Warn only that chain ops stall while a
    // session is live (and any pending invite is cancelled).
    if (sessionPhase !== 'none') {
      setConfirmDialog({
        title: 'Disconnect wallet?',
        body: 'You are in a session. Blockchain operations will stall until you reconnect a wallet, and you will appear busy to the hub.',
        onConfirm: () => {
          setConfirmDialog(null);
          doDisconnectWallet();
        },
      });
    } else {
      doDisconnectWallet();
    }
  }, [sessionPhase, doDisconnectWallet]);

  const handleDisconnectHub = useCallback(() => {
    if (
      (peerLiveness === 'connected' || peerLiveness === 'degraded') &&
      sessionPhase === 'off-chain'
    ) {
      setConfirmDialog({
        title: 'Disconnect from hub?',
        body: 'Disconnecting from this hub will end your peer connection. Your game stays off-chain — resolve it on-chain from the dashboard if needed.',
        onConfirm: () => {
          setConfirmDialog(null);
          doDisconnectHub();
        },
      });
    } else if (peerLiveness === 'connected' || peerLiveness === 'degraded') {
      setConfirmDialog({
        title: 'Disconnect from hub?',
        body: 'This will end your peer connection.',
        onConfirm: () => {
          setConfirmDialog(null);
          doDisconnectHub();
        },
      });
    } else {
      doDisconnectHub();
    }
  }, [peerLiveness, sessionPhase, doDisconnectHub]);

  const startCleanShutdownGrace = useCallback(() => {
    if (cleanShutdownGraceTimerRef.current !== null) {
      clearTimeout(cleanShutdownGraceTimerRef.current);
    }
    setCleanShutdownGraceActive(true);
    saveSession({
      scope: 'presentation',
      presentation: { cleanShutdownGraceStartedAt: BigInt(Date.now()) },
    });
    cleanShutdownGraceTimerRef.current = setTimeout(() => {
      cleanShutdownGraceTimerRef.current = null;
      setCleanShutdownGraceActive(false);
      patchLiveSessionPresentation({ cleanShutdownGraceStartedAt: null });
    }, Number(GRACE_DELAY_MS));
  }, []);

  const requestDashboardCleanShutdown = useCallback(() => {
    startCleanShutdownGrace();
    setDashboardSessionModel((prev) =>
      prev ? { ...prev, channel: { ...prev.channel, cleanShutdownStarted: true } } : prev,
    );
    sessionController?.cleanShutdown();
  }, [setDashboardSessionModel, startCleanShutdownGrace]);

  const performDashboardGoOnChain = useCallback(() => {
    if (!sessionController?.goOnChain()) return;
    sessionPhaseRef.current = 'on-chain';
    setSessionPhase('on-chain');
    hubConnRef.current?.setBusy(shouldReportHubBusy('on-chain'));
    peerSessionRef.current?.markDead();
    syncPeerLiveness();
  }, [setSessionPhase, syncPeerLiveness]);

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

  const handleDashboardAction = useCallback(
    (kind: GameDashboardActionKind) => {
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
              if (
                !isSessionAbandonable(dashboardSessionModelRef.current, abandonEnabledRef.current)
              )
                return;
              abandonActiveChannel();
            },
          });
          break;
        case 'none':
          break;
      }
    },
    [
      abandonActiveChannel,
      cancelDashboardSession,
      requestDashboardCleanShutdown,
      requestDashboardGoOnChain,
    ],
  );

  const handleReconnect = useCallback(() => {
    if (!blockchainType || connecting) return;
    handleConnect(blockchainType);
  }, [blockchainType, connecting, handleConnect]);

  if (bootState.kind === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-canvas-bg-subtle text-canvas-text">
        <p className="text-sm">Loading Chia Gaming…</p>
      </div>
    );
  }

  // Auto-resume before hydrate finishes: do not mount interactive session UI.
  if (bootState.kind === 'autoResuming' && !sessionConfig) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-canvas-bg-subtle text-canvas-text">
        <p className="text-sm">Restoring your session…</p>
      </div>
    );
  }

  // --- Tab dead (user chose to yield to another tab) ---
  if (bootState.kind === 'tabDead') {
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'center',
          width: '100vw',
          height: '100vh',
        }}
        className="bg-canvas-bg-subtle text-canvas-text"
      >
        <div
          style={{
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
          }}
        >
          <p className="text-canvas-text-contrast font-semibold text-lg">Tab inactive</p>
          <p className="text-canvas-text text-sm text-center">
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
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'center',
          width: '100vw',
          height: '100vh',
        }}
        className="bg-canvas-bg-subtle text-canvas-text"
      >
        <div
          style={{
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
          }}
        >
          <p className="text-canvas-text-contrast font-semibold text-lg">
            {loadFailed ? 'Saved session unavailable' : 'Previously saved state'}
          </p>
          <p className="text-canvas-text text-sm text-center">
            {loadFailed
              ? `${bootState.loadError} Start over to clear it.`
              : 'You have previously saved state. Resume where you left off, or start over?'}
          </p>
          {!loadFailed && (
            <button
              onClick={handleResume}
              disabled={resuming || startingOver}
              className="w-full px-4 py-2 rounded-md font-medium text-sm bg-primary-solid text-primary-on-primary hover:bg-primary-solid-hover transition-colors disabled:opacity-50"
            >
              {resuming ? 'Resuming\u2026' : 'Resume Session'}
            </button>
          )}
          <button
            onClick={handleStartOver}
            disabled={resuming || startingOver}
            className="w-full px-4 py-2 rounded-md font-medium text-sm border border-canvas-border text-canvas-text hover:bg-canvas-bg-hover transition-colors disabled:opacity-50"
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
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'center',
          width: '100vw',
          height: '100vh',
          ...(isMidSession ? { position: 'fixed', inset: 0, zIndex: 9999 } : {}),
        }}
        className="bg-canvas-bg-subtle text-canvas-text"
      >
        <div
          style={{
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
          }}
        >
          <p className="text-canvas-text-contrast font-semibold text-lg">Another tab is active</p>
          <p className="text-canvas-text text-sm text-center">
            {isMidSession
              ? 'Another tab has taken over this session.'
              : 'It looks like another tab is already running.'}{' '}
            Would you like this tab to take over, or close it?
          </p>
          <button
            onClick={handleTakeOver}
            className="w-full px-4 py-2 rounded-md font-medium text-sm bg-primary-solid text-primary-on-primary hover:bg-primary-solid-hover transition-colors"
          >
            {isMidSession ? 'Take back control' : 'Take over'}
          </button>
          <button
            onClick={handleCloseTab}
            className="w-full px-4 py-2 rounded-md font-medium text-sm border border-canvas-border text-canvas-text hover:bg-canvas-bg-hover transition-colors"
          >
            Close this tab
          </button>
        </div>
      </div>
    );
  }

  const sessionPaneTransition =
    shellState.transition.kind === 'pending' && shellState.transition.scope === 'session-pane';
  // Finished freeze (resolved) is not a live setup model — keep Cancel synthesized
  // until the first non-resolved SessionModel arrives from GameSession.
  const hasLiveSessionModel = dashboardSessionModel !== null && sessionPhase !== 'resolved';

  const sessionCanMount = sessionConfig !== null && peerConn !== null;
  const { startSession: sessionReadyToStart, keepSession } = shouldMountGameSession(
    sessionCanMount,
    walletConnected,
    !!sessionConfig?.restoring,
    sessionStartedRef.current,
  );
  if (sessionReadyToStart) sessionStartedRef.current = true;

  const dashboardView: GameDashboardViewModel = selectGameDashboardView(dashboardSessionModel, {
    hasSession: dashboardSessionModel !== null,
    setupPending: shouldSynthesizeSetupPending(sessionPaneTransition, hasLiveSessionModel),
    cleanShutdownGraceActive,
    abandonEnabled,
  });
  const statusBarBalances = selectStatusBarBalances(dashboardSessionModel);
  const sessionConsentOverlay = pendingAdvisory ? (
    <div className="absolute inset-0 flex items-center justify-center bg-canvas-bg/80 backdrop-blur-sm z-50">
      <div className="bg-canvas-bg border border-canvas-border rounded-lg p-6 shadow-lg max-w-sm text-center">
        <h2 className="text-lg font-semibold text-canvas-text mb-2">New Session</h2>
        <p className="text-sm text-canvas-text mb-4">
          <strong>{pendingAdvisory.peer_alias}</strong> would like to play.
          <SessionBuyIn
            myAmount={pendingAdvisory.my_amount}
            theirAmount={pendingAdvisory.their_amount}
            channelTimeout={pendingAdvisory.channel_timeout}
            unrollTimeout={pendingAdvisory.unroll_timeout}
          />
        </p>
        <div className="flex gap-3 justify-center">
          <button
            onClick={() => acceptPendingAdvisory(pendingAdvisory)}
            className="px-4 py-2 rounded-md font-medium text-sm bg-primary-solid text-primary-on-primary hover:bg-primary-solid-hover transition-colors"
          >
            Accept
          </button>
          <button
            onClick={() => declinePendingAdvisory(pendingAdvisory)}
            className="px-4 py-2 rounded-md font-medium text-sm border border-canvas-border text-canvas-text hover:bg-canvas-bg-hover transition-colors"
          >
            Decline
          </button>
        </div>
      </div>
    </div>
  ) : pendingProposal ? (
    <div className="absolute inset-0 flex items-center justify-center bg-canvas-bg/80 backdrop-blur-sm z-50">
      <div className="bg-canvas-bg border border-canvas-border rounded-lg p-6 shadow-lg max-w-sm text-center">
        <h2 className="text-lg font-semibold text-canvas-text mb-2">New Session</h2>
        <p className="text-sm text-canvas-text mb-4">
          <strong>{pendingProposal.from_alias}</strong> is proposing a session.
          <SessionBuyIn
            myAmount={pendingProposal.responder_amount}
            theirAmount={pendingProposal.proposer_amount}
            channelTimeout={pendingProposal.channel_timeout}
            unrollTimeout={pendingProposal.unroll_timeout}
          />
        </p>
        <div className="flex gap-3 justify-center">
          <button
            onClick={() => acceptPendingProposal(pendingProposal)}
            className="px-4 py-2 rounded-md font-medium text-sm bg-primary-solid text-primary-on-primary hover:bg-primary-solid-hover transition-colors"
          >
            Accept
          </button>
          <button
            onClick={() => declinePendingProposal(pendingProposal)}
            className="px-4 py-2 rounded-md font-medium text-sm border border-canvas-border text-canvas-text hover:bg-canvas-bg-hover transition-colors"
          >
            Decline
          </button>
        </div>
      </div>
    </div>
  ) : null;

  if (shellState.transition.kind === 'pending' && shellState.transition.scope === 'shell') {
    return <SessionTransitionOverlay reason={shellState.transition.reason} />;
  }

  // --- Main tabbed app ---
  // autoResuming with session hydrated: mount the real tree invisibly so
  // GameSession/hub can finish restore, then flip to ready in one paint.
  const shellHidden = bootState.kind === 'autoResuming';
  return (
    <>
      <UncaughtClientErrorReporter />
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          position: 'relative',
          width: '100vw',
          height: '100vh',
          ...(shellHidden ? { visibility: 'hidden' as const } : {}),
        }}
        className="bg-canvas-bg-subtle text-canvas-text"
        aria-hidden={shellHidden || undefined}
      >
        {/* Tab bar with branding */}
        <div
          style={{
            flexShrink: 0,
            display: 'flex',
            alignItems: 'flex-end',
            gap: '0.25rem',
            padding: '0.5rem 1rem 0',
            borderBottom: '1px solid var(--color-canvas-border)',
            background: 'var(--color-canvas-bg-active)',
          }}
        >
          {/* Tabs */}
          {TAB_DEFS.map((tab) => {
            const active = activeTab === tab.id;
            const showDot =
              !active &&
              ((tab.id === 'game' && unreadGame) ||
                (tab.id === 'wallet' && walletAlert) ||
                (tab.id === 'hub' && hubAlert));

            let dotColor: string | null = null;
            switch (tab.id) {
              case 'wallet':
                dotColor = walletConnected
                  ? 'var(--color-success-solid)'
                  : 'var(--color-alert-solid)';
                break;
              case 'hub':
                if (hubLiveness === 'connected') {
                  dotColor = 'var(--color-success-solid)';
                } else if (hubLiveness === 'reconnecting') {
                  dotColor = 'var(--color-warning-solid)';
                } else if (hubLiveness === 'inactive') {
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
                style={
                  active
                    ? {
                        background: 'var(--canvas-bg-subtle)',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '0.35rem',
                      }
                    : { display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }
                }
                className={
                  'relative px-3 py-1.5 text-sm font-medium rounded-t-md transition-colors ' +
                  (active
                    ? 'text-canvas-text-contrast border border-b-0 border-canvas-border -mb-px'
                    : 'text-canvas-text hover:text-canvas-text-contrast hover:bg-canvas-bg-hover')
                }
              >
                {dotColor && (
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background: dotColor,
                      flexShrink: 0,
                    }}
                  />
                )}
                {tab.label}
                {showDot && (
                  <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-alert-text" />
                )}
              </button>
            );
          })}

          {/* Right side: Branding + Theme */}
          <div
            style={{ marginLeft: 'auto', paddingBottom: '0.25rem' }}
            className="flex items-center gap-2"
          >
            <img
              src="images/chia_logo.png"
              alt="Chia Logo"
              className="max-w-12 h-auto"
              style={{ filter: isDark ? 'brightness(2.1) contrast(1.1)' : 'none' }}
            />
            <button
              onClick={() => setIsDark((d) => !d)}
              className={`p-1 border border-canvas-border rounded ${isDark ? 'text-warning-solid' : 'text-canvas-text'} hover:bg-canvas-bg-hover`}
              aria-label="toggle theme"
              title="Toggle theme"
            >
              <span className="text-sm leading-none">{isDark ? '\u2600' : '\u263E'}</span>
            </button>
          </div>
        </div>

        {/* Tab content */}
        <div
          style={{ position: 'relative', flex: '1 1 0%', minHeight: 0, zIndex: 0 }}
          className="bg-canvas-bg-subtle"
        >
          {/* Wallet tab */}
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: activeTab === 'wallet' ? 'flex' : 'none',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              overflow: 'auto',
            }}
          >
            <Button
              variant={transactionPublishNerfed ? 'solid' : 'outline'}
              color={transactionPublishNerfed ? 'primary' : 'neutral'}
              size="sm"
              className="absolute right-4 top-4"
              onClick={toggleTransactionPublishNerf}
            >
              Transaction publishing: {transactionPublishNerfed ? 'nerfed' : 'enabled'}
            </Button>
            {walletConnected ? (
              <div className="flex flex-col items-center gap-4 p-6 max-w-md w-full">
                <div className="flex items-center gap-2">
                  <span className="inline-block w-3 h-3 rounded-full bg-success-solid" />
                  <span className="text-lg font-semibold text-canvas-text-contrast">Connected</span>
                </div>
                {balance !== undefined && (
                  <p className="text-2xl font-bold text-canvas-text-contrast">
                    {balance.toLocaleString()} mojos
                  </p>
                )}
                <div className="w-full max-w-xs text-sm text-canvas-text">
                  <div className="flex items-center gap-2 mb-1">
                    <span>Transaction fee</span>
                    <div className="flex rounded-md border border-canvas-border overflow-hidden text-xs">
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
                    <div className="flex gap-2">
                      <input
                        ref={feeInputRef}
                        type="text"
                        inputMode={feeUnit === 'xch' ? 'decimal' : 'numeric'}
                        value={feeInput}
                        onChange={(e) => setFeeInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && feeInputValid) commitFee();
                          if (e.key === 'Escape') cancelEditFee();
                        }}
                        className="flex-1 px-3 py-2 rounded-md bg-canvas-bg-subtle text-canvas-text border border-canvas-border outline-none"
                      />
                      <button
                        onClick={commitFee}
                        disabled={!feeInputValid}
                        className="px-3 py-2 text-sm font-medium rounded-md border border-canvas-border text-canvas-text hover:bg-canvas-bg-hover transition-colors disabled:opacity-40 disabled:cursor-default"
                      >
                        Set
                      </button>
                      <button
                        onClick={cancelEditFee}
                        className="px-3 py-2 text-sm font-medium rounded-md border border-canvas-border text-canvas-text hover:bg-canvas-bg-hover transition-colors"
                      >
                        ✕
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={startEditingFee}
                      className="w-full text-left px-3 py-2 rounded-md bg-canvas-bg-subtle text-canvas-text border border-canvas-border hover:bg-canvas-bg-hover transition-colors cursor-pointer"
                    >
                      {feeDisplayText()} {feeUnit === 'xch' ? 'XCH' : 'mojos'}
                    </button>
                  )}
                </div>
                <Button variant="solid" onClick={handleDisconnectWallet}>
                  Disconnect
                </Button>
              </div>
            ) : connectionSetup ? (
              <div className="flex flex-col items-center gap-4 p-6 max-w-md w-full">
                <p className="text-lg font-semibold text-canvas-text-contrast">Scan QR Code</p>
                <p className="text-sm text-canvas-text text-center">
                  Open your Chia wallet and scan this QR code to connect
                </p>
                <div className="p-4 rounded-xl border-2 border-canvas-border bg-white shadow-md">
                  {qrDataUrl ? (
                    <img
                      src={qrDataUrl}
                      alt="Connection QR"
                      className="w-[200px] h-auto rounded-md"
                    />
                  ) : (
                    <div className="w-[200px] h-[200px] flex items-center justify-center text-canvas-solid">
                      Generating…
                    </div>
                  )}
                </div>
                <div className="w-full max-w-sm flex gap-2">
                  <textarea
                    readOnly
                    value={connectionSetup.qrUri}
                    rows={3}
                    className="flex-1 text-xs font-mono rounded-md p-2 border border-canvas-border bg-canvas-bg-subtle text-canvas-text resize-none"
                  />
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(connectionSetup.qrUri);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    }}
                    className="self-center p-2 rounded-md border border-canvas-border text-canvas-text hover:bg-canvas-bg-hover transition-colors"
                    title="Copy URI to clipboard"
                  >
                    {copied ? (
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        viewBox="0 0 20 20"
                        fill="currentColor"
                        className="w-4 h-4"
                      >
                        <path
                          fillRule="evenodd"
                          d="M16.704 4.153a.75.75 0 0 1 .143 1.052l-8 10.5a.75.75 0 0 1-1.127.075l-4.5-4.5a.75.75 0 0 1 1.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 0 1 1.05-.143Z"
                          clipRule="evenodd"
                        />
                      </svg>
                    ) : (
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        viewBox="0 0 20 20"
                        fill="currentColor"
                        className="w-4 h-4"
                      >
                        <path d="M7 3.5A1.5 1.5 0 0 1 8.5 2h3.879a1.5 1.5 0 0 1 1.06.44l3.122 3.12A1.5 1.5 0 0 1 17 6.622V12.5a1.5 1.5 0 0 1-1.5 1.5h-1v-3.379a3 3 0 0 0-.879-2.121L10.5 5.379A3 3 0 0 0 8.379 4.5H7v-1Z" />
                        <path d="M4.5 6A1.5 1.5 0 0 0 3 7.5v9A1.5 1.5 0 0 0 4.5 18h7a1.5 1.5 0 0 0 1.5-1.5v-5.879a1.5 1.5 0 0 0-.44-1.06L9.44 6.439A1.5 1.5 0 0 0 8.378 6H4.5Z" />
                      </svg>
                    )}
                  </button>
                </div>
                <div className="w-full max-w-sm text-sm text-canvas-text">
                  <div className="flex items-center gap-2 mb-1">
                    <span>Transaction fee</span>
                    <div className="flex rounded-md border border-canvas-border overflow-hidden text-xs">
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
                    <div className="flex gap-2">
                      <input
                        ref={feeInputRef}
                        type="text"
                        inputMode={feeUnit === 'xch' ? 'decimal' : 'numeric'}
                        value={feeInput}
                        onChange={(e) => setFeeInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && feeInputValid) commitFee();
                          if (e.key === 'Escape') cancelEditFee();
                        }}
                        className="flex-1 px-3 py-2 rounded-md bg-canvas-bg-subtle text-canvas-text border border-canvas-border outline-none"
                      />
                      <button
                        onClick={commitFee}
                        disabled={!feeInputValid}
                        className="px-3 py-2 text-sm font-medium rounded-md border border-canvas-border text-canvas-text hover:bg-canvas-bg-hover transition-colors disabled:opacity-40 disabled:cursor-default"
                      >
                        Set
                      </button>
                      <button
                        onClick={cancelEditFee}
                        className="px-3 py-2 text-sm font-medium rounded-md border border-canvas-border text-canvas-text hover:bg-canvas-bg-hover transition-colors"
                      >
                        ✕
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={startEditingFee}
                      className="w-full text-left px-3 py-2 rounded-md bg-canvas-bg-subtle text-canvas-text border border-canvas-border hover:bg-canvas-bg-hover transition-colors cursor-pointer"
                    >
                      {feeDisplayText()} {feeUnit === 'xch' ? 'XCH' : 'mojos'}
                    </button>
                  )}
                </div>
                <p className="text-sm text-canvas-text animate-pulse">
                  Waiting for wallet to connect…
                </p>
                <Button variant="solid" onClick={handleCancelConnect}>
                  Cancel
                </Button>
                <SimulatorSetupModal
                  open={showSimModal}
                  onConnect={handleFinalize}
                  connecting={connecting}
                />
              </div>
            ) : connecting ? (
              <div className="flex flex-col items-center gap-4 p-6 max-w-md w-full">
                <div className="w-6 h-6 border-2 border-canvas-border border-t-canvas-text-contrast rounded-full animate-spin" />
                <p className="text-sm text-canvas-text animate-pulse">Connecting…</p>
                <Button variant="solid" onClick={handleCancelConnect}>
                  Cancel
                </Button>
              </div>
            ) : !walletConnected && activeBlockchainRef.current ? (
              <div className="flex flex-col items-center gap-4 p-6 max-w-md w-full">
                <div className="flex items-center gap-2">
                  <span className="inline-block w-3 h-3 rounded-full bg-alert-solid" />
                  <span className="text-lg font-semibold text-alert-text">Disconnected</span>
                </div>
                <p className="text-sm text-canvas-text">Connection was lost</p>
                <Button variant="solid" onClick={handleReconnect}>
                  Reconnect
                </Button>
              </div>
            ) : (
              <div className="flex flex-col justify-center items-center w-full px-4 py-6 gap-4">
                <p className="text-lg font-semibold text-canvas-text-contrast">Choose Connection</p>
                <div className="w-full max-w-sm flex flex-col gap-3">
                  <Button
                    variant="solid"
                    fullWidth
                    onClick={() => handleConnect('simulator', false, true)}
                  >
                    Continue with Simulator
                  </Button>
                  <div className="flex items-center gap-2">
                    <div className="flex-1 border-t border-canvas-border" />
                    <span className="text-canvas-text font-medium text-sm">OR</span>
                    <div className="flex-1 border-t border-canvas-border" />
                  </div>
                  <Button
                    variant="solid"
                    fullWidth
                    onClick={() => handleConnect('walletconnect', false, true)}
                  >
                    Link Wallet
                  </Button>
                </div>
              </div>
            )}
          </div>

          {/* Hub tab */}
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: activeTab === 'hub' ? 'flex' : 'none',
              flexDirection: 'column',
            }}
          >
            {hubOrigin ? (
              <>
                <div className="flex items-center justify-between px-4 py-2 border-b border-canvas-border bg-canvas-bg-subtle text-sm text-canvas-text shrink-0">
                  <span>
                    {hubLiveness === 'connected'
                      ? `Connected to ${hubOrigin}`
                      : `${TRACKER_LIVENESS_LABELS[hubLiveness ?? 'disconnected']} from ${hubOrigin}`}
                  </span>
                  <div className="flex items-center gap-2">
                    {hubLiveness === 'disconnected' && (
                      <button
                        onClick={() => connectToHub(hubOrigin)}
                        className="flex-shrink-0 px-3 py-1.5 rounded-md text-sm font-medium border border-canvas-border hover:bg-canvas-solid transition-colors"
                      >
                        Retry
                      </button>
                    )}
                    <button
                      onClick={handleDisconnectHub}
                      className="flex-shrink-0 px-3 py-1.5 rounded-md text-sm font-medium bg-primary-solid text-primary-on-primary hover:bg-primary-solid-hover transition-colors"
                    >
                      Disconnect
                    </button>
                  </div>
                </div>
                {hubConnectionError && (
                  <p className="px-4 py-2 text-sm text-alert-text bg-canvas-bg-subtle">
                    {hubConnectionError}
                  </p>
                )}
                <iframe
                  id="hub-iframe"
                  className="bg-canvas-bg-subtle"
                  style={{ flex: '1 1 0%', width: '100%', border: 'none', margin: 0 }}
                  src={iframeUrl}
                />
              </>
            ) : (
              <HubPicker onConnect={requestHubConnect} connectionError={hubConnectionError} />
            )}
          </div>

          {/* Game Session tab */}
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              visibility: activeTab === 'game' ? 'visible' : 'hidden',
            }}
          >
            <GameDashboard
              view={dashboardView}
              balances={statusBarBalances}
              onAction={handleDashboardAction}
              getProtocolState={getProtocolState}
              getCoins={getCoins}
            />
            <div style={{ flex: '1 1 0%', minHeight: 0, overflow: 'auto' }}>
              {sessionPaneTransition && !keepSession ? (
                <SessionTransitionSurface />
              ) : keepSession && restoreStatus === 'failed' ? (
                <div className="w-full h-full flex flex-col items-center justify-center gap-3 text-canvas-text p-8">
                  <h2 className="text-lg font-semibold text-alert-text">Restore failed</h2>
                  <p className="max-w-lg text-sm text-center select-text cursor-text">
                    {restoreError ?? 'The saved session could not be restored.'}
                  </p>
                  <button
                    onClick={handleStartOver}
                    disabled={startingOver}
                    className="px-4 py-2 rounded-md font-medium text-sm border border-canvas-border text-canvas-text hover:bg-canvas-bg-hover transition-colors disabled:opacity-50"
                  >
                    {startingOver ? 'Starting over\u2026' : 'Start over'}
                  </button>
                </div>
              ) : keepSession ? (
                <div className="relative w-full h-full">
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
                      suppressPhaseReporting={shouldSuppressPhaseReporting(
                        restoreBlocked,
                        terminalPresentation != null,
                      )}
                      terminalPresentation={terminalPresentation}
                      showTransitionSurface={sessionPaneTransition}
                    />
                  </GameSessionErrorBoundary>
                  {sessionConsentOverlay}
                </div>
              ) : sessionPhase === 'resolved' && dashboardSessionModel ? (
                // Prefer the finished freeze over sessionCanMount+"Restoring session...".
                // After live terminal finalization, sessionConfig/peerConn often remain
                // (warm GameSession path); if keepSession drops, we must not claim restore.
                <div className="relative w-full h-full">
                  <FinishedSessionGameView
                    model={sessionModelForReactProps(dashboardSessionModel)}
                    myName={finishedSessionIdentity?.myName ?? peekAlias()}
                    opponentName={finishedSessionIdentity?.opponentName}
                    iStarted={finishedSessionIdentity?.iStarted ?? false}
                  />
                  {sessionConsentOverlay}
                </div>
              ) : sessionCanMount ? (
                <div className="w-full h-full flex items-center justify-center text-canvas-solid">
                  Restoring session...
                </div>
              ) : (
                <div className="relative w-full h-full">
                  <div className="w-full h-full flex items-center justify-center text-canvas-solid">
                    No active game session
                  </div>
                  {sessionConsentOverlay}
                </div>
              )}
            </div>
          </div>

          {/* History tab */}
          <div
            style={{
              position: 'absolute',
              inset: 0,
              padding: '1rem',
              display: activeTab === 'history' ? 'block' : 'none',
            }}
          >
            <HistoryPanel lines={history} />
          </div>

          {/* Log tab */}
          <div
            style={{
              position: 'absolute',
              inset: 0,
              padding: '1rem',
              display: activeTab === 'log' ? 'block' : 'none',
            }}
          >
            {logLines.length > 0 ? (
              <LogPanel lines={logLines} />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-canvas-solid">
                No log entries yet
              </div>
            )}
          </div>
        </div>

        {confirmDialog && (
          <div
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 9999,
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              background: 'rgba(0,0,0,0.5)',
            }}
          >
            <div
              style={{
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
              }}
            >
              <p className="text-canvas-text-contrast font-semibold text-lg">
                {confirmDialog.title}
              </p>
              <p className="text-canvas-text text-sm text-center">{confirmDialog.body}</p>
              <button
                onClick={confirmDialog.onConfirm}
                className="w-full px-4 py-2 rounded-md font-medium text-sm bg-primary-solid text-primary-on-primary hover:bg-primary-solid-hover transition-colors"
              >
                {confirmDialog.confirmLabel ?? 'Proceed'}
              </button>
              <button
                onClick={() => setConfirmDialog(null)}
                className="w-full px-4 py-2 rounded-md font-medium text-sm border border-canvas-border text-canvas-text hover:bg-canvas-bg-hover transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
};

export default Shell;
