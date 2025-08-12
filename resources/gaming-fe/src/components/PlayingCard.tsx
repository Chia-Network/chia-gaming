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
}

const PlayingCard: React.FC<PlayingCardProps> = ({
  id,
  index,
  cardValue,
  selected,
  setSelection,
  selectionColor,
  isFaceDown = false,
}) => {
  const suitNames = ['Q', '♥', '♦', '♤', '♧'];
  const rank = cardValue.slice(0, -1);
  const suit = suitNames[(cardValue.slice(-1)[0] as any)];
  const setSelectedCB = () => {
    const newSelected = !selected;
    setSelection(index, newSelected);
  };

  const isRedSuit = suit === '♥' || suit === '♦';
  const suitColor = isRedSuit ? '#d32f2f' : '#23272b';

  const cardStyle: React.CSSProperties = {
    width: '40px',
    height: '56px',
    backgroundColor: '#e3eafc',
    color: suitColor,
    borderRadius: '6px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '14px',
    margin: '0 4px',
    boxShadow: selected ? '0 0 0 2px #ff9800' : '0 1px 4px rgba(0,0,0,0.13)',
    border: '1px solid #b3c6e6',
    cursor: 'pointer',
    transition: 'all 0.2s ease',
    transform: selected ? 'translateY(-4px)' : 'translateY(0)',
    fontWeight: 'bold',
    position: 'relative' as 'relative',
  };

  const cardBackStyle: React.CSSProperties = {
    ...cardStyle,
    background: `
      repeating-linear-gradient(135deg, rgba(144,164,194,0.28) 0 8px, transparent 8px 16px),
      repeating-linear-gradient(45deg, rgba(144,164,194,0.28) 0 8px, transparent 8px 16px),
      #b3c6e6
    `,
    color: '#b3c6e6',
    border: '1px solid #90a4c2',
  };

  const cardContentStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    height: '100%',
  };

  const formatRank = (rankArr: number[]): string => {
    if (rankArr.length === 0) return '';
    const rankValue = rankArr[0];
    if (rankValue === 10) return 'T';
    if (rankValue === 11) return 'J';
    if (rankValue === 12) return 'Q';
    if (rankValue === 13) return 'K';
    if (rankValue === 14) return 'A';
    return rankValue.toString();
  };

  return (
    <div 
      id={id} 
      style={isFaceDown ? cardBackStyle : cardStyle} 
      onClick={setSelectedCB}
      onMouseEnter={(e) => {
        if (!selected && !isFaceDown) {
          e.currentTarget.style.transform = 'translateY(-2px)';
          e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,0.2)';
        }
      }}
      onMouseLeave={(e) => {
        if (!selected && !isFaceDown) {
          e.currentTarget.style.transform = 'translateY(0)';
          e.currentTarget.style.boxShadow = '0 1px 4px rgba(0,0,0,0.13)';
        }
      }}
    >
      {!isFaceDown && (
        <div style={cardContentStyle}>
          <span>{formatRank(rank)}{suit}</span>
        </div>
      )}
    </div>
  );
};

export default PlayingCard;

