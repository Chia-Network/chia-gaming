import { Component, useCallback, useEffect, useRef, useState, type RefObject, type ReactNode, type ErrorInfo } from 'react';
import { Observable } from 'rxjs';
import { useGameSession, ChannelStatusInfo, GameTerminalAttentionInfo, GameTurnState, GameplayEvent, isWindingDown, deriveSessionPhase, QueuedNotification } from '../hooks/useGameSession';
import { useCalpokerHand } from '../hooks/useCalpokerHand';
import { CalpokerHandState, CalpokerDisplaySnapshot } from '../hooks/save';
import { formatMojos, formatAmount } from '../util';
import { getPlayerId } from '../hooks/save';
import { CalpokerOutcome, ChannelState, SessionPhase } from '../types/ChiaGaming';
import { WasmBlobWrapper } from '../hooks/WasmBlobWrapper';
import Calpoker from '../features/calPoker';

import { motion, useMotionValue, useDragControls } from 'framer-motion';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Separator } from './ui/separator';
import { Button } from './button';
import { AmountInput } from './AmountInput';

interface ErrorBoundaryProps { children: ReactNode; }
interface ErrorBoundaryState { error: string | null; }

export class GameSessionErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(err: Error): ErrorBoundaryState {
    return { error: err.stack || err.message };
  }

  componentDidCatch(err: Error, info: ErrorInfo) {
    console.error('[GameSession] render crash:', err, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className='flex flex-col items-center justify-center gap-4 w-full h-full p-8 text-canvas-text'>
          <h2 className='text-xl font-semibold text-alert-text'>Something went wrong</h2>
          <pre className='text-xs whitespace-pre-wrap break-all max-w-lg max-h-[40vh] overflow-auto select-text cursor-text bg-canvas-bg p-4 rounded border border-canvas-line'>{this.state.error}</pre>
          <button
            className='px-4 py-2 rounded bg-canvas-solid text-canvas-bg-subtle hover:opacity-90'
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
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
            <path fillRule="evenodd" d="M16.704 4.153a.75.75 0 0 1 .143 1.052l-8 10.5a.75.75 0 0 1-1.127.075l-4.5-4.5a.75.75 0 0 1 1.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 0 1 1.05-.143Z" clipRule="evenodd" />
          </svg>
        ) : (
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
            <path d="M7 3.5A1.5 1.5 0 0 1 8.5 2h3.879a1.5 1.5 0 0 1 1.06.44l3.122 3.12A1.5 1.5 0 0 1 17 6.622V12.5a1.5 1.5 0 0 1-1.5 1.5h-1v-3.379a3 3 0 0 0-.879-2.121L10.5 5.379A3 3 0 0 0 8.379 4.5H7v-1Z" />
            <path d="M4.5 6A1.5 1.5 0 0 0 3 7.5v9A1.5 1.5 0 0 0 4.5 18h7a1.5 1.5 0 0 0 1.5-1.5v-5.879a1.5 1.5 0 0 0-.44-1.06L9.44 6.439A1.5 1.5 0 0 0 8.378 6H4.5Z" />
          </svg>
        )}
      </button>
    </span>
  );
}

const CHANNEL_STATE_LABELS: Record<ChannelState, string> = {
  Handshaking: 'Handshaking',
  WaitingForHeightToOffer: 'Waiting For Height To Offer',
  WaitingForHeightToAccept: 'Waiting For Height To Accept',
  WaitingForOffer: 'Waiting For Offer',
  OfferSent: 'Offer Sent',
  TransactionPending: 'Tx Pending',
  Active: 'Active',
  ShuttingDown: 'Shutting Down',
  ShutdownTransactionPending: 'Shutdown Tx Pending',
  GoingOnChain: 'Going On Chain',
  Unrolling: 'Unrolling',
  ResolvedClean: 'Resolved Clean',
  ResolvedUnrolled: 'Resolved Unrolled',
  ResolvedStale: 'Resolved Stale',
  Failed: 'Failed',
};

const GAME_TURN_LABELS: Record<GameTurnState, string> = {
  'my-turn': 'Your turn',
  'their-turn': 'Their turn',
  'playing-on-chain': 'Playing our move on-chain',
  'replaying': 'Replaying our move on-chain',
  'opponent-illegal-move': 'Your turn (opponent attempted illegal move)',
  'ended': 'Ended',
};

function channelCoinLabelForState(state: ChannelState): string {
  if (state === 'ResolvedClean' || state === 'ResolvedUnrolled' || state === 'ResolvedStale') {
    return 'Channel reward coin ID';
  }
  if (state === 'Unrolling') {
    return 'Unroll coin ID';
  }
  return 'Channel coin ID';
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


function ChannelStateContent({ info }: { info: ChannelStatusInfo }) {
  return (
    <>
      {info.advisory && (
        <p className='text-sm text-canvas-text-contrast select-text cursor-text'>{info.advisory}</p>
      )}
      {info.coinHex && (
        <p className='text-xs text-canvas-text break-all select-text cursor-text'>
          Coin ID: <CoinId hex={info.coinHex} />
        </p>
      )}
      {info.coinAmount && (
        <p className='text-xs text-canvas-text select-text cursor-text'>
          Coin amount: {formatOptionalMojos(info.coinAmount)} mojos
        </p>
      )}
    </>
  );
}

function GameTerminalContent({ info }: { info: GameTerminalAttentionInfo }) {
  return (
    <div className='rounded-md border border-canvas-line bg-canvas-bg p-3 text-sm space-y-2 select-text cursor-text'>
      <p className='flex flex-wrap items-center gap-x-2 gap-y-1'>
        <span className='text-canvas-text'>My reward:</span>
        <span className='font-semibold text-canvas-text-contrast'>
          {formatOptionalMojos(info.myReward)}
        </span>
      </p>
      <p className='flex flex-wrap items-center gap-x-2 gap-y-1'>
        <span className='text-canvas-text'>Reward coin ID:</span>
        {info.rewardCoinHex ? (
          <CoinId hex={info.rewardCoinHex} />
        ) : (
          <span className='font-semibold text-canvas-text-contrast'>None</span>
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
}: {
  notification: QueuedNotification;
  onDismiss: () => void;
  boundsRef: RefObject<HTMLElement | null>;
  zClass: string;
}) {
  const { cardRef, x, y, clampToViewport } = useViewportClampedDragWithInsets(boundsRef, { top: 8 });
  const dragControls = useDragControls();
  const isError = notification.kind === 'infra-error' || notification.kind === 'action-failed';
  const titleColor = isError ? 'text-alert-text' : 'text-canvas-text-contrast';

  return (
    <motion.div
      key={notification.id}
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
    >
      <Card className='theme-inverted w-full max-w-md shadow-xl bg-canvas-bg-subtle border border-canvas-line'>
        <CardHeader
          className='text-center pb-2 cursor-grab active:cursor-grabbing'
          onPointerDown={(e) => dragControls.start(e)}
        >
          <CardTitle className={`text-xl ${titleColor}`}>{notification.title}</CardTitle>
        </CardHeader>
        <Separator />
        <CardContent className='pt-4 flex flex-col gap-2'>
          {notification.kind === 'channel-state' && notification.payload && 'state' in notification.payload && (
            <ChannelStateContent info={notification.payload as ChannelStatusInfo} />
          )}
          {notification.kind === 'game-terminal' && notification.payload && 'label' in notification.payload && (
            <GameTerminalContent info={notification.payload as GameTerminalAttentionInfo} />
          )}
          {isError && notification.message && (
            <pre className='text-sm text-canvas-text-contrast whitespace-pre-wrap break-all font-sans select-text cursor-text max-h-[60vh] overflow-auto'>{notification.message}</pre>
          )}
          {!isError && notification.kind !== 'channel-state' && notification.kind !== 'game-terminal' && notification.message && (
            <p className='text-sm text-canvas-text-contrast text-center select-text cursor-text'>{notification.message}</p>
          )}
          <Button variant='solid' size='sm' onClick={onDismiss} className='self-center min-w-[96px]'>
            Dismiss
          </Button>
        </CardContent>
      </Card>
    </motion.div>
  );
}

interface CalpokerHandProps {
  gameObject: WasmBlobWrapper;
  gameId: string;
  iStarted: boolean;
  playerNumber: number;
  gameplayEvent$: Observable<GameplayEvent>;
  onOutcome: (outcome: CalpokerOutcome) => void;
  onTurnChanged: (isMyTurn: boolean) => void;
  appendGameLog: (line: string) => void;
  perGameAmount: bigint;
  initialHandState?: CalpokerHandState;
  myName?: string;
  opponentName?: string;
}

function CalpokerHand({
  gameObject,
  gameId,
  iStarted,
  playerNumber,
  gameplayEvent$,
  onOutcome,
  onTurnChanged,
  appendGameLog,
  perGameAmount,
  initialHandState,
  myName,
  opponentName,
}: CalpokerHandProps) {
  const {
    playerHand,
    opponentHand,
    cardSelections,
    setCardSelections,
    moveNumber,
    outcome,
    handleMakeMove,
    handleCheat,
    handleNerf,
    saveDisplaySnapshot,
    initialDisplaySnapshot,
  } = useCalpokerHand(
    gameObject,
    gameId,
    iStarted,
    gameplayEvent$,
    onOutcome,
    onTurnChanged,
    initialHandState,
  );

  const handleGameLog = useCallback((lines: string[]) => {
    appendGameLog(`California Poker ${formatAmount(perGameAmount)}`);
    lines.forEach(l => appendGameLog(l));
    appendGameLog('');
  }, [appendGameLog, perGameAmount]);

  return (
    <Calpoker
      outcome={outcome}
      moveNumber={moveNumber}
      playerNumber={playerNumber}
      playerHand={playerHand}
      opponentHand={opponentHand}
      cardSelections={cardSelections}
      setCardSelections={setCardSelections}
      handleMakeMove={handleMakeMove}
      handleCheat={handleCheat}
      handleNerf={handleNerf}
      onGameLog={handleGameLog}
      onSnapshotChange={saveDisplaySnapshot}
      initialSnapshot={initialDisplaySnapshot}
      myName={myName}
      opponentName={opponentName}
    />
  );
}

export interface GameSessionProps {
  params: import('../types/ChiaGaming').GameSessionParams;
  peerConn: import('../types/ChiaGaming').PeerConnectionResult;
  trackerLiveness?: import('../types/ChiaGaming').TrackerLiveness | null;
  peerConnected?: boolean | null;
  registerMessageHandler: (handler: (msgno: number, msg: Uint8Array) => void, ackHandler: (ack: number) => void, keepaliveHandler: () => void) => void;
  appendGameLog: (line: string) => void;
  sessionSave?: import('../hooks/save').SessionState;
  onGameActivity?: () => void;
  onSessionPhaseChange?: (phase: Exclude<SessionPhase, 'none'>, hasError: boolean) => void;
}

const TRACKER_LIVENESS_LABELS: Record<string, string> = {
  connected: 'Connected',
  reconnecting: 'Reconnecting',
  inactive: 'Inactive',
  disconnected: 'Disconnected',
};

const GameSession: React.FC<GameSessionProps> = ({ params, peerConn, trackerLiveness, peerConnected, registerMessageHandler, appendGameLog, sessionSave, onGameActivity, onSessionPhaseChange }) => {
  const uniqueId = getPlayerId();

  const session = useGameSession(params, uniqueId, peerConn, registerMessageHandler, appendGameLog, sessionSave);

  useEffect(() => {
    if (!onSessionPhaseChange) return;
    const phase = deriveSessionPhase(session.channelStatus.state, session.goOnChainPressed);
    const hasError =
      session.channelStatus.state === 'Failed' ||
      session.channelStatus.state === 'ResolvedStale' ||
      session.gameTerminal.type === 'opponent-successfully-cheated' ||
      session.gameTerminal.type === 'game-error' ||
      (session.gameTerminal.type === 'we-timed-out' && !session.gameTerminal.cleanEnd);
    onSessionPhaseChange(phase, hasError);
  }, [session.channelStatus.state, session.goOnChainPressed, session.gameTerminal.type, session.gameTerminal.cleanEnd, onSessionPhaseChange]);

  useEffect(() => {
    if (!onGameActivity) return;
    const sub = session.gameplayEvent$.subscribe((evt) => {
      if ('OpponentMoved' in evt || 'ProposalAccepted' in evt) {
        onGameActivity();
      }
    });
    return () => sub.unsubscribe();
  }, [session.gameplayEvent$, onGameActivity]);

  const prevGameQueueLen = useRef(session.gameQueue.length);
  const prevChannelQueueLen = useRef(session.channelQueue.length);
  useEffect(() => {
    const grew = session.gameQueue.length > prevGameQueueLen.current ||
                 session.channelQueue.length > prevChannelQueueLen.current;
    prevGameQueueLen.current = session.gameQueue.length;
    prevChannelQueueLen.current = session.channelQueue.length;
    if (grew) onGameActivity?.();
  }, [session.gameQueue.length, session.channelQueue.length, onGameActivity]);

  const channelOverlayBoundsRef = useRef<HTMLDivElement | null>(null);
  const gameAreaRef = useRef<HTMLDivElement | null>(null);

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
  const hideGameInterfaceForBetweenHandDialog =
    session.betweenHands &&
    (session.betweenHandMode === 'compose-proposal' || session.betweenHandMode === 'review-incoming-proposal');
  const showGameInterface = handEverStarted && !!session.displayGameId && !hideGameInterfaceForBetweenHandDialog;
  const channelStateLabel = session.channelStatus.state === 'Active' && session.channelStatus.havePotato
    ? 'Active \u{1F954}'
    : CHANNEL_STATE_LABELS[session.channelStatus.state] ?? session.channelStatus.state;
  const channelCoinLabel = channelCoinLabelForState(session.channelStatus.state);
  const gameStateLabel = session.gameTerminal.label ?? GAME_TURN_LABELS[session.gameCoin.turnState];
  const gameCoinLabel = session.gameTerminal.type !== 'none' ? 'Game reward coin ID' : 'Game coin ID';
  const gameCoinOrRewardHex = session.gameTerminal.rewardCoinHex ?? session.gameCoin.coinHex;

  return (
    <div className='relative w-full h-full min-h-0 flex flex-col bg-canvas-bg-subtle text-canvas-text pt-6'>
      <div ref={channelOverlayBoundsRef} className='absolute inset-0 pointer-events-none' />
      {session.gameQueue[0] && (
        <NotificationOverlay
          notification={session.gameQueue[0]}
          onDismiss={session.dismissGame}
          boundsRef={channelOverlayBoundsRef}
          zClass='z-40'
        />
      )}
      {/* Session header (shrink-0) */}
      <div className='flex-shrink-0 px-4 pt-3 pb-2 sm:px-6 md:px-8'>
        {/* Report + end session */}
        <div className='flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between'>
          <div className='flex flex-col gap-1 text-sm text-canvas-text'>
            <div className='flex flex-wrap items-center gap-x-2 gap-y-0.5'>
              <span className='text-canvas-text'>Channel size:</span>
              <span className='font-medium'>{formatMojos(session.amount * 2n)}</span>
              <span className='text-canvas-solid'>·</span>
              <span className='text-canvas-text'>My Stack:</span>
              <span className='font-medium'>{formatOptionalMojos(session.channelStatus.ourBalance)}</span>
            </div>
            <div className='flex flex-wrap items-center gap-x-2 gap-y-0.5'>
              <span className='text-canvas-text'>Game terms:</span>
              <span className='font-medium'>California Poker</span>
              <span className='text-canvas-solid'>·</span>
              <span className='text-canvas-text'>Game size:</span>
              <span className='font-medium'>{formatMojos(session.currentHandAmount * 2n)}</span>
            </div>
            <div className='flex flex-wrap items-center gap-x-2 gap-y-0.5'>
              <span className='text-canvas-text'>Channel status:</span>
              <span className='font-medium'>{channelStateLabel}</span>
            </div>
            <div className='flex flex-wrap items-center gap-x-2 gap-y-0.5'>
              <span className='text-canvas-text'>{channelCoinLabel}:</span>
              {session.channelStatus.coinHex ? (
                <CoinId hex={session.channelStatus.coinHex} />
              ) : (
                <span className='font-medium'>None</span>
              )}
            </div>
            <div className='flex flex-wrap items-center gap-x-2 gap-y-0.5'>
              <span className='text-canvas-text'>Tracker:</span>
              <span className='font-medium'>
                {trackerLiveness ? TRACKER_LIVENESS_LABELS[trackerLiveness] : 'Unknown'}
              </span>
              <span className='text-canvas-solid'>·</span>
              <span className='text-canvas-text'>Peer:</span>
              <span className='font-medium'>
                {peerConnected === null ? 'Unknown' : peerConnected ? 'Active' : 'Inactive'}
              </span>
            </div>
            <div className='flex flex-wrap items-center gap-x-2 gap-y-0.5'>
              <span className='text-canvas-text'>Game state:</span>
              <span className='font-medium'>{gameStateLabel}</span>
            </div>
            <div className='flex flex-wrap items-center gap-x-2 gap-y-0.5'>
              <span className='text-canvas-text'>{gameCoinLabel}:</span>
              {gameCoinOrRewardHex ? (
                <CoinId hex={gameCoinOrRewardHex} />
              ) : (
                <span className='font-medium'>None</span>
              )}
              <span className='text-canvas-solid'>·</span>
              <span className='text-canvas-text'>My reward:</span>
              <span className='font-medium'>{formatOptionalMojos(session.gameTerminal.myReward)}</span>
            </div>
          </div>
          <div className='flex flex-col items-stretch gap-2 mt-2 sm:mt-0'>
            <Button
              data-testid='go-on-chain'
              variant='solid'
              onClick={session.goOnChain}
              size='sm'
              disabled={session.goOnChainPressed || isWindingDown(session.channelStatus.state) || session.channelStatus.state === 'ShuttingDown'}
            >
              Go On-Chain
            </Button>
          </div>
        </div>

        <Separator className='mt-2' />
      </div>

      {/* Main content area */}
      <div className='flex flex-col gap-2 px-4 pb-2 sm:px-6 md:px-8'>
        {/* Game area — z-0 creates a stacking context so card zIndexes (up to 100) can't escape */}
          <div ref={gameAreaRef} className='relative overflow-hidden z-0'>
          {showGameInterface && (
            <CalpokerHand
              key={session.handKey}
              gameObject={session.gameObject}
              gameId={session.activeGameId ?? session.displayGameId ?? ''}
              iStarted={session.iStarted}
              playerNumber={session.playerNumber}
              gameplayEvent$={session.gameplayEvent$}
              onOutcome={session.onHandOutcome}
              onTurnChanged={session.onTurnChanged}
              appendGameLog={session.appendGameLog}
              perGameAmount={session.currentHandAmount}
              initialHandState={session.handKey === 1 && sessionSave?.handState ? sessionSave.handState : undefined}
              myName={params.myAlias}
              opponentName={params.opponentAlias}
            />
          )}

          {/* Waiting for first hand */}
          {!handEverStarted && (
            <div className='flex items-center justify-center py-20'>
              <p className='text-canvas-text'>Waiting for game to start…</p>
            </div>
          )}
          {handEverStarted && !session.displayGameId && !session.betweenHands && (
            <div className='flex items-center justify-center py-20'>
              <p className='text-canvas-text'>Waiting for game to start…</p>
            </div>
          )}

        </div>

        {/* Between-hand session controls */}
        {session.betweenHands && !isWindingDown(session.channelStatus.state) && session.channelStatus.state !== 'ShuttingDown' && (
          <>
            {session.betweenHandMode === 'decision' && (
              <div className='relative flex w-full items-center justify-center py-2'>
                <Button
                  variant='solid'
                  color='primary'
                  size='sm'
                  onClick={session.chooseNewHandSameTerms}
                  disabled={session.newHandRequested}
                >
                  {session.newHandRequested ? 'Waiting\u2026' : 'New Hand'}
                </Button>
                <Button
                  variant='ghost'
                  color='neutral'
                  size='sm'
                  className='absolute right-2'
                  onClick={session.chooseDoNotUseCurrentProposal}
                  leadingIcon={<span className='text-base leading-none'>&times;</span>}
                  iconOnly
                />
              </div>
            )}

            {session.betweenHandMode === 'compose-proposal' && (
              <div className='mx-auto w-full max-w-xl rounded-md border border-canvas-line bg-canvas-bg p-4'>
                <div className='flex flex-col gap-3'>
                  <p className='text-sm text-canvas-text-contrast'>Propose terms for the next hand.</p>
                  <AmountInput
                    valueMojos={session.composePerHandAmount}
                    onChange={session.setComposePerHandAmount}
                    maxMojos={maxPerHandMojos}
                    onUseMax={maxPerHandMojos != null ? () => session.setComposePerHandAmount(maxPerHandMojos) : undefined}
                    disabled={session.composeProposalSent}
                    label='Per-player stake'
                    exceedsLabel='Exceeds available reserve.'
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !session.composeProposalSent && session.composePerHandAmount > 0n) {
                        session.submitComposedProposal(session.composePerHandAmount);
                      }
                    }}
                  />
                  <div className='flex flex-wrap items-center gap-3'>
                    <Button
                      variant='solid'
                      color='primary'
                      size='sm'
                      disabled={session.composeProposalSent || session.composePerHandAmount <= 0n}
                      onClick={() => session.submitComposedProposal(session.composePerHandAmount)}
                    >
                      {session.composeProposalSent ? 'Proposal Sent' : 'Send Proposal'}
                    </Button>
                    <Button variant='solid' size='sm' onClick={session.startCleanShutdown}>
                      Start Clean Shutdown
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {session.betweenHandMode === 'review-incoming-proposal' && session.reviewPeerProposal && (
              <div className='mx-auto w-full max-w-xl rounded-md border border-canvas-line bg-canvas-bg p-4'>
                <div className='flex flex-col gap-3'>
                  <p className='text-sm text-canvas-text-contrast'>Do you want to accept this hand?</p>
                  <p className='text-xs text-canvas-text'>
                    Per-player stake: {formatMojos(session.reviewPeerProposal.terms.myContribution)}
                  </p>
                  <div className='flex flex-wrap items-center gap-3'>
                    <Button variant='solid' color='primary' size='sm' onClick={session.acceptReviewedProposal}>
                      Yes
                    </Button>
                    <Button variant='solid' size='sm' onClick={session.rejectReviewedProposal}>
                      No
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {session.channelQueue[0] && (
        <NotificationOverlay
          notification={session.channelQueue[0]}
          onDismiss={session.dismissChannel}
          boundsRef={channelOverlayBoundsRef}
          zClass='z-50'
        />
      )}
    </div>
  );
};

export default GameSession;
