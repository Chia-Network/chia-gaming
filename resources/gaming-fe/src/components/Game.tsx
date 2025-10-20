import { Box, Button, Typography } from '@mui/material';

import { useWasmBlob } from '../hooks/useWasmBlob';
import { getSearchParams, generateOrRetrieveUniqueId } from '../util';

import WaitingScreen from './WaitingScreen';
import Calpoker from './Calpoker';

const Game = () => {
  const uniqueId = generateOrRetrieveUniqueId();
  const params = getSearchParams();
  const {
    error,
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
    stopPlaying,
  } = useWasmBlob(params.lobbyUrl, uniqueId);

  // All early returns need to be after all useEffect, etc.
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
        </Box>
      </Box>
    );
  }

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
      stopPlaying={stopPlaying}
    />
  );
};

export default Game;
