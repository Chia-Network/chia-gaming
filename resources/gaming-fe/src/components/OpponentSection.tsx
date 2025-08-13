import React from "react";
import { useCallback } from "react";
import PlayingCard from "./PlayingCard";

interface SwappingCard {
  rank: string;
  suit: string;
  value: number;
  originalIndex: number;
  id: string;
}

interface OpponentSectionProps {
  playerNumber: number;
  opponentHand: number[][];
  swappingCards?: { player: SwappingCard[], ai: SwappingCard[] };
  showSwapAnimation?: boolean;
}

const OpponentSection: React.FC<OpponentSectionProps> = ({
  playerNumber,
  opponentHand,
  swappingCards = { player: [], ai: [] },
  showSwapAnimation = false,
}) => {
  const setSelection = useCallback((index: number, selected: boolean) => {}, []);

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
    marginBottom: '4px',
    textAlign: 'center',
    color: '#4b5563',
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
    gap: '8px',
    flexWrap: 'wrap',
  };

  const actionLineStyle: React.CSSProperties = {
    textAlign: 'center',
    fontSize: '14px',
    color: '#d81b60',
    minHeight: '20px',
    marginBottom: '12px',
  };

  return (
    <div style={sectionStyle} data-area="ai">
      <h3 style={titleStyle}>Opponent Hand</h3>
      <div style={cardRowStyle}>
        {opponentHand.map((card, index) => {
          const isBeingSwapped = showSwapAnimation && swappingCards.ai.some(c => c.originalIndex === index);
          return (
            <PlayingCard 
              id={`ai-${index}`} 
              key={index} 
              cardValue={card} 
              isFaceDown={false} 
              index={index} 
              setSelection={setSelection} 
              selected={false}
              isBeingSwapped={isBeingSwapped}
            />
          );
        })}
      </div>
    </div>
  );
};

export default OpponentSection;

