import { Paper, Typography } from '@mui/material';

const suitNames: Record<number, string> = {
  0: 'Q',
  1: '♥',
  2: '♦',
  3: '♠',
  4: '♣',
};

const rankSymbols: Record<number, string> = {
  14: 'A',
  11: 'J',
  12: 'Q',
  13: 'K',
};

interface PlayingCardProps {
  id: string;
  index: number;
  cardValue: number[]; // [rank, suit]
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
  const rank = cardValue[0];
  const suit = suitNames[cardValue[1]];
  const rankDisplay = rankSymbols[rank] ?? rank;

  const isRedSuit = suit === '♥' || suit === '♦';
  const suitColor = isRedSuit ? 'red' : 'black';

  const handleClick = () => setSelection(index, !selected);

  const cardStyle = {
    width: '60px',
    height: '90px',
    marginRight: '8px',
    borderRadius: '8px',
    border: selected ? '2px solid #1976d2' : '1px solid #000',
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
    transform: selected ? 'translateY(-5px)' : 'none',
    transition: 'transform 0.2s ease',
  };

  return (
    <Paper
      id={id}
      elevation={3}
      aria-label={`card-${iAmPlayer}-${index}`}
      style={cardStyle}
      onClick={handleClick}
    >
      {!isFaceDown && (
        <>
          <Typography variant='body2' style={{ fontWeight: 'bold' }}>
            {rankDisplay}
            {suit}
          </Typography>
          <Typography
            variant='body2'
            style={{
              fontWeight: 'bold',
              transform: 'rotate(180deg)',
            }}
          >
            {rankDisplay}
            {suit}
          </Typography>
        </>
      )}
    </Paper>
  );
};

export default PlayingCard;
