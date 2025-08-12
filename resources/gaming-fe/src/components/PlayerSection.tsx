import React from "react";
import { useCallback, useState } from "react";
import { popcount } from '../util';
import PlayingCard from "./PlayingCard";

interface PlayerSectionProps {
  playerNumber: number;
  playerHand: number[][];
  isPlayerTurn: boolean;
  moveNumber: number;
  handleMakeMove: (move: any) => void;
  cardSelections: number,
  setCardSelections: (mask: number) => void;
  swappingCards?: { player: any[], ai: any[] };
  showSwapAnimation?: boolean;
}

const PlayerSection: React.FC<PlayerSectionProps> = ({
  playerNumber,
  playerHand,
  isPlayerTurn,
  moveNumber,
  handleMakeMove,
  cardSelections,
  setCardSelections,
  swappingCards = { player: [], ai: [] },
  showSwapAnimation = false,
}) => {
  let doHandleMakeMove = () => {
    let moveData = "80";
    handleMakeMove(moveData);
  };
  let setSelection = (index: number, selected: boolean) => {
    let selections = cardSelections;
    if (selected) {
      selections |= (1 << index);
    } else {
      selections &= ~(1 << index);
    };
    setCardSelections(selections);
    console.warn(isPlayerTurn, moveNumber, 'cardSelections', selections, selected);
  };

  const sectionStyle: React.CSSProperties = {
    width: '100%',
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    padding: '24px',
    backgroundColor: '#ffffff',
    marginBottom: '32px',
    borderRadius: '8px',
    boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)',
  };

  const titleStyle: React.CSSProperties = {
    display: 'none', // Hide title as it's not in the concept
  };

  const handLabelStyle: React.CSSProperties = {
    display: 'none', // Hide label as it's not in the concept
  };

  const cardRowStyle: React.CSSProperties = {
    display: 'flex',
    justifyContent: 'center',
    marginBottom: '16px',
    gap: '8px',
    flexWrap: 'wrap',
  };

  const actionLineStyle: React.CSSProperties = {
    textAlign: 'center',
    fontSize: '14px',
    color: '#1976d2',
    minHeight: '20px',
    marginBottom: '8px',
  };

  const buttonStyle: React.CSSProperties = {
    background: playerSelected.length === 4 ? '#2563eb' : '#9ca3af',
    color: playerSelected.length === 4 ? '#ffffff' : '#6b7280',
    border: 'none',
    borderRadius: '8px',
    padding: '12px 24px',
    fontSize: '16px',
    fontWeight: 'bold',
    cursor: playerSelected.length === 4 ? 'pointer' : 'not-allowed',
    transition: 'background 0.2s',
    boxShadow: '0 1px 2px rgba(0,0,0,0.07)',
    minWidth: '120px',
    whiteSpace: 'nowrap',
  };

  // Count selected cards
  const playerSelected = [];
  for (let i = 0; i < 8; i++) {
    if (cardSelections & (1 << i)) {
      playerSelected.push(i);
    }
  }

  return (
    <div style={sectionStyle} data-area="player">
      <h3 style={{ fontSize: '20px', fontWeight: 'bold', marginBottom: '16px' }}>Your Hand</h3>
      <div style={cardRowStyle}>
        {playerHand.map((card: number[], index) => {
          const isBeingSwapped = showSwapAnimation && swappingCards.player.some(c => c.originalIndex === index);
          return (
            <PlayingCard 
              id={`player-${index}`} 
              key={index} 
              index={index} 
              selected={!!(cardSelections & (1 << index))} 
              cardValue={card} 
              setSelection={setSelection}
              isBeingSwapped={isBeingSwapped}
            />
          );
        })}
      </div>
      {moveNumber === 1 && (
        <div style={{ marginBottom: '16px', textAlign: 'center', fontSize: '16px', fontWeight: 'bold' }}>
          Select 4 cards to KEEP ({playerSelected.length}/4 selected)
        </div>
      )}
      <button
        aria-label="make-move"
        onClick={doHandleMakeMove}
        disabled={!isPlayerTurn || (moveNumber === 1 && popcount(cardSelections) != 4)}
        style={buttonStyle}
        onMouseEnter={(e) => {
          if (isPlayerTurn && playerSelected.length === 4) {
            e.currentTarget.style.background = '#1d4ed8';
          }
        }}
        onMouseLeave={(e) => {
          if (isPlayerTurn && playerSelected.length === 4) {
            e.currentTarget.style.background = '#2563eb';
          }
        }}
      >
        {moveNumber === 1 ? 'Swap Cards' : 'Make Move'}
      </button>
    </div>
  );
};

export default PlayerSection;

