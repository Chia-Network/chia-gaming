import React from "react";
import { useCallback, useState } from "react";
import { Box, Button, Typography, Paper } from "@mui/material";
import { popcount } from '../util';
import { card_color, CalpokerOutcome } from '../types/ChiaGaming';
import PlayingCard from "./PlayingCard";

interface GameEndPlayerProps {
iStarted: boolean;
playerNumber: number;
outcome: CalpokerOutcome;
}

const GameEndPlayer: React.FC<GameEndPlayerProps> = ({
    iStarted,
    playerNumber,
    outcome,
}) => {
  const iAmAlice = iStarted === (playerNumber === 2);
  const playerHand: number[][] = iAmAlice ? outcome.alice_cards : outcome.bob_cards;
  const who = (iStarted !== iAmAlice) ? 'Opponent' : 'Your';
  const whoTitle = (iStarted !== iAmAlice) ? 'Opponent' : 'You';
  const cardColors = {
    'my-used': '#4d4',
    'my-final': '#bfb',
    'their-used': '#bbb',
    'their-final': '#fff'
  };
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
      {whoTitle}
      </Typography>
      <br />
      <Typography variant="h6">{`${who} Hand:`}</Typography>
      <br />
      <Box display="flex" flexDirection="row" mb={2}>
        {playerHand.map((card: number[], index: number) => {
          const id = `at-rest-${iStarted}-${card}`;
          let selectionColor = cardColors[card_color(outcome, iAmAlice, card)];
          return (
            <PlayingCard
                id={id}
                key={index}
                index={index}
                selected={false}
                selectionColor={selectionColor}
                cardValue={card}
                setSelection={() => {}}
            />
          );
        })}
      </Box>
    </Paper>
  );
};

export default GameEndPlayer;

