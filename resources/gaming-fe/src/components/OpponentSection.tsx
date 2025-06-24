import React from "react";
import { Box, Typography, Paper } from "@mui/material";
import PlayingCard from "./PlayingCard";

interface OpponentSectionProps {
  playerNumber: number;
  opponentHand: string[];
  iStarted: boolean;
}

const OpponentSection: React.FC<OpponentSectionProps> = ({
  playerNumber,
  iStarted,
  opponentHand,
}) => {
  let players = ["You", "Other"];
  let playerSwap = iStarted ? 0 : 1;
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
      {`Player ${playerNumber} (${players[playerNumber ^ playerSwap]})`}
      </Typography>
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

