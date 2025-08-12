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
}

const PlayerSection: React.FC<PlayerSectionProps> = ({
  playerNumber,
  playerHand,
  isPlayerTurn,
  moveNumber,
  handleMakeMove,
  cardSelections,
  setCardSelections,
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
    padding: '20px',
    backgroundColor: '#fff',
    borderRadius: '10px',
    boxShadow: '0 2px 12px rgba(0,0,0,0.07)',
    marginBottom: '16px',
  };

  const titleStyle: React.CSSProperties = {
    fontSize: '18px',
    fontWeight: 'bold',
    color: '#1976d2',
    marginBottom: '12px',
    textAlign: 'center',
  };

  const handLabelStyle: React.CSSProperties = {
    fontSize: '14px',
    color: '#666',
    marginBottom: '8px',
    textAlign: 'center',
  };

  const cardRowStyle: React.CSSProperties = {
    display: 'flex',
    justifyContent: 'center',
    marginBottom: '16px',
  };

  const actionLineStyle: React.CSSProperties = {
    textAlign: 'center',
    fontSize: '14px',
    color: '#1976d2',
    minHeight: '20px',
    marginBottom: '12px',
  };

  const buttonStyle: React.CSSProperties = {
    background: '#1976d2',
    color: '#fff',
    border: 'none',
    borderRadius: '5px',
    padding: '8px 16px',
    fontSize: '14px',
    cursor: 'pointer',
    transition: 'background 0.2s',
    boxShadow: '0 1px 2px rgba(0,0,0,0.07)',
    minWidth: '100px',
    whiteSpace: 'nowrap',
  };

  const disabledButtonStyle: React.CSSProperties = {
    ...buttonStyle,
    background: '#b0bec5',
    cursor: 'not-allowed',
  };

  return (
    <div style={sectionStyle}>
      <div style={titleStyle}>You</div>
      <div style={handLabelStyle}>Your Hand:</div>
      <div style={cardRowStyle}>
        {playerHand.map((card: number[], index) => (
          <PlayingCard 
            id={`card-${playerNumber}-${card}`} 
            key={index} 
            index={index} 
            selected={!!(cardSelections & (1 << index))} 
            cardValue={card} 
            setSelection={setSelection} 
          />
        ))}
      </div>
      {isPlayerTurn && (
        <div style={actionLineStyle}>
          🟠 Your turn
        </div>
      )}
      <button
        aria-label="make-move"
        onClick={doHandleMakeMove}
        disabled={!isPlayerTurn || (moveNumber === 1 && popcount(cardSelections) != 4)}
        style={!isPlayerTurn || (moveNumber === 1 && popcount(cardSelections) != 4) ? disabledButtonStyle : buttonStyle}
        onMouseEnter={(e) => {
          if (isPlayerTurn && !(moveNumber === 1 && popcount(cardSelections) != 4)) {
            e.currentTarget.style.background = '#1565c0';
          }
        }}
        onMouseLeave={(e) => {
          if (isPlayerTurn && !(moveNumber === 1 && popcount(cardSelections) != 4)) {
            e.currentTarget.style.background = '#1976d2';
          }
        }}
      >
        Make Move
      </button>
    </div>
  );
};

export default PlayerSection;

