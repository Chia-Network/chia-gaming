import { useEffect, useRef } from 'react';
import { useGameSession, ChannelCoinState, GameCoinState } from '../hooks/useGameSession';
import { useCalpokerHand } from '../hooks/useCalpokerHand';
import { generateOrRetrieveUniqueId } from '../util';
import Calpoker from '../features/calPoker';
import WaitingScreen from './WaitingScreen';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Separator } from './ui/separator';
import { Button } from './button';
import { Toaster } from 'sonner';
import { LogOut, RotateCcw } from 'lucide-react';

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
    <span className='text-sm text-canvas-text'>
      {label}: {coinHex ? `0x${truncateHex(coinHex)}` : '—'} · {stateLabel}
    </span>
  );
}

interface CalpokerHandProps {
  gameObject: any;
  gameId: string;
  iStarted: boolean;
  playerNumber: number;
  gameplayEvent$: any;
  onOutcome: (outcome: any) => void;
  onTurnChanged: (isMyTurn: boolean) => void;
  appendGameLog: (line: string) => void;
  stopPlaying: () => void;
  addressData: any;
  ourShare: number | undefined;
  theirShare: number | undefined;
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
  stopPlaying,
  addressData,
  ourShare,
  theirShare,
}: CalpokerHandProps) {
  const {
    playerHand,
    opponentHand,
    cardSelections,
    setCardSelections,
    moveNumber,
    isPlayerTurn,
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
    appendGameLog,
  );

  return (
    <Calpoker
      outcome={outcome}
      moveNumber={moveNumber}
      iStarted={iStarted}
      isPlayerTurn={isPlayerTurn}
      playerNumber={playerNumber}
      playerHand={playerHand}
      opponentHand={opponentHand}
      cardSelections={cardSelections}
      setCardSelections={setCardSelections}
      handleMakeMove={handleMakeMove}
      handleCheat={handleCheat}
      addressData={addressData}
      ourShare={ourShare}
      theirShare={theirShare}
    />
  );
}

function LogTextArea({ label, lines }: { label: string; lines: string[] }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (ref.current) {
      ref.current.scrollTop = ref.current.scrollHeight;
    }
  }, [lines]);

  return (
    <div className='flex flex-col gap-1'>
      <h3 className='text-sm font-semibold text-canvas-text-contrast'>{label}</h3>
      <textarea
        ref={ref}
        readOnly
        value={lines.join('\n')}
        className='w-full h-32 resize-none rounded-md border border-canvas-border bg-canvas-bg p-2 text-xs font-mono text-canvas-text focus:outline-none'
      />
    </div>
  );
}

export interface GameSessionProps {
  params: any;
}

const GameSession: React.FC<GameSessionProps> = ({ params }) => {
  const uniqueId = generateOrRetrieveUniqueId();

  const session = useGameSession(params, params.lobbyUrl, uniqueId);

  if (session.error) {
    return (
      <div className='flex items-center justify-center min-h-screen p-4'>
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
  const handActive = session.activeGameId !== null;

  return (
    <div className='relative flex min-h-screen w-full flex-col bg-canvas-bg-subtle px-4 text-canvas-text sm:px-6 md:px-8'>
      {/* Session header */}
      <div className='flex w-full flex-col gap-1 pt-4 pb-2 sm:flex-row sm:items-center sm:justify-between'>
        <div className='flex flex-col gap-0.5'>
          <h1 className='text-2xl font-semibold text-canvas-text-contrast sm:text-3xl'>
            California Poker
          </h1>
          <div className='flex flex-wrap gap-x-4 gap-y-0.5'>
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
        </div>
        <div className='flex items-center gap-2 mt-2 sm:mt-0'>
          <Button
            data-testid='stop-playing'
            variant='destructive'
            onClick={session.stopPlaying}
            size='sm'
            disabled={session.sessionEnded || handActive}
            leadingIcon={<LogOut />}
          >
            End Session
          </Button>
        </div>
      </div>

      <Separator className='mb-2' />

      {/* Session ended indicator */}
      {session.sessionEnded && (
        <div className='rounded-md border border-canvas-border bg-canvas-bg p-3 mb-2 text-center'>
          <p className='text-lg font-semibold text-canvas-text-contrast'>Session Ended</p>
          <p className='text-sm text-canvas-text'>Channel closed — funds returned on-chain</p>
        </div>
      )}

      {/* Main content area */}
      <div className='flex w-full flex-1 flex-col gap-2 overflow-hidden lg:flex-row lg:min-h-0'>
        {/* Game area */}
        <div className='relative flex-1 overflow-auto lg:flex-[18_1_0%] lg:min-h-0'>
          {/* CalpokerHand persists through the hand lifecycle including post-outcome animation.
              It only unmounts when a new hand starts (handKey changes) or session ends. */}
          {handEverStarted && !session.sessionEnded && (
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
              stopPlaying={session.stopPlaying}
              addressData={session.addressData}
              ourShare={session.ourShare}
              theirShare={session.theirShare}
            />
          )}

          {/* Between-hand overlay floats on top of the game area */}
          {session.showBetweenHandOverlay && !session.sessionEnded && (
            <div className='absolute inset-0 z-10 flex flex-col items-center justify-center bg-canvas-bg-subtle/80 backdrop-blur-sm'>
              <Card className='w-full max-w-md'>
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
                  <Button
                    variant='soft'
                    onClick={session.playAgain}
                    className='w-full'
                    leadingIcon={<RotateCcw />}
                  >
                    Play Another Hand
                  </Button>
                  <Button
                    variant='destructive'
                    onClick={session.stopPlaying}
                    className='w-full'
                    leadingIcon={<LogOut />}
                  >
                    End Session
                  </Button>
                </CardContent>
              </Card>
            </div>
          )}

          {/* Waiting for first hand */}
          {!handEverStarted && !session.sessionEnded && (
            <div className='flex items-center justify-center h-full'>
              <p className='text-canvas-text'>Waiting for game to start…</p>
            </div>
          )}

          {/* Session ended, no active hand */}
          {session.sessionEnded && !handEverStarted && (
            <div className='flex items-center justify-center h-full'>
              <p className='text-canvas-text'>Session complete.</p>
            </div>
          )}
        </div>

        {/* Logs panel */}
        <div className='flex flex-col gap-2 lg:flex-[7_1_0%] lg:min-h-0 lg:overflow-y-auto'>
          <LogTextArea label='Game Log' lines={session.gameLog} />
          <LogTextArea label='Debug Log' lines={session.debugLog} />
        </div>
      </div>

      <Toaster />
    </div>
  );
};

export default GameSession;
