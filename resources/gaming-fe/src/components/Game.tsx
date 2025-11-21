import { Box, Button, Typography } from '@mui/material';

import { useWasmBlob } from '../hooks/useWasmBlob';
import { getSearchParams, generateOrRetrieveUniqueId } from '../util';


import WaitingScreen from './WaitingScreen';
import Calpoker from '../features/calPoker';
import GameLog from './GameLog';
import { useEffect } from 'react';
import installThemeSyncListener from '../utils/themeSyncListener';



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
      <Box p={4}>
        <Typography variant='h4' align='center' aria-label='shutdown'>
          {`Cal Poker - shutdown succeeded`}
        </Typography>
        <Box>
          {gameConnectionState.stateDetail.map((c) => (
            <Typography variant='h5' align='center'>
              {c}
            </Typography>
          ))}
          <Box>
            {gameConnectionState.stateDetail.map((c) => (
              <Typography variant='h5' align='center'>
                {c}
              </Typography>
            ))}
            <GameLog log={log} />
          </Box>
        </Box>
      </Box>
    );
  }

  return (
    <Calpoker
      outcome={outcome}
      lastOutcome={lastOutcome}
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
