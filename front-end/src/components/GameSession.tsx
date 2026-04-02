import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { Observable } from 'rxjs';
import { useGameSession, ChannelStatusInfo, GameTurnState, GameplayEvent, isWindingDown } from '../hooks/useGameSession';
import { useCalpokerHand } from '../hooks/useCalpokerHand';
import { CalpokerHandState } from '../hooks/save';
import { formatMojos, formatAmount } from '../util';
import { getPlayerId } from '../hooks/save';
import { CalpokerOutcome, ChannelState } from '../types/ChiaGaming';
import { WasmBlobWrapper } from '../hooks/WasmBlobWrapper';
import Calpoker from '../features/calPoker';

import { motion, useMotionValue } from 'framer-motion';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Separator } from './ui/separator';
import { Button } from './button';
function truncateHex(hex: string, head = 8, tail = 6): string {
  if (hex.length <= head + tail + 1) return hex;
  return `${hex.slice(0, head)}…${hex.slice(-tail)}`;
}

const CHANNEL_STATE_LABELS: Record<ChannelState, string> = {
  Handshaking: 'Handshaking',
  WaitingForHeightToOffer: 'Waiting for block height\u2026',
  WaitingForHeightToAccept: 'Waiting for block height\u2026',
  OfferSent: 'Offer sent',
  TransactionPending: 'Tx pending',
  Active: 'Active',
  ShuttingDown: 'Shutting down',
  ShutdownTransactionPending: 'Shutdown tx pending',
  GoingOnChain: 'Going on-chain',
  Unrolling: 'Unrolling',
  ResolvedClean: 'Resolved (clean)',
  ResolvedUnrolled: 'Resolved (unrolled)',
  ResolvedStale: 'Resolved (stale)',
  Failed: 'Failed',
};

const GAME_TURN_LABELS: Record<GameTurnState, string> = {
  'my-turn': 'Your turn',
  'their-turn': 'Their turn',
  'replaying': 'Replaying our move on-chain',
  'opponent-illegal-move': 'Your turn (opponent attempted illegal move)',
  'ended': 'Ended',
};

function channelCoinLabelForState(state: ChannelState): string {
  if (state === 'ResolvedUnrolled' || state === 'ResolvedStale') {
    return 'Channel reward coin';
  }
  if (state === 'Unrolling') {
    return 'Unroll coin';
  }
  return 'Channel coin';
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

function ExpandableCoinId({ hex }: { hex: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <span
      onClick={() => setExpanded(e => !e)}
      className="font-mono text-[11px] hover:text-canvas-text-contrast transition-colors cursor-pointer select-all"
      title={expanded ? 'Click to collapse' : 'Click to expand full coin ID'}
    >
      0x{expanded ? hex : truncateHex(hex)}
    </span>
  );
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
      <Card className='w-full max-w-md shadow-xl bg-canvas-bg border border-canvas-line'>
        <CardHeader className='text-center pb-2'>
          <CardTitle className={`text-xl ${isBad ? 'text-alert-text' : ''}`}>
            Channel: {label}
          </CardTitle>
          {info.advisory && (
            <p className='text-sm text-canvas-text/70 mt-1'>{info.advisory}</p>
          )}
        </CardHeader>
        <Separator />
        <CardContent className='pt-4 flex flex-col gap-2'>
          {info.coinHex && (
            <p className="text-xs font-mono text-canvas-text/60 break-all">
              Coin: 0x{info.coinHex}
            </p>
          )}
          {info.coinAmount && (
            <p className='text-xs text-canvas-text/70'>
              Coin amount: {formatOptionalMojos(info.coinAmount)} mojos
            </p>
          )}
          <Button variant="soft" onClick={onDismiss} className='w-full'>
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
      <Card className='w-full max-w-md shadow-xl bg-canvas-bg border border-canvas-line'>
        <CardHeader className='text-center pb-2'>
          <CardTitle className='text-xl text-canvas-text-contrast'>{title}</CardTitle>
        </CardHeader>
        <Separator />
        <CardContent className='pt-4 flex flex-col gap-3'>
          <div className='rounded-md border border-canvas-line bg-canvas-bg-subtle p-3 text-sm space-y-2'>
            <p className='flex flex-wrap items-center gap-x-2 gap-y-1'>
              <span className='text-canvas-text/80'>My reward:</span>
              <span className='font-semibold text-canvas-text-contrast'>
                {formatOptionalMojos(myReward)}
              </span>
            </p>
            <p className='flex flex-wrap items-center gap-x-2 gap-y-1'>
              <span className='text-canvas-text/80'>Reward coin:</span>
              {rewardCoinHex ? (
                <ExpandableCoinId hex={rewardCoinHex} />
              ) : (
                <span className='font-semibold text-canvas-text-contrast'>None</span>
              )}
            </p>
          </div>
          <Button variant='soft' size='sm' onClick={onDismiss} className='self-center min-w-[96px]'>
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
      onDisplayComplete={onDisplayComplete}
      onGameLog={handleGameLog}
      myName={myName}
      opponentName={opponentName}
    />
  );
}

export interface GameSessionProps {
  params: import('../types/ChiaGaming').GameSessionParams;
  peerConn: import('../types/ChiaGaming').PeerConnectionResult;
  peerConnected?: boolean | null;
  registerMessageHandler: (handler: (msgno: number, msg: string) => void, ackHandler: (ack: number) => void, pingHandler: () => void) => void;
  appendGameLog: (line: string) => void;
  sessionSave?: import('../hooks/save').SessionSave;
  blockchainType?: import('../hooks/save').BlockchainType;
  onSessionActivity?: () => void;
}

const GameSession: React.FC<GameSessionProps> = ({ params, peerConn, peerConnected, registerMessageHandler, appendGameLog, sessionSave, blockchainType, onSessionActivity }) => {
  const uniqueId = getPlayerId();

  const session = useGameSession(params, uniqueId, peerConn, registerMessageHandler, appendGameLog, sessionSave, blockchainType);

  useEffect(() => {
    if (!onSessionActivity) return;
    const sub = session.gameplayEvent$.subscribe((evt) => {
      if ('OpponentMoved' in evt || 'GameProposalAccepted' in evt) {
        onSessionActivity();
      }
    });
    return () => sub.unsubscribe();
  }, [session.gameplayEvent$, onSessionActivity]);

  const channelOverlayBoundsRef = useRef<HTMLDivElement | null>(null);
  const gameAreaRef = useRef<HTMLDivElement | null>(null);
  const handOverlayDrag = useViewportClampedDrag(gameAreaRef);

  if (session.error) {
    return (
      <div className='flex items-center justify-center h-full p-4'>
        <Card className='w-full max-w-md border-destructive'>
          <CardHeader>
            <CardTitle className='text-destructive'>Error</CardTitle>
          </CardHeader>
          <CardContent>
            <p className='text-sm text-muted-foreground'>{session.error}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const handEverStarted = session.handKey > 0;
  const channelStateLabel = CHANNEL_STATE_LABELS[session.channelStatus.state] ?? session.channelStatus.state;
  const channelCoinLabel = channelCoinLabelForState(session.channelStatus.state);
  const gameStateLabel = session.gameTerminal.label ?? GAME_TURN_LABELS[session.gameCoin.turnState];
  const gameCoinLabel = session.gameTerminal.type !== 'none' ? 'Game reward coin' : 'Game coin';
  const gameCoinOrRewardHex = session.gameTerminal.rewardCoinHex ?? session.gameCoin.coinHex;
  const betweenHandTitle = session.lastOutcome
    ? session.lastOutcome.my_win_outcome === 'win'
      ? 'You Won!'
      : session.lastOutcome.my_win_outcome === 'lose'
        ? 'You Lost'
        : 'Tie Game'
    : session.gameTerminal.type === 'we-timed-out'
      ? 'You Won!'
      : session.gameTerminal.type === 'opponent-timed-out'
        ? 'You Lost'
        : 'Hand Finished';
  const peerBadge =
    peerConnected === null
      ? { label: 'Peer: Unknown', className: 'bg-canvas-bg-hover text-canvas-text' }
      : peerConnected
        ? { label: 'Peer: Active', className: 'bg-emerald-600 text-white' }
        : { label: 'Peer: Inactive', className: 'bg-alert-bg text-alert-text' };

  return (
    <div className='relative w-full h-full min-h-0 flex flex-col bg-canvas-bg-subtle text-canvas-text pt-6'>
      <div ref={channelOverlayBoundsRef} className='absolute inset-0 pointer-events-none' />
      {/* Session header (shrink-0) */}
      <div className='flex-shrink-0 px-4 pt-3 pb-2 sm:px-6 md:px-8'>
        {/* Report + end session */}
        <div className='flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between'>
          <div className='flex flex-col gap-1 text-sm text-canvas-text'>
            <div className='flex flex-wrap items-center gap-x-2 gap-y-0.5'>
              <span className='text-canvas-text/80'>Channel size:</span>
              <span className='font-medium'>{formatMojos(session.amount * 2n)}</span>
              <span className='text-canvas-text/70'>·</span>
              <span className='text-canvas-text/80'>My share:</span>
              <span className='font-medium'>{formatOptionalMojos(session.channelStatus.ourBalance)}</span>
            </div>
            <div className='flex flex-wrap items-center gap-x-2 gap-y-0.5'>
              <span className='text-canvas-text/80'>Game terms:</span>
              <span className='font-medium'>California Poker</span>
              <span className='text-canvas-text/70'>·</span>
              <span className='text-canvas-text/80'>Game size:</span>
              <span className='font-medium'>{formatMojos(session.perGameAmount * 2n)}</span>
            </div>
            <div className='flex flex-wrap items-center gap-x-2 gap-y-0.5'>
              <span className='text-canvas-text/80'>Channel status:</span>
              <span className='font-medium'>{channelStateLabel}</span>
              <span className='text-canvas-text/70'>·</span>
              <span className='text-canvas-text/80'>{channelCoinLabel}:</span>
              {session.channelStatus.coinHex ? (
                <ExpandableCoinId hex={session.channelStatus.coinHex} />
              ) : (
                <span className='font-medium'>None</span>
              )}
            </div>
            <div className='flex flex-wrap items-center gap-x-2 gap-y-0.5'>
              <span className='text-canvas-text/80'>Peer connection:</span>
              <span className='font-medium'>
                {peerConnected === null ? 'Unknown' : peerConnected ? 'Active' : 'Inactive'}
              </span>
            </div>
            <div className='flex flex-wrap items-center gap-x-2 gap-y-0.5'>
              <span className='text-canvas-text/80'>Game state:</span>
              <span className='font-medium'>{gameStateLabel}</span>
            </div>
            <div className='flex flex-wrap items-center gap-x-2 gap-y-0.5'>
              <span className='text-canvas-text/80'>{gameCoinLabel}:</span>
              {gameCoinOrRewardHex ? (
                <ExpandableCoinId hex={gameCoinOrRewardHex} />
              ) : (
                <span className='font-medium'>None</span>
              )}
              <span className='text-canvas-text/70'>·</span>
              <span className='text-canvas-text/80'>My reward:</span>
              <span className='font-medium'>{formatOptionalMojos(session.gameTerminal.myReward)}</span>
            </div>
          </div>
          <div className='flex flex-col items-stretch gap-2 mt-2 sm:mt-0'>
            <div className='flex justify-center'>
              <span className={`inline-flex items-center rounded-md px-2 py-1 text-xs font-semibold ${peerBadge.className}`}>
                {peerBadge.label}
              </span>
            </div>
            <Button
              data-testid='go-on-chain'
              variant='destructive'
              onClick={session.goOnChain}
              size='sm'
              disabled={session.goOnChainPressed || isWindingDown(session.channelStatus.state)}
            >
              Go On-Chain
            </Button>
            <Button
              data-testid='cut-peer-connection'
              variant='outline'
              onClick={session.cutPeerConnection}
              size='sm'
            >
              Cut Peer Connection
            </Button>
            <Button
              data-testid='toggle-tx-nerf'
              variant={session.txPublishNerfed ? 'destructive' : 'outline'}
              onClick={session.toggleTxPublishNerf}
              size='sm'
            >
              {session.txPublishNerfed ? 'Unnerf Publish' : 'Nerf Publish'}
            </Button>
          </div>
        </div>

        <Separator className='mt-2' />
      </div>

      {/* Main content area */}
      <div className='flex flex-col gap-2 px-4 pb-2 sm:px-6 md:px-8'>
        {/* Game area */}
          <div ref={gameAreaRef} className='relative overflow-hidden'>
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
            />
          )}

          {/* Between-hand overlay (draggable, no backdrop) */}
          {session.showBetweenHandOverlay && !isWindingDown(session.channelStatus.state) && (
            <motion.div
              ref={handOverlayDrag.cardRef}
              drag
              dragMomentum={false}
              dragElastic={0}
              initial={false}
              style={{ x: handOverlayDrag.x, y: handOverlayDrag.y }}
              onDrag={handOverlayDrag.clampToViewport}
              onDragEnd={handOverlayDrag.clampToViewport}
              className='absolute z-30 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 cursor-grab active:cursor-grabbing'
            >
              <Card className='w-full max-w-md shadow-xl bg-canvas-bg border border-canvas-line'>
                <CardHeader className='text-center pb-2'>
                  <CardTitle className='text-xl'>
                    {betweenHandTitle}
                  </CardTitle>
                </CardHeader>
                <Separator />
                <CardContent className='pt-4 flex flex-col gap-2'>
                  {session.channelStatus.state !== 'Active' ? (
                    <p className='text-sm text-center text-canvas-text'>Session ending…</p>
                  ) : (
                    <>
                      <Button
                        variant='soft'
                        onClick={session.playAgain}
                        className='w-full'
                      >
                        Play Another Hand
                      </Button>
                      <Button
                        variant='destructive'
                        onClick={session.stopPlaying}
                        className='w-full'
                      >
                        End Session
                      </Button>
                    </>
                  )}
                </CardContent>
              </Card>
            </motion.div>
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
    </div>
  );
};

export default GameSession;
