import { useEffect, useRef, useState } from 'react';
import { HandDisplayProps } from '../../../types/californiaPoker';
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
  const [showPlaceholders, setShowPlaceholders] = useState(false);
  const [placeholderFlip, setPlaceholderFlip] = useState(false);

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

  // Show placeholders if no cards. When cards arrive, run flip animation then hide placeholders.
  useEffect(() => {
    if (!cards || cards.length === 0) {
      setShowPlaceholders(true);
      setPlaceholderFlip(false);
    } else if (showPlaceholders && cards.length > 0) {
      // trigger flip animation
      setPlaceholderFlip(true);
      const t = setTimeout(() => {
        setShowPlaceholders(false);
        setPlaceholderFlip(false);
      }, 600); // match animation duration
      return () => clearTimeout(t);
    }
  }, [cards, showPlaceholders]);


  const isWinner = winner === winnerType;
  const isTie = winner === 'tie';
  const isPlayer = area === 'player';

  // Only show the title, not the hand description
 
  
  // We'll render cards in a responsive grid (2 -> 4 -> 6 -> 8 columns)

  return (
    <div
      ref={containerRef}
      className='p-1 rounded-lg max-w-full mx-auto gap-[32px] mb-2 relative text-canvas-text'
      data-area={area}
    >
      

      <div className='relative'>
        {gameState === GAME_STATES.FINAL && (isWinner || isTie) && (
          <div
            className={`absolute z-1200 -top-5 ${isWinner
              ? 'bg-success-solid text-success-on-success'
              : 'bg-canvas-solid text-canvas-on-canvas'
              } px-4 py-2 rounded-full font-bold text-base shadow-lg z-10`}
            style={{
              left: '50%',
              transform: `translateX(calc(-50% + ${winnerIndicatorOffset}px))`,
            }}
          >
            {isWinner ? 'Winner!' : 'Tie!'}
          </div>
        )}

        <div className='min-w-full'>
          {showPlaceholders ? (

            <div className="inline-grid
                            grid-flow-row-dense
                            gap-4
                            h-full
                            justify-center
                            grid-cols-3
                            md:grid-cols-4
                            lg:grid-cols-8
                            xl:grid-cols-8
                            grid-cols-2-xs
                          ">

              {Array.from({ length: 8 }).map((_, i) => {
                const frontCard = cards && cards[i];
                const originalIndex = frontCard
                  ? cards.findIndex(
                    (c) => c.suit === frontCard.suit && c.rank === frontCard.rank
                  )
                  : -1;

                return (
                  <div key={`placeholder-${i}`} className="w-20 h-28 lg:w-20 lg:h-28 md:w-24 md:h-32 xl:w-24 xl:h-32 flex items-center justify-center">
                    <div className="flip-container">
                      <div className={`flip-inner ${placeholderFlip ? 'is-flipped' : ''}`}>
                        {/* Back of the card */}
                        <div
                          className="flip-back rounded-lg border-2 border-canvas-border flex items-center justify-center
                   bg-canvas-bg-subtle dark:bg-canvas-bg/90 text-canvas-border dark:text-canvas-bg-subtle"
                        >
                          {/* Poker Spade in the center */}
                          <span className="text-4xl font-bold">♠</span>
                        </div>

                        {/* Front of the card */}
                        <div
                          className="flip-front rounded-lg border-2 border-canvas-border bg-white shadow-md"
                          style={{ transform: 'rotateY(180deg)' }}
                        >
                          {frontCard && (
                            <Card
                              index={i}
                              id={`card-${playerNumber}-${i}`}
                              key={`${area}-flip-${i}`}
                              card={frontCard}
                              cardId={`${area}-${i}`}
                              isSelected={selectedCards.includes(originalIndex)}
                              onClick={() => onCardClick && onCardClick(originalIndex)}
                              isBeingSwapped={false}
                              isInBestHand={false}
                            />
                          )}
                        </div>
                      </div>
                    </div>
                  </div>


                );
              })}
            </div>
          ) : (
            <div className='inline-grid
                            grid-flow-row-dense
                            gap-4
                            h-full
                            justify-center
                            grid-cols-3
                            md:grid-cols-4
                            lg:grid-cols-
                            xl:grid-cols-8
                            grid-cols-2-xs'>
              {cards.map((card: any, idx: number) => {
                const originalIndex = cards.findIndex(
                  (c) => c.suit === card.suit && c.rank === card.rank,
                );
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
                    key={`${area}-${originalIndex}`}
                    className='w-20 h-28 lg:w-20 lg:h-28 md:w-24 md:h-32 xl:w-24 xl:h-32  flex items-center justify-center'
                  >
                    <Card
                      index={idx}
                      id={`card-${playerNumber}-${idx}`}
                      key={`${area}-${originalIndex}`}
                      card={card}
                      cardId={`${area}-${originalIndex}`}
                      isSelected={selectedCards.includes(originalIndex)}
                      onClick={() => onCardClick && onCardClick(originalIndex)}
                      isBeingSwapped={isBeingSwapped}
                      isInBestHand={isInBestHand}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
export default HandDisplay;
