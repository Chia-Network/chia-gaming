import { useCallback, useEffect, useState } from 'react';
import { Observable } from 'rxjs';
import { useGameSession, ChannelStatusInfo, GameTurnState, GameplayEvent, isWindingDown } from '../hooks/useGameSession';
import { useCalpokerHand } from '../hooks/useCalpokerHand';
import { CalpokerHandState } from '../hooks/save';
import { formatMojos, formatAmount } from '../util';
import { getPlayerId } from '../hooks/save';
import { CalpokerOutcome, ChannelState } from '../types/ChiaGaming';
import { WasmBlobWrapper } from '../hooks/WasmBlobWrapper';
import Calpoker from '../features/calPoker';

import { motion } from 'framer-motion';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Separator } from './ui/separator';
import { Button } from './button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from './ui/dialog';
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
  'ended': 'Ended',
};

function ExpandableCoinId({ hex }: { hex: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <button
      type="button"
      onClick={() => setExpanded(e => !e)}
      className="font-mono text-[11px] hover:text-canvas-text-contrast transition-colors"
      title={expanded ? 'Click to collapse' : 'Click to expand full coin ID'}
    >
      0x{expanded ? hex : truncateHex(hex)}
    </button>
  );
}

function ChannelStatusDisplay({ status }: { status: ChannelStatusInfo }) {
  const stateLabel = CHANNEL_STATE_LABELS[status.state] ?? status.state;
  const isResolved = status.state.startsWith('Resolved') || status.state === 'Failed';
  const stateColor = status.state === 'Failed' ? 'text-alert-text'
    : status.state === 'Active' ? 'text-success-text'
    : isResolved ? 'text-canvas-text/80'
    : 'text-canvas-text';

  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
        <span className="text-sm text-canvas-text">Channel:</span>
        <span className={`text-sm font-medium ${stateColor}`}>{stateLabel}</span>
        {status.coinHex && (
          <>
            <span className="text-sm text-canvas-text">·</span>
            <ExpandableCoinId hex={status.coinHex} />
          </>
        )}
      </div>
      {!isResolved && (status.ourBalance != null || status.theirBalance != null) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-sm text-canvas-text">
          {status.ourBalance != null && <span>Ours: {status.ourBalance}</span>}
          {status.theirBalance != null && <span>Theirs: {status.theirBalance}</span>}
          {status.gameAllocated != null && status.gameAllocated !== '0' && (
            <span>In game: {status.gameAllocated}</span>
          )}
        </div>
      )}
      {status.advisory && (
        <p className="text-sm text-alert-text italic">{status.advisory}</p>
      )}
    </div>
  );
}

function ChannelAttentionOverlay({
  info,
  onDismiss,
}: {
  info: ChannelStatusInfo;
  onDismiss: () => void;
}) {
  const label = CHANNEL_STATE_LABELS[info.state] ?? info.state;
  const isBad = info.state === 'Failed' || info.state === 'ResolvedStale';
  return (
    <motion.div
      drag
      dragMomentum={false}
      initial={false}
      className='fixed z-50 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 cursor-grab active:cursor-grabbing'
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
          <Button variant="soft" onClick={onDismiss} className='w-full'>
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
  registerMessageHandler: (handler: (msgno: number, msg: string) => void, ackHandler: (ack: number) => void, pingHandler: () => void) => void;
  appendGameLog: (line: string) => void;
  sessionSave?: import('../hooks/save').SessionSave;
  blockchainType?: import('../hooks/save').BlockchainType;
  onSessionActivity?: () => void;
}

const GameSession: React.FC<GameSessionProps> = ({ params, peerConn, registerMessageHandler, appendGameLog, sessionSave, blockchainType, onSessionActivity }) => {
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

  return (
    <div className='w-full flex flex-col bg-canvas-bg-subtle text-canvas-text pt-6'>
      {/* Session header (shrink-0) */}
      <div className='flex-shrink-0 px-4 pt-3 pb-2 sm:px-6 md:px-8'>
        {/* Row 1: title + financial summary + end session */}
        <div className='flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between'>
          <div className='flex flex-col gap-0.5'>
            <h1 className='text-2xl font-semibold text-canvas-text-contrast sm:text-3xl'>
              California Poker
            </h1>
            <div className='flex flex-wrap items-center gap-x-4 gap-y-0.5 text-sm text-canvas-text'>
              <span>Channel: {formatMojos(session.amount * 2n)}</span>
              <span>Per hand: {formatMojos(session.perGameAmount)}</span>
            </div>
          </div>
          <div className='flex items-center gap-2 mt-2 sm:mt-0'>
            <Button
              data-testid='go-on-chain'
              variant='destructive'
              onClick={session.goOnChain}
              size='sm'
              disabled={session.goOnChainPressed || isWindingDown(session.channelStatus.state)}
            >
              Go On-Chain
            </Button>
          </div>
        </div>

        {/* Row 2: channel status */}
        <ChannelStatusDisplay status={session.channelStatus} />

        {/* Row 3: game status */}
        <div className="flex items-center gap-x-2 text-sm text-canvas-text mt-0.5">
          <span>Game:</span>
          <span>{GAME_TURN_LABELS[session.gameCoin.turnState]}</span>
          {session.gameCoin.coinHex && (
            <>
              <span className="text-canvas-text">·</span>
              <span className="text-canvas-text font-medium">On-chain</span>
              <span className="text-canvas-text">·</span>
              <ExpandableCoinId hex={session.gameCoin.coinHex} />
            </>
          )}
        </div>

        <Separator className='mt-2' />
      </div>

      {/* Main content area */}
      <div className='flex flex-col gap-2 px-4 pb-2 sm:px-6 md:px-8'>
        {/* Game area */}
          <div className='relative'>
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
          {session.showBetweenHandOverlay && (
            <motion.div
              drag
              dragMomentum={false}
              initial={false}
              className='absolute z-30 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 cursor-grab active:cursor-grabbing'
            >
              <Card className='w-full max-w-md shadow-xl bg-canvas-bg border border-canvas-line'>
                <CardHeader className='text-center pb-2'>
                  <CardTitle className='text-xl'>
                    {session.lastOutcome
                      ? session.lastOutcome.my_win_outcome === 'win'
                        ? 'You Won!'
                        : session.lastOutcome.my_win_outcome === 'lose'
                          ? 'You Lost'
                          : 'Tie Game'
                      : 'Hand Finished'}
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
        </div>
      </div>

      <Dialog open={session.actionFailedReason !== null} onOpenChange={(open) => { if (!open) session.dismissActionFailed(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Action Failed</DialogTitle>
            <DialogDescription>{session.actionFailedReason}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant='soft'>Dismiss</Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {session.channelAttention && (
        <ChannelAttentionOverlay
          info={session.channelAttention}
          onDismiss={session.dismissChannelAttention}
        />
      )}
    </div>
  );
};

export default GameSession;
