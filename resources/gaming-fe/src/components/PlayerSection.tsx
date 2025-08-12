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
  outcome?: any;
  gameState?: string;
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
  outcome,
  gameState = 'playing',
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
    padding: '16px',
    backgroundColor: '#ffffff',
    marginBottom: '8px',
    borderRadius: '8px',
    boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)',
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
    marginBottom: '12px',
    gap: '4px',
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
    background: isButtonEnabled ? '#2563eb' : '#9ca3af',
    color: isButtonEnabled ? '#ffffff' : '#6b7280',
    border: 'none',
    borderRadius: '8px',
    padding: '12px 24px',
    fontSize: '16px',
    fontWeight: 'bold',
    cursor: isButtonEnabled ? 'pointer' : 'not-allowed',
    transition: 'background 0.2s',
    boxShadow: '0 1px 2px rgba(0,0,0,0.07)',
    minWidth: '120px',
    whiteSpace: 'nowrap',
  };

  // Get outcome info for this player
  const myWinOutcome = outcome?.my_win_outcome;
  const iAmAlice = playerNumber === 2;
  const myHandValue = outcome && (iAmAlice ? outcome?.alice_hand_value : outcome?.bob_hand_value);

  return (
    <div style={sectionStyle} data-area="player">
      <h3 style={{ fontSize: '20px', fontWeight: 'bold', marginBottom: '8px' }}>Your Hand</h3>
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
      
      {/* Show outcome when game is final */}
      {gameState === 'final' && outcome && (
        <div style={{ marginTop: '16px', textAlign: 'center' }}>
          <div style={{ 
            fontSize: '18px', 
            fontWeight: 'bold',
            color: myWinOutcome === 'win' ? '#16a34a' : myWinOutcome === 'lose' ? '#dc2626' : '#f59e0b',
            marginBottom: '8px'
          }}>
            {myWinOutcome === 'win' && '🎉 You Win!'}
            {myWinOutcome === 'lose' && '😞 You Lose'}
            {myWinOutcome === 'tie' && '🤝 It\'s a Tie!'}
          </div>
          {myHandValue && (
            <div style={{ fontSize: '14px', color: '#666' }}>
              Your hand: {myHandValue}
            </div>
          )}
        </div>
      )}
      
      {/* Show selection UI during card selection */}
      {moveNumber === 1 && gameState === 'playing' && (
        <div style={{ marginBottom: '16px', textAlign: 'center', fontSize: '16px', fontWeight: 'bold' }}>
          Select 4 cards to KEEP ({playerSelected.length}/4 selected)
        </div>
      )}
      
      {/* Show button only when not in final state */}
      {gameState !== 'final' && (
        <button
          aria-label="make-move"
          onClick={doHandleMakeMove}
          disabled={!isButtonEnabled}
          style={buttonStyle}
          onMouseEnter={(e) => {
            if (isButtonEnabled) {
              e.currentTarget.style.background = '#1d4ed8';
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
      )}
    </div>
  );
};

export default PlayerSection;

