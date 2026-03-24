import { useCallback, useState } from 'react';
import { Observable } from 'rxjs';
import { useGameSession, ChannelStatusInfo, GameCoinState, GameplayEvent } from '../hooks/useGameSession';
import { useCalpokerHand } from '../hooks/useCalpokerHand';
import { CalpokerHandState } from '../hooks/save';
import { formatMojos, formatAmount } from '../util';
import { getPlayerId } from '../hooks/save';
import { CalpokerOutcome, ChannelState } from '../types/ChiaGaming';
import { WasmBlobWrapper } from '../hooks/WasmBlobWrapper';
import Calpoker from '../features/calPoker';
import WaitingScreen from './WaitingScreen';
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
  TransactionSubmitted: 'Tx submitted',
  Active: 'Active',
  ShuttingDown: 'Shutting down',
  Unrolling: 'Unrolling',
  ResolvedClean: 'Resolved (clean)',
  ResolvedUnrolled: 'Resolved (unrolled)',
  ResolvedStale: 'Resolved (stale)',
  Failed: 'Failed',
};

const GAME_STATE_LABELS: Record<GameCoinState, string> = {
  'off-chain-my-turn': 'Off-chain · Your turn',
  'off-chain-their-turn': 'Off-chain · Their turn',
  'on-chain-my-turn': 'On-chain · Your turn',
  'on-chain-their-turn': 'On-chain · Their turn',
  'reward': 'Reward',
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
        <span className="text-xs text-canvas-text/60">Channel:</span>
        <span className={`text-xs font-medium ${stateColor}`}>{stateLabel}</span>
        {status.coinHex && (
          <>
            <span className="text-xs text-canvas-text/40">·</span>
            <ExpandableCoinId hex={status.coinHex} />
          </>
        )}
      </div>
      {!isResolved && (status.ourBalance != null || status.theirBalance != null) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-canvas-text/60">
          {status.ourBalance != null && <span>Ours: {status.ourBalance}</span>}
          {status.theirBalance != null && <span>Theirs: {status.theirBalance}</span>}
          {status.gameAllocated != null && status.gameAllocated !== '0' && (
            <span>In game: {status.gameAllocated}</span>
          )}
        </div>
      )}
      {status.advisory && (
        <p className="text-xs text-alert-text/80 italic">{status.advisory}</p>
      )}
    </div>
  );
}

function ChannelAttentionDialog({
  info,
  onDismiss,
}: {
  info: ChannelStatusInfo;
  onDismiss: () => void;
}) {
  const label = CHANNEL_STATE_LABELS[info.state] ?? info.state;
  const isBad = info.state === 'Failed' || info.state === 'ResolvedStale';
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onDismiss(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className={isBad ? 'text-alert-text' : undefined}>
            Channel: {label}
          </DialogTitle>
          {info.advisory && (
            <DialogDescription>{info.advisory}</DialogDescription>
          )}
        </DialogHeader>
        {info.coinHex && (
          <p className="text-xs font-mono text-canvas-text/60 break-all">
            Coin: 0x{info.coinHex}
          </p>
        )}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="soft">Dismiss</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
}

const GameSession: React.FC<GameSessionProps> = ({ params, peerConn, registerMessageHandler, appendGameLog, sessionSave, blockchainType }) => {
  const uniqueId = getPlayerId();

  const session = useGameSession(params, uniqueId, peerConn, registerMessageHandler, appendGameLog, sessionSave, blockchainType);

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

  if (session.gameConnectionState.stateIdentifier === 'starting') {
    return (
      <WaitingScreen
        stateName={session.gameConnectionState.stateIdentifier}
        messages={session.gameConnectionState.stateDetail}
      />
    );
  }

  const handEverStarted = session.handKey > 0;

  const balanceSign = session.myRunningBalance >= 0n ? '+' : '';
  const balanceColor = session.myRunningBalance > 0n
    ? 'text-success-text'
    : session.myRunningBalance < 0n
      ? 'text-alert-text'
      : 'text-canvas-text';

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
              <span>Channel: {formatMojos(session.amount)}</span>
              <span>Per hand: {formatMojos(session.perGameAmount)}</span>
              <span className={balanceColor}>
                Balance: {balanceSign}{formatMojos(session.myRunningBalance < 0n ? -session.myRunningBalance : session.myRunningBalance)}
              </span>
            </div>
          </div>
          <div className='flex items-center gap-2 mt-2 sm:mt-0'>
            <Button
              data-testid='go-on-chain'
              variant='destructive'
              onClick={session.goOnChain}
              size='sm'
              disabled={session.shutdownInitiated || session.channelStatus.state !== 'Active'}
            >
              Go On-Chain
            </Button>
          </div>
        </div>

        {/* Row 2: channel & game status */}
        <div className='flex flex-wrap gap-x-6 gap-y-1 mt-1'>
          <ChannelStatusDisplay status={session.channelStatus} />
          <div className="flex items-center gap-x-2 text-xs text-canvas-text/60">
            <span>Game:</span>
            <span>{GAME_STATE_LABELS[session.gameCoin.state]}</span>
            {session.gameCoin.coinHex && (
              <>
                <span className="text-canvas-text/40">·</span>
                <ExpandableCoinId hex={session.gameCoin.coinHex} />
              </>
            )}
          </div>
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
                  {session.shutdownInitiated ? (
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
        <ChannelAttentionDialog
          info={session.channelAttention}
          onDismiss={session.dismissChannelAttention}
        />
      )}
    </div>
  );
};

export default GameSession;
