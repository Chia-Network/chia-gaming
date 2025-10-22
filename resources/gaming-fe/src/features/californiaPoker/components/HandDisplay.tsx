import { useEffect, useRef, useState } from "react";
import { HandDisplayProps } from "../../../types/californiaPoker";
import { GAME_STATES } from "../constants/constants";
import { calculateBalancedRows } from "../utils";
import Card from "./Card";

function HandDisplay(props: HandDisplayProps) {
  const {
    title,
    cards,
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

  // Determine what text to show
  let displayText = title;
  if (gameState === GAME_STATES.FINAL && bestHand?.cards) {
    displayText = formatHandDescription(bestHand.rank);
  }

  // Calculate balanced rows
  const rowSizes = calculateBalancedRows(cards.length, containerWidth);
  const cardRows: any[] = [];
  let cardIndex = 0;

  rowSizes.forEach((rowSize) => {
    cardRows.push(cards.slice(cardIndex, cardIndex + rowSize));
    cardIndex += rowSize;
  });

  return (
    <div
      ref={containerRef}
      className='p-2 rounded-lg max-w-full mx-auto'
      data-area={area}
    >
      {!isPlayer && (
        <h3 className='text-sm font-bold mb-1 text-center text-gray-700'>
          {displayText}
        </h3>
      )}

      <div className='relative'>
        {gameState === GAME_STATES.FINAL && (isWinner || isTie) && (
          <div
            className={`absolute -top-5 ${isWinner ? 'bg-green-500' : 'bg-gray-500'} text-white px-4 py-2 rounded-full font-bold text-base shadow-lg z-10`}
            style={{
              left: '50%',
              transform: `translateX(calc(-50% + ${winnerIndicatorOffset}px))`,
            }}
          >
            {isWinner ? 'Winner!' : 'Tie!'}
          </div>
        )}

        <div className='flex flex-col gap-2 items-center'>
          {cardRows.map((row, rowIndex) => (
            <div key={`row-${rowIndex}`} className='flex gap-2 justify-center'>
              {row.map((card: any, cardInRowIndex: number) => {
                const originalIndex = cards.findIndex(
                  (c) => c.suit === card.suit && c.rank === card.rank,
                );
                const isBeingSwapped =
                  showSwapAnimation &&
                  swappingCards.some((c) => c.originalIndex === originalIndex);
                const isInBestHand =
                  gameState === GAME_STATES.FINAL &&
                  bestHand?.cards &&
                  bestHand.cards.some(
                    (bestCard) =>
                      bestCard.rank === card.rank &&
                      bestCard.suit === card.suit,
                  );

                return (
                  <Card
                    key={`${area}-${originalIndex}`}
                    card={card}
                    cardId={`${area}-${originalIndex}`}
                    isSelected={selectedCards.includes(originalIndex)}
                    onClick={() => onCardClick && onCardClick(originalIndex)}
                    isBeingSwapped={isBeingSwapped}
                    isInBestHand={isInBestHand}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {isPlayer && (
        <h3 className='text-sm font-bold mt-1 text-center text-gray-700'>
          {displayText}
        </h3>
      )}
    </div>
  );
}
export default HandDisplay;