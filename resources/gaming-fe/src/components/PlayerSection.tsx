import React from "react";
import { Box, Button, Typography, Paper } from "@mui/material";
import PlayingCard from "./PlayingCard";

interface PlayerSectionProps {
  playerNumber: number;
  playerHand: string[];
  isPlayerTurn: boolean;
  iStarted: boolean;
  moveNumber: number;
  handleMakeMove: (move: any) => void;
}

const PlayerSection: React.FC<PlayerSectionProps> = ({
  playerNumber,
  playerHand,
  isPlayerTurn,
  iStarted,
  moveNumber,
  handleMakeMove,
}) => {
  let players = ["You", "Other"];
  let playerSwap = iStarted ? 0 : 1;
  let moveData = "80";
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
          onClick={() => handleMakeMove(moveData)}
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

