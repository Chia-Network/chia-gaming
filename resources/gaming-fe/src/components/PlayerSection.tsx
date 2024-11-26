// components/PlayerSection.tsx
import React from "react";
import { Box, Button, Typography, Paper } from "@mui/material";
import PlayingCard from "./PlayingCard";

interface PlayerSectionProps {
  playerNumber: number;
  playerCoins: number;
  wagerAmount: string;
  playerHand: string[];
  isPlayerTurn: boolean;
  handleBet: (amount: number) => void;
  handleMakeMove: () => void;
  handleEndTurn: () => void;
}

const PlayerSection: React.FC<PlayerSectionProps> = ({
  playerNumber,
  playerCoins,
  wagerAmount,
  playerHand,
  isPlayerTurn,
  handleBet,
  handleMakeMove,
  handleEndTurn,
}) => {
  return (
    <Paper
      elevation={3}
      style={{
        padding: "16px",
        flexGrow: 1,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <Typography variant="h5">
        {playerNumber === 1 ? "Player 1 (You)" : "Player 2 (You)"}
      </Typography>
      <br />
      <Typography>Coins: {playerCoins}</Typography>
      <Typography>Wager Amount: {wagerAmount} XCH</Typography>
      <br />
      <Typography variant="h6">Your Hand:</Typography>
      <br />
      <Box display="flex" flexDirection="row" mb={2}>
        {playerHand.map((card, index) => (
          <PlayingCard key={index} cardValue={card} />
        ))}
      </Box>
      <Typography>Bet:</Typography>
      <Box display="flex" flexDirection="row" mb={2}>
        <Button
          variant="outlined"
          onClick={() => handleBet(5)}
          style={{ marginRight: "8px" }}
          disabled={!isPlayerTurn}
        >
          Bet 5
        </Button>
        <Button
          variant="outlined"
          onClick={() => handleBet(10)}
          style={{ marginRight: "8px" }}
          disabled={!isPlayerTurn}
        >
          Bet 10
        </Button>
        <Button
          variant="outlined"
          onClick={() => handleBet(20)}
          disabled={!isPlayerTurn}
        >
          Bet 20
        </Button>
      </Box>
      <Box mt="auto">
        <Button
          variant="contained"
          color="secondary"
          onClick={handleMakeMove}
          disabled={!isPlayerTurn}
          style={{ marginRight: "8px" }}
        >
          Make Move
        </Button>

        <Button
          variant="contained"
          color="primary"
          onClick={handleEndTurn}
          disabled={!isPlayerTurn}
        >
          End Turn
        </Button>
      </Box>
    </Paper>
  );
};

export default PlayerSection;
