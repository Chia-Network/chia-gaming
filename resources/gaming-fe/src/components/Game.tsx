import { useWasmBlob } from '../hooks/useWasmBlob';
import { getSearchParams, generateOrRetrieveUniqueId } from '../util';
import WaitingScreen from './WaitingScreen';
import Calpoker from '../features/calPoker';
import GameLog from './GameLog';
import { useEffect } from 'react';
import installThemeSyncListener from '../utils/themeSyncListener';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Separator } from './ui/separator';



const Game = () => {
  const uniqueId = generateOrRetrieveUniqueId();
  const params = getSearchParams();
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
    playerHand,
    opponentHand,
    playerNumber,
    cardSelections,
    setCardSelections,
    outcome,
    lastOutcome,
    stopPlaying,
  } = useWasmBlob(params.lobbyUrl, uniqueId);

  // All early returns need to be after all useEffect, etc.
  useEffect(() => {
    // If this page is loaded inside an iframe, accept theme-sync messages
    // from the parent so CSS variables and dark class can be applied.
    const uninstall = installThemeSyncListener();
    return () => uninstall();
  }, []);
  if (error) {
    return <div>{error}</div>;
  }

  if (gameConnectionState.stateIdentifier === 'starting') {
    return (
      <WaitingScreen
        stateName={gameConnectionState.stateIdentifier}
        messages={gameConnectionState.stateDetail}
      />
    );
  }

  if (gameConnectionState.stateIdentifier === 'shutdown') {
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-canvas-base p-6">
        <Card className="
            w-full max-w-4xl
            max-h-[90vh]       
            rounded-2xl
            border border-canvas-border
            bg-canvas-bg-subtle
            shadow-[0_10px_40px_-12px_rgba(0,0,0,0.15)]
            backdrop-blur-xl
            overflow-hidden      
            transition-all duration-300
            flex flex-col      
          ">

          {/* HEADER */}
          <CardHeader className="text-center space-y-2 px-8 pt-8 shrink-0">
            <CardTitle className="text-4xl font-extrabold tracking-tight text-canvas-text-contrast">
              Cal Poker – shutdown succeeded
            </CardTitle>

            <CardDescription className="text-base text-canvas-text font-medium">
              Systems safely terminated – see session details below
            </CardDescription>
          </CardHeader>

          <Separator className="bg-canvas-border/60 my-4 shrink-0" />

          {/* CONTENT */}
          <CardContent className="space-y-6 px-8 pb-8 flex flex-col flex-1 overflow-hidden">

            {/* DETAIL ROW */}
            <div className="w-full grid grid-cols-1 md:grid-cols-2 gap-3 shrink-0">
              {gameConnectionState.stateDetail.map((c, index) => (
                <div
                  key={index}
                  className="w-full h-12 rounded-lg bg-secondary-bg border border-secondary-border text-secondary-text font-medium text-sm flex items-center justify-center shadow-sm transition-colors hover:bg-secondary-bg-hover"
                >
                  {c}
                </div>
              ))}
            </div>

            <Separator className="bg-canvas-border/60 shrink-0" />

            {/* GAME LOG */}
            <div className="w-full rounded-xl border border-canvas-border bg-canvas-base shadow-sm flex-1 overflow-y-auto">
              <GameLog log={log} />
            </div>
          </CardContent>
        </Card>
      </div>

    );
  }

  return (
    <Calpoker
      outcome={outcome ? outcome : lastOutcome}
      moveNumber={moveNumber}
      iStarted={iStarted}
      isPlayerTurn={isPlayerTurn}
      playerNumber={playerNumber}
      playerHand={playerHand}
      opponentHand={opponentHand}
      cardSelections={cardSelections}
      setCardSelections={setCardSelections}
      handleMakeMove={handleMakeMove}
      stopPlaying={stopPlaying}
      log={log}
      addressData={addressData}
      ourShare={ourShare}
      theirShare={theirShare}
    />
  );
};

export default Game;
