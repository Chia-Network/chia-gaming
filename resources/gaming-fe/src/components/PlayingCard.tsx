import React from 'react';
import { useState, useCallback } from 'react';

interface PlayingCardProps {
  id: string;
  index: number;
  cardValue: number[];
  isFaceDown?: boolean;
  selected: boolean;
  selectionColor?: string;
  setSelection: (index: number, selected: boolean) => void;
  isBeingSwapped?: boolean;
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
}) => {
  // Match the exact suit colors from calpoker-remixed
  const suitSymbols = ['♠', '♥', '♦', '♠', '♣'];
  const suitColors = ['#000000', '#ef4444', '#3b82f6', '#000000', '#16a34a'];
  
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
    height: '96px',
    backgroundColor: selected ? '#dbeafe' : '#ffffff',
    color: suitColor,
    borderRadius: '8px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '14px',
    margin: '0 4px',
    boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)',
    border: selected ? '2px solid #3b82f6' : '2px solid #d1d5db',
    cursor: 'pointer',
    fontWeight: 'bold',
    position: 'relative' as 'relative',
    userSelect: 'none' as 'none',
    transition: 'all 0.2s',
    opacity: isBeingSwapped ? 0.5 : 1,
    transform: isBeingSwapped ? 'scale(0.95)' : 'scale(1)',
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

  const formatRank = (rankArr: number[]): string => {
    if (rankArr.length === 0) return '';
    const rankValue = rankArr[0];
    if (rankValue === 10) return '10';
    if (rankValue === 11) return 'J';
    if (rankValue === 12) return 'Q';
    if (rankValue === 13) return 'K';
    if (rankValue === 14) return 'A';
    return rankValue.toString();
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
          <div style={{ fontSize: '16px', fontWeight: 'bold' }}>
            {formattedRank}
          </div>
          <div style={{ fontSize: '24px' }}>
            {suit}
          </div>
        </>
      )}
    </div>
  );
};

export default PlayingCard;

