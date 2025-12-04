import { Box, Button, Typography } from '@mui/material';

import { useWasmBlob } from '../hooks/useWasmBlob';
import { getSearchParams, generateOrRetrieveUniqueId } from '../util';


import WaitingScreen from './WaitingScreen';
import Calpoker from '../features/calPoker';
import GameLog from './GameLog';
import { useEffect, useState, useCallback } from 'react';
import installThemeSyncListener from '../utils/themeSyncListener';

let plainDataCalpokerKeys = [
  'log',
  'addressData',
  'ourShare',
  'theirShare',
  'isPlayerTurn',
  'iStarted',
  'moveNumber',
  'playerHand',
  'opponentHand',
  'playerNumber',
  'cardSelections',
  'setCardSelections',
  'outcome',
  'lastOutcome'
];

function copyKeys(source: any, keys: string[]): any {
  const result: any = {};
  keys.forEach((k) => result[k] = source[k]);
  return result;
}

const Game = () => {
  let [updatesSuspended, setUpdatesSuspended] = useState(false);
  const uniqueId = generateOrRetrieveUniqueId();
  const params = getSearchParams();
  const nativeWasmBlobData = useWasmBlob(params.lobbyUrl, uniqueId);
  const capturedPlainWasmBlobData = copyKeys(nativeWasmBlobData, plainDataCalpokerKeys);
  let [calpokerGameDisplayData, setCalpokerGameDisplayData] = useState<any>(capturedPlainWasmBlobData);
  let showCalpokerData = updatesSuspended ? calpokerGameDisplayData : nativeWasmBlobData;
  let {
    error,
    gameConnectionState,
    handleMakeMove,
    stopPlaying,
    setCardSelections
  } = nativeWasmBlobData;

  let downstreamSetSuspended = useCallback((suspended: boolean) => {
    if (suspended) {
      setCalpokerGameDisplayData(capturedPlainWasmBlobData);
    }
    console.log('suspend changed', suspended);
    console.log('cards (incoming)', nativeWasmBlobData.playerHand);
    setUpdatesSuspended(suspended);
  }, [capturedPlainWasmBlobData]);

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
            <GameLog log={showCalpokerData.log} />
          </Box>
        </Box>
      </Box>
    );
  }

  return (
    <Calpoker
      setSuspended={downstreamSetSuspended}
      suspended={updatesSuspended}
      outcome={showCalpokerData.outcome}
      lastOutcome={showCalpokerData.lastOutcome}
      moveNumber={showCalpokerData.moveNumber}
      iStarted={showCalpokerData.iStarted}
      isPlayerTurn={showCalpokerData.isPlayerTurn}
      playerNumber={showCalpokerData.playerNumber}
      playerHand={showCalpokerData.playerHand}
      opponentHand={showCalpokerData.opponentHand}
      cardSelections={showCalpokerData.cardSelections}
      log={showCalpokerData.log}
      addressData={showCalpokerData.addressData}
      ourShare={showCalpokerData.ourShare}
      theirShare={showCalpokerData.theirShare}
      setCardSelections={setCardSelections}
      handleMakeMove={handleMakeMove}
      stopPlaying={stopPlaying}
    />
  );
};

export default Game;
