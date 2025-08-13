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
    // Using OKLCH colors from new_calpoker.tsx
    if (card.suit === '♥') return 'oklch(50% 0.3 25)';  // Red
    if (card.suit === '♦') return 'oklch(50% 0.3 265)'; // Blue
    if (card.suit === '♣') return 'oklch(50% 0.3 155)'; // Green
    return 'oklch(0% 0 0)'; // Black for spades
  };

  if (!startPosition || !endPosition) return null;

  const startX = startPosition.x - 32; // Half of card width (64px / 2)
  const startY = startPosition.y - 48; // Half of card height (96px / 2)
  const endX = endPosition.x - 32;
  const endY = endPosition.y - 48;

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
    boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.15), 0 4px 6px -2px rgba(0, 0, 0, 0.05)',
    position: 'fixed',
    left: startX,
    top: startY,
    zIndex: 50,
    pointerEvents: 'none',
    color: getCardColor(),
    animation: 'moveCard 2s ease-in-out forwards',
    '--start-x': `${startX}px`,
    '--start-y': `${startY}px`,
    '--end-x': `${endX}px`,
    '--end-y': `${endY}px`,
  } as React.CSSProperties;

  return (
    <>
      <style>{`
        @keyframes moveCard {
          from {
            left: var(--start-x);
            top: var(--start-y);
          }
          to {
            left: var(--end-x);
            top: var(--end-y);
          }
        }
      `}</style>
      <div style={cardStyle}>
        <div style={{ fontSize: '24px' }}>
          {card.rank}
        </div>
        <div style={{ fontSize: '24px', marginTop: '-8px' }}>
          {card.suit}
        </div>
      </div>
    </>
  );
};

export default MovingCard;