import React from 'react';
import { useState, useCallback } from 'react';
import { Paper, Typography } from '@mui/material';

interface PlayingCardProps {
  index: number;
  cardValue: string;
  isFaceDown?: boolean;
  setSelection: (index: number, selected: boolean) => void;
}

const PlayingCard: React.FC<PlayingCardProps> = ({
  index,
  cardValue,
  setSelection,
  isFaceDown = false,
}) => {
  const suitNames = ['Q', '♥', '♦', '♤', '♧'];
  const rank = cardValue.slice(0, -1);
  const suit = suitNames[(cardValue.slice(-1)[0] as any)];
  const [selected, setSelected] = useState<boolean>(false);
  const setSelectedCB = useCallback(() => {
    setSelected(!selected);
    setSelection(index, selected);
  }, []);

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
    backgroundColor: selected ? '#ddd' : (isFaceDown ? '#2E7D32' : '#FFFFFF'),
    color: isFaceDown ? '#FFFFFF' : suitColor,
    textAlign: 'center' as 'center',
    boxSizing: 'border-box' as 'border-box',
  };

  return (
    <Paper elevation={3} style={cardStyle} onClick={setSelectedCB}>
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

