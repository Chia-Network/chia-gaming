import React, { useState } from 'react';
import { Box, Typography, Card, CardContent } from '@mui/material';
import {
  OutcomeLogLine,
  OutcomeHandType,
  suitNames,
} from '../types/ChiaGaming';
import { ExpandMore } from '@mui/icons-material';
import { RANK_SYMBOLS } from '../features/californiaPoker/constants/constants';

interface GameLogProps {
  log: OutcomeLogLine[];
}

const getRankSymbol = (n: number) => RANK_SYMBOLS[n] ?? n.toString();

const GameLog: React.FC<GameLogProps> = ({ log }) => {
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);

  const makeDescription = (desc: OutcomeHandType) => {
    const mappedValues = desc.values.map((v: number) => getRankSymbol(v));
    if (desc.rank) {
      return `${desc.name} ${mappedValues.join(', ')}`;
    }
    return `${desc.name} ${mappedValues[0]}`;
  };

  const cardDisplay = (
    c: number[],
    index: number,
    idPrefix: string,
    selected: boolean,
  ) => {
    const suitName = suitNames[c[1]];
    const isRedSuit = suitName === '♥' || suitName === '♦';
    const suitColor = isRedSuit ? '#dc2626' : '#000';
    const rankDisplay = RANK_SYMBOLS[c[0]] ?? c[0];

    return (
      <Box
        key={`${idPrefix}-${index}`}
        id={`${idPrefix}-${index}`}
        sx={{
          color: suitColor,
          px: 0.75,
          py: 0.5,
          ml: 0.5,
          borderRadius: '4px',
          backgroundColor: selected ? '#e5e7eb' : '#f3f4f6',
          fontWeight: selected ? 600 : 500,
          fontSize: '0.8rem',
          border: '1px solid #d1d5db',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          minWidth: '30px',
          textAlign: 'center',
          whiteSpace: 'nowrap',
        }}
      >
        {rankDisplay}
        {suitName}
      </Box>
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
      <Box>
        <Typography sx={{ fontWeight: 600, fontSize: '0.95rem', mb: 0.75, color: '#374151' }}>
          {makeDescription(desc)}
        </Typography>
        <Box display='flex' flexWrap='wrap' gap={0.5}>
          {cards}
        </Box>
      </Box>
    );
  };

  return (
    <Card
      sx={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        borderRadius: '12px',
        border: '1px solid #e5e7eb',
        boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
        backgroundColor: '#ffffff',
      }}
    >
      {/* Header - Non-scrolling */}
      <CardContent
        sx={{
          pb: 1,
          pt: 2,
          px: 2,
          borderBottom: '1px solid #f3f4f6',
        }}
      >
        <Typography
          variant='subtitle1'
          sx={{
            fontWeight: 700,
            fontSize: '1rem',
            color: '#1f2937',
            display: 'flex',
            alignItems: 'center',
            gap: 1,
          }}
        >
          Log {`(${log.length})`}
        </Typography>
      </CardContent>

      {/* Scrollable Log Content */}
      <Box
        sx={{
          flex: 1,
          overflowY: 'auto',
          overflowX: 'hidden',
          px: 2,
          py: 1,
          '&::-webkit-scrollbar': {
            width: '6px',
          },
          '&::-webkit-scrollbar-track': {
            background: '#f1f5f9',
            borderRadius: '3px',
          },
          '&::-webkit-scrollbar-thumb': {
            background: '#cbd5e1',
            borderRadius: '3px',
            '&:hover': {
              background: '#94a3b8',
            },
          },
        }}
      >
        {log.length === 0 ? (
          <Box sx={{ py: 3, textAlign: 'center' }}>
            <Typography variant='body2' color='#9ca3af'>
              No game history yet.
            </Typography>
          </Box>
        ) : (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            {log.map((entry, index) => {
              const isExpanded = expandedIndex === index;
              const iWin = entry.topLineOutcome === 'win';
              const opWin = entry.topLineOutcome === 'lose';

              return (
                <Card
                  key={`log-entry-${index}`}
                  sx={{
                    p: 1.5,
                    borderRadius: '8px',
                    backgroundColor: '#f9fafb',
                    border: '1px solid #e5e7eb',
                    cursor: 'pointer',
                    transition: 'all 0.2s ease',
                    '&:hover': {
                      backgroundColor: '#f3f4f6',
                      borderColor: '#d1d5db',
                    },
                  }}
                  onClick={() => setExpandedIndex(isExpanded ? null : index)}
                >
                  {/* Compact Summary View */}
                  <Box
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      mb: isExpanded ? 1.5 : 0,
                    }}
                  >
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Typography
                        sx={{
                          fontSize: '0.85rem',
                          fontWeight: 600,
                          color: iWin ? '#10b981' : opWin ? '#ef4444' : '#6b7280',
                          mb: 0.5,
                        }}
                      >
                        {iWin ? '🏆 You Won' : opWin ? '🏆 Opponent Won' : '🤝 Tie'}
                      </Typography>
                      <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
                        <Box>
                          <Typography sx={{ fontSize: '0.75rem', color: '#6b7280', fontWeight: 500 }}>
                            You
                          </Typography>
                          <Typography sx={{ fontSize: '0.8rem', fontWeight: 600, color: '#374151' }}>
                            {makeDescription(entry.myHandDescription)}
                          </Typography>
                        </Box>
                        <Box>
                          <Typography sx={{ fontSize: '0.75rem', color: '#6b7280', fontWeight: 500 }}>
                            Opponent
                          </Typography>
                          <Typography sx={{ fontSize: '0.8rem', fontWeight: 600, color: '#374151' }}>
                            {makeDescription(entry.opponentHandDescription)}
                          </Typography>
                        </Box>
                      </Box>
                    </Box>
                    <ExpandMore
                      sx={{
                        ml: 1,
                        transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                        transition: 'transform 0.2s ease',
                        color: '#9ca3af',
                        flexShrink: 0,
                      }}
                    />
                  </Box>

                  {/* Expanded Detailed View */}
                  {isExpanded && (
                    <Box
                      sx={{
                        pt: 1.5,
                        borderTop: '1px solid #e5e7eb',
                        display: 'flex',
                        flexDirection: { xs: 'column', sm: 'column' },
                        gap: 1.5,
                      }}
                    >
                      {/* You Section */}
                      <Box>
                        <Typography
                          sx={{
                            fontSize: '0.75rem',
                            fontWeight: 700,
                            color: '#1f2937',
                            mb: 0.75,
                            textTransform: 'uppercase',
                            letterSpacing: '0.5px',
                          }}
                        >
                          Your Hand
                        </Typography>
                        <Box sx={{ mb: 1 }}>
                          {playerDisplay(
                            true,
                            `my-used-hand-${index}`,
                            entry.myHandDescription,
                            entry.myHand,
                          )}
                        </Box>
                        <Typography
                          sx={{
                            fontSize: '0.75rem',
                            fontWeight: 700,
                            color: '#1f2937',
                            mb: 0.75,
                            textTransform: 'uppercase',
                            letterSpacing: '0.5px',
                          }}
                        >
                          Cards
                        </Typography>
                        <Box display='flex' flexWrap='wrap' gap={0.5}>
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

                      {/* Opponent Section */}
                      <Box>
                        <Typography
                          sx={{
                            fontSize: '0.75rem',
                            fontWeight: 700,
                            color: '#1f2937',
                            mb: 0.75,
                            textTransform: 'uppercase',
                            letterSpacing: '0.5px',
                          }}
                        >
                          Opponent Hand
                        </Typography>
                        <Box sx={{ mb: 1 }}>
                          {playerDisplay(
                            false,
                            `opponent-used-hand-${index}`,
                            entry.opponentHandDescription,
                            entry.opponentHand,
                          )}
                        </Box>
                        <Typography
                          sx={{
                            fontSize: '0.75rem',
                            fontWeight: 700,
                            color: '#1f2937',
                            mb: 0.75,
                            textTransform: 'uppercase',
                            letterSpacing: '0.5px',
                          }}
                        >
                          Cards
                        </Typography>
                        <Box display='flex' flexWrap='wrap' gap={0.5}>
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
                    </Box>
                  )}
                </Card>
              );
            })}
          </Box>
        )}
      </Box>
    </Card>
  );
};

export default GameLog;
