import React from "react";
import { useCallback } from "react";
import { Box, Button, Typography, Paper } from "@mui/material";
import PlayingCard from "./PlayingCard";

interface PlayerSectionProps {
  playerNumber: number;
  playerHand: string[];
  isPlayerTurn: boolean;
  moveNumber: number;
  handleMakeMove: (move: any) => void;
}

const PlayerSection: React.FC<PlayerSectionProps> = ({
  playerNumber,
  playerHand,
  isPlayerTurn,
  moveNumber,
  handleMakeMove,
}) => {
  let moveData = "80";
  let doHandleMakeMove = useCallback(() => {
    handleMakeMove(moveData);
  }, []);
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
      {"You"}
      </Typography>
      <br />
      <Typography variant="h6">Your Hand:</Typography>
      <br />
      <Box display="flex" flexDirection="row" mb={2}>
        {playerHand.map((card, index) => (
          <PlayingCard key={index} cardValue={card} />
        ))}
      </Box>
      <Box mt="auto">
        <Button
          variant="contained"
          color="secondary"
          onClick={doHandleMakeMove}
          disabled={!isPlayerTurn}
          style={{ marginRight: "8px" }}
        >
          Make Move
        </Button>
      </Box>
    </Paper>
  );
};

export default PlayerSection;

