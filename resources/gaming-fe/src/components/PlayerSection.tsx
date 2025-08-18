import React from "react";
import { useCallback, useState } from "react";
import { Box, Button, Typography, Paper } from "@mui/material";
import { popcount } from '../util';
import PlayingCard from "./PlayingCard";

interface PlayerSectionProps {
  playerNumber: number;
  playerHand: number[][];
  isPlayerTurn: boolean;
  moveNumber: number;
  handleMakeMove: (move: any) => void;
  cardSelections: number,
  setCardSelections: (mask: number) => void;
}

const PlayerSection: React.FC<PlayerSectionProps> = ({
  playerNumber,
  playerHand,
  isPlayerTurn,
  moveNumber,
  handleMakeMove,
  cardSelections,
  setCardSelections,
}) => {
  let doHandleMakeMove = () => {
    let moveData = "80";
    handleMakeMove(moveData);
  };
  let setSelection = (index: number, selected: boolean) => {
    let selections = cardSelections;
    if (selected) {
      selections |= (1 << index);
    } else {
      selections &= ~(1 << index);
    };
    setCardSelections(selections);
    console.warn(isPlayerTurn, moveNumber, 'cardSelections', selections, selected);
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
      {"You"}
      </Typography>
      <br />
      <Typography variant="h6">Your Hand:</Typography>
      <br />
      <Box display="flex" flexDirection="row" mb={2}>
        {playerHand.map((card: number[], index) => (
          <PlayingCard id={`card-${playerNumber}-${card}`} key={index} index={index} selected={!!(cardSelections & (1 << index))} cardValue={card} setSelection={setSelection} />
        ))}
      </Box>
      <Box mt="auto">
        <Button
          aria-label="make-move"
          variant="contained"
          color="secondary"
          onClick={doHandleMakeMove}
          disabled={!isPlayerTurn || (moveNumber === 1 && popcount(cardSelections) != 4)}
          style={{ marginRight: "8px" }}
        >
          Make Move
        </Button>
      </Box>
    </Paper>
  );
};

export default PlayerSection;
