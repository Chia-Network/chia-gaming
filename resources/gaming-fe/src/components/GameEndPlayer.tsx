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
  const iAmAlice = playerNumber === 2;
  const playerHand: number[][] = iAmAlice ? outcome.alice_cards : outcome.bob_cards;
  const iAmPlayer = iStarted !== iAmAlice;
  const who = iAmPlayer ? 'Your' : 'Opponent';
  const whoTitle = iAmPlayer ? 'You' : 'Opponent';
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
          let selectionColor = cardColors[card_color(outcome, !iStarted, card)];
          return (
            <PlayingCard
                id={id}
                key={index}
                index={index}
                iAmPlayer={iAmPlayer}
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

