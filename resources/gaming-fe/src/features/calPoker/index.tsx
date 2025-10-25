import { Box, Button, Typography } from '@mui/material';


import { CalpokerOutcome, OutcomeLogLine } from '../../types/ChiaGaming';
import {  OpponentSection, PlayerSection } from './components';
import GameEndPlayer from '../../components/GameEndPlayer';
import GameLog from '../../components/GameLog';

export interface CalpokerProps {
  outcome: CalpokerOutcome | undefined;
  ourShare: number | undefined;
  theirShare: number | undefined;
  moveNumber: number;
  iStarted: boolean;
  isPlayerTurn: boolean;
  playerNumber: number;
  playerHand: number[][];
  opponentHand: number[][];
  cardSelections: number;
  setCardSelections: (n: number) => void;
  handleMakeMove: (hex: string) => void;
  stopPlaying: () => void;
  addressData: any;
  log: OutcomeLogLine[];
}

const Calpoker: React.FC<CalpokerProps> = ({
  outcome,
  ourShare,
  theirShare,
  moveNumber,
  iStarted,
  isPlayerTurn,
  playerNumber,
  playerHand,
  opponentHand,
  cardSelections,
  setCardSelections,
  handleMakeMove,
  stopPlaying,
  addressData,
  log,
}) => {
  const myWinOutcome = outcome?.my_win_outcome;
  const colors = {
    win: 'green',
    lose: 'red',
    tie: '#ccc',
    success: '#363',
    warning: '#633',
  };
  const color: 'success' | 'warning' | 'win' | 'lose' | 'tie' = myWinOutcome
    ? myWinOutcome
    : isPlayerTurn
      ? 'success'
      : 'warning';
  const iAmAlice = playerNumber === 2;
  const myHandValue = iAmAlice
    ? outcome?.alice_hand_value
    : outcome?.bob_hand_value;
  let banner = isPlayerTurn ? 'Your turn' : "Opponent's turn";
  if (myWinOutcome === 'win') {
    banner = `You win ${myHandValue}`;
  } else if (myWinOutcome === 'lose') {
    banner = `You lose ${myHandValue}`;
  } else if (myWinOutcome === 'tie') {
    banner = `Game tied ${myHandValue}`;
  }
  const moveDescription = [
    'Commit to random number',
    'Choose 4 cards to discard',
    'Finish game',
  ][moveNumber];

  if (outcome) {
    return (
      <div id='total'>
        <div id='overlay'> </div>
        <Box p={4}>
          <Typography variant='h4' align='center'>
            {`Cal Poker - move ${moveNumber}`}
          </Typography>
          <br />
          <Typography variant='h6' align='center' color={colors[color]}>
            {banner}
          </Typography>
          <br />
          <Box
            display='flex'
            flexDirection={{ xs: 'column', md: 'row' }}
            alignItems='stretch'
            gap={2}
            mb={4}
          >
            <Box flex={1} display='flex' flexDirection='column'>
              <GameEndPlayer
                iStarted={iStarted}
                playerNumber={iStarted ? 1 : 2}
                outcome={outcome}
              />
            </Box>
            <Box flex={1} display='flex' flexDirection='column'>
              <GameEndPlayer
                iStarted={iStarted}
                playerNumber={iStarted ? 2 : 1}
                outcome={outcome}
              />
            </Box>
          </Box>
        </Box>
      </div>
    );
  }

  const balanceDisplay =
    (ourShare !== undefined && theirShare !== undefined) ?
    ` - Our Share ${ourShare} vs ${theirShare}` : '';

  return (
    <Box p={4}>
      <Typography variant='h4' align='center'>
        {`Cal Poker - move ${moveNumber}`}
        {balanceDisplay}
      </Typography>
      <Button
        onClick={stopPlaying}
        disabled={moveNumber !== 0}
        aria-label='stop-playing'
        aria-disabled={moveNumber !== 0}
      >
        Stop
      </Button>
      <br />
      <Typography variant='h6' align='center' color={colors[color]}>
        {banner}
      </Typography>
      <br />
      <Box
        display='flex'
        flexDirection={{ xs: 'column', md: 'row' }}
        alignItems='stretch'
        gap={2}
        mb={4}
      >
        <Box flex={1} display='flex' flexDirection='column'>
          <PlayerSection
            playerNumber={playerNumber}
            playerHand={playerHand}
            isPlayerTurn={isPlayerTurn}
            moveNumber={moveNumber}
            handleMakeMove={handleMakeMove}
            cardSelections={cardSelections}
            setCardSelections={setCardSelections}
          />
        </Box>
        <Box flex={1} display='flex' flexDirection='column'>
          <OpponentSection
            playerNumber={playerNumber == 1 ? 2 : 1}
            opponentHand={opponentHand}
          />
        </Box>
      </Box>
      <br />
      <Typography>{moveDescription}</Typography>
      <br />
      <GameLog log={log} />
      <div
        id='blockchain-address'
        style={{ position: 'relative', width: 0, height: 0, opacity: '0%' }}
      >
        {JSON.stringify(addressData)}
      </div>
    </Box>
  );
};

export default Calpoker;
