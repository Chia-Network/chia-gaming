import React, { cloneElement, useState, useEffect, useCallback } from "react";
import {
  Box,
  Button,
  ButtonGroup,
  Divider,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Typography,
} from "@mui/material";
import useGameSocket from "../hooks/useGameSocket";
import PlayerSection from "./PlayerSection";
import OpponentSection from "./OpponentSection";
import GameEndPlayer from "./GameEndPlayer";
import GameLog from "./GameLog";
import WaitingScreen from "./WaitingScreen";
import { useWasmBlob } from "../hooks/useWasmBlob";
import { getGameSelection } from '../util';
import evaluateHand from '../types/evaluateHand';

const Game: React.FC = () => {
  const gameSelection = getGameSelection();
  const {
    error,
    gameConnectionState,
    setState,
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
    stopPlaying
  } = useWasmBlob();

  const setStateFromMessage = useCallback((evt: any) => {
    setState(evt.data);
  }, []);

  useEffect(function () {
    window.addEventListener("message", setStateFromMessage);

    return function () {
      window.removeEventListener("message", setStateFromMessage);
    };
  });

  // All early returns need to be after all useEffect, etc.
  if (error) {
    return (<div>{error}</div>);
  }

  if (gameConnectionState.stateIdentifier === 'starting') {
    return <WaitingScreen stateName={gameConnectionState.stateIdentifier} messages={gameConnectionState.stateDetail}  />;
  }

  if (gameConnectionState.stateIdentifier === 'shutdown') {
    return (
      <Box p={4}>
          <Typography variant="h4" align="center">
              {`Cal Poker - shutdown succeeded`}
          </Typography>
      </Box>
    );
  }

  console.log('game outcome', outcome);
  let myWinOutcome = outcome?.my_win_outcome;
  let colors = {
    'win': 'green',
    'lose': 'red',
    'tie': '#ccc',
    'success': '#363',
    'warning': '#633',
  };
  let color: 'success' | 'warning' | 'win' | 'lose' | 'tie' = myWinOutcome ? myWinOutcome : isPlayerTurn ? "success" : "warning";
  const iAmAlice = playerNumber === 2;
  const myHandValue = iAmAlice ? outcome?.alice_hand_value : outcome?.bob_hand_value;
  let banner = isPlayerTurn ? "Your turn" : "Opponent's turn";
  if (myWinOutcome === 'win') {
    banner = `You win ${myHandValue}`;
  } else if (myWinOutcome === 'lose') {
    banner = `You lose ${myHandValue}`;
  } else if (myWinOutcome === 'tie') {
    banner = `Game tied ${myHandValue}`;
  }
  const moveDescription = [
    "Commit to random number",
    "Choose 4 cards to discard",
    "Finish game"
  ][moveNumber];

  if (outcome) {
    const alice_hand_string = evaluateHand(outcome.alice_used_cards);
    const bob_hand_string = evaluateHand(outcome.bob_used_cards);
    const end_game_banner = "foo " + alice_hand_string + "over" + bob_hand_string;
    return (
      <div id='total'>
        <div id='overlay'> </div>
        <Box p={4}>
          <Typography variant="h4" align="center">
          {`Cal Poker - move ${moveNumber}`}
          </Typography>
          <br />
          <Typography
            variant="h6"
            align="center"
            color={colors[color]}
          >
            {end_game_banner}
          </Typography>
          <br />
          <Box
            display="flex"
            flexDirection={{ xs: "column", md: "row" }}
            alignItems="stretch"
            gap={2}
            mb={4}
          >
            <Box flex={1} display="flex" flexDirection="column">
              <GameEndPlayer
                iStarted={iStarted}
                playerNumber={iStarted ? 1 : 2}
                outcome={outcome}
              />
            </Box>
            <Box flex={1} display="flex" flexDirection="column">
                <GameEndPlayer
                    iStarted={iStarted}
                    playerNumber={iStarted ? 2 : 1}
                    outcome={outcome}
                />
            </Box>
          </Box>
        </Box>
      </div>
    );
  }

  return (
    <Box p={4}>
      <Typography variant="h4" align="center">
      {`Cal Poker - move ${moveNumber}`}
      </Typography>
      <Button onClick={stopPlaying} disabled={moveNumber !== 0}>Stop</Button>
      <br />
      <Typography
        variant="h6"
        align="center"
        color={colors[color]}
      >
        {banner}
      </Typography>
      <br />
      <Box
        display="flex"
        flexDirection={{ xs: "column", md: "row" }}
        alignItems="stretch"
        gap={2}
        mb={4}
      >
        <Box flex={1} display="flex" flexDirection="column">
          <PlayerSection
            playerNumber={playerNumber}
            playerHand={playerHand}
            isPlayerTurn={isPlayerTurn}
            moveNumber={moveNumber}
            handleMakeMove={handleMakeMove}
            cardSelections={cardSelections}
            setCardSelections={setCardSelections}
          />
        </Box>
        <Box flex={1} display="flex" flexDirection="column">
            <OpponentSection
                playerNumber={(playerNumber == 1) ? 2 : 1}
                opponentHand={opponentHand}
            />
        </Box>
      </Box>
      <br/>
      <Typography>{moveDescription}</Typography>
      <br/>
      <GameLog log={[]} />
    </Box>
  );
};

export default Game;
