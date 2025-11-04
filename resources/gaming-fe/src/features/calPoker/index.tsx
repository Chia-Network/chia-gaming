import {
  Box,
  Button,
  Card,
  CardContent,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';

import { CalpokerOutcome, OutcomeLogLine } from '../../types/ChiaGaming';
import GameEndPlayer from '../../components/GameEndPlayer';
import GameLog from '../../components/GameLog';
import CaliforniaPoker from '../californiaPoker';
import { StopCircle } from '@mui/icons-material';

export interface CalpokerProps {
  outcome: CalpokerOutcome | undefined;
  lastOutcome: CalpokerOutcome | undefined;
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
  lastOutcome,
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
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));

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

  // if (outcome) {
  //   return (
  //     <div id='total'>
  //       <div id='overlay'> </div>
  //       <Box p={4}>
  //         <Typography variant='h4' align='center'>
  //           {`Cal Poker - move ${moveNumber}`}
  //         </Typography>
  //         <br />
  //         <Typography variant='h6' align='center' color={colors[color]}>
  //           {banner}
  //         </Typography>
  //         <br />
  //         <Box
  //           display='flex'
  //           flexDirection={{ xs: 'column', md: 'row' }}
  //           alignItems='stretch'
  //           gap={2}
  //           mb={4}
  //         >
  //           <Box flex={1} display='flex' flexDirection='column'>
  //             <GameEndPlayer
  //               iStarted={iStarted}
  //               playerNumber={iStarted ? 1 : 2}
  //               outcome={outcome}
  //             />
  //           </Box>
  //           <Box flex={1} display='flex' flexDirection='column'>
  //             <GameEndPlayer
  //               iStarted={iStarted}
  //               playerNumber={iStarted ? 2 : 1}
  //               outcome={outcome}
  //             />
  //           </Box>
  //         </Box>
  //       </Box>
  //     </div>
  //   );
  // }

  const balanceDisplay =
    ourShare !== undefined && theirShare !== undefined
      ? ` - Our Share ${ourShare} vs ${theirShare}`
      : '';

  return (
    <Box
      p={{ xs: 2, sm: 3, md: 4 }}
      sx={{
        minHeight: '100vh',
        bgcolor: '#f8fafc',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
      }}
    >
      {/* Header */}
      <Box
        width='100%'
        display='flex'
        flexDirection={{ xs: 'column', sm: 'row' }}
        justifyContent='space-between'
        alignItems='center'
        mb={3}
      >
        <Typography
          variant={isMobile ? 'h5' : 'h4'}
          sx={{
            fontWeight: 700,
            color: '#424F6D',
            textAlign: { xs: 'center', sm: 'left' },
          }}
        >
          {`Cal Poker - Move ${moveNumber}`}
        </Typography>

        <Box
          display='flex'
          alignItems='center'
          justifyContent={{ xs: 'center', sm: 'flex-end' }}
          gap={2}
          mt={{ xs: 1, sm: 0 }}
        >
          <Typography
            variant='body1'
            sx={{ color: '#6B7280', fontWeight: 600 }}
          >
            {balanceDisplay}
          </Typography>

          <Button
            onClick={stopPlaying}
            disabled={moveNumber !== 0}
            variant='contained'
            startIcon={<StopCircle />}
            sx={{
              backgroundColor:
                moveNumber === 0 ? '#EF4444' : 'rgba(239,68,68,0.5)',
              color: '#fff',
              fontWeight: 600,
              borderRadius: '8px',
              '&:hover': {
                backgroundColor:
                  moveNumber === 0 ? '#DC2626' : 'rgba(239,68,68,0.5)',
              },
            }}
          >
            Stop
          </Button>
        </Box>
      </Box>

      {/* Banner */}
      <Card
        elevation={3}
        sx={{
          width: '100%',
          mb: 3,
          background: `linear-gradient(90deg, ${colors[color]} 0%, #4F5D75 100%)`,
          color: 'white',
          borderRadius: '12px',
          textAlign: 'center',
          boxShadow: '0 4px 10px rgba(0,0,0,0.1)',
        }}
      >
        <CardContent>
          <Typography
            variant={isMobile ? 'h6' : 'h5'}
            sx={{
              fontWeight: 600,
              textShadow: '0 2px 4px rgba(0,0,0,0.3)',
            }}
          >
            {banner || 'Waiting for players...'}
          </Typography>
        </CardContent>
      </Card>

      {/* Main Game Layout */}
      <Box
        width='100%'
        display='flex'
        flexDirection={{ xs: 'column', md: 'row' }}
        gap={2}
      >
        {/* Game Section */}
        <Card
          elevation={3}
          sx={{
            flex: { xs: '1 1 100%', md: '3 1 0%' },
            borderRadius: '12px',
            p: { xs: 2, sm: 3 },
          }}
        >
          <CardContent>
            <CaliforniaPoker
              playerNumber={playerNumber}
              isPlayerTurn={isPlayerTurn}
              moveNumber={moveNumber}
              playerHand={playerHand}
              opponentHand={opponentHand}
              cardSelections={cardSelections}
              setCardSelections={setCardSelections}
              handleMakeMove={handleMakeMove}
              iStarted={iStarted}
              lastOutcome={lastOutcome}
              log={log}
            />

            <Typography
              mt={2}
              textAlign='center'
              sx={{
                color: '#424F6D',
                fontWeight: 500,
                fontSize: isMobile ? '0.9rem' : '1rem',
              }}
            >
              {moveDescription}
            </Typography>
          </CardContent>
        </Card>

        {/* Game Log Section */}

        <GameLog log={log} />
      </Box>

      {/* Hidden blockchain address */}
      <Box
        id='blockchain-address'
        sx={{ position: 'absolute', width: 0, height: 0, opacity: 0 }}
      >
        {JSON.stringify(addressData)}
      </Box>
    </Box>
  );
};

export default Calpoker;
