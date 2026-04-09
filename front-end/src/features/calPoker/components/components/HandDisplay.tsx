import { useEffect, useRef, useState, useCallback } from 'react';
import { HandDisplayProps } from '../../../../types/californiaPoker';
import { CardValueSuit } from '../../../../types/californiaPoker/CardValueSuit';
import { GAME_STATES } from '../constants/constants';
import Card from './Card';

type SlotCenter = { x: number; y: number } | null;
type HoleSlot = CardValueSuit | null;
type PendingDrag = {
  pointerId: number;
  index: number;
  startX: number;
  startY: number;
};
type ActiveDrag = {
  card: CardValueSuit;
  originIndex: number;
  width: number;
  height: number;
  left: number;
  top: number;
  lockLeft: number;
  lockTop: number;
};

const DRAG_ACTIVATION_THRESHOLD_PX = 4;
const SWITCH_EPSILON_SQ = 16;

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
  const [holeSlots, setHoleSlots] = useState<HoleSlot[] | null>(null);
  const [activeDrag, setActiveDrag] = useState<ActiveDrag | null>(null);
  const [cols, setCols] = useState(8);
  const colsRef = useRef(8);
  const cardsRef = useRef(cards);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const groupRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Array<HTMLDivElement | null>>([]);
  const slotCentersRef = useRef<SlotCenter[]>([]);
  const holeSlotsRef = useRef<HoleSlot[] | null>(null);
  const homeSlotRef = useRef<number>(-1);
  const grabOffsetRef = useRef<{ x: number; y: number } | null>(null);
  const pendingDragRef = useRef<PendingDrag | null>(null);
  const activeDragRef = useRef<ActiveDrag | null>(null);
  const dragAxisRef = useRef<'x' | 'y' | true>(true);
  const bodyUserSelectBeforeDragRef = useRef<string | null>(null);
  const isDraggingRef = useRef(false);

  const lockBodyTextSelection = useCallback(() => {
    if (typeof document === 'undefined') return;
    if (bodyUserSelectBeforeDragRef.current !== null) return;
    bodyUserSelectBeforeDragRef.current = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
  }, []);

  const unlockBodyTextSelection = useCallback(() => {
    if (typeof document === 'undefined') return;
    if (bodyUserSelectBeforeDragRef.current === null) return;
    document.body.style.userSelect = bodyUserSelectBeforeDragRef.current;
    bodyUserSelectBeforeDragRef.current = null;
  }, []);

  const measureSlotCenters = useCallback(() => {
    const centers: SlotCenter[] = new Array(cardsRef.current.length).fill(null);
    for (let i = 0; i < centers.length; i++) {
      const el = itemRefs.current[i];
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      centers[i] = {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      };
    }
    slotCentersRef.current = centers;
  }, []);

  const nearestSlotIndex = useCallback((centerX: number, centerY: number, excludeIndex: number): number => {
    const centers = slotCentersRef.current;
    const slots = holeSlotsRef.current;
    if (centers.length === 0 || !slots) return homeSlotRef.current;

    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let i = 0; i < centers.length; i++) {
      if (i === excludeIndex) continue;
      if (slots[i] == null) continue;
      const center = centers[i];
      if (!center) continue;
      const dx = centerX - center.x;
      const dy = centerY - center.y;
      const distSq = dx * dx + dy * dy;
      if (distSq < bestDistance) {
        bestDistance = distSq;
        bestIndex = i;
      }
    }
    return bestIndex >= 0 ? bestIndex : homeSlotRef.current;
  }, []);

  useEffect(() => {
    cardsRef.current = cards;
  }, [cards]);

  useEffect(() => {
    holeSlotsRef.current = holeSlots;
  }, [holeSlots]);

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
      measureSlotCenters();
    });
    ro.observe(el);
    const w = el.clientWidth;
    const initial = columnsForWidth(w, colsRef.current);
    colsRef.current = initial;
    setCols(initial);
    measureSlotCenters();
    return () => ro.disconnect();
  }, [measureSlotCenters]);

  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      measureSlotCenters();
    });
    return () => cancelAnimationFrame(raf);
  }, [cards.length, cols, measureSlotCenters, holeSlots]);

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
      measureSlotCenters();
    };

    const timer = setTimeout(updateWinnerPosition, 50);
    window.addEventListener('resize', updateWinnerPosition);

    return () => {
      clearTimeout(timer);
      window.removeEventListener('resize', updateWinnerPosition);
    };
  }, [cards, area, measureSlotCenters]);

  useEffect(() => {
    itemRefs.current = itemRefs.current.slice(0, cards.length);
  }, [cards.length]);

  const clearDragSession = useCallback(() => {
    pendingDragRef.current = null;
    activeDragRef.current = null;
    homeSlotRef.current = -1;
    grabOffsetRef.current = null;
    holeSlotsRef.current = null;
    setActiveDrag(null);
    setHoleSlots(null);
    setDraggingCardId(null);
    setAnyDragging(false);
    unlockBodyTextSelection();
    setTimeout(() => {
      isDraggingRef.current = false;
    }, 0);
  }, [unlockBodyTextSelection]);

  const beginDragSession = useCallback((index: number, pointerX: number, pointerY: number) => {
    const groupEl = groupRef.current;
    const itemEl = itemRefs.current[index];
    const cardsNow = cardsRef.current;
    if (!groupEl || !itemEl || !cardsNow[index]) return;

    const groupRect = groupEl.getBoundingClientRect();
    const itemRect = itemEl.getBoundingClientRect();
    const card = cardsNow[index];
    const cardCenterX = itemRect.left + itemRect.width / 2;
    const cardCenterY = itemRect.top + itemRect.height / 2;

    const nextHoleSlots: HoleSlot[] = cardsNow.map((c, i) => (i === index ? null : c));

    const nextActiveDrag: ActiveDrag = {
      card,
      originIndex: index,
      width: itemRect.width,
      height: itemRect.height,
      left: itemRect.left - groupRect.left,
      top: itemRect.top - groupRect.top,
      lockLeft: itemRect.left - groupRect.left,
      lockTop: itemRect.top - groupRect.top,
    };

    homeSlotRef.current = index;
    grabOffsetRef.current = {
      x: pointerX - cardCenterX,
      y: pointerY - cardCenterY,
    };
    holeSlotsRef.current = nextHoleSlots;
    activeDragRef.current = nextActiveDrag;
    isDraggingRef.current = true;

    setAnyDragging(true);
    setDraggingCardId(card.cardId ?? index);
    setHoleSlots(nextHoleSlots);
    setActiveDrag(nextActiveDrag);
  }, []);

  const updateActiveDragFromPointer = useCallback((pointerX: number, pointerY: number) => {
    const dragging = activeDragRef.current;
    const groupEl = groupRef.current;
    if (!dragging || !groupEl) return;

    const groupRect = groupEl.getBoundingClientRect();
    const grabOffset = grabOffsetRef.current ?? { x: 0, y: 0 };

    const centerX = pointerX - grabOffset.x;
    const centerY = pointerY - grabOffset.y;

    let nextLeft = centerX - dragging.width / 2 - groupRect.left;
    let nextTop = centerY - dragging.height / 2 - groupRect.top;

    const maxLeft = Math.max(0, groupRect.width - dragging.width);
    const maxTop = Math.max(0, groupRect.height - dragging.height);

    if (dragAxisRef.current === 'x') nextTop = dragging.lockTop;
    if (dragAxisRef.current === 'y') nextLeft = dragging.lockLeft;

    nextLeft = Math.min(maxLeft, Math.max(0, nextLeft));
    nextTop = Math.min(maxTop, Math.max(0, nextTop));

    const nextDrag = {
      ...dragging,
      left: nextLeft,
      top: nextTop,
    };
    activeDragRef.current = nextDrag;
    setActiveDrag(nextDrag);

    const defaultSlot = homeSlotRef.current;
    const centers = slotCentersRef.current;
    const currentDefaultCenter = centers[defaultSlot];
    if (!currentDefaultCenter) return;

    const nearest = nearestSlotIndex(centerX, centerY, defaultSlot);
    if (nearest < 0) return;

    const nearestCenter = centers[nearest];
    if (!nearestCenter) return;

    const defaultDx = centerX - currentDefaultCenter.x;
    const defaultDy = centerY - currentDefaultCenter.y;
    const defaultDistSq = defaultDx * defaultDx + defaultDy * defaultDy;

    const nearestDx = centerX - nearestCenter.x;
    const nearestDy = centerY - nearestCenter.y;
    const nearestDistSq = nearestDx * nearestDx + nearestDy * nearestDy;

    if (nearestDistSq + SWITCH_EPSILON_SQ >= defaultDistSq) return;

    const currentSlots = holeSlotsRef.current;
    if (!currentSlots) return;

    const nextSlots = currentSlots.slice();
    nextSlots[defaultSlot] = nextSlots[nearest];
    nextSlots[nearest] = null;

    homeSlotRef.current = nearest;
    holeSlotsRef.current = nextSlots;
    setHoleSlots(nextSlots);
    requestAnimationFrame(measureSlotCenters);
  }, [measureSlotCenters, nearestSlotIndex]);

  const finalizeDrag = useCallback(() => {
    const dragging = activeDragRef.current;
    const currentSlots = holeSlotsRef.current;
    const defaultSlot = homeSlotRef.current;
    if (dragging && currentSlots && defaultSlot >= 0 && defaultSlot < currentSlots.length) {
      const next = currentSlots.slice();
      next[defaultSlot] = dragging.card;
      onReorder?.(next as CardValueSuit[]);
    }
    clearDragSession();
  }, [clearDragSession, onReorder]);

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const pending = pendingDragRef.current;
      if (pending && event.pointerId === pending.pointerId && !activeDragRef.current) {
        const dx = event.clientX - pending.startX;
        const dy = event.clientY - pending.startY;
        if ((dx * dx + dy * dy) < (DRAG_ACTIVATION_THRESHOLD_PX * DRAG_ACTIVATION_THRESHOLD_PX)) return;
        beginDragSession(pending.index, event.clientX, event.clientY);
      }
      if (activeDragRef.current) {
        updateActiveDragFromPointer(event.clientX, event.clientY);
      }
    };

    const onPointerUp = (event: PointerEvent) => {
      const pending = pendingDragRef.current;
      if (pending && event.pointerId === pending.pointerId && !activeDragRef.current) {
        pendingDragRef.current = null;
        unlockBodyTextSelection();
        return;
      }
      if (activeDragRef.current) {
        finalizeDrag();
        unlockBodyTextSelection();
      }
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      unlockBodyTextSelection();
    };
  }, [beginDragSession, finalizeDrag, updateActiveDragFromPointer, unlockBodyTextSelection]);

  const isWinner = winner === winnerType;

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
  const rows = Math.ceil(cards.length / cols);
  const dragAxis: 'x' | 'y' | true = rows === 1 ? 'x' : cols === 1 ? 'y' : true;
  dragAxisRef.current = dragAxis;
  const gapPx = 8;
  const gapAdjust = cols > 1 ? `${(cols - 1) * gapPx / cols}px` : '0px';
  const itemWidth = `calc(${100 / cols}% - ${gapAdjust})`;
  const groupStyle = { '--card-w': itemWidth, position: 'relative' } as React.CSSProperties;
  const visibleSlots = holeSlots ?? cards;

  return (
    <div
      ref={containerRef}
      className='w-full max-w-full mx-auto relative text-canvas-text'
      data-area={area}
    >
      <div className='relative'>
        {gameState === GAME_STATES.FINAL && isWinner && (
          <div
            className='absolute z-20 -top-5 bg-success-solid text-success-on-success px-4 py-2 rounded-full font-bold text-base shadow-lg'
            style={{
              left: '50%',
              transform: `translateX(calc(-50% + ${winnerIndicatorOffset}px))`,
            }}
          >
            Winner!
          </div>
        )}

        <div ref={groupRef} className='hand-reorder-group' style={groupStyle}>
          {visibleSlots.map((slotCard, idx) => {
            const slotCardId = slotCard?.cardId ?? idx;
            const isDragging = draggingCardId === slotCardId;
            return (
              <div
                key={`slot-${idx}`}
                className={`relative flex items-center justify-center ${isDragging ? 'z-50' : 'z-0'}`}
                ref={(el) => { itemRefs.current[idx] = el; }}
                onPointerDown={(event) => {
                  if (!dragEnabled) return;
                  if (slotCard == null) return;
                  if (activeDragRef.current) return;
                  lockBodyTextSelection();
                  pendingDragRef.current = {
                    pointerId: event.pointerId,
                    index: idx,
                    startX: event.clientX,
                    startY: event.clientY,
                  };
                }}
              >
                {slotCard ? (
                  <div
                    style={{
                      width: '100%',
                      transform: isDragging ? 'scale(1.05)' : 'scale(1)',
                      transition: isDragging ? 'none' : 'transform 0.2s ease',
                    }}
                  >
                    {renderCard(slotCard, idx)}
                  </div>
                ) : (
                  <div style={{ width: '100%' }}>
                    <div className='w-full aspect-[5/7]' />
                  </div>
                )}
              </div>
            );
          })}
          {activeDrag && (
            <div
              className='absolute z-50 pointer-events-none'
              style={{
                left: activeDrag.left,
                top: activeDrag.top,
                width: activeDrag.width,
                touchAction: 'none',
              }}
            >
              <div
                style={{
                  width: '100%',
                  transform: 'scale(1.05)',
                  transition: 'none',
                }}
              >
                {renderCard(activeDrag.card, activeDrag.originIndex)}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
export default HandDisplay;
