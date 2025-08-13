import React, { useRef, useEffect, useState } from "react";
import PlayingCard from "./PlayingCard";

interface SwappingCard {
  rank: string;
  suit: string;
  value: number;
  originalIndex: number;
  id: string;
}

interface HandDisplayProps {
  title: string;
  cards: number[][];
  area: 'player' | 'ai';
  isPlayer?: boolean;
  onCardClick?: (index: number) => void;
  selectedCards?: number[];
  swappingCards?: SwappingCard[];
  showSwapAnimation?: boolean;
  bestHand?: { cards: number[][] };
  gameState?: 'playing' | 'swapping' | 'final';
  winner?: string | null;
  winnerType?: 'player' | 'ai';
}

// Utility function to calculate balanced rows
const calculateBalancedRows = (totalCards: number, containerWidth: number, cardWidth: number = 64, gap: number = 8): number[] => {
  const cardsPerRow = Math.floor((containerWidth + gap) / (cardWidth + gap));

  if (cardsPerRow >= totalCards) {
    return [totalCards]; // All cards fit in one row
  }

  const rows = Math.ceil(totalCards / cardsPerRow);
  const balancedRows: number[] = [];

  // Distribute cards as evenly as possible
  const baseCardsPerRow = Math.floor(totalCards / rows);
  const remainder = totalCards % rows;

  for (let i = 0; i < rows; i++) {
    const cardsInThisRow = baseCardsPerRow + (i < remainder ? 1 : 0);
    balancedRows.push(cardsInThisRow);
  }

  return balancedRows;
};

const HandDisplay: React.FC<HandDisplayProps> = ({
  title,
  cards,
  area,
  isPlayer = false,
  onCardClick,
  selectedCards = [],
  swappingCards = [],
  showSwapAnimation = false,
  bestHand,
  gameState = 'playing',
  winner,
  winnerType,
}) => {
  const [containerWidth, setContainerWidth] = useState(600);
  const [winnerIndicatorOffset, setWinnerIndicatorOffset] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const updateWidth = () => {
      if (containerRef.current) {
        setContainerWidth(containerRef.current.offsetWidth - 16); // Subtract padding
      }
    };

    updateWidth();
    window.addEventListener('resize', updateWidth);
    return () => window.removeEventListener('resize', updateWidth);
  }, []);

  useEffect(() => {
    const updateWinnerPosition = () => {
      if (containerRef.current) {
        const cardElements = containerRef.current.querySelectorAll(`[data-card-id^="${area}-"]`);
        if (cardElements.length > 0) {
          const containerRect = containerRef.current.getBoundingClientRect();
          const lastCardElement = cardElements[cardElements.length - 1];
          const lastCardRect = lastCardElement.getBoundingClientRect();

          // Calculate offset to align right edge of indicator with right edge of rightmost card
          const containerCenter = containerRect.left + containerRect.width / 2;
          const cardRightEdge = lastCardRect.right;

          // Estimate indicator width
          const indicatorWidth = 80; // Approximate width of "Winner!" text + padding
          const offset = cardRightEdge - containerCenter - (indicatorWidth / 2);

          setWinnerIndicatorOffset(offset);
        }
      }
    };

    // Update position when cards change
    const timer = setTimeout(updateWinnerPosition, 50);
    window.addEventListener('resize', updateWinnerPosition);

    return () => {
      clearTimeout(timer);
      window.removeEventListener('resize', updateWinnerPosition);
    };
  }, [cards, area]);

  const isWinner = winner === winnerType;
  const isTie = winner === 'tie';

  // Calculate balanced rows
  const rowSizes = calculateBalancedRows(cards.length, containerWidth);
  const cardRows: number[][][] = [];
  let cardIndex = 0;

  rowSizes.forEach(rowSize => {
    cardRows.push(cards.slice(cardIndex, cardIndex + rowSize));
    cardIndex += rowSize;
  });

  // Handle card selection for the player
  const handleCardClick = (index: number) => {
    if (!isPlayer || !onCardClick) return;
    onCardClick(index);
  };

  const setSelection = (index: number, selected: boolean) => {
    if (!isPlayer || !onCardClick) return;
    onCardClick(index);
  };

  const sectionStyle: React.CSSProperties = {
    padding: '8px',
    borderRadius: '8px',
    maxWidth: '100%',
    margin: '0 auto',
  };

  const titleStyle: React.CSSProperties = {
    fontSize: '14px',
    fontWeight: 'bold',
    marginBottom: isPlayer ? '0' : '4px',
    marginTop: isPlayer ? '4px' : '0',
    textAlign: 'center',
    color: '#4b5563',
  };

  return (
    <div ref={containerRef} style={sectionStyle} data-area={area}>
      {!isPlayer && (
        <h3 style={titleStyle}>{title}</h3>
      )}

      <div style={{ position: 'relative' }}>
        {gameState === 'final' && (isWinner || isTie) && (
          <div
            style={{
              position: 'absolute',
              top: '-20px',
              left: '50%',
              transform: `translateX(calc(-50% + ${winnerIndicatorOffset}px))`,
              background: isWinner ? '#10b981' : '#6b7280',
              color: 'white',
              padding: '8px 16px',
              borderRadius: '9999px',
              fontWeight: 'bold',
              fontSize: '16px',
              boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.1)',
              zIndex: 10,
            }}
          >
            {isWinner ? 'Winner!' : 'Tie!'}
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', alignItems: 'center' }}>
          {cardRows.map((row, rowIndex) => (
            <div key={`row-${rowIndex}`} style={{ display: 'flex', gap: '8px', justifyContent: 'center' }}>
              {row.map((card, cardInRowIndex) => {
                const originalIndex = cards.findIndex(c => c[0] === card[0] && c[1] === card[1]);
                const isBeingSwapped = showSwapAnimation && swappingCards.some(c => c.originalIndex === originalIndex);
                const isInBestHand = gameState === 'final' && bestHand?.cards &&
                  bestHand.cards.some(bestCard =>
                    bestCard[0] === card[0] && bestCard[1] === card[1]
                  );

                // Check if card is selected (for player)
                const isSelected = isPlayer && selectedCards.includes(originalIndex);

                return (
                  <PlayingCard
                    key={`${area}-${originalIndex}`}
                    id={`${area}-${originalIndex}`}
                    cardValue={card}
                    index={originalIndex}
                    selected={isSelected}
                    setSelection={setSelection}
                    isBeingSwapped={isBeingSwapped}
                    isInBestHand={isInBestHand}
                    isFaceDown={false}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {isPlayer && (
        <h3 style={titleStyle}>{title}</h3>
      )}
    </div>
  );
};

export default HandDisplay;