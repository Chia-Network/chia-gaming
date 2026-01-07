import React, { useState, useCallback } from 'react';
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
      <div
        key={`${idPrefix}-${index}`}
        id={`${idPrefix}-${index}`}
        className={`
    inline-flex items-center justify-center ml-1 px-3 py-1
    rounded-sm border text-center whitespace-nowrap min-w-[30px]
    ${selected ? 'font-semibold bg-canvas-border' : 'font-medium bg-canvas-light'}
    border-canvas-border
  `}
        style={{ color: suitColor }}
      >
        {rankDisplay}
        {suitName}
      </div>
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
      <div className='flex flex-row items-center py-1'>
        <span
          aria-label={`${label}-description`}
          data-hand-description={JSON.stringify(desc)}
          className='mr-1 font-semibold text-[0.95rem] text-canvas-solid mb-2'
        >
          {makeDescription(desc)}
        </span>
        <div data-testid={label} className='flex flex-wrap gap-1'>
          {cards}
        </div>
      </div>
    );
  };

  return (
    <div className='flex flex-col h-full w-full'>
      {/* Card Container */}
      <div className='flex flex-col h-full border border-canvas-border rounded-lg shadow-sm bg-canvas-bg overflow-hidden'>
        {/* Header - Non-scrolling */}
        <div className='px-4 pt-2 pb-1 border-b border-canvas-border'>
          <h2 className='text-base font-bold text-canvas-solid flex items-center gap-1'>
            Log ({log.length})
          </h2>
        </div>

        {/* Scrollable Log Content */}
        <div className='flex-1 overflow-y-auto overflow-x-hidden px-4 py-2'>
          {log.length === 0 ? (
            <div className='py-3 text-center'>
              <p className='text-sm text-canvas-muted'>No game history yet.</p>
            </div>
          ) : (
            <div className='flex flex-col gap-2'>
              {log.map((entry, index) => {
                const isExpanded = expandedIndex === index;
                const iWin = entry.topLineOutcome === 'win';
                const opWin = entry.topLineOutcome === 'lose';

                return (
                  <div
                    key={`log-entry-${index}`}
                    className={`p-2 rounded-lg border border-canvas-border cursor-pointer transition-all duration-200 ${
                      isExpanded ? 'bg-canvas-light' : 'bg-canvas-bg'
                    } hover:bg-canvas-light hover:border-canvas-border-hover`}
                    onClick={() => setExpandedIndex(isExpanded ? null : index)}
                  >
                    {/* Compact Summary */}
                    <div
                      className={`flex items-center justify-between mb-${
                        isExpanded ? '2' : '0'
                      }`}
                    >
                      <div className='flex-1 min-w-0'>
                        <p
                          data-testid={`log-entry-me-${index}`}
                          className={`text-sm font-semibold mb-1 ${
                            iWin
                              ? 'text-success-text'
                              : opWin
                                ? 'text-alert-text'
                                : 'text-canvas-muted'
                          }`}
                        >
                          {iWin
                            ? '🏆 You Won'
                            : opWin
                              ? '🏆 Opponent Won'
                              : '🤝 Tie'}
                        </p>
                        <div className='flex flex-wrap gap-2'>
                          <div>
                            <p className='text-xs font-medium text-canvas-muted'>
                              You
                            </p>
                            <p className='text-sm font-semibold text-canvas-solid'>
                              {makeDescription(entry.myHandDescription)}
                            </p>
                          </div>
                          <div>
                            <p className='text-xs font-medium text-canvas-muted'>
                              Opponent
                            </p>
                            <p className='text-sm font-semibold text-canvas-solid'>
                              {makeDescription(entry.opponentHandDescription)}
                            </p>
                          </div>
                        </div>
                      </div>

                      <ExpandMore
                        data-testid={`log-expand-button-${index}`}
                        className={`ml-1 flex-shrink-0 transform transition-transform duration-200 ${
                          isExpanded ? 'rotate-180' : 'rotate-0'
                        } text-canvas-muted`}
                      />
                    </div>

                    {/* Expanded Details */}
                    {isExpanded && (
                      <div className='pt-2 border-t border-canvas-border flex flex-col gap-2'>
                        {/* You Section */}
                        <div data-testid={`log-entry-me-${index}`}>
                          <p className='text-xs font-bold text-canvas-solid mb-1 uppercase tracking-wide'>
                            Your Hand
                          </p>
                          <div className='mb-1'>
                            {playerDisplay(
                              true,
                              `my-used-hand-${index}`,
                              entry.myHandDescription,
                              entry.myHand,
                            )}
                          </div>

                          <p className='text-xs font-bold text-canvas-solid mb-1 uppercase tracking-wide'>
                            Cards
                          </p>
                          <div
                            data-testid={`my-start-hand-${index}`}
                            className='flex flex-wrap gap-1'
                          >
                            {entry.myStartHand.map((c, i) =>
                              cardDisplay(
                                c,
                                i,
                                'my-cards',
                                (entry.myPicks & (1 << i)) !== 0,
                              ),
                            )}
                          </div>

                          <p className='text-xs font-bold text-canvas-solid mb-1 uppercase tracking-wide'>
                            Swapped Cards
                          </p>
                          <div
                            data-testid={`my-final-hand-${index}`}
                            className='flex flex-wrap gap-1'
                          >
                            {entry.myFinalHand.map((c, i) =>
                              cardDisplay(
                                c,
                                i,
                                'my-final-cards',
                                (entry.mySelects & (1 << i)) !== 0,
                              ),
                            )}
                          </div>
                        </div>

                        {/* Opponent Section */}
                        <div>
                          <p className='text-xs font-bold text-canvas-solid mb-1 uppercase tracking-wide'>
                            Opponent Hand
                          </p>
                          <div className='mb-1'>
                            {playerDisplay(
                              false,
                              `opponent-used-hand-${index}`,
                              entry.opponentHandDescription,
                              entry.opponentHand,
                            )}
                          </div>

                          <p className='text-xs font-bold text-canvas-solid mb-1 uppercase tracking-wide'>
                            Start Cards
                          </p>
                          <div
                            data-testid={`opponent-start-hand-${index}`}
                            className='flex flex-wrap gap-1'
                          >
                            {entry.opponentStartHand.map((c, i) =>
                              cardDisplay(
                                c,
                                i,
                                'opponent-cards',
                                (entry.opponentPicks & (1 << i)) !== 0,
                              ),
                            )}
                          </div>

                          <p className='text-xs font-bold text-canvas-solid mb-1 uppercase tracking-wide'>
                            Swapped Cards
                          </p>
                          <div
                            data-testid={`opponent-final-hand-${index}`}
                            className='flex flex-wrap gap-1'
                          >
                            {entry.opponentFinalHand.map((c, i) =>
                              cardDisplay(
                                c,
                                i,
                                'opponent-final-cards',
                                (entry.opponentSelects & (1 << i)) !== 0,
                              ),
                            )}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default GameLog;