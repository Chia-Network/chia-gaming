import { useEffect, useRef, useState } from 'react';
import { HandDisplayProps } from '../../../../types/californiaPoker';
import { GAME_STATES } from '../constants/constants';
import Card from './Card';

function HandDisplay(props: HandDisplayProps) {
  const {
    title,
    cards,
    playerNumber,
    area,
    winner,
    winnerType,
    bestHand,
    onCardClick,
    selectedCards,
    swappingCards,
    showSwapAnimation,
    gameState,
    formatHandDescription,
  } = props;
  const [containerWidth, setContainerWidth] = useState(600);
  const [winnerIndicatorOffset, setWinnerIndicatorOffset] = useState(0);
  const containerRef = useRef<any | null>(null);

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
        const cardElements = containerRef.current.querySelectorAll(
          `[data-card-id^="${area}-"]`,
        );
        if (cardElements.length > 0) {
          const containerRect = containerRef.current.getBoundingClientRect();
          const lastCardElement = cardElements[cardElements.length - 1];
          const lastCardRect = lastCardElement.getBoundingClientRect();

          // Calculate offset to align right edge of indicator with right edge of rightmost card
          const containerCenter = containerRect.left + containerRect.width / 2;
          const cardRightEdge = lastCardRect.right;

          // We need to position the indicator so its right edge aligns with the card's right edge
          // Since the indicator starts centered, we need to account for half its width
          // Estimate indicator width (will be refined by actual measurement if needed)
          const indicatorWidth = 80; // Approximate width of "Winner!" text + padding
          const offset = cardRightEdge - containerCenter - indicatorWidth / 2;

          setWinnerIndicatorOffset(offset);
        }
      }
    };

    // Always update position when cards change, regardless of game state
    // This ensures the position is calculated before the indicator becomes visible
    const timer = setTimeout(updateWinnerPosition, 50);
    window.addEventListener('resize', updateWinnerPosition);

    return () => {
      clearTimeout(timer);
      window.removeEventListener('resize', updateWinnerPosition);
    };
  }, [cards, area]); // Removed winner, winnerType, gameState dependencies

  const isWinner = winner === winnerType;
  const isTie = winner === 'tie';
  const isPlayer = area === 'player';

  // Only show the title, not the hand description

  // We'll render cards in a responsive grid (2 -> 4 -> 6 -> 8 columns)

  return (
    <div
      ref={containerRef}
      className='w-full max-w-full mx-auto relative text-canvas-text'
      data-area={area}
    >
      <div className='relative'>
        {gameState === GAME_STATES.FINAL && (isWinner || isTie) && (
          <div
            className={`absolute z-20 -top-5 ${
              isWinner
                ? 'bg-success-solid text-success-on-success'
                : 'bg-canvas-solid text-canvas-on-canvas'
            } px-4 py-2 rounded-full font-bold text-base shadow-lg`}
            style={{
              left: '50%',
              transform: `translateX(calc(-50% + ${winnerIndicatorOffset}px))`,
            }}
          >
            {isWinner ? 'Winner!' : 'Tie!'}
          </div>
        )}

        <div className='w-full'>
          <div className='grid grid-cols-4 md:grid-cols-8 gap-2 w-full'>
            {cards.map((card: any, idx: number) => {
              const originalIndex =
                card.originalIndex !== undefined ? card.originalIndex : idx;
              const cardId = card.cardId ?? originalIndex;
              const isBeingSwapped =
                showSwapAnimation &&
                swappingCards.some((c) => c.originalIndex === originalIndex);
              const isInBestHand =
                gameState === GAME_STATES.FINAL &&
                bestHand?.cards?.some(
                  (bestCard) =>
                    bestCard.rank === card.rank &&
                    bestCard.suit === card.suit,
                );

              return (
                <div
                  key={`${area}-${cardId}`}
                  className='flex items-center justify-center'
                >
                  <Card
                    index={idx}
                    id={`card-${playerNumber}-${idx}`}
                    key={`${area}-${originalIndex}`}
                    card={card}
                    cardId={`${area}-${cardId}`}
                    isSelected={selectedCards.includes(cardId)}
                    onClick={() => onCardClick && onCardClick(cardId)}
                    isBeingSwapped={isBeingSwapped}
                    isInBestHand={isInBestHand}
                    area={area}
                  />
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
export default HandDisplay;
