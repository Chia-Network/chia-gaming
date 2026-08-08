import {
  Component,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
  type ReactNode,
  type ErrorInfo,
} from 'react';
import {
  useGameSession,
  GameTerminalAttentionInfo,
  QueuedNotification,
} from '../hooks/useGameSession';
import { formatMojos } from '../util';
import { getPlayerId } from '../hooks/save';
import { SessionPhase } from '../types/ChiaGaming';
import { RestoreStatus } from '../hooks/SessionController';
import type { BlockchainPoller } from '../hooks/BlockchainPoller';
import { liveGameMountRequest, renderGameMount } from '../lib/gameMountRegistry';
import { isErrorSettlementOutcome } from '../lib/settlement';
import {
  channelStateNeedsGameTabAttention,
  gameplayEventNeedsGameTabAttention,
  peerProposalIdNeedsGameTabAttention,
} from '../lib/gameTabAttention';
import { shouldReportSessionPhase } from '../lib/restoreLifecycle';
import {
  PRE_ACTIVE_CHANNEL_STATES,
  selectInertGameInterfaceForBetweenHandDialog,
  type ChannelStatusModel,
  type SessionModel,
} from '../lib/session/model';

import { motion, useMotionValue, useDragControls } from 'framer-motion';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Separator } from './ui/separator';
import { Button } from './button';
import { ComposeProposalDialog, ReviewProposalDialog } from './GameProposalDialogs';

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface ErrorBoundaryProps {
  children: ReactNode;
}
interface ErrorBoundaryState {
  error: string | null;
  componentStack: string | null;
  dialogDismissed: boolean;
}

function RenderErrorDialog({
  title,
  error,
  componentStack,
  onDismiss,
  onReload,
}: {
  title: string;
  error: string;
  componentStack: string | null;
  onDismiss?: () => void;
  onReload?: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50 p-4"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="render-error-title"
    >
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col gap-3 overflow-hidden rounded-lg border border-alert-text bg-canvas-bg p-4 text-canvas-text shadow-xl">
        <div>
          <h2 id="render-error-title" className="text-lg font-semibold text-alert-text">
            {title}
          </h2>
          <p className="mt-1 text-sm text-canvas-text">
            The game UI hit a render error. The session shell is still running; details are shown
            below.
          </p>
        </div>
        <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all rounded border border-canvas-line bg-canvas-bg-subtle p-3 text-xs select-text cursor-text">
          {error}
        </pre>
        {componentStack && (
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded border border-canvas-line bg-canvas-bg-subtle p-3 text-xs select-text cursor-text">
            {componentStack}
          </pre>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          {onDismiss && (
            <Button variant="outline" size="sm" onClick={onDismiss}>
              Dismiss
            </Button>
          )}
          {onReload && (
            <Button variant="solid" size="sm" onClick={onReload}>
              Reload
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export class GameSessionErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, componentStack: null, dialogDismissed: false };

  static getDerivedStateFromError(err: Error): ErrorBoundaryState {
    return { error: err.stack || err.message, componentStack: null, dialogDismissed: false };
  }

  componentDidCatch(err: Error, info: ErrorInfo) {
    console.error('[GameSession] render crash:', err, info.componentStack);
    this.setState({ componentStack: info.componentStack ?? null });
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex flex-col items-center justify-center gap-4 w-full h-full p-8 text-canvas-text">
          <h2 className="text-xl font-semibold text-alert-text">Something went wrong</h2>
          <p className="text-sm text-canvas-text">
            The session renderer crashed. Reloading is the safest recovery.
          </p>
          <RenderErrorDialog
            title="Session renderer crashed"
            error={this.state.error}
            componentStack={this.state.componentStack}
            onReload={() => window.location.reload()}
          />
          <button
            className="px-4 py-2 rounded bg-canvas-solid text-canvas-bg-subtle hover:opacity-90"
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

interface GameAreaErrorBoundaryProps {
  children: ReactNode;
  resetKey: string;
}

class GameAreaErrorBoundary extends Component<GameAreaErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, componentStack: null, dialogDismissed: false };

  static getDerivedStateFromError(err: Error): ErrorBoundaryState {
    return { error: err.stack || err.message, componentStack: null, dialogDismissed: false };
  }

  componentDidCatch(err: Error, info: ErrorInfo) {
    console.error('[GameSession] game render crash:', err, info.componentStack);
    this.setState({ componentStack: info.componentStack ?? null });
  }

  componentDidUpdate(prevProps: GameAreaErrorBoundaryProps) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null, componentStack: null, dialogDismissed: false });
    }
  }

  render() {
    if (this.state.error) {
      return (
        <>
          {!this.state.dialogDismissed && (
            <RenderErrorDialog
              title="Game renderer crashed"
              error={this.state.error}
              componentStack={this.state.componentStack}
              onDismiss={() => this.setState({ dialogDismissed: true })}
            />
          )}
          <div className="rounded-md border border-alert-text bg-canvas-bg p-4 text-sm text-canvas-text">
            <h2 className="mb-2 font-semibold text-alert-text">Game renderer crashed</h2>
            <p className="mb-3 text-canvas-text">The rest of the session is still available.</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => this.setState({ dialogDismissed: false })}
            >
              Show Error Details
            </Button>
          </div>
        </>
      );
    }
    return this.props.children;
  }
}

function CoinId({ hex }: { hex: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(`0x${hex}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <span className="inline-flex items-center gap-1">
      <span className="font-mono text-[11px] select-all text-canvas-text-contrast">0x{hex}</span>
      <button
        onClick={copy}
        className="inline-flex items-center p-0.5 rounded hover:bg-canvas-bg-hover transition-colors text-canvas-solid hover:text-canvas-text-contrast"
        title="Copy coin ID"
      >
        {copied ? (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="w-3.5 h-3.5"
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
            className="w-3.5 h-3.5"
          >
            <path d="M7 3.5A1.5 1.5 0 0 1 8.5 2h3.879a1.5 1.5 0 0 1 1.06.44l3.122 3.12A1.5 1.5 0 0 1 17 6.622V12.5a1.5 1.5 0 0 1-1.5 1.5h-1v-3.379a3 3 0 0 0-.879-2.121L10.5 5.379A3 3 0 0 0 8.379 4.5H7v-1Z" />
            <path d="M4.5 6A1.5 1.5 0 0 0 3 7.5v9A1.5 1.5 0 0 0 4.5 18h7a1.5 1.5 0 0 0 1.5-1.5v-5.879a1.5 1.5 0 0 0-.44-1.06L9.44 6.439A1.5 1.5 0 0 0 8.378 6H4.5Z" />
          </svg>
        )}
      </button>
    </span>
  );
}

function formatOptionalMojos(raw: string | null): string {
  if (raw == null) return '—';
  try {
    return formatMojos(BigInt(raw));
  } catch {
    return raw;
  }
}

function useViewportClampedDragWithInsets(
  boundsRef: RefObject<HTMLElement | null> | undefined,
  insets: { top?: number; right?: number; bottom?: number; left?: number } = {},
) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const x = useMotionValue(0);
  const y = useMotionValue(0);

  const clampToViewport = useCallback(() => {
    const el = cardRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const boundsRect = boundsRef?.current?.getBoundingClientRect();
    const minX = (boundsRect?.left ?? 0) + (insets.left ?? 0);
    const minY = (boundsRect?.top ?? 0) + (insets.top ?? 0);
    const maxX = (boundsRect?.right ?? window.innerWidth) - (insets.right ?? 0);
    const maxY = (boundsRect?.bottom ?? window.innerHeight) - (insets.bottom ?? 0);
    let nextX = x.get();
    let nextY = y.get();

    if (rect.width >= maxX - minX) {
      nextX -= rect.left - minX;
    } else {
      if (rect.left < minX) nextX -= rect.left - minX;
      if (rect.right > maxX) nextX -= rect.right - maxX;
    }

    if (rect.height >= maxY - minY) {
      nextY -= rect.top - minY;
    } else {
      if (rect.top < minY) nextY -= rect.top - minY;
      if (rect.bottom > maxY) nextY -= rect.bottom - maxY;
    }

    if (nextX !== x.get()) x.set(nextX);
    if (nextY !== y.get()) y.set(nextY);
  }, [boundsRef, insets.bottom, insets.left, insets.right, insets.top, x, y]);

  useEffect(() => {
    const onResize = () => clampToViewport();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [clampToViewport]);

  return { cardRef, x, y, clampToViewport };
}

function ChannelStatusContent({ info }: { info: ChannelStatusModel }) {
  return (
    <>
      {info.advisory && (
        <p className="text-sm text-canvas-text-contrast select-text cursor-text">{info.advisory}</p>
      )}
      {info.coinHex && (
        <p className="text-xs text-canvas-text break-all select-text cursor-text">
          Coin ID: <CoinId hex={info.coinHex} />
        </p>
      )}
      {info.coinAmount && (
        <p className="text-xs text-canvas-text select-text cursor-text">
          Coin amount: {formatOptionalMojos(info.coinAmount)}
        </p>
      )}
    </>
  );
}

function GameTerminalContent({ info }: { info: GameTerminalAttentionInfo }) {
  return (
    <div className="rounded-md border border-canvas-line bg-canvas-bg p-3 text-sm space-y-2 select-text cursor-text">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-canvas-text">My reward:</span>
        <span className="font-semibold text-canvas-text-contrast">
          {formatOptionalMojos(info.myReward)}
        </span>
      </p>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-canvas-text">Reward coin ID:</span>
        {info.rewardCoinHex ? (
          <CoinId hex={info.rewardCoinHex} />
        ) : (
          <span className="font-semibold text-canvas-text-contrast">None</span>
        )}
      </p>
    </div>
  );
}

function NotificationOverlay({
  notification,
  onDismiss,
  boundsRef,
  zClass,
  focusBoundaryPriority,
}: {
  notification: QueuedNotification;
  onDismiss: () => void;
  boundsRef: RefObject<HTMLElement | null>;
  zClass: string;
  focusBoundaryPriority: number;
}) {
  const { cardRef, x, y, clampToViewport } = useViewportClampedDragWithInsets(boundsRef, {
    top: 8,
  });
  const dragControls = useDragControls();
  const isError = notification.kind === 'infra-error' || notification.kind === 'action-failed';
  const titleColor = 'text-canvas-text-contrast';

  return (
    <motion.div
      key={String(notification.id)}
      ref={cardRef}
      drag
      dragControls={dragControls}
      dragListener={false}
      dragMomentum={false}
      dragElastic={0}
      initial={false}
      style={{ x, y }}
      onDrag={clampToViewport}
      onDragEnd={clampToViewport}
      className={`absolute ${zClass} left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2`}
      data-between-hand-focus-boundary={focusBoundaryPriority}
    >
      <Card className="theme-inverted w-full max-w-md shadow-xl bg-canvas-bg-subtle border border-canvas-line">
        <CardHeader
          className="text-center pb-2 cursor-grab active:cursor-grabbing"
          onPointerDown={(e) => dragControls.start(e)}
        >
          <CardTitle className={`text-xl ${titleColor}`}>{notification.title}</CardTitle>
        </CardHeader>
        <Separator />
        <CardContent className="pt-4 flex flex-col gap-2">
          {notification.kind === 'channel-state' &&
            notification.payload &&
            'state' in notification.payload && (
              <ChannelStatusContent info={notification.payload as ChannelStatusModel} />
            )}
          {notification.kind === 'game-terminal' &&
            notification.payload &&
            'label' in notification.payload && (
              <GameTerminalContent info={notification.payload as GameTerminalAttentionInfo} />
            )}
          {isError && notification.message && (
            <pre className="text-sm text-canvas-text-contrast whitespace-pre-wrap break-all font-sans select-text cursor-text max-h-[60vh] overflow-auto">
              {notification.message}
            </pre>
          )}
          {!isError &&
            notification.kind !== 'channel-state' &&
            notification.kind !== 'game-terminal' &&
            notification.message && (
              <p className="text-sm text-canvas-text-contrast text-center select-text cursor-text">
                {notification.message}
              </p>
            )}
          <Button
            variant="solid"
            size="sm"
            onClick={onDismiss}
            className="self-center min-w-[96px]"
          >
            Dismiss
          </Button>
        </CardContent>
      </Card>
    </motion.div>
  );
}

function BetweenHandOverlay({
  children,
  restoreFocus,
}: {
  children: ReactNode;
  restoreFocus: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const notificationFocusables = () =>
      Array.from(document.querySelectorAll<HTMLElement>('[data-between-hand-focus-boundary]'))
        .sort(
          (a, b) =>
            Number(b.dataset.betweenHandFocusBoundary) - Number(a.dataset.betweenHandFocusBoundary),
        )
        .flatMap((boundary) =>
          Array.from(boundary.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)),
        );
    const focusable = () =>
      Array.from(document.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (element) =>
          dialog.contains(element) ||
          element.closest('[data-between-hand-focus-boundary]') !== null,
      );
    (notificationFocusables()[0] ?? focusable()[0] ?? dialog).focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const elements = focusable();
      if (elements.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = elements[0];
      const last = elements[elements.length - 1];
      const activeElement = document.activeElement;
      const activeIndex = elements.indexOf(activeElement as HTMLElement);
      if (activeIndex === -1) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      if (previouslyFocused?.isConnected && previouslyFocused !== document.body) {
        previouslyFocused.focus();
      } else {
        restoreFocus();
      }
    };
  }, [restoreFocus]);

  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-labelledby="between-hand-dialog-title"
      className="absolute inset-0 z-30 flex items-center justify-center overflow-y-auto bg-canvas-bg/90 p-4 focus:outline-none"
    >
      <h2 id="between-hand-dialog-title" className="sr-only">
        Between-hand proposal
      </h2>
      {children}
    </div>
  );
}

export interface GameSessionProps {
  params: import('../types/ChiaGaming').GameSessionParams;
  peerConn: import('../types/ChiaGaming').PeerConnectionResult;
  registerMessageHandler: (
    handler: (msgno: number, msg: Uint8Array) => void,
    ackHandler: (ack: number) => void,
    keepaliveHandler: () => void,
  ) => void;
  appendGameLog: (line: string) => void;
  sessionSave?: import('../hooks/save').SessionSave;
  onGameActivity?: () => void;
  onSessionPhaseChange?: (phase: Exclude<SessionPhase, 'none'>, hasError: boolean) => void;
  onRestoreStatusChange?: (status: RestoreStatus, error: string | null) => void;
  onSessionModelChange?: (model: SessionModel) => void;
  onProtocolStateProviderChange?: (getter: (() => string | null) | null) => void;
  onCoinsProviderChange?: (
    getter: (() => import('../types/ChiaGaming').CoinOfInterestEntry[]) | null,
  ) => void;
  suppressPhaseReporting?: boolean;
  blockchain: BlockchainPoller | null;
}

const GameSession: React.FC<GameSessionProps> = ({
  params,
  peerConn,
  registerMessageHandler,
  appendGameLog,
  sessionSave,
  onGameActivity,
  onSessionPhaseChange,
  onRestoreStatusChange,
  onSessionModelChange,
  onProtocolStateProviderChange,
  onCoinsProviderChange,
  suppressPhaseReporting,
  blockchain,
}) => {
  const uniqueId = getPlayerId();

  const session = useGameSession(
    params,
    uniqueId,
    peerConn,
    registerMessageHandler,
    appendGameLog,
    sessionSave,
    blockchain,
  );

  useEffect(() => {
    onRestoreStatusChange?.(session.restoreStatus, session.restoreError);
  }, [session.restoreStatus, session.restoreError, onRestoreStatusChange]);

  useEffect(() => {
    onSessionModelChange?.(session.sessionModel);
  }, [session.sessionModel, onSessionModelChange]);

  useEffect(() => {
    if (!onProtocolStateProviderChange) return;
    const gameObject = session.sessionController;
    onProtocolStateProviderChange(() => gameObject.getProtocolStatePretty());
    return () => onProtocolStateProviderChange(null);
  }, [session.sessionController, onProtocolStateProviderChange]);

  useEffect(() => {
    if (!onCoinsProviderChange) return;
    const gameObject = session.sessionController;
    onCoinsProviderChange(() => gameObject.getCoinsOfInterest());
    return () => onCoinsProviderChange(null);
  }, [session.sessionController, onCoinsProviderChange]);

  const resolvedPhaseReportedRef = useRef(false);
  useEffect(() => {
    const phase = session.sessionPhase;
    if (
      !onSessionPhaseChange ||
      !shouldReportSessionPhase(phase, !!suppressPhaseReporting, resolvedPhaseReportedRef.current)
    ) {
      return;
    }
    const settledOutcome = session.gameTerminal.outcome;
    const hasError =
      session.channelStatus.state === 'Failed' ||
      session.channelStatus.state === 'ResolvedStale' ||
      session.gameTerminal.type === 'game-error' ||
      (session.gameTerminal.type === 'settled' &&
        settledOutcome != null &&
        isErrorSettlementOutcome(settledOutcome));
    if (phase === 'resolved') {
      resolvedPhaseReportedRef.current = true;
    }
    onSessionPhaseChange(phase, hasError);
  }, [
    session.sessionPhase,
    session.channelStatus.state,
    session.gameTerminal.type,
    session.gameTerminal.outcome,
    onSessionPhaseChange,
    suppressPhaseReporting,
  ]);

  useEffect(() => {
    if (!onGameActivity) return;
    const sub = session.gameplayEvent$.subscribe((evt) => {
      if (gameplayEventNeedsGameTabAttention(evt)) {
        onGameActivity();
      }
    });
    return () => sub.unsubscribe();
  }, [session.gameplayEvent$, onGameActivity]);

  const prevGameQueueLen = useRef(session.gameQueue.length);
  const prevChannelQueueLen = useRef(session.channelQueue.length);
  useEffect(() => {
    const grew =
      session.gameQueue.length > prevGameQueueLen.current ||
      session.channelQueue.length > prevChannelQueueLen.current;
    prevGameQueueLen.current = session.gameQueue.length;
    prevChannelQueueLen.current = session.channelQueue.length;
    if (grew) onGameActivity?.();
  }, [session.gameQueue.length, session.channelQueue.length, onGameActivity]);

  // Rising edge: peer hand proposal enters review (skip restore/hydration).
  const prevBetweenHandMode = useRef(session.betweenHandMode);
  useEffect(() => {
    const prev = prevBetweenHandMode.current;
    prevBetweenHandMode.current = session.betweenHandMode;
    if (
      session.betweenHandMode === 'review-incoming-proposal' &&
      prev !== 'review-incoming-proposal'
    ) {
      onGameActivity?.();
    }
  }, [session.betweenHandMode, onGameActivity]);

  // Rising edge: proposal cached in decision mode, or replaced while reviewing.
  // Combined id so promoting cache → review does not double-fire.
  const attentionProposalId =
    session.reviewPeerProposal?.id ?? session.cachedPeerProposal?.id ?? null;
  const prevAttentionProposalId = useRef(attentionProposalId);
  useEffect(() => {
    const prev = prevAttentionProposalId.current;
    prevAttentionProposalId.current = attentionProposalId;
    if (peerProposalIdNeedsGameTabAttention(prev, attentionProposalId)) {
      onGameActivity?.();
    }
  }, [attentionProposalId, onGameActivity]);

  // Rising edge: clean shutdown / going on-chain begins (skip restore and
  // transitions between already-attention channel states).
  const prevChannelAttention = useRef(
    channelStateNeedsGameTabAttention(session.channelStatus.state),
  );
  useEffect(() => {
    const next = channelStateNeedsGameTabAttention(session.channelStatus.state);
    const prev = prevChannelAttention.current;
    prevChannelAttention.current = next;
    if (next && !prev) {
      onGameActivity?.();
    }
  }, [session.channelStatus.state, onGameActivity]);

  const channelOverlayBoundsRef = useRef<HTMLDivElement | null>(null);
  const gameAreaRef = useRef<HTMLDivElement | null>(null);
  const restoreGameAreaFocus = useCallback(() => gameAreaRef.current?.focus(), []);

  const maxPerHandMojos = (() => {
    const ours = session.channelStatus.ourBalance;
    const theirs = session.channelStatus.theirBalance;
    if (ours == null || theirs == null) return null;
    try {
      const a = BigInt(ours);
      const b = BigInt(theirs);
      return a < b ? a : b;
    } catch {
      return null;
    }
  })();

  const handEverStarted = session.handKey > 0;
  const hasPersistedGameState = !!session.gameSpecificView.handState;
  const hasReviewPeerProposal = session.reviewPeerProposal != null;
  const showBetweenHandOverlay =
    session.betweenHands &&
    session.channelStatus.state === 'Active' &&
    !session.cleanShutdownStarted &&
    (session.betweenHandMode === 'compose-proposal' ||
      (session.betweenHandMode === 'review-incoming-proposal' && hasReviewPeerProposal));
  const gameInterfaceIsInertForBetweenHandDialog = selectInertGameInterfaceForBetweenHandDialog(
    session.betweenHands,
    session.betweenHandMode,
    hasReviewPeerProposal,
    showBetweenHandOverlay,
  );
  const gameSpecificView = session.gameSpecificView;
  const showGameInterface =
    handEverStarted && (!!gameSpecificView.displayGameId || hasPersistedGameState);

  if (suppressPhaseReporting) {
    return (
      <div className="w-full h-full flex items-center justify-center text-canvas-solid">
        Restoring session...
      </div>
    );
  }

  return (
    <div className="relative w-full h-full min-h-0 flex flex-col bg-canvas-bg-subtle text-canvas-text pt-6">
      <div ref={channelOverlayBoundsRef} className="absolute inset-0 pointer-events-none" />
      {session.gameQueue[0] && (
        <NotificationOverlay
          notification={session.gameQueue[0]}
          onDismiss={session.dismissGame}
          boundsRef={channelOverlayBoundsRef}
          zClass="z-40"
          focusBoundaryPriority={40}
        />
      )}
      {/* Main content area */}
      <div className="flex flex-col gap-2 px-4 pb-2 sm:px-6 md:px-8">
        {/* Game area — z-0 creates a stacking context so card zIndexes (up to 100) can't escape */}
        <div
          ref={gameAreaRef}
          tabIndex={-1}
          inert={gameInterfaceIsInertForBetweenHandDialog}
          className="relative overflow-hidden z-0 focus:outline-none"
        >
          {showGameInterface && (
            <GameAreaErrorBoundary
              resetKey={`${gameSpecificView.gameType}:${session.handKey}:${session.activeGameId ?? gameSpecificView.displayGameId ?? ''}`}
            >
              <Suspense
                fallback={
                  <div className="flex items-center justify-center py-20 text-canvas-text">
                    Loading game…
                  </div>
                }
              >
                {renderGameMount(
                  liveGameMountRequest(session, {
                    myName: params.myAlias,
                    opponentName: params.opponentAlias,
                  }),
                )}
              </Suspense>
            </GameAreaErrorBoundary>
          )}

          {(!handEverStarted || PRE_ACTIVE_CHANNEL_STATES.has(session.channelStatus.state)) && (
            <div className="flex items-center justify-center py-20">
              <p className="text-canvas-text">Setting up channel…</p>
            </div>
          )}
          {handEverStarted &&
            !PRE_ACTIVE_CHANNEL_STATES.has(session.channelStatus.state) &&
            !gameSpecificView.displayGameId &&
            !hasPersistedGameState &&
            !session.betweenHands && (
              <div className="flex items-center justify-center py-20">
                <p className="text-canvas-text">Waiting for next hand…</p>
              </div>
            )}
        </div>

        {/* Between-hand session controls — only when the channel is Active */}
        {session.betweenHands &&
          session.channelStatus.state === 'Active' &&
          !session.cleanShutdownStarted && (
            <>
              {session.betweenHandMode === 'decision' && (
                <div className="relative flex w-full items-center justify-center py-2">
                  <Button
                    variant="solid"
                    color="primary"
                    size="sm"
                    onClick={session.chooseNewHandSameTerms}
                    disabled={session.newHandRequested}
                  >
                    {session.newHandRequested ? 'Waiting\u2026' : 'New Hand'}
                  </Button>
                  <Button
                    variant="ghost"
                    color="neutral"
                    size="sm"
                    className="absolute right-2"
                    onClick={session.chooseDoNotUseCurrentProposal}
                    leadingIcon={<span className="text-base leading-none">&times;</span>}
                  >
                    Close
                  </Button>
                </div>
              )}
            </>
          )}
      </div>

      {showBetweenHandOverlay && (
        <BetweenHandOverlay restoreFocus={restoreGameAreaFocus}>
          {session.betweenHandMode === 'compose-proposal' && (
            <ComposeProposalDialog session={session} maxPerHandMojos={maxPerHandMojos} />
          )}
          {session.betweenHandMode === 'review-incoming-proposal' && session.reviewPeerProposal && (
            <ReviewProposalDialog session={session} />
          )}
        </BetweenHandOverlay>
      )}

      {session.channelQueue[0] && (
        <NotificationOverlay
          notification={session.channelQueue[0]}
          onDismiss={session.dismissChannel}
          boundsRef={channelOverlayBoundsRef}
          zClass="z-50"
          focusBoundaryPriority={50}
        />
      )}
    </div>
  );
};

export default GameSession;
