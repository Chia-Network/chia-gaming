import React from 'react';

interface MovingCardProps {
  cardData: {
    card: {
      rank: string;
      suit: string;
      id: string;
    };
    startPosition: {
      x: number;
      y: number;
    };
    endPosition: {
      x: number;
      y: number;
    };
    direction: string;
  };
}

const MovingCard: React.FC<MovingCardProps> = ({ cardData }) => {
  const { card, startPosition, endPosition } = cardData;
  
  const getCardColor = () => {
    if (card.suit === '♥') return '#ef4444';
    if (card.suit === '♦') return '#3b82f6';
    if (card.suit === '♣') return '#16a34a';
    return '#000000';
  };

  if (!startPosition || !endPosition) return null;

  const cardStyle: React.CSSProperties = {
    width: '64px',
    height: '96px',
    border: '2px solid #d1d5db',
    borderRadius: '8px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '14px',
    fontWeight: 'bold',
    backgroundColor: '#ffffff',
    boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)',
    position: 'fixed',
    left: startPosition.x - 32, // Half of card width (64px / 2)
    top: startPosition.y - 48,  // Half of card height (96px / 2)
    zIndex: 9999,
    pointerEvents: 'none',
    color: getCardColor(),
    animation: 'moveCard 2s ease-in-out forwards',
  };

  return (
    <>
      <style>{`
        @keyframes moveCard {
          0% {
            left: ${startPosition.x - 32}px;
            top: ${startPosition.y - 48}px;
          }
          100% {
            left: ${endPosition.x - 32}px;
            top: ${endPosition.y - 48}px;
          }
        }
      `}</style>
      <div style={cardStyle}>
        <div style={{ fontSize: '16px', fontWeight: 'bold' }}>
          {card.rank}
        </div>
        <div style={{ fontSize: '24px' }}>
          {card.suit}
        </div>
      </div>
    </>
  );
};

export default MovingCard;