import React from "react";
import { useCallback } from "react";
import PlayingCard from "./PlayingCard";

interface OpponentSectionProps {
  playerNumber: number;
  opponentHand: number[][];
}

const OpponentSection: React.FC<OpponentSectionProps> = ({
  playerNumber,
  opponentHand,
}) => {
  const setSelection = useCallback((index: number, selected: boolean) => {}, []);

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
    color: '#d81b60',
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
    color: '#d81b60',
    minHeight: '20px',
    marginBottom: '12px',
  };

  return (
    <div style={sectionStyle}>
      <div style={titleStyle}>Opponent</div>
      <div style={handLabelStyle}>Opponent's Hand:</div>
      <div style={cardRowStyle}>
        {opponentHand.map((card, index) => (
          <PlayingCard 
            id={`card-${playerNumber}-${card}`} 
            key={index} 
            cardValue={card} 
            isFaceDown={false} 
            index={index} 
            setSelection={setSelection} 
            selected={false} 
          />
        ))}
      </div>
    </div>
  );
};

export default OpponentSection;

