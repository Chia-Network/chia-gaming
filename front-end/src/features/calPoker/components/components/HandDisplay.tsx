import { useEffect, useRef, useState, useCallback } from 'react';
import { Reorder } from 'framer-motion';
import { HandDisplayProps } from '../../../../types/californiaPoker';
import { CardValueSuit } from '../../../../types/californiaPoker/CardValueSuit';
import { GAME_STATES } from '../constants/constants';
import Card from './Card';

const NOOP = () => {};

function columnsForWidth(px: number, currentCols: number): number {
  const margin = 20;
  const breakpoints = [
    { cols: 8, min: 580 },
    { cols: 4, min: 290 },
    { cols: 3, min: 220 },
    { cols: 2, min: 140 },
    { cols: 1, min: 0 },
  ];

  let target = 1;
  for (const bp of breakpoints) {
    if (px >= bp.min) { target = bp.cols; break; }
  }
  if (target === currentCols) return currentCols;

  if (target > currentCols) {
    const bp = breakpoints.find(b => b.cols === target);
    if (bp && px < bp.min + margin) return currentCols;
  } else {
    const bp = breakpoints.find(b => b.cols === currentCols);
    if (bp && px > bp.min - margin) return currentCols;
  }
  return target;
}

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
  const [anyDragging, setAnyDragging] = useState(false);
  const [cols, setCols] = useState(8);
  const colsRef = useRef(8);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const isDraggingRef = useRef(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const w = entry.contentRect.width;
      const next = columnsForWidth(w, colsRef.current);
      if (next !== colsRef.current) {
        colsRef.current = next;
        setCols(next);
      }
    });
    ro.observe(el);
    const w = el.clientWidth;
    const initial = columnsForWidth(w, colsRef.current);
    colsRef.current = initial;
    setCols(initial);
    return () => ro.disconnect();
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

  const dragEnabled = !!onReorder;
  const gapPx = 8;
  const gapAdjust = cols > 1 ? `${(cols - 1) * gapPx / cols}px` : '0px';
  const itemWidth = `calc(${100 / cols}% - ${gapAdjust})`;
  const groupStyle = { '--card-w': itemWidth } as React.CSSProperties;

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

        <Reorder.Group
            axis='x'
            values={cards}
            onReorder={onReorder ?? NOOP}
            className='hand-reorder-group'
            style={groupStyle}
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
                  initial={false}
                  layout={anyDragging || undefined}
                  transition={{ layout: { duration: 0 } }}
                  dragListener={dragEnabled}
                  onDragStart={() => {
                    isDraggingRef.current = true;
                    setAnyDragging(true);
                    setDraggingCardId(card.cardId ?? idx);
                  }}
                  onDragEnd={() => {
                    setDraggingCardId(null);
                    setAnyDragging(false);
                    setTimeout(() => { isDraggingRef.current = false; }, 0);
                  }}
                >
                  <div
                    style={{
                      width: '100%',
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
  );
}
export default HandDisplay;
