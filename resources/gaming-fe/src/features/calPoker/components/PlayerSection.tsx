import { Box, Button, Typography, Paper } from '@mui/material';



import PlayingCard from './PlayingCard';

interface PlayerSectionProps {
  playerNumber: number;
  playerHand: number[];
  isPlayerTurn: boolean;
  moveNumber: number;
  handleMakeMove: (move: any) => void;
  cardSelections: number[];
  setCardSelections: (mask: number[]) => void;
}

const PlayerSection = ({
  playerNumber,
  playerHand,
  isPlayerTurn,
  moveNumber,
  handleMakeMove,
  cardSelections,
  setCardSelections,
}: PlayerSectionProps) => {
  const doHandleMakeMove = () => {
    const moveData = '80';
    handleMakeMove(moveData);
  };
  const setSelection = (cardId: number, selected: boolean) => {
    let selections = cardSelections;
    if (selected) {
      selections = [...cardSelections, cardId];
    } else {
      selections = cardSelections.filter((id) => id !== cardId);
    }
    setCardSelections(selections);
    console.warn(
      isPlayerTurn,
      moveNumber,
      'cardSelections',
      selections,
      selected,
    );
  };
  const disabled =
    !isPlayerTurn || (moveNumber === 1 && cardSelections.length != 4);
  return (
    <Paper
      elevation={3}
      style={{
        padding: '16px',
        flexGrow: 1,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <Typography variant='h5'>{'You'}</Typography>
      <br />
      <Typography variant='h6'>Your Hand:</Typography>
      <br />
      <Box display='flex' flexDirection='row' mb={2}>
        {playerHand.map((card: number, index) => (
          <PlayingCard
            iAmPlayer
            id={`card-${playerNumber}-${card}`}
            key={index}
            index={card}
            selected={cardSelections.includes(card)}
            cardValue={card}
            setSelection={setSelection}
          />
        ))}
      </Box>
      <Box mt='auto'>
        <Button
          variant='contained'
          color='secondary'
          onClick={doHandleMakeMove}
          disabled={disabled}
          style={{ marginRight: '8px' }}
          aria-label='make-move'
          aria-disabled={disabled}
        >
          Make Move
        </Button>
      </Box>
    </Paper>
  );
};

export default PlayerSection;
