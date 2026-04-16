import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { Observable } from 'rxjs';
import { useGameSession, ChannelStatusInfo, GameTurnState, GameplayEvent, isWindingDown } from '../hooks/useGameSession';
import { useCalpokerHand } from '../hooks/useCalpokerHand';
import { CalpokerHandState, CalpokerDisplaySnapshot } from '../hooks/save';
import { formatMojos, formatAmount } from '../util';
import { getPlayerId } from '../hooks/save';
import { CalpokerOutcome, ChannelState } from '../types/ChiaGaming';
import { WasmBlobWrapper } from '../hooks/WasmBlobWrapper';
import Calpoker from '../features/calPoker';

import { motion, useMotionValue, useDragControls } from 'framer-motion';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Separator } from './ui/separator';
import { Button } from './button';
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

function useViewportClampedDrag(boundsRef?: RefObject<HTMLElement | null>) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const x = useMotionValue(0);
  const y = useMotionValue(0);

  const clampToViewport = useCallback(() => {
    const el = cardRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const boundsRect = boundsRef?.current?.getBoundingClientRect();
    const minX = boundsRect?.left ?? 0;
    const minY = boundsRect?.top ?? 0;
    const maxX = boundsRect?.right ?? window.innerWidth;
    const maxY = boundsRect?.bottom ?? window.innerHeight;
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
  }, [boundsRef, x, y]);

  useEffect(() => {
    const onResize = () => clampToViewport();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [clampToViewport]);

  return { cardRef, x, y, clampToViewport };
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


function ChannelAttentionOverlay({
  info,
  onDismiss,
  boundsRef,
}: {
  info: ChannelStatusInfo;
  onDismiss: () => void;
  boundsRef: RefObject<HTMLElement | null>;
}) {
  const label = CHANNEL_STATE_LABELS[info.state] ?? info.state;
  const isBad = info.state === 'Failed' || info.state === 'ResolvedStale';
  const { cardRef, x, y, clampToViewport } = useViewportClampedDragWithInsets(boundsRef, { top: 8 });
  return (
    <motion.div
      ref={cardRef}
      drag
      dragMomentum={false}
      dragElastic={0}
      initial={false}
      style={{ x, y }}
      onDrag={clampToViewport}
      onDragEnd={clampToViewport}
      className='absolute z-50 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 cursor-grab active:cursor-grabbing'
    >
      <Card className='theme-inverted w-full max-w-md shadow-xl bg-canvas-bg-subtle border border-canvas-line'>
        <CardHeader className='text-center pb-2'>
          <CardTitle className={`text-xl ${isBad ? 'text-alert-text' : 'text-canvas-text-contrast'}`}>
            Channel: {label}
          </CardTitle>
          {info.advisory && (
            <p className='text-sm text-canvas-text mt-1'>{info.advisory}</p>
          )}
        </CardHeader>
        <Separator />
        <CardContent className='pt-4 flex flex-col gap-2'>
          {info.coinHex && (
            <p className="text-xs text-canvas-text break-all">
              Coin ID: <CoinId hex={info.coinHex} />
            </p>
          )}
          {info.coinAmount && (
            <p className='text-xs text-canvas-text'>
              Coin amount: {formatOptionalMojos(info.coinAmount)} mojos
            </p>
          )}
          <Button variant="solid" onClick={onDismiss} className='w-full'>
            Dismiss
          </Button>
        </CardContent>
      </Card>
    </motion.div>
  );
}

function ErrorAttentionOverlay({
  message,
  onDismiss,
  boundsRef,
}: {
  message: string;
  onDismiss: () => void;
  boundsRef: RefObject<HTMLElement | null>;
}) {
  const { cardRef, x, y, clampToViewport } = useViewportClampedDragWithInsets(boundsRef, { top: 8 });
  const dragControls = useDragControls();
  return (
    <motion.div
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
      className='absolute z-50 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2'
    >
      <Card className='theme-inverted w-full max-w-md shadow-xl bg-canvas-bg-subtle border border-canvas-line'>
        <CardHeader
          className='text-center pb-2 cursor-grab active:cursor-grabbing'
          onPointerDown={(e) => dragControls.start(e)}
        >
          <CardTitle className='text-xl text-alert-text'>Error</CardTitle>
        </CardHeader>
        <Separator />
        <CardContent className='pt-4 flex flex-col gap-2'>
          <pre className='text-sm text-canvas-text-contrast whitespace-pre-wrap break-all font-sans select-text cursor-text max-h-[60vh] overflow-auto'>{message}</pre>
          <Button variant="solid" onClick={onDismiss}>
            Dismiss
          </Button>
        </CardContent>
      </Card>
    </motion.div>
  );
}

function GameTerminalAttentionOverlay({
  label,
  myReward,
  rewardCoinHex,
  onDismiss,
  boundsRef,
}: {
  label: string;
  myReward: string | null;
  rewardCoinHex: string | null;
  onDismiss: () => void;
  boundsRef: RefObject<HTMLElement | null>;
}) {
  const { cardRef, x, y, clampToViewport } = useViewportClampedDrag(boundsRef);
  const title = label.startsWith('Ended: ') ? label.slice('Ended: '.length) : label;
  return (
    <motion.div
      ref={cardRef}
      drag
      dragMomentum={false}
      dragElastic={0}
      initial={false}
      style={{ x, y }}
      onDrag={clampToViewport}
      onDragEnd={clampToViewport}
      className='absolute z-50 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 cursor-grab active:cursor-grabbing'
    >
      <Card className='theme-inverted w-full max-w-md shadow-xl bg-canvas-bg-subtle border border-canvas-line'>
        <CardHeader className='text-center pb-2'>
          <CardTitle className='text-xl text-canvas-text-contrast'>{title}</CardTitle>
        </CardHeader>
        <Separator />
        <CardContent className='pt-4 flex flex-col gap-3'>
          <div className='rounded-md border border-canvas-line bg-canvas-bg p-3 text-sm space-y-2'>
            <p className='flex flex-wrap items-center gap-x-2 gap-y-1'>
              <span className='text-canvas-text'>My reward:</span>
              <span className='font-semibold text-canvas-text-contrast'>
                {formatOptionalMojos(myReward)}
              </span>
            </p>
            <p className='flex flex-wrap items-center gap-x-2 gap-y-1'>
              <span className='text-canvas-text'>Reward coin ID:</span>
              {rewardCoinHex ? (
                <CoinId hex={rewardCoinHex} />
              ) : (
                <span className='font-semibold text-canvas-text-contrast'>None</span>
              )}
            </p>
          </div>
          <Button variant='solid' size='sm' onClick={onDismiss} className='self-center min-w-[96px]'>
            OK
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
  onDisplayComplete: () => void;
  initialHandState?: CalpokerHandState;
  myName?: string;
  opponentName?: string;
  onPlayAgain?: () => void;
  onEndSession?: () => void;
  showBetweenHandActions?: boolean;
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
  onDisplayComplete,
  initialHandState,
  myName,
  opponentName,
  onPlayAgain,
  onEndSession,
  showBetweenHandActions,
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
      onDisplayComplete={onDisplayComplete}
      onGameLog={handleGameLog}
      onSnapshotChange={saveDisplaySnapshot}
      initialSnapshot={initialDisplaySnapshot}
      myName={myName}
      opponentName={opponentName}
      onPlayAgain={onPlayAgain}
      onEndSession={onEndSession}
      showBetweenHandActions={showBetweenHandActions}
    />
  );
}

export interface GameSessionProps {
  params: import('../types/ChiaGaming').GameSessionParams;
  peerConn: import('../types/ChiaGaming').PeerConnectionResult;
  trackerLiveness?: import('../types/ChiaGaming').TrackerLiveness | null;
  peerConnected?: boolean | null;
  registerMessageHandler: (handler: (msgno: number, msg: string) => void, ackHandler: (ack: number) => void, keepaliveHandler: () => void) => void;
  appendGameLog: (line: string) => void;
  sessionSave?: import('../hooks/save').SessionSave;
  onSessionActivity?: () => void;
}

const TRACKER_LIVENESS_LABELS: Record<string, string> = {
  connected: 'Connected',
  reconnecting: 'Reconnecting',
  inactive: 'Inactive',
  disconnected: 'Disconnected',
};

const GameSession: React.FC<GameSessionProps> = ({ params, peerConn, trackerLiveness, peerConnected, registerMessageHandler, appendGameLog, sessionSave, onSessionActivity }) => {
  const uniqueId = getPlayerId();

  const session = useGameSession(params, uniqueId, peerConn, registerMessageHandler, appendGameLog, sessionSave);

  useEffect(() => {
    if (!onSessionActivity) return;
    const sub = session.gameplayEvent$.subscribe((evt) => {
      if ('OpponentMoved' in evt || 'ProposalAccepted' in evt) {
        onSessionActivity();
      }
    });
    return () => sub.unsubscribe();
  }, [session.gameplayEvent$, onSessionActivity]);

  const channelOverlayBoundsRef = useRef<HTMLDivElement | null>(null);
  const gameAreaRef = useRef<HTMLDivElement | null>(null);
  const [gameAreaMinHeight, setGameAreaMinHeight] = useState<number | undefined>(undefined);

  useEffect(() => {
    const el = gameAreaRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setGameAreaMinHeight(entry.contentRect.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const [dismissedError, setDismissedError] = useState(false);

  const handEverStarted = session.handKey > 0;
  const channelStateLabel = CHANNEL_STATE_LABELS[session.channelStatus.state] ?? session.channelStatus.state;
  const channelCoinLabel = channelCoinLabelForState(session.channelStatus.state);
  const gameStateLabel = session.gameTerminal.label ?? GAME_TURN_LABELS[session.gameCoin.turnState];
  const gameCoinLabel = session.gameTerminal.type !== 'none' ? 'Game reward coin ID' : 'Game coin ID';
  const gameCoinOrRewardHex = session.gameTerminal.rewardCoinHex ?? session.gameCoin.coinHex;

  return (
    <div className='relative w-full h-full min-h-0 flex flex-col bg-canvas-bg-subtle text-canvas-text pt-6'>
      <div ref={channelOverlayBoundsRef} className='absolute inset-0 pointer-events-none' />
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
              <span className='font-medium'>{formatMojos(session.perGameAmount * 2n)}</span>
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
              disabled={session.goOnChainPressed || isWindingDown(session.channelStatus.state)}
            >
              Go On-Chain
            </Button>
          </div>
        </div>

        <Separator className='mt-2' />
      </div>

      {/* Main content area */}
      <div className='flex flex-col gap-2 px-4 pb-2 sm:px-6 md:px-8'>
        {/* Game area */}
          <div ref={gameAreaRef} className='relative overflow-hidden' style={gameAreaMinHeight != null ? { minHeight: gameAreaMinHeight } : undefined}>
          {handEverStarted && (
            <CalpokerHand
              key={session.handKey}
              gameObject={session.gameObject}
              gameId={session.activeGameId ?? ''}
              iStarted={session.iStarted}
              playerNumber={session.playerNumber}
              gameplayEvent$={session.gameplayEvent$}
              onOutcome={session.onHandOutcome}
              onTurnChanged={session.onTurnChanged}
              appendGameLog={session.appendGameLog}
              perGameAmount={session.perGameAmount}
              onDisplayComplete={session.onDisplayComplete}
              initialHandState={session.handKey === 1 && sessionSave?.handState ? sessionSave.handState : undefined}
              myName={params.myAlias}
              opponentName={params.opponentAlias}
              onPlayAgain={session.playAgain}
              onEndSession={session.stopPlaying}
              showBetweenHandActions={session.showBetweenHandOverlay && !isWindingDown(session.channelStatus.state)}
            />
          )}

          {/* Waiting for first hand */}
          {!handEverStarted && (
            <div className='flex items-center justify-center py-20'>
              <p className='text-canvas-text'>Waiting for game to start…</p>
            </div>
          )}

          {session.gameTerminalAttention && (
            <GameTerminalAttentionOverlay
              label={session.gameTerminalAttention.label}
              myReward={session.gameTerminalAttention.myReward}
              rewardCoinHex={session.gameTerminalAttention.rewardCoinHex}
              onDismiss={session.dismissGameTerminalAttention}
              boundsRef={gameAreaRef}
            />
          )}
        </div>
      </div>

      {session.channelAttention && (
        <ChannelAttentionOverlay
          info={session.channelAttention}
          onDismiss={session.dismissChannelAttention}
          boundsRef={channelOverlayBoundsRef}
        />
      )}
      {session.error && !dismissedError && (
        <ErrorAttentionOverlay
          message={session.error}
          onDismiss={() => setDismissedError(true)}
          boundsRef={channelOverlayBoundsRef}
        />
      )}
    </div>
  );
};

export default GameSession;
