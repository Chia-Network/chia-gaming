import { useWasmBlob } from '../hooks/useWasmBlob';
import { getSearchParams, generateOrRetrieveUniqueId } from '../util';
import WaitingScreen from './WaitingScreen';
import Calpoker from '../features/calPoker';
import GameLog from './GameLog';
import { useEffect, useState } from 'react';
import installThemeSyncListener from '../utils/themeSyncListener';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from './ui/card';
import { Separator } from './ui/separator';
import { Box, Typography } from '@mui/material';
import { Button } from './button';
import CreateRoomDialog from '../features/createRoom/CreateRoomDialog';

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
    playerHand,
    opponentHand,
    playerNumber,
    cardSelections,
    setCardSelections,
    outcome,
    lastOutcome,
    stopPlaying,
  } = useWasmBlob(params, params.lobbyUrl, uniqueId);

  // State for create room dialog
  const [dialogOpen, setDialogOpen] = useState(false);
  const [gameChoice, setGameChoice] = useState('');
  const [wagerInput, setWagerInput] = useState('');
  const [perHandInput, setPerHandInput] = useState('');
  const [wagerValidationError, setWagerValidationError] = useState('');

  // Placeholder lobby games - you'll need to get this from your actual source
  const lobbyGames = [{ game: 'calpoker', displayName: 'Cal Poker' }];

  // All early returns need to be after all useEffect, etc.
  useEffect(() => {
    // If this page is loaded inside an iframe, accept theme-sync messages
    // from the parent so CSS variables and dark class can be applied.
    const uninstall = installThemeSyncListener();
    return () => uninstall();
  }, []);

  // Set default game choice
  useEffect(() => {
    if (lobbyGames.length > 0 && !gameChoice) {
      setGameChoice(lobbyGames[0].game);
    }
  }, [lobbyGames, gameChoice]);

  const handleCreateClick = () => {
    setDialogOpen(true);
  };

  const handleCreate = () => {
    // Log the create room info for now
    console.log('Create Room Info:', {
      gameChoice,
      wagerInput,
      perHandInput,
    });

    // Close the dialog
    setDialogOpen(false);

    // TODO: Add actual functionality here later
    alert('Room creation logged to console. Functionality to be implemented.');
  };

  const setWagerInputWithCalculation = (newWagerInput: string) => {
    setWagerInput(newWagerInput);
    try {
      const newWagerInputInteger = parseInt(newWagerInput);
      setWagerValidationError('');
      const newPerHand = Math.max(1, Math.floor(newWagerInputInteger / 10));
      setPerHandInput(newPerHand.toString());
    } catch (e: any) {
      setWagerValidationError(`${e.toString()}`);
    }
  };

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
          {gameConnectionState.stateDetail.map((c: string) => (
            <Typography variant='h5' align='center'>
              {c}
            </Typography>
          ))}
          <Box>
            {gameConnectionState.stateDetail.map((c: string) => (
              <Typography variant='h5' align='center'>
                {c}
              </Typography>
            ))}
            <GameLog log={log} />
          </Box>
        </Box>
        <Box display='flex' justifyContent='end' sx={{ pt: 3 }}>
          <Button variant='surface' color='primary' onClick={handleCreateClick}>
            Create New Room
          </Button>
        </Box>
        <CreateRoomDialog
          dialogOpen={dialogOpen}
          closeDialog={() => setDialogOpen(false)}
          gameChoice={gameChoice}
          setGameChoice={setGameChoice}
          lobbyGames={lobbyGames}
          wagerInput={wagerInput}
          setWagerInput={setWagerInputWithCalculation}
          perHandInput={perHandInput}
          setPerHandInput={setPerHandInput}
          wagerValidationError={wagerValidationError}
          handleCreate={handleCreate}
        />
      </Box>
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
