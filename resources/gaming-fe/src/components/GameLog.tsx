import React from "react";
import { Box, Typography, Paper } from "@mui/material";

interface GameLogProps {
  log: string[];
}

const GameLog: React.FC<GameLogProps> = ({ log }) => {
  return (
    <Box mt={4}>
      <Typography variant="h5">Game & Transactions Log:</Typography>
      <br />
      <Paper
        elevation={1}
        style={{ maxHeight: "800px", overflow: "auto", padding: "8px" }}
      >
        {log.map((entry, index) => (
          <Typography aria-label={`log-entry-${index}`} key={index}>{entry}</Typography>
        ))}
      </Paper>
    </Box>
  );
};

export default GameLog;

