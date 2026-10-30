import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import QRCode from 'qrcode';
import { getCurrencyLabels } from '../constants/currency';
import { MIN_NONZERO_FEE_MOJOS, isEffectivelyZeroFee } from '../constants/fees';
import { useCopyToClipboard } from '../hooks/useCopyToClipboard';
import { shouldSuppressPhaseReporting } from '../lib/restoreLifecycle';
import { shouldSynthesizeSetupPending } from '../lib/session/acceptLifecycle';
import { sessionModelForReactProps } from '../lib/session/finishedSessionDisplay';
import { selectGamePaneKind } from '../lib/session/gamePane';
import {
  DEFAULT_CHANNEL_TIMEOUT_BLOCKS,
  DEFAULT_UNROLL_TIMEOUT_BLOCKS,
  selectDashboardCoins,
  selectGameDashboardView,
  selectGameTabConnected,
  selectStatusBarBalances,
  type BannerTone,
  type GameDashboardActionKind,
  type GameDashboardViewModel,
  type StatusBarBalanceSegment,
} from '../lib/session/model';
import { parseOptionalBigInt } from '../lib/session/peerSessionParams';
import { installHubIframeAuthentication } from '../services/hubIframeAuthentication';
import { CoinOfInterestEntry, HubLiveness } from '../types/ChiaGaming';
import { formatMojos } from '../util';
import { isElectronDistribution } from '../util/distribution';
import { Button } from './button';
import { ConnectionSetupModal } from './ConnectionSetupModal';
import { COPY_FAILED_TITLE, CopyIcon } from './CopyIcon';
import FinishedSessionGameView from './FinishedSessionGameView';
import GameSession, { GameSessionErrorBoundary, UncaughtClientErrorReporter } from './GameSession';
import { HubIframe } from './HubIframe';
import { SessionTransitionSurface } from './SessionTransitionSurface';
import { Setup2048Provider } from './Setup2048';
import WalletRecoveryNotice from './WalletRecoveryNotice';

import { HubPicker } from './HubPicker';

type TabId = 'wallet' | 'hub' | 'game' | 'history' | 'log';

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
  const labels = getCurrencyLabels();
  const effectiveChannelTimeout =
    parseOptionalBigInt(channelTimeout) ?? DEFAULT_CHANNEL_TIMEOUT_BLOCKS;
  const effectiveUnrollTimeout =
    parseOptionalBigInt(unrollTimeout) ?? DEFAULT_UNROLL_TIMEOUT_BLOCKS;
  if (myAmount === theirAmount) {
    return (
      <>
        <br />
        Buy-in: <strong>{myAmount}</strong> {labels.mojos}
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
      Your buy-in: <strong>{myAmount}</strong> {labels.mojos}
      <br />
      Their buy-in: <strong>{theirAmount}</strong> {labels.mojos}
      <br />
      Channel timeout: <strong>{effectiveChannelTimeout.toString()}</strong> blocks
      <br />
      Unroll timeout: <strong>{effectiveUnrollTimeout.toString()}</strong> blocks
    </>
  );
}

const TAB_DEFS: { id: TabId; label: string }[] = [
  { id: 'wallet', label: 'Wallet' },
  { id: 'hub', label: 'Hub' },
  { id: 'game', label: 'Game' },
  { id: 'history', label: 'History' },
  { id: 'log', label: 'Log' },
];

const TAB_PIPE_CONNECTED = '\u{1F517}';
const TAB_PIPE_DISCONNECTED = '\u{26D3}\u{FE0F}\u{200D}\u{1F4A5}';

const BANNER_TONE_BAR: Record<BannerTone, string> = {
  idle: 'var(--color-canvas-text-subtle)',
  playing: 'var(--color-success-solid)',
  'pings-bad': 'var(--color-warning-solid)',
  'on-chain': 'var(--color-alert-solid)',
  ended: 'var(--color-info-solid)',
};

/** Tab to show before any resume hydrate — session restores always open on Game. */
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

function pasteableCoinId(id: string): string {
  return `0x${id.replace(/^0x/i, '')}`;
}

function GameDashboard({
  view,
  balances,
  onAction,
  coins,
}: {
  view: GameDashboardViewModel;
  balances: StatusBarBalanceSegment[] | null;
  onAction: (kind: GameDashboardActionKind) => void;
  coins: CoinOfInterestEntry[];
}) {
  const [expanded, setExpanded] = useState(false);

  const barColor = BANNER_TONE_BAR[view.bannerTone];
  return (
    <div className="flex flex-shrink-0 border-b border-canvas-border bg-canvas-bg-subtle text-canvas-text">
      <div aria-hidden="true" className="w-10 shrink-0" style={{ background: barColor }} />
      <div className="min-w-0 flex-1 px-4 py-2 sm:px-6 md:px-8">
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
                  {view.channelDetail && (
                    <span className="text-canvas-text">{view.channelDetail}</span>
                  )}
                  {view.havePotato && (
                    <span aria-label="You have the potato" title="You have the potato">
                      🥔
                    </span>
                  )}
                  {view.bannerTone === 'pings-bad' && (
                    <span className="text-warning-text">Peer pings look stuck</span>
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
                      {view.handDetail && (
                        <span className="text-canvas-text">{view.handDetail}</span>
                      )}
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
            {coins.length > 0 ? (
              <div className="flex flex-col gap-y-0.5 text-xs">
                {coins.map((coin) => (
                  <div key={`${coin.label}:${coin.id}`} className="flex flex-col gap-y-0.5">
                    <span className="flex min-w-0 flex-wrap gap-x-1">
                      <span className="text-canvas-solid">{coin.label} ID:</span>
                      <span className="break-all font-mono text-canvas-text-contrast select-all cursor-text">
                        {pasteableCoinId(coin.id)}
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <span className="text-xs text-canvas-solid">No coins yet</span>
            )}
          </div>
        )}
      </div>
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
  const { state: copyState, copy } = useCopyToClipboard();

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
          onClick={() => void copy(filtered.join('\n'))}
          className="p-1.5 rounded-md border border-canvas-border text-canvas-text hover:bg-canvas-bg-hover transition-colors"
          title={copyState === 'failed' ? COPY_FAILED_TITLE : 'Copy to clipboard'}
        >
          <CopyIcon state={copyState} className="w-4 h-4" />
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

import type { ApplicationFrontend } from '../lib/application/Application';
const Shell = ({ application }: { application: ApplicationFrontend }) => {
  const [view, setView] = useState(application.snapshot);
  useEffect(() => {
    setView(application.snapshot());
    return application.subscribe((event) => setView(event.view));
  }, [application]);
  const dispatch = application.dispatch;
  const {
    alias,
    theme,
    keepSession,
    sessionPresentation,
    sessionFrontend,
    cleanShutdownGraceActive,
    abandonEnabled,
    peerLiveness,
    restoreStatus,
    restoreError,
    feeUnit,
    defaultFee,
    hubOrigin,
    sessionId,
    iframeUrl,
    bootState,
    sessionConfig,
    resuming,
    startingOver,
    transition,
    dashboardSessionModel,
    sessionPhase,
    coins,
    pendingAdvisory,
    blockchainReady,
    pendingProposal,
    activeTab,
    unreadGame,
    walletAlert,
    hubAlert,
    hubLiveness,
    transactionPublishNerfed,
    walletView,
    networkLocked,
    network,
    hubConnectionError,
    terminalFinalizationBlocker,
    restoreBlocked,
    terminalPresentation,
    finishedSessionIdentity,
    history,
    logLines,
    confirmDialog,
  } = view;
  const {
    setup: connectionSetup,
    connected: walletConnected,
    recovering: walletRecovering,
    showSetup: showConnectionSetupModal,
    connecting,
    error: connectError,
    balance,
  } = walletView;
  const [showTransactionPublishControl, setShowTransactionPublishControl] = useState(false);
  useEffect(() => {
    if (showTransactionPublishControl) return;
    const sequence = 'nerf^';
    let buffer = '';
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        target?.closest?.(
          'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
        )
      ) {
        buffer = '';
        return;
      }
      if (event.key.length !== 1) return;
      const next = buffer + event.key;
      if (next === sequence) {
        setShowTransactionPublishControl(true);
      } else {
        buffer = sequence.startsWith(next) ? next : sequence.startsWith(event.key) ? event.key : '';
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [showTransactionPublishControl]);
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [feeEditing, setFeeEditing] = useState(false);
  const [feeInput, setFeeInput] = useState('');
  const feeInputRef = useRef<HTMLInputElement>(null);
  const { state: copyState, copy } = useCopyToClipboard();
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
  const parsedFeeInput = parseFeeInput(feeInput);
  const feeInputError =
    parsedFeeInput === null
      ? 'Enter a valid amount.'
      : isEffectivelyZeroFee(parsedFeeInput)
        ? `A fee below ${MIN_NONZERO_FEE_MOJOS.toLocaleString()} ${getCurrencyLabels().mojos} is treated as zero by the network and will not confirm. Use 0 or at least ${MIN_NONZERO_FEE_MOJOS.toLocaleString()} ${getCurrencyLabels().mojos}.`
        : null;
  const feeInputValid = feeInputError === null;
  const startEditingFee = useCallback(() => {
    setFeeInput(feeDisplayText());
    setFeeEditing(true);
    setTimeout(() => feeInputRef.current?.select(), 0);
  }, [feeDisplayText]);
  const commitFee = useCallback(() => {
    const mojos = parseFeeInput(feeInput);
    if (mojos === null || isEffectivelyZeroFee(mojos)) return;
    dispatch({ type: 'fee', fee: mojos });
    setFeeEditing(false);
  }, [feeInput, parseFeeInput, dispatch]);
  const cancelEditFee = useCallback(() => {
    setFeeEditing(false);
  }, []);
  const handleFeeUnitChange = useCallback(
    (unit: 'mojo' | 'xch') => {
      dispatch({ type: 'fee-unit', unit });
      if (feeEditing) {
        const currentMojos = parseFeeInput(feeInput);
        if (currentMojos !== null) {
          setFeeInput(unit === 'xch' ? mojosToXchStr(currentMojos) : String(currentMojos));
        }
      }
    },
    [feeEditing, feeInput, parseFeeInput, dispatch],
  );
  const currency = getCurrencyLabels();
  const [isDark, setIsDark] = useState<boolean>(() => {
    const stored = theme;
    if (stored === 'dark') return true;
    if (stored === 'light') return false;
    return document.documentElement.classList.contains('dark');
  });
  useEffect(() => {
    if (isDark) {
      document.documentElement.classList.add('dark');
      dispatch({ type: 'theme', theme: 'dark' });
    } else {
      document.documentElement.classList.remove('dark');
      dispatch({ type: 'theme', theme: 'light' });
    }
  }, [isDark, dispatch]);
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
  useEffect(() => {
    if (hubOrigin === null || !sessionId || iframeUrl === 'about:blank') return;
    const iframe = document.getElementById('hub-iframe') as HTMLIFrameElement | null;
    if (iframe === null) return;
    return installHubIframeAuthentication({ iframe, iframeUrl, sessionId });
  }, [hubOrigin, iframeUrl, sessionId]);
  if (bootState.kind === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-canvas-bg-subtle text-canvas-text">
        <p className="text-sm">Loading Chia Gaming…</p>
      </div>
    );
  }
  if (bootState.kind === 'autoResuming' && !sessionConfig) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-canvas-bg-subtle text-canvas-text">
        <p className="text-sm">Restoring your session…</p>
      </div>
    );
  }
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
              ? `${bootState.loadError} Use Retry Hard Reset when the blockers are closed.`
              : 'You have previously saved state. Resume where you left off, or start over?'}
          </p>
          {!loadFailed && (
            <button
              onClick={() => dispatch({ type: 'resume' })}
              disabled={resuming || startingOver}
              className="w-full px-4 py-2 rounded-md font-medium text-sm bg-primary-solid text-primary-on-primary hover:bg-primary-solid-hover transition-colors disabled:opacity-50"
            >
              {resuming ? 'Resuming\u2026' : 'Resume Session'}
            </button>
          )}
          <button
            onClick={() => dispatch({ type: 'reset' })}
            disabled={resuming || startingOver}
            className="w-full px-4 py-2 rounded-md font-medium text-sm border border-canvas-border text-canvas-text hover:bg-canvas-bg-hover transition-colors disabled:opacity-50"
          >
            {startingOver ? 'Starting over\u2026' : loadFailed ? 'Retry Hard Reset' : 'Start over'}
          </button>
        </div>
      </div>
    );
  }
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
            onClick={() => dispatch({ type: 'takeover' })}
            className="w-full px-4 py-2 rounded-md font-medium text-sm bg-primary-solid text-primary-on-primary hover:bg-primary-solid-hover transition-colors"
          >
            {isMidSession ? 'Take back control' : 'Take over'}
          </button>
          <button
            onClick={() => dispatch({ type: 'close-tab' })}
            className="w-full px-4 py-2 rounded-md font-medium text-sm border border-canvas-border text-canvas-text hover:bg-canvas-bg-hover transition-colors"
          >
            Close this tab
          </button>
        </div>
      </div>
    );
  }
  const sessionPaneTransition =
    transition.kind === 'pending' && transition.scope === 'session-pane';
  const hasLiveSessionModel = dashboardSessionModel !== null && sessionPhase !== 'resolved';
  const dashboardView: GameDashboardViewModel = selectGameDashboardView(dashboardSessionModel, {
    hasSession: dashboardSessionModel !== null,
    setupPending: shouldSynthesizeSetupPending(sessionPaneTransition, hasLiveSessionModel),
    actionsBlocked: bootState.kind !== 'ready',
    cleanShutdownGraceActive,
    abandonEnabled,
    peerLiveness,
  });
  const statusBarBalances = selectStatusBarBalances(dashboardSessionModel);
  const dashboardCoins = dashboardSessionModel
    ? selectDashboardCoins(dashboardSessionModel, coins)
    : coins;
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
            onClick={() => dispatch({ type: 'accept-session' })}
            disabled={!walletConnected || !blockchainReady}
            className="px-4 py-2 rounded-md font-medium text-sm bg-primary-solid text-primary-on-primary hover:bg-primary-solid-hover transition-colors"
          >
            Accept
          </button>
          <button
            onClick={() => dispatch({ type: 'decline-session' })}
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
            onClick={() => dispatch({ type: 'accept-session' })}
            disabled={!walletConnected || !blockchainReady}
            className="px-4 py-2 rounded-md font-medium text-sm bg-primary-solid text-primary-on-primary hover:bg-primary-solid-hover transition-colors"
          >
            Accept
          </button>
          <button
            onClick={() => dispatch({ type: 'decline-session' })}
            className="px-4 py-2 rounded-md font-medium text-sm border border-canvas-border text-canvas-text hover:bg-canvas-bg-hover transition-colors"
          >
            Decline
          </button>
        </div>
      </div>
    </div>
  ) : null;
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
        }}
        className="bg-canvas-bg-subtle text-canvas-text"
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

            let pipeConnected: boolean | null = null;
            switch (tab.id) {
              case 'wallet':
                pipeConnected = walletConnected || walletRecovering;
                break;
              case 'hub':
                pipeConnected = hubLiveness === 'connected';
                break;
              case 'game':
                pipeConnected = selectGameTabConnected({ sessionPhase, peerLiveness });
                break;
            }
            const walletDisconnected = tab.id === 'wallet' && !walletConnected && !walletRecovering;
            const pipeLabel =
              pipeConnected === null
                ? tab.label
                : `${tab.label}, ${pipeConnected ? 'connected' : 'disconnected'}`;

            return (
              <button
                key={tab.id}
                onClick={() => dispatch({ type: 'tab', tab: tab.id })}
                aria-label={pipeLabel}
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
                {pipeConnected !== null && (
                  <span aria-hidden="true" className="text-base leading-none">
                    {pipeConnected ? TAB_PIPE_CONNECTED : TAB_PIPE_DISCONNECTED}
                  </span>
                )}
                <span className={walletDisconnected ? 'text-alert-text' : undefined}>
                  {tab.label}
                </span>
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
            <span className="text-2xl font-black tracking-wide text-canvas-text-contrast">
              BETA
            </span>
            <span
              role="img"
              aria-label="Chia Logo"
              className="block w-12 shrink-0 aspect-[96/37] bg-current text-canvas-text-contrast"
              style={{
                mask: 'url(images/chia-wordmark.svg) center / contain no-repeat',
                WebkitMask: 'url(images/chia-wordmark.svg) center / contain no-repeat',
              }}
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
            <WalletRecoveryNotice notice={walletView.recoveryNotice} />
            {showTransactionPublishControl && (
              <Button
                variant={transactionPublishNerfed ? 'solid' : 'outline'}
                color={transactionPublishNerfed ? 'primary' : 'neutral'}
                size="sm"
                className="absolute right-4 top-4"
                onClick={() => dispatch({ type: 'toggle-publish' })}
              >
                Transaction publishing: {transactionPublishNerfed ? 'nerfed' : 'enabled'}
              </Button>
            )}
            <ConnectionSetupModal
              open={showConnectionSetupModal && !!connectionSetup}
              title={connectionSetup?.title}
              description={connectionSetup?.description}
              fields={connectionSetup?.fields}
              onConnect={(values) => dispatch({ type: 'wallet-finalize', values })}
              onCancel={() => dispatch({ type: 'wallet-cancel' })}
              connecting={connecting}
              error={connectError}
            />
            {walletConnected || walletRecovering ? (
              <div className="flex flex-col items-center gap-4 p-6 max-w-md w-full">
                <div className="flex items-center gap-2">
                  <span className="inline-block w-3 h-3 rounded-full bg-success-solid" />
                  <span className="text-lg font-semibold text-canvas-text-contrast">Connected</span>
                </div>
                {balance !== undefined && (
                  <p className="text-2xl font-bold text-canvas-text-contrast">
                    {balance.toLocaleString()} {currency.mojos}
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
                        {currency.mojo}
                      </button>
                      <button
                        onClick={() => handleFeeUnitChange('xch')}
                        className={`px-2 py-0.5 transition-colors border-l border-canvas-border ${feeUnit === 'xch' ? 'bg-canvas-bg-active font-semibold' : 'hover:bg-canvas-bg-hover'}`}
                      >
                        {currency.xch}
                      </button>
                    </div>
                  </div>
                  {feeEditing ? (
                    <>
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
                      {feeInputError && feeInput.trim() !== '' ? (
                        <p className="text-xs text-alert-text mt-1 break-words">{feeInputError}</p>
                      ) : null}
                    </>
                  ) : (
                    <button
                      onClick={startEditingFee}
                      className="w-full text-left px-3 py-2 rounded-md bg-canvas-bg-subtle text-canvas-text border border-canvas-border hover:bg-canvas-bg-hover transition-colors cursor-pointer"
                    >
                      {feeDisplayText()} {feeUnit === 'xch' ? currency.xch : currency.mojos}
                    </button>
                  )}
                </div>
                <Button variant="solid" onClick={() => dispatch({ type: 'wallet-disconnect' })}>
                  Disconnect
                </Button>
              </div>
            ) : connectionSetup && !connectionSetup.skipQr ? (
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
                    onClick={() => void copy(connectionSetup.qrUri)}
                    className="self-center p-2 rounded-md border border-canvas-border text-canvas-text hover:bg-canvas-bg-hover transition-colors"
                    title={copyState === 'failed' ? COPY_FAILED_TITLE : 'Copy URI to clipboard'}
                  >
                    <CopyIcon state={copyState} className="w-4 h-4" />
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
                        {currency.mojo}
                      </button>
                      <button
                        onClick={() => handleFeeUnitChange('xch')}
                        className={`px-2 py-0.5 transition-colors border-l border-canvas-border ${feeUnit === 'xch' ? 'bg-canvas-bg-active font-semibold' : 'hover:bg-canvas-bg-hover'}`}
                      >
                        {currency.xch}
                      </button>
                    </div>
                  </div>
                  {feeEditing ? (
                    <>
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
                      {feeInputError && feeInput.trim() !== '' ? (
                        <p className="text-xs text-alert-text mt-1 break-words">{feeInputError}</p>
                      ) : null}
                    </>
                  ) : (
                    <button
                      onClick={startEditingFee}
                      className="w-full text-left px-3 py-2 rounded-md bg-canvas-bg-subtle text-canvas-text border border-canvas-border hover:bg-canvas-bg-hover transition-colors cursor-pointer"
                    >
                      {feeDisplayText()} {feeUnit === 'xch' ? currency.xch : currency.mojos}
                    </button>
                  )}
                </div>
                <p className="text-sm text-canvas-text animate-pulse">
                  Waiting for wallet to connect…
                </p>
                <Button variant="solid" onClick={() => dispatch({ type: 'wallet-cancel' })}>
                  Cancel
                </Button>
              </div>
            ) : connecting ? (
              <div className="flex flex-col items-center gap-4 p-6 max-w-md w-full">
                <div className="w-6 h-6 border-2 border-canvas-border border-t-canvas-text-contrast rounded-full animate-spin" />
                <p className="text-sm text-canvas-text animate-pulse">Connecting…</p>
                <Button variant="solid" onClick={() => dispatch({ type: 'wallet-cancel' })}>
                  Cancel
                </Button>
              </div>
            ) : !walletConnected && walletView.hasProvider ? (
              <div className="flex flex-col items-center gap-4 p-6 max-w-md w-full">
                <div className="flex items-center gap-2">
                  <span className="inline-block w-3 h-3 rounded-full bg-alert-solid" />
                  <span className="text-lg font-semibold text-alert-text">Disconnected</span>
                </div>
                <p className="text-sm text-canvas-text">Connection was lost</p>
                <Button variant="solid" onClick={() => dispatch({ type: 'wallet-reconnect' })}>
                  Reconnect
                </Button>
              </div>
            ) : (
              <div className="flex flex-col justify-center items-center w-full px-4 py-6 gap-4">
                <p className="text-lg font-semibold text-canvas-text-contrast">Choose Connection</p>
                <div className="w-full max-w-sm flex flex-col items-center gap-1">
                  <span className="text-sm text-canvas-text">Network</span>
                  <div className="flex rounded-md border border-canvas-border overflow-hidden text-xs">
                    <button
                      type="button"
                      disabled={networkLocked}
                      onClick={() => dispatch({ type: 'network', network: 'mainnet' })}
                      className={`px-3 py-1 transition-colors ${network === 'mainnet' ? 'bg-canvas-bg-active font-semibold' : networkLocked ? '' : 'hover:bg-canvas-bg-hover'} ${networkLocked ? 'opacity-40 cursor-default' : ''}`}
                    >
                      Mainnet
                    </button>
                    <button
                      type="button"
                      disabled={networkLocked}
                      onClick={() => dispatch({ type: 'network', network: 'testnet' })}
                      className={`px-3 py-1 transition-colors border-l border-canvas-border ${network === 'testnet' ? 'bg-canvas-bg-active font-semibold' : networkLocked ? '' : 'hover:bg-canvas-bg-hover'} ${networkLocked ? 'opacity-40 cursor-default' : ''}`}
                    >
                      Testnet
                    </button>
                  </div>
                  {networkLocked && (
                    <p className="text-xs text-canvas-text text-center">
                      Network is locked for this session
                    </p>
                  )}
                </div>
                <div className="w-full max-w-sm flex flex-col gap-3">
                  {!isElectronDistribution() && (
                    <>
                      <Button
                        variant="solid"
                        fullWidth
                        onClick={() =>
                          dispatch({ type: 'wallet-connect', wallet: 'simulator', fresh: true })
                        }
                      >
                        Continue with Simulator
                      </Button>
                      <div className="flex items-center gap-2">
                        <div className="flex-1 border-t border-canvas-border" />
                        <span className="text-canvas-text font-medium text-sm">OR</span>
                        <div className="flex-1 border-t border-canvas-border" />
                      </div>
                    </>
                  )}
                  <Button
                    variant="solid"
                    fullWidth
                    onClick={() =>
                      dispatch({ type: 'wallet-connect', wallet: 'walletconnect', fresh: true })
                    }
                  >
                    Link Wallet
                  </Button>
                  <Button
                    variant="solid"
                    fullWidth
                    onClick={() =>
                      dispatch({ type: 'wallet-connect', wallet: 'cloud', fresh: true })
                    }
                  >
                    Cloud Wallet
                  </Button>
                </div>
                {connectError ? (
                  <p className="w-full max-w-sm text-sm text-alert-text text-center break-words">
                    {connectError}
                  </p>
                ) : null}
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
                        onClick={() => dispatch({ type: 'hub-retry' })}
                        className="flex-shrink-0 px-3 py-1.5 rounded-md text-sm font-medium border border-canvas-border hover:bg-canvas-solid transition-colors"
                      >
                        Retry
                      </button>
                    )}
                    <button
                      onClick={() => dispatch({ type: 'hub-disconnect' })}
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
                <HubIframe iframeUrl={iframeUrl} />
              </>
            ) : (
              <HubPicker
                onConnect={(origin) => dispatch({ type: 'hub-connect', origin })}
                connectionError={hubConnectionError}
              />
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
            {terminalFinalizationBlocker && (
              <div
                role="alert"
                className="px-4 py-2 text-sm text-alert-text bg-canvas-bg-subtle border-b border-canvas-border"
              >
                <span className="font-semibold">Session finalization blocked: </span>
                {terminalFinalizationBlocker}
              </div>
            )}
            <GameDashboard
              view={dashboardView}
              balances={statusBarBalances}
              onAction={(action) => dispatch({ type: 'session-action', action })}
              coins={dashboardCoins}
            />
            <div style={{ flex: '1 1 0%', minHeight: 0, overflow: 'auto' }}>
              <Setup2048Provider
                attemptKey={
                  transition.kind === 'pending'
                    ? transition.readyKey
                    : (sessionConfig?.pairingToken ?? null)
                }
              >
                {(() => {
                  const pane = selectGamePaneKind({
                    sessionPaneTransition,
                    keepSession,
                    restoreStatus,
                    restoreError,
                    sessionPhase,
                    hasDashboardModel: dashboardSessionModel !== null,
                    sessionCanMount: sessionConfig !== null,
                  });
                  switch (pane.kind) {
                    case 'transitionCover':
                      return <SessionTransitionSurface />;
                    case 'restoreFailed':
                      return (
                        <div className="w-full h-full flex flex-col items-center justify-center gap-3 text-canvas-text p-8">
                          <h2 className="text-lg font-semibold text-alert-text">Restore failed</h2>
                          <p className="max-w-lg text-sm text-center select-text cursor-text">
                            {pane.error ?? 'The saved session could not be restored.'}
                          </p>
                          <button
                            onClick={() => dispatch({ type: 'reset' })}
                            disabled={startingOver}
                            className="px-4 py-2 rounded-md font-medium text-sm border border-canvas-border text-canvas-text hover:bg-canvas-bg-hover transition-colors disabled:opacity-50"
                          >
                            {startingOver ? 'Starting over\u2026' : 'Start over'}
                          </button>
                        </div>
                      );
                    case 'gameSession':
                      return (
                        <div className="relative w-full h-full">
                          <GameSessionErrorBoundary>
                            {sessionFrontend && sessionPresentation && (
                              <GameSession
                                key={sessionConfig!.pairingToken}
                                params={sessionConfig!}
                                sessionFrontend={sessionFrontend!}
                                presentation={sessionPresentation!}
                                appendGameLog={(line) => dispatch({ type: 'history', line })}
                                suppressPhaseReporting={shouldSuppressPhaseReporting(
                                  restoreBlocked,
                                  terminalPresentation != null,
                                )}
                                terminalPresentation={terminalPresentation}
                                showTransitionSurface={pane.showTransitionSurface}
                              />
                            )}
                          </GameSessionErrorBoundary>
                          {sessionConsentOverlay}
                        </div>
                      );
                    case 'finishedFreeze':
                      return (
                        <div className="relative w-full h-full">
                          <FinishedSessionGameView
                            model={sessionModelForReactProps(dashboardSessionModel!)}
                            myName={finishedSessionIdentity?.myName ?? alias}
                            opponentName={finishedSessionIdentity?.opponentName}
                          />
                          {sessionConsentOverlay}
                        </div>
                      );
                    case 'restoringPlaceholder':
                      return (
                        <div className="w-full h-full flex items-center justify-center text-canvas-solid">
                          Restoring session...
                        </div>
                      );
                    case 'empty':
                      return (
                        <div className="relative w-full h-full">
                          <div className="w-full h-full flex items-center justify-center text-canvas-solid">
                            No active game session
                          </div>
                          {sessionConsentOverlay}
                        </div>
                      );
                  }
                })()}
              </Setup2048Provider>
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
                onClick={() => dispatch({ type: 'confirm' })}
                className="w-full px-4 py-2 rounded-md font-medium text-sm bg-primary-solid text-primary-on-primary hover:bg-primary-solid-hover transition-colors"
              >
                {confirmDialog.confirmLabel ?? 'Proceed'}
              </button>
              <button
                onClick={() => dispatch({ type: 'cancel-confirmation' })}
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
