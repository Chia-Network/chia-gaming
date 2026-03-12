import { useWasmBlob } from '../hooks/useWasmBlob';
import { getSearchParams, generateOrRetrieveUniqueId } from '../util';
import WaitingScreen from './WaitingScreen';
import Calpoker from '../features/calPoker';
import GameLog from './GameLog';
import { useEffect } from 'react';
import installThemeSyncListener from '../utils/themeSyncListener';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Separator } from './ui/separator';
import { Box, Typography } from '@mui/material';
import { Toaster } from './ui/toaster';

export interface GameParams {
  params: any;
}

const Game: React.FC<GameParams> = ({ params }) => {
  const uniqueId = generateOrRetrieveUniqueId();
  const {
    error,
    log,
    addressData,
    ourShare,
    theirShare,
    gameConnectionState,
    isPlayerTurn,
    iStarted,
    moveNumber,
    handleMakeMove,
    handleCheat,
    playerHand,
    opponentHand,
    playerNumber,
    cardSelections,
    setCardSelections,
    outcome,
    stopPlaying,
  } = useWasmBlob(params, params.lobbyUrl, uniqueId);

  useEffect(() => {
    const uninstall = installThemeSyncListener();
    return () => uninstall();
  }, []);

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-screen p-4">
        <Card className="w-full max-w-md border-destructive">
          <CardHeader>
            <CardTitle className="text-destructive">Error</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">{error}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (gameConnectionState.stateIdentifier === 'starting') {
    return (
      <WaitingScreen
        stateName={gameConnectionState.stateIdentifier}
        messages={gameConnectionState.stateDetail}
      />
    );
  }

  if (gameConnectionState.stateIdentifier === 'clean_shutdown') {
    return (
      <div className="flex items-center justify-center min-h-screen p-4 bg-background">
        <Card className="w-full max-w-2xl shadow-lg">
          <CardHeader className="text-center pb-2">
            <CardTitle
              className="text-2xl font-bold tracking-tight"
              aria-label="shutdown"
            >
              Cal Poker — Shutdown Succeeded
            </CardTitle>
          </CardHeader>

          <Separator className="my-2" />

          <CardContent className="pt-4 space-y-2">
            {gameConnectionState.stateDetail.map((c: string, i: number) => (
              <p
                key={i}
                className="text-center text-lg font-medium text-muted-foreground"
              >
                {c}
              </p>
            ))}
          </CardContent>

          <Separator className="my-2" />

          <CardContent className="pt-2">
            <GameLog log={log} />
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <>
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
        stopPlaying={stopPlaying}
        log={log}
        addressData={addressData}
        ourShare={ourShare}
        theirShare={theirShare}
      />
      <Toaster />
    </>
  );
};

export default Game;