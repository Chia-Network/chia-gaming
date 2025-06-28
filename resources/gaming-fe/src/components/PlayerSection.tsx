import React from "react";
import { useCallback, useState } from "react";
import { Box, Button, Typography, Paper } from "@mui/material";
import { popcount } from '../util';
import PlayingCard from "./PlayingCard";

interface PlayerSectionProps {
  playerNumber: number;
  playerHand: string[];
  isPlayerTurn: boolean;
  moveNumber: number;
  handleMakeMove: (move: any) => void;
  setCardSelections: (mask: number) => void;
}

const PlayerSection: React.FC<PlayerSectionProps> = ({
  playerNumber,
  playerHand,
  isPlayerTurn,
  moveNumber,
  handleMakeMove,
  setCardSelections,
}) => {
  let moveData = "80";
  let [cardSelections, setMyCardSelections] = useState<number>(0);
  let doHandleMakeMove = useCallback(() => {
    handleMakeMove(moveData);
  }, []);
  let setSelection = useCallback((index: number, selected: boolean) => {
    if (selected) {
      cardSelections |= 1 << index;
    } else {
      cardSelections &= 0xff ^ (1 << index);
    };
    setMyCardSelections(cardSelections);
    setCardSelections(cardSelections);
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
          <PlayingCard key={index} index={index} cardValue={card} setSelection={setSelection} />
        ))}
      </Box>
      <Box mt="auto">
        <Button
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

