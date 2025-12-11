import { Box, Button, Typography } from '@mui/material';

import { useWasmBlob } from '../hooks/useWasmBlob';
import { getSearchParams, generateOrRetrieveUniqueId } from '../util';


import WaitingScreen from './WaitingScreen';
import Calpoker from '../features/calPoker';
import GameLog from './GameLog';
import { useEffect } from 'react';
import installThemeSyncListener from '../utils/themeSyncListener';

export interface GameParams {
  params: any;
}

const Game: React.FC<GameParams> = ({ params }) => {
  const uniqueId = generateOrRetrieveUniqueId();
  const {
    error,
    log,
    eventFireLog,
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

  useEffect(() => {
    // DEBUG use: hook ^L in the window so the user can get a download version of the startup log.
    const saveOnKeypress = (evt: any) => {
      if (evt.ctrlKey && evt.key === 'l') {
        const content = JSON.stringify(eventFireLog);
        const blob = new Blob([content], { type: "application/json" });
        const blobUrl = window.URL.createObjectURL(blob);
        const rootElement = document.getElementById('root');
        if (blobUrl && rootElement) {
          const newElement = document.createElement('a');
          newElement.style = "width: 1px; height: 1px;";
          newElement.download = 'startup.log';
          newElement.href = blobUrl;
          newElement.addEventListener('click', () => {
            setTimeout(() => { window.URL.revokeObjectURL(blobUrl); }, 15000);
          });
          // Click link
          setTimeout(() => {
            newElement.dispatchEvent(new MouseEvent('click'));
            rootElement.removeChild(newElement);
          }, 500);
          rootElement.appendChild(newElement);
        }
      }
    };

    window.addEventListener('keydown', saveOnKeypress);
    return () => {
      window.removeEventListener('keydown', saveOnKeypress);
    };
  }, [eventFireLog]);

  if (gameConnectionState.stateIdentifier === 'starting') {
    return (
      <WaitingScreen
        stateName={gameConnectionState.stateIdentifier}
        messages={gameConnectionState.stateDetail}
        subsystemWaitingList={gameConnectionState.subsystemStatusList}
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
