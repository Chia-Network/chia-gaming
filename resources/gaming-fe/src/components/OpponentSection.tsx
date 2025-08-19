import React from "react";
import { useCallback } from "react";
import { Box, Typography, Paper } from "@mui/material";
import PlayingCard from "./PlayingCard";

interface OpponentSectionProps {
  playerNumber: number;
  opponentHand: number[][];
}

const OpponentSection: React.FC<OpponentSectionProps> = ({
  playerNumber,
  opponentHand,
}) => {
  const setSelection = useCallback((index: number, selected: boolean) => {}, []);

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
      {"Opponent"}
      </Typography>
      <br />
      <Typography variant="h6">Opponent's Hand:</Typography>
      <br />
      <Box display="flex" flexDirection="row" mb={2}>
        {opponentHand.map((card, index) => (
          <PlayingCard id={`card-${playerNumber}-${card}`} iAmPlayer={false} key={index} cardValue={card} isFaceDown={false} index={index} setSelection={setSelection} selected={false} />
        ))}
      </Box>
    </Paper>
  );
};

export default OpponentSection;

