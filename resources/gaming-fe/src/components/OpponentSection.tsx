import React from "react";
import { Box, Typography, Paper } from "@mui/material";
import PlayingCard from "./PlayingCard";

interface OpponentSectionProps {
  playerNumber: number;
  opponentCoins: number;
  opponentWager: string;
  opponentHand: string[];
}

const OpponentSection: React.FC<OpponentSectionProps> = ({
  playerNumber,
  opponentCoins,
  opponentWager,
  opponentHand,
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
        {playerNumber === 1 ? "Player 2 (Opponent)" : "Player 1 (Opponent)"}
      </Typography>
      <br />
      <Typography>Coins: {opponentCoins}</Typography>
      <Typography>Wager Amount: {opponentWager} XCH</Typography>
      <br />
      <Typography variant="h6">Opponent's Hand:</Typography>
      <br />
      <Box display="flex" flexDirection="row" mb={2}>
        {opponentHand.map((card, index) => (
          <PlayingCard key={index} cardValue={card} isFaceDown={false} />
        ))}
      </Box>
    </Paper>
  );
};

export default OpponentSection;

