import React from "react";
import { Box, Typography, Paper } from "@mui/material";
import { OutcomeLogLine, OutcomeHandType, suitNames } from "../types/ChiaGaming";

interface GameLogProps {
  log: OutcomeLogLine[];
}

const GameLog: React.FC<GameLogProps> = ({ log }) => {
  const makeDescription = (desc: OutcomeHandType) => {
    if (desc.rank) {
      return `${desc.name} ${desc.values.toString()}`;
    }

    return `${desc.name} ${suitNames[desc.values[0]]}`;
  };

  const playerDisplay = (desc: OutcomeHandType, hand: number[][]) => {
    const cards = hand.map((c) => {
      const suitName = suitNames[c[1]];
      const isRedSuit = suitName === '♥' || suitName === '♦';
      const suitColor = isRedSuit ? 'red' : 'black';
      return (
        <span style={{color: suitColor, padding: '0.25em'}}>{c[0]}{suitName}</span>
      );
    });
    return (
      <Box mt={2} style={{ display: 'flex', flexDirection: 'row', padding: "0.25em" }}>
        {makeDescription(desc)}
        <div>
          {cards}
        </div>
      </Box>
    );
  };

  return (
    <Box mt={4}>
      <Typography variant="h5">Game & Transactions Log:</Typography>
      <br />
      <Paper
        elevation={1}
        style={{ maxHeight: "800px", overflow: "auto", padding: "8px" }}
      >
        {log.map((entry, index) => (
          <Typography aria-label={`log-entry-${index}`} key={index} style={{ display: 'flex', flexDirection: 'row', alignItems: 'baseline' }}>I {entry.topLineOutcome}: {playerDisplay(entry.myHandDescription, entry.myHand)} vs {playerDisplay(entry.opponentHandDescription, entry.opponentHand)}
          </Typography>
        ))}
      </Paper>
    </Box>
  );
};

export default GameLog;

