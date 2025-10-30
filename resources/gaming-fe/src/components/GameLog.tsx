import React, { useState, useCallback } from 'react';
import { Box, Typography, Paper, Divider } from '@mui/material';
import {
  OutcomeLogLine,
  OutcomeHandType,
  suitNames,
} from '../types/ChiaGaming';
import { ArrowDownward, ChevronRight } from '@mui/icons-material';
import { RANK_SYMBOLS } from '../features/californiaPoker/constants/constants';

interface GameLogProps {
  log: OutcomeLogLine[];
}

const GameLog: React.FC<GameLogProps> = ({ log }) => {
  const [logOpen, setLogOpen] = useState(false);
  
  const makeDescription = (desc: OutcomeHandType) => {
    if (desc.rank) return `${desc.name} ${desc.values.toString()}`;
    return `${desc.name} ${suitNames[desc.values[0]]}`;
  };

  const onClickHandler = useCallback(() => {
    setLogOpen(!logOpen);
  }, [logOpen]);

  const cardDisplay = (
    c: number[],
    index: number,
    idPrefix: string,
    selected: boolean,
  ) => {
    const suitName = suitNames[c[1]];
    const isRedSuit = suitName === '♥' || suitName === '♦';
    const suitColor = isRedSuit ? 'red' : 'black';
    const rankDisplay = RANK_SYMBOLS[c[0]] ?? c[0];
    return (
      <Paper
        key={`${idPrefix}-${index}`}
        id={`${idPrefix}-${index}`}
        elevation={1}
        sx={{
          color: suitColor,
          px: 0.5,
          py: 0.25,
          ml: 0.5,
          borderRadius: 1,
          backgroundColor: selected ? '#f2f2f2' : '#fff',
          fontWeight: selected ? 600 : 400,
          fontSize: '0.9rem',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minWidth: '28px',
          textAlign: 'center',
        }}
      >
        {rankDisplay}
        {suitName}
      </Paper>
    );
  };

  const playerDisplay = (
    me: boolean,
    label: string,
    desc: OutcomeHandType,
    hand: number[][],
  ) => {
    const cards = hand.map((c, i) =>
      cardDisplay(c, i, `outcome-${me ? 'me' : 'opponent'}`, false),
    );
    return (
      <Box display='flex' flexDirection='row' alignItems='center' py={0.5}>
        <Typography variant='body2' fontWeight={600} mr={1}>
          {makeDescription(desc)}:
        </Typography>
        <Box
          aria-label={label}
          display='flex'
          flexDirection='row'
          flexWrap='wrap'
        >
          {cards}
        </Box>
      </Box>
    );
  };

  return (
    <Paper
      elevation={3}
      sx={{
        p: 2,
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        borderRadius: 2,
        bgcolor: '#fafafa',
      }}
    >
      {/* Header (fixed, not scrolled) */}
      <Typography
        variant='h6'
        onClick={onClickHandler}
        sx={{
          mb: 1,
          cursor: 'pointer',
          textAlign: 'center',
          fontWeight: 700,
          userSelect: 'none',
          color: '#333',
          '&:hover': { color: '#1976d2' },
        }}
        aria-label='game-log-heading'
      >
        Game & Transactions Log {logOpen ? <ArrowDownward /> : <ChevronRight />}
      </Typography>
      <Divider sx={{ mb: 1 }} />

      {/* Scrollable Log Content */}
      <Box
        flex={1}
        overflow='auto'
        sx={{
          pr: 1,
          maxHeight: { xs: 300, md: 'auto' },
        }}
      >
        {log.length === 0 ? (
          <Typography variant='body2' color='text.secondary' textAlign='center'>
            No game history yet.
          </Typography>
        ) : (
          log.map((entry, index) => {
            const iWin = entry.topLineOutcome === 'win' ? '🏆 WINNER' : '';
            const opWin = entry.topLineOutcome === 'lose' ? '🏆 WINNER' : '';

            return (
              <Paper
                key={`log-entry-${index}`}
                elevation={1}
                sx={{
                  p: 2,
                  mb: 2,
                  borderRadius: 2,
                  bgcolor: '#fff',
                }}
              >
                {/* Responsive player-opponent container */}
                <Box
                  display='flex'
                  flexDirection={{ xs: 'column', sm: 'column' }}
                  justifyContent='space-between'
                  gap={2}
                >
                  {/* Player section */}
                  <Box flex={1}>
                    <Box
                      display='flex'
                      alignItems='center'
                      justifyContent='space-between'
                      mb={0.5}
                    >
                      {playerDisplay(
                        true,
                        `my-used-hand-${index}`,
                        entry.myHandDescription,
                        entry.myHand,
                      )}
                      <Typography variant='caption' color='success.main' ml={1}>
                        {iWin}
                      </Typography>
                    </Box>

                    {logOpen && (
                      <Box mt={1}>
                        <Typography variant='body2' fontWeight={600}>
                          My Cards:
                        </Typography>
                        <Box
                          display='flex'
                          flexWrap='wrap'
                        >
                          {entry.myStartHand.map((c, i) =>
                            cardDisplay(
                              c,
                              i,
                              'my-cards',
                              (entry.myPicks & (1 << i)) !== 0,
                            ),
                          )}
                        </Box>
                      </Box>
                    )}
                  </Box>

                  <Divider
                    orientation='horizontal'
                    flexItem
                    sx={{
                      display: { xs: 'none', md: 'block' },
                      mx: 1,
                    }}
                  />

                  {/* Opponent section */}
                  <Box flex={1}>
                    <Box
                      display='flex'
                      alignItems='center'
                      justifyContent='space-between'
                      mb={0.5}
                    >
                      {playerDisplay(
                        false,
                        `opponent-used-hand-${index}`,
                        entry.opponentHandDescription,
                        entry.opponentHand,
                      )}
                      <Typography variant='caption' color='error.main' ml={1}>
                        {opWin}
                      </Typography>
                    </Box>

                    {logOpen && (
                      <Box mt={1}>
                        <Typography variant='body2' fontWeight={600}>
                          Their Cards:
                        </Typography>
                        <Box
                          display='flex'
                          flexWrap='wrap'
                        >
                          {entry.opponentStartHand.map((c, i) =>
                            cardDisplay(
                              c,
                              i,
                              'opponent-cards',
                              (entry.opponentPicks & (1 << i)) !== 0,
                            ),
                          )}
                        </Box>
                      </Box>
                    )}
                  </Box>
                </Box>
              </Paper>
            );
          })
        )}
      </Box>
    </Paper>
  );
};

export default GameLog;
