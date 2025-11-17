import React, { useEffect, useState } from 'react';
import {
  Box,
  Button,
  Card,
  CardContent,
  Typography,
  useMediaQuery,
  useTheme,
  Snackbar,
  Slide,
  IconButton,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';

import { CalpokerOutcome, OutcomeLogLine } from '../../types/ChiaGaming';
import GameEndPlayer from '../../components/GameEndPlayer';
import GameLog from '../../components/GameLog';
import CaliforniaPoker from '../californiaPoker';
import { StopCircle } from '@mui/icons-material';
import { Info, LogOut } from 'lucide-react';

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

  // Toast (Snackbar) state for move description
  const [showMoveToast, setShowMoveToast] = useState(false);

  useEffect(() => {
    // show toast on mount or when moveNumber changes
    setShowMoveToast(true);
  }, [moveNumber]);

  const handleHelpClick = () => {
    // Re-trigger the toast so it animates again from the top
    setShowMoveToast(false);
    // small timeout to allow exit animation before re-opening
    setTimeout(() => setShowMoveToast(true), 120);
  };

  const handleCloseMoveToast = (_: any, reason?: string) => {
    if (reason === 'clickaway') return;
    setShowMoveToast(false);
  };

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
        bgcolor: '#fff',
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
        marginY={3}
      >
        <Typography
          variant={isMobile ? 'h5' : 'h4'}
          sx={{
            fontWeight: 700,
            color: '#424F6D',
            textAlign: { xs: 'center', sm: 'left' },
          }}
        >
          {`California Poker`}
        </Typography>
        <Box
          display='flex'
          alignItems='center'
          justifyContent={{ xs: 'center', sm: 'flex-end' }}
          gap={2}
          mt={{ xs: 1, sm: 0 }}
        >
          <Button
            onClick={handleHelpClick}
            variant='outlined'
            startIcon={<Info />}
            sx={{
              backgroundColor: 'white',
              borderColor: '#e5e7eb',
              color: '#0f172a',
              fontWeight: 600,
              borderRadius: '8px',
              px: 2,
              '&:hover': {
                backgroundColor: '#ffffff',
              },
            }}
          >
            Hint
          </Button>
          <Button
            onClick={stopPlaying}
            disabled={moveNumber !== 0}
            variant='outlined'
            startIcon={<LogOut />}
            data-testid='stop-playing'
            sx={{
              borderColor: '#EF4444',
              color: '#EF4444',
              fontWeight: 600,
              borderRadius: '8px',
              px: 2,
              '&:hover': {
                backgroundColor: 'rgba(239,68,68,0.04)',
              },
            }}
          >
            Leave Game
          </Button>
        </Box>
      </Box>

      {/* Banner */}

      {/* Main Game Layout */}
      <Box
        width='100%'
        display='flex'
        justifyContent='center'
        
        sx={{
          overflow: 'visible',
          height: { md: 'calc(100vh - 150px)', xs: 'auto' },
        }}
      >
        <Box
          width='100%'
          display='flex'
          flexDirection={{ xs: 'column', md: 'row' }}
          sx={{
            gap: 2,
            overflow: 'hidden',
            height: { md: '100%', xs: 'auto' },
          }}
        >
          {/* Main game pane (75% on md+) */}
          <Box
            sx={{
              flex: { xs: 'unset', md: '3 1 0%' },
              height: { xs: 'auto', md: '100%' },
              overflow: 'auto',
              minHeight: { md: 0 },
            }}
          >
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
              myWinOutcome={myWinOutcome}
              banner={banner}
              balanceDisplay={balanceDisplay}
            />
          </Box>

          {/* Game Log Section (25% on md+) */}
          <Box
            sx={{
              flex: { xs: 'unset', md: '1 1 0%' },
              height: { xs: 'auto', md: '100%' },
              overflowY: 'auto',
              minHeight: { md: 0 },
            }}
          >
            <Box
              sx={{
                height: '100%',
              }}
            >
              <GameLog log={log} />
            </Box>
          </Box>
        </Box>
      </Box>

      {/* Hidden blockchain address */}
      {/* Move description toast */}
      <Snackbar
        key={`move-toast-${moveNumber}`}
        open={showMoveToast}
        onClose={handleCloseMoveToast}
        autoHideDuration={4500}
        anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
        TransitionComponent={(props) => <Slide {...props} direction='down' />}
        message={moveDescription}
        ContentProps={{
          sx: {
            backgroundColor: '#111827',
            color: '#fff',
            borderRadius: '12px',
            px: 3,
            py: 1.5,
            boxShadow: '0 6px 18px rgba(17,24,39,0.3)',
            fontWeight: 600,
          },
        }}
        action={
          <IconButton
            size='small'
            aria-label='close'
            color='inherit'
            onClick={() => setShowMoveToast(false)}
          >
            <CloseIcon fontSize='small' />
          </IconButton>
        }
      />
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
