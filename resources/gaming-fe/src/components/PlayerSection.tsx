import React from "react";
import { useCallback, useState } from "react";
import { popcount } from '../util';
import PlayingCard from "./PlayingCard";

interface SwappingCard {
  rank: string;
  suit: string;
  value: number;
  originalIndex: number;
  id: string;
}

interface PlayerSectionProps {
  playerNumber: number;
  playerHand: number[][];
  isPlayerTurn: boolean;
  moveNumber: number;
  handleMakeMove: (move: any) => void;
  cardSelections: number,
  setCardSelections: (mask: number) => void;
  swappingCards?: { player: SwappingCard[], ai: SwappingCard[] };
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
    padding: '8px',
    borderRadius: '8px',
    maxWidth: '100%',
    margin: '0 auto',
  };

  const titleStyle: React.CSSProperties = {
    fontSize: '14px',
    fontWeight: 'bold',
    marginTop: '4px',
    textAlign: 'center',
    color: '#4b5563',
  };

  const handLabelStyle: React.CSSProperties = {
    display: 'none', // Hide label as it's not in the concept
  };

  const cardRowStyle: React.CSSProperties = {
    display: 'flex',
    justifyContent: 'center',
    marginBottom: '8px',
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

  // Count selected cards
  const playerSelected: number[] = [];
  for (let i = 0; i < 8; i++) {
    if (cardSelections & (1 << i)) {
      playerSelected.push(i);
    }
  }

  // Button should be enabled if:
  // - It's the player's turn AND
  // - Either it's not move 1 (card selection), OR it's move 1 and 4 cards are selected
  const isButtonEnabled = isPlayerTurn && (moveNumber !== 1 || playerSelected.length === 4);

  const buttonStyle: React.CSSProperties = {
    background: isButtonEnabled ? '#2563eb' : '#d1d5db',
    color: isButtonEnabled ? '#ffffff' : '#6b7280',
    border: 'none',
    borderRadius: '8px',
    padding: '8px 24px',
    fontSize: '16px',
    fontWeight: 'bold',
    cursor: isButtonEnabled ? 'pointer' : 'default',
    transition: 'background 0.2s',
    minWidth: '256px',
    whiteSpace: 'nowrap',
  };

  return (
    <div style={sectionStyle} data-area="player">
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
      <h3 style={titleStyle}>Your Hand</h3>
      {moveNumber === 1 && (
        <div style={{ marginBottom: '8px', textAlign: 'center', fontSize: '14px', fontWeight: 'bold' }}>
          Select 4 cards to KEEP ({playerSelected.length}/4 selected)
        </div>
      )}
      <button
        aria-label="make-move"
        onClick={doHandleMakeMove}
        disabled={!isButtonEnabled}
        style={buttonStyle}
        onMouseEnter={(e) => {
          if (isButtonEnabled) {
            e.currentTarget.style.background = '#1e40af';
          }
        }}
        onMouseLeave={(e) => {
          if (isButtonEnabled) {
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

