import { useCallback } from 'react';
import { Observable } from 'rxjs';
import { useGameSession, ChannelCoinState, GameCoinState, GameplayEvent } from '../hooks/useGameSession';
import { useCalpokerHand } from '../hooks/useCalpokerHand';
import { generateOrRetrieveUniqueId, parseGameSessionParams, formatMojos, formatAmount } from '../util';
import { CalpokerOutcome } from '../types/ChiaGaming';
import { WasmBlobWrapper } from '../hooks/WasmBlobWrapper';
import Calpoker from '../features/calPoker';
import WaitingScreen from './WaitingScreen';
import { motion } from 'framer-motion';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Separator } from './ui/separator';
import { Button } from './button';
import { Toaster } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from './ui/dialog';
function truncateHex(hex: string, head = 6, tail = 4): string {
  if (hex.length <= head + tail) return hex;
  return `${hex.slice(0, head)}…${hex.slice(-tail)}`;
}

const CHANNEL_STATE_LABELS: Record<ChannelCoinState, string> = {
  'not-created': 'Not yet created',
  'channel': 'Channel',
  'unrolling': 'Unrolling',
  'reward': 'Reward',
  'closed': 'Closed',
};

const GAME_STATE_LABELS: Record<GameCoinState, string> = {
  'off-chain-my-turn': 'Off-chain · Your turn',
  'off-chain-their-turn': 'Off-chain · Their turn',
  'on-chain-my-turn': 'On-chain · Your turn',
  'on-chain-their-turn': 'On-chain · Their turn',
  'reward': 'Reward',
  'ended': 'Ended',
};

function CoinStatus({ label, coinHex, stateLabel }: { label: string; coinHex: string | null; stateLabel: string }) {
  return (
    <span>
      {label}: {coinHex ? `0x${truncateHex(coinHex)}` : '—'} · {stateLabel}
    </span>
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
  params: Record<string, string | undefined>;
  appendGameLog: (line: string) => void;
  appendDebugLog: (line: string) => void;
}

const GameSession: React.FC<GameSessionProps> = ({ params, appendGameLog, appendDebugLog }) => {
  const uniqueId = generateOrRetrieveUniqueId();
  const parsed = parseGameSessionParams(params);

  const session = useGameSession(parsed, uniqueId, appendGameLog, appendDebugLog);

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
    <div className='flex h-full w-full flex-col overflow-hidden bg-canvas-bg-subtle text-canvas-text pt-6'>
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
              disabled={session.sessionEnded || session.shutdownInitiated}
            >
              Go On-Chain
            </Button>
          </div>
        </div>

        {/* Row 2: diagnostic coin info (subtle) */}
        <div className='flex flex-wrap gap-x-4 gap-y-0.5 mt-1 text-xs text-canvas-text/60'>
          <CoinStatus
            label='Channel'
            coinHex={session.channelCoin.coinHex}
            stateLabel={CHANNEL_STATE_LABELS[session.channelCoin.state]}
          />
          <CoinStatus
            label='Game'
            coinHex={session.gameCoin.coinHex}
            stateLabel={GAME_STATE_LABELS[session.gameCoin.state]}
          />
        </div>

        <Separator className='mt-2' />
      </div>

      {/* Main content area (flex-1 min-h-0) */}
      <div className='flex flex-1 min-h-0 flex-col gap-2 px-4 pb-2 sm:px-6 md:px-8'>
        {/* Game area */}
        <div className='relative flex-1 min-h-0 flex flex-col'>
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
            />
          )}

          {/* Between-hand overlay (draggable, no backdrop) */}
          {(session.showBetweenHandOverlay || session.sessionEnded) && (
            <motion.div
              drag
              dragMomentum={false}
              initial={false}
              className='absolute z-30 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 cursor-grab active:cursor-grabbing'
            >
              <Card className='w-full max-w-md shadow-xl bg-canvas-bg border border-canvas-line'>
                <CardHeader className='text-center pb-2'>
                  <CardTitle className='text-xl'>
                    {session.sessionEnded
                      ? 'Session Ended'
                      : session.lastOutcome
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
                  {session.sessionEnded ? (
                    <p className='text-sm text-center text-canvas-text'>Channel closed — funds returned on-chain</p>
                  ) : session.shutdownInitiated ? (
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
          {!handEverStarted && !session.sessionEnded && (
            <div className='flex flex-1 items-center justify-center'>
              <p className='text-canvas-text'>Waiting for game to start…</p>
            </div>
          )}

          {/* Session ended, no active hand */}
          {session.sessionEnded && !handEverStarted && (
            <div className='flex flex-1 items-center justify-center'>
              <p className='text-canvas-text'>Session complete.</p>
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

      <Toaster />
    </div>
  );
};

export default GameSession;
