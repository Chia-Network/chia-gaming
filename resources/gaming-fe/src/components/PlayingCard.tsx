import React from 'react';
import { useState, useCallback } from 'react';
import { Paper, Typography } from '@mui/material';

interface PlayingCardProps {
  id: string;
  index: number;
  cardValue: number[];
  isFaceDown?: boolean;
  selected: boolean;
  selectionColor?: string;
  setSelection: (index: number, selected: boolean) => void;
}

const PlayingCard: React.FC<PlayingCardProps> = ({
  id,
  index,
  cardValue,
  selected,
  setSelection,
  selectionColor,
  isFaceDown = false,
}) => {
  const suitNames = ['Q', '♥', '♦', '♤', '♧'];
  const rank = cardValue.slice(0, -1);
  const suit = suitNames[(cardValue.slice(-1)[0] as any)];
  const setSelectedCB = () => {
    const newSelected = !selected;
    setSelection(index, newSelected);
  };

  const isRedSuit = suit === '♥' || suit === '♦';
  const suitColor = isRedSuit ? 'red' : 'black';

  const cardStyle = {
    width: '60px',
    height: '90px',
    marginRight: '8px',
    borderRadius: '8px',
    border: '1px solid #000',
    display: 'flex',
    flexDirection: 'column' as 'column',
    justifyContent: 'space-between',
    padding: '8px',
    backgroundColor: selectionColor ? selectionColor : selected ? '#ddd' : (isFaceDown ? '#2E7D32' : '#FFFFFF'),
    color: isFaceDown ? '#FFFFFF' : suitColor,
    cursor: 'pointer',
    textAlign: 'center' as 'center',
    boxSizing: 'border-box' as 'border-box',
  };

  return (
    <Paper id={id} elevation={3} style={cardStyle} onClick={setSelectedCB}>
      {!isFaceDown && (
        <>
          <Typography variant="body2" style={{ fontWeight: 'bold' }}>
            {rank}
            {suit}
          </Typography>
          <Typography
            variant="body2"
            style={{ fontWeight: 'bold', transform: 'rotate(180deg)' }}
          >
            {rank}
            {suit}
          </Typography>
        </>
      )}
    </Paper>
  );
};

export default PlayingCard;

