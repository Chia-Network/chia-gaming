import React, { useState} from 'react';
import {
  OutcomeLogLine,
  OutcomeHandType,
  suitNames,
} from '../types/ChiaGaming';

import { RANK_SYMBOLS, SUIT_COLORS } from '../features/californiaPoker/constants/constants';
import { cn } from '../lib/utils';
import { Expand, History } from 'lucide-react';

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

    type SuitKey = 'Q' | '♠' | '♥' | '♦' | '♣';

    const suitName: SuitKey = suitNames[c[1]] as SuitKey;
    const colorClass = SUIT_COLORS[suitName];
    const rankDisplay = RANK_SYMBOLS[c[0]] ?? c[0];

    return (
      <div
        key={`${idPrefix}-${index}`}
        id={`${idPrefix}-${index}`}
        className={cn(
          'flex flex-col items-center justify-center min-w-9 px-4 py-2 rounded-md border border-canvas-border text-center whitespace-nowrap',
          selected ? 'bg-canvas-border font-semibold' : 'bg-canvas-light font-medium'
        )}
        style={{ color: colorClass }}
      >
        <div className='text-sm'>{rankDisplay}</div>
        <div className='text-lg'>{suitName}</div>
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
      <div className='flex flex-col py-1'>
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
    <div className='flex flex-col h-full w-full rounded-lg'>
      {/* Card Container */}
      <div className='flex flex-col h-full border border-canvas-border rounded-lg shadow-sm bg-canvas-bg overflow-hidden'>
        {/* Header - Non-scrolling */}

        <div className="border-b border-canvas-border px-4 py-2">
          <h2 className="text-sm font-semibold tracking-tight flex items-center gap-1.5 text-canvas-solid">
            <History className="h-4 w-4 text-canvas-muted" />
            Log
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-canvas-bg-subtle text-canvas-muted border border-canvas-border">
              {log.length}
            </span>
          </h2>
        </div>



        {/* Scrollable Log Content */}
        <div className='flex-1 overflow-y-auto overflow-x-hidden px-4 py-2'>
          {log.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full py-6 text-center text-canvas-muted">
              <History className="w-10 h-10 mb-2 opacity-60" />
              <p className="text-sm font-medium">No game history yet</p>
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
                    className={`p-2 rounded-lg border border-canvas-border cursor-pointer transition-all duration-200 ${isExpanded ? 'bg-canvas-light' : 'bg-canvas-bg'
                      } hover:bg-canvas-light hover:border-canvas-border-hover`}
                    onClick={() => setExpandedIndex(isExpanded ? null : index)}
                  >
                    {/* Compact Summary */}
                    <div
                      className={`flex items-center justify-between mb-${isExpanded ? '2' : '0'
                        }`}
                    >
                      <div className='flex-1 min-w-0'>
                        <p className={cn('text-sm font-semibold mb-1', iWin ? 'text-green-600' : opWin ? 'text-red-600' : 'text-canvas-muted')}>
                          {iWin ? '🏆 You Won' : opWin ? '🏆 Opponent Won' : '🤝 Tie'}
                        </p>
                        <div className='grid grid-cols-2 gap-2'>
                          <div>
                            <p className='text-xs font-medium text-canvas-muted'>You</p>
                            <p className='text-sm font-semibold text-canvas-solid'>
                              {makeDescription(entry.myHandDescription)}
                            </p>
                          </div>
                          <div>
                            <p className='text-xs font-medium text-canvas-muted'>Opponent</p>
                            <p className='text-sm font-semibold text-canvas-solid'>
                              {makeDescription(entry.opponentHandDescription)}
                            </p>
                          </div>
                        </div>
                      </div>

                      <Expand
                        data-testid={`log-expand-button-${index}`}
                        className={`ml-1 shrink-0 transform transition-transform duration-200 ${isExpanded ? 'rotate-180' : 'rotate-0'
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
                            data-testid={`my-start-hand-${index} mt-1`}
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

                          <p className='text-xs mt-2 font-bold text-canvas-solid mb-1 uppercase tracking-wide'>
                            Swapped Cards
                          </p>
                          <div
                            data-testid={`my-final-hand-${index} mt-1`}
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
                            data-testid={`opponent-start-hand-${index} mt-1`}
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

                          <p className='text-xs font-bold mt-2 text-canvas-solid mb-1 uppercase tracking-wide'>
                            Swapped Cards
                          </p>
                          <div
                            data-testid={`opponent-final-hand-${index} mt-1`}
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
