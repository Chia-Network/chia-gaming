import React from 'react';
import { useState, useCallback } from 'react';
import { suitSymbols, formatRank } from '../types/ChiaGaming';

interface PlayingCardProps {
  id: string;
  index: number;
  cardValue: number[];
  isFaceDown?: boolean;
  selected: boolean;
  selectionColor?: string;
  setSelection: (index: number, selected: boolean) => void;
  isBeingSwapped?: boolean;
  isInBestHand?: boolean;
}

const PlayingCard: React.FC<PlayingCardProps> = ({
  id,
  index,
  cardValue,
  selected,
  setSelection,
  selectionColor,
  isFaceDown = false,
  isBeingSwapped = false,
  isInBestHand = false,
}) => {
  // OKLCH colors from new_calpoker.tsx
  const suitColors = [
    'oklch(0% 0 0)',      // Spades - Black
    'oklch(50% 0.3 25)',  // Hearts - Red
    'oklch(50% 0.3 265)', // Diamonds - Blue
    'oklch(0% 0 0)',      // Unknown - Black
    'oklch(50% 0.3 155)'  // Clubs - Green
  ];
  
  const rank = cardValue.slice(0, -1);
  const suitIndex = cardValue.slice(-1)[0] as number;
  const suit = suitSymbols[suitIndex] || suitSymbols[0];
  const suitColor = suitColors[suitIndex] || suitColors[0];
  
  const setSelectedCB = () => {
    const newSelected = !selected;
    setSelection(index, newSelected);
  };

  const cardStyle: React.CSSProperties = {
    width: '64px',
    minWidth: '48px',
    height: '96px',
    backgroundColor: isBeingSwapped ? '#f9fafb' : isInBestHand ? '#fef3c7' : (selected ? '#dbeafe' : '#ffffff'),
    color: suitColor,
    borderRadius: '8px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '14px',
    margin: '0',
    boxShadow: isInBestHand ? '0 10px 15px -3px rgba(251, 191, 36, 0.3), 0 4px 6px -2px rgba(251, 191, 36, 0.2)' : selected ? '0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)' : '',
    border: isBeingSwapped ? '2px solid #d1d5db' : isInBestHand ? '2px solid #f59e0b' : (selected ? '2px solid #3b82f6' : '2px solid #d1d5db'),
    cursor: 'pointer',
    fontWeight: 'bold',
    position: 'relative' as 'relative',
    userSelect: 'none' as 'none',
    transition: 'all 0.2s',
    opacity: isBeingSwapped ? 0.5 : 1,
  };

  const cardBackStyle: React.CSSProperties = {
    ...cardStyle,
    background: `
      repeating-linear-gradient(135deg, rgba(59, 130, 246, 0.3) 0 8px, transparent 8px 16px),
      repeating-linear-gradient(45deg, rgba(59, 130, 246, 0.3) 0 8px, transparent 8px 16px),
      #93c5fd
    `,
    color: '#93c5fd',
    border: '2px solid #60a5fa',
  };

  const formattedRank = formatRank(rank);

  return (
    <div 
      id={id}
      data-card-id={id}
      style={isFaceDown ? cardBackStyle : cardStyle} 
      onClick={setSelectedCB}
    >
      {!isFaceDown && (
        <>
          <div style={{ fontSize: '24px', fontWeight: 'bold' }}>
            {formattedRank}
          </div>
          <div style={{ fontSize: '24px', marginTop: '-8px' }}>
            {suit}
          </div>
        </>
      )}
    </div>
  );
};

export default PlayingCard;

