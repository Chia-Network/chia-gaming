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
  outcome?: any;
  gameState?: string;
  currentPlayerNumber?: number;
}

const OpponentSection: React.FC<OpponentSectionProps> = ({
  playerNumber,
  opponentHand,
  swappingCards = { player: [], ai: [] },
  showSwapAnimation = false,
  outcome,
  gameState = 'playing',
  currentPlayerNumber,
}) => {
  const setSelection = useCallback((index: number, selected: boolean) => {}, []);

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
    marginBottom: '12px',
    gap: '4px',
    flexWrap: 'wrap',
  };

  const actionLineStyle: React.CSSProperties = {
    textAlign: 'center',
    fontSize: '14px',
    color: '#d81b60',
    minHeight: '20px',
    marginBottom: '12px',
  };

  // Get opponent outcome info
  const myWinOutcome = outcome?.my_win_outcome;
  const iAmAlice = currentPlayerNumber === 2;
  const isOpponentAlice = playerNumber === 2;
  const opponentHandValue = outcome && (isOpponentAlice ? outcome?.alice_hand_value : outcome?.bob_hand_value);
  
  // Opponent's win outcome is opposite of player's
  const opponentWinOutcome = myWinOutcome === 'win' ? 'lose' : myWinOutcome === 'lose' ? 'win' : 'tie';

  return (
    <div style={sectionStyle} data-area="ai">
      <h3 style={{ fontSize: '20px', fontWeight: 'bold', marginBottom: '8px' }}>AI Hand</h3>
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
      
      {/* Show outcome when game is final */}
      {gameState === 'final' && outcome && (
        <div style={{ marginTop: '16px', textAlign: 'center' }}>
          <div style={{ 
            fontSize: '18px', 
            fontWeight: 'bold',
            color: opponentWinOutcome === 'win' ? '#16a34a' : opponentWinOutcome === 'lose' ? '#dc2626' : '#f59e0b',
            marginBottom: '8px'
          }}>
            {opponentWinOutcome === 'win' && '🎉 AI Wins!'}
            {opponentWinOutcome === 'lose' && '😞 AI Loses'}
            {opponentWinOutcome === 'tie' && '🤝 Tie!'}
          </div>
          {opponentHandValue && (
            <div style={{ fontSize: '14px', color: '#666' }}>
              AI hand: {opponentHandValue}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default OpponentSection;

