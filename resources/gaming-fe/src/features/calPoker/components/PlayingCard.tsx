import { Paper, Typography } from '@mui/material';
import { cardIdToRankSuit, suitNames } from '../../../types/ChiaGaming';
import { RANK_SYMBOLS } from './constants/constants';


interface PlayingCardProps {
  id: string;
  index: number;
  cardValue: number;
  isFaceDown?: boolean;
  selected: boolean;
  selectionColor?: string;
  setSelection: (index: number, selected: boolean) => void;
  iAmPlayer: boolean;
}

const PlayingCard = ({
  id,
  index,
  cardValue,
  selected,
  setSelection,
  selectionColor,
  isFaceDown = false,
  iAmPlayer,
}: PlayingCardProps) => {
  const { rank, suit } = cardIdToRankSuit(cardValue);
  const suitName = suitNames[suit];
  const rankDisplay = RANK_SYMBOLS[rank] ?? rank;
  const setSelectedCB = () => {
    const newSelected = !selected;
    setSelection(index, newSelected);
  };

  const isRedSuit = suitName === '♥' || suitName === '♦';
  const suitColor = isRedSuit ? 'red' : 'black';

  const cardStyle = {
    width: '60px',
    height: '90px',
    marginRight: '8px',
    borderRadius: '8px',
    border: '1px solid #000',
    display: 'flex',
    flexDirection: 'column' as const,
    justifyContent: 'space-between',
    padding: '8px',
    backgroundColor: selectionColor
      ? selectionColor
      : selected
        ? '#ddd'
        : isFaceDown
          ? '#2E7D32'
          : '#FFFFFF',
    color: isFaceDown ? '#FFFFFF' : suitColor,
    cursor: 'pointer',
    textAlign: 'center' as const,
    boxSizing: 'border-box' as const,
  };

  return (
    <Paper
      id={id}
      elevation={3}
      aria-label={`card-${iAmPlayer}-${index}`}
      style={cardStyle}
      onClick={setSelectedCB}
    >
      {!isFaceDown && (
        <>
          <Typography variant='body2' style={{ fontWeight: 'bold' }}>
            {rankDisplay}
            {suitName}
          </Typography>
          <Typography
            variant='body2'
            style={{ fontWeight: 'bold', transform: 'rotate(180deg)' }}
          >
            {rankDisplay}
            {suitName}
          </Typography>
        </>
      )}
    </Paper>
  );
};

export default PlayingCard;
