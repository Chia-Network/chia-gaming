import { useEffect, useRef, useState } from 'react';
import { Reorder } from 'framer-motion';
import { HandDisplayProps } from '../../../../types/californiaPoker';
import { CardValueSuit } from '../../../../types/californiaPoker/CardValueSuit';
import { GAME_STATES } from '../constants/constants';
import Card from './Card';

const NOOP = () => {};

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
    showSwapAnimation,
    gameState,
    haloCardIds,
    onReorder,
    formatHandDescription,
  } = props;
  const [winnerIndicatorOffset, setWinnerIndicatorOffset] = useState(0);
  const [draggingCardId, setDraggingCardId] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const isDraggingRef = useRef(false);

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

          const containerCenter = containerRect.left + containerRect.width / 2;
          const cardRightEdge = lastCardRect.right;
          const indicatorWidth = 80;
          const offset = cardRightEdge - containerCenter - indicatorWidth / 2;

          setWinnerIndicatorOffset(offset);
        }
      }
    };

    const timer = setTimeout(updateWinnerPosition, 50);
    window.addEventListener('resize', updateWinnerPosition);

    return () => {
      clearTimeout(timer);
      window.removeEventListener('resize', updateWinnerPosition);
    };
  }, [cards, area]);

  const isWinner = winner === winnerType;
  const isTie = winner === 'tie';

  const handleCardClick = (cardId: number) => {
    if (isDraggingRef.current) return;
    onCardClick?.(cardId);
  };

  const renderCard = (card: CardValueSuit, idx: number) => {
    const cardId = card.cardId ?? idx;
    const isInBestHand =
      gameState === GAME_STATES.FINAL &&
      bestHand?.cards?.some(
        (bestCard) =>
          bestCard.cardId != null &&
          bestCard.cardId === card.cardId,
      );
    const hasHalo = haloCardIds.includes(card.cardId ?? -1);

    return (
      <Card
        index={idx}
        id={`card-${playerNumber}-${idx}`}
        card={card}
        cardId={`${area}-${cardId}`}
        isSelected={selectedCards.includes(cardId)}
        onClick={() => handleCardClick(cardId)}
        isBeingSwapped={showSwapAnimation}
        isInBestHand={isInBestHand}
        isFinal={gameState === GAME_STATES.FINAL}
        hasHalo={hasHalo}
        area={area}
      />
    );
  };

  const gridClass = 'grid grid-cols-4 md:grid-cols-8 gap-2 w-full';
  const dragEnabled = !!onReorder;

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
          <Reorder.Group
            axis='x'
            values={cards}
            onReorder={onReorder ?? NOOP}
            className={gridClass}
            as='div'
          >
            {cards.map((card, idx) => {
              const isDragging = draggingCardId === (card.cardId ?? idx);
              return (
                <Reorder.Item
                  key={card.cardId ?? idx}
                  value={card}
                  as='div'
                  className={`relative flex items-center justify-center ${isDragging ? 'z-50' : 'z-0'}`}
                  layout={dragEnabled || undefined}
                  dragListener={dragEnabled}
                  onDragStart={() => {
                    isDraggingRef.current = true;
                    setDraggingCardId(card.cardId ?? idx);
                  }}
                  onDragEnd={() => {
                    setDraggingCardId(null);
                    setTimeout(() => { isDraggingRef.current = false; }, 0);
                  }}
                >
                  <div
                    className='w-full'
                    style={{
                      transform: isDragging ? 'scale(1.05)' : 'scale(1)',
                      transition: isDragging ? 'none' : 'transform 0.2s ease',
                    }}
                  >
                    {renderCard(card, idx)}
                  </div>
                </Reorder.Item>
              );
            })}
          </Reorder.Group>
        </div>
      </div>
    </div>
  );
}
export default HandDisplay;
