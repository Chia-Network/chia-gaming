import React from "react";
import { Box, Typography } from "@mui/material";
import useGameSocket from "../hooks/useGameSocket";
import PlayerSection from "./PlayerSection";
import OpponentSection from "./OpponentSection";
import GameLog from "./GameLog";
import WaitingScreen from "./WaitingScreen";
import LobbyScreen from "./LobbyScreen";

const Game: React.FC = () => {
  const {
    gameState,
    wagerAmount,
    setWagerAmount,
    opponentWager,
    log,
    playerHand,
    opponentHand,
    playerCoins,
    opponentCoins,
    isPlayerTurn,
    playerNumber,
    handleFindOpponent,
    handleBet,
    handleMakeMove,
    handleEndTurn,
  } = useGameSocket();

  if (gameState === "idle") {
    return (
      <LobbyScreen
        wagerAmount={wagerAmount}
        setWagerAmount={setWagerAmount}
        handleFindOpponent={handleFindOpponent}
      />
    );
  } else if (gameState === "searching") {
    return <WaitingScreen />;
  } else if (gameState === "playing") {
    return (
      <Box p={4}>
        <Typography variant="h4" align="center">
          Cal Poker
        </Typography>
        <br />
        <Typography
          variant="h6"
          align="center"
          color={isPlayerTurn ? "success" : "warning"}
        >
          {isPlayerTurn ? "Your turn" : "Opponent's turn"}
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
              playerCoins={playerCoins}
              wagerAmount={wagerAmount}
              playerHand={playerHand}
              isPlayerTurn={isPlayerTurn}
              handleBet={handleBet}
              handleMakeMove={handleMakeMove}
              handleEndTurn={handleEndTurn}
            />
          </Box>
          <Box flex={1} display="flex" flexDirection="column">
            <OpponentSection
              playerNumber={playerNumber}
              opponentCoins={opponentCoins}
              opponentWager={opponentWager}
              opponentHand={opponentHand}
            />
          </Box>
        </Box>
        <GameLog log={log} />
      </Box>
    );
  }

  return null;
};

export default Game;
