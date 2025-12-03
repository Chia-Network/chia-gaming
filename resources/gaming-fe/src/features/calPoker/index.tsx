import React, { useEffect, useState } from 'react';
import {
  Box,
  Typography,
  useMediaQuery,
  useTheme,
  Snackbar,
  Slide,
  IconButton,
} from '@mui/material';
import { Button } from '../../components/button';
import CloseIcon from '@mui/icons-material/Close';

import { CalpokerOutcome, OutcomeLogLine } from '../../types/ChiaGaming';
import GameLog from '../../components/GameLog';
import CaliforniaPoker from '../californiaPoker';
import { Info, LogOut } from 'lucide-react';

export interface CalpokerProps {
  setSuspended: (suspended: boolean) => void;
  suspended: boolean;
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
  setSuspended,
  suspended,
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

  const balanceDisplay =
    ourShare !== undefined && theirShare !== undefined
      ? ` - Our Share ${ourShare} vs ${theirShare}`
      : '';

  return (
    <Box
      p={{ xs: 2, sm: 3, md: 4 }}
      sx={{
        bgcolor: 'var(--canvas-bg-subtle)',
        color: 'var(--canvas-text)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        minHeight: '100%',
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
            color: 'var(--canvas-text-contrast)',
            textAlign: { xs: 'center', sm: 'left' },
          }}
        >
          California Poker
        </Typography>

        <Box
          display='flex'
          alignItems='center'
          justifyContent={{ xs: 'center', sm: 'flex-end' }}
          gap={2}
          mt={{ xs: 1, sm: 0 }}
        >
          {/* HINT button */}
          <Button
            onClick={handleHelpClick}
            color={'neutral'}
            variant={'ghost'}
            size={'sm'}
            leadingIcon={<Info />}
          >
            Hint
          </Button>

          {/* Leave */}
          <Button
	    data-testid='stop-playing'
            variant={'destructive'}
            onClick={stopPlaying}
            size={'sm'}
            disabled={moveNumber !== 0}
            leadingIcon={<LogOut />}
            fullWidth
          >
            Leave Game
          </Button>
        </Box>
      </Box>

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
          {/* MAIN GAME AREA */}
          <Box
            sx={{
              flex: { xs: 'unset', md: '3 1 0%' },
              height: { xs: 'auto', md: '100%' },
              overflow: 'auto',
              minHeight: { md: 0 },
            }}
          >
            <CaliforniaPoker
              setSuspended={setSuspended}
              suspended={suspended}
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

          {/* GAME LOG */}
          <Box
            sx={{
              flex: { xs: 'unset', md: '1 1 0%' },
              height: { xs: 'auto', md: '100%' },
              overflowY: 'auto',
              minHeight: { md: 0 },
              bgcolor: 'var(--canvas-bg)',
            }}
          >
            <Box sx={{ height: '100%' }}>
              <GameLog log={log} />
            </Box>
          </Box>
        </Box>
      </Box>

      {/* Move Description Toast */}
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
            backgroundColor: 'var(--canvas-bg-subtle)',
            color: 'var(--canvas-text-contrast)',
            borderRadius: '12px',
            px: 3,
            py: 1.5,
            border: '1px solid var(--canvas-line)',
            fontWeight: 600,
          },
        }}
        action={
          <IconButton
            size='small'
            aria-label='close'
            color='inherit'
            onClick={() => setShowMoveToast(false)}
            sx={{ color: 'var(--canvas-text)' }}
          >
            <CloseIcon fontSize='small' />
          </IconButton>
        }
      />

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
