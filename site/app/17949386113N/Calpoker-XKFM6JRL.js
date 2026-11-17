import {
  cardIdToRankSuit,
  formatCardsForLog,
  formatOrderedCardsForLog,
  orderUsedCardsForLog,
  projectCalpokerFinalDisplay,
  shouldRestoreCalpokerSelection
} from "./chunk-3D4PUFI5.js";
import {
  __toESM,
  require_jsx_runtime,
  require_react
} from "./chunk-ZODP5B7L.js";

// ../games/calpoker/ui/components/CaliforniaPoker.tsx
var import_react2 = __toESM(require_react());

// ../games/calpoker/ui/components/constants/constants.ts
var RANK_SYMBOLS = {
  14: "A",
  10: "T",
  11: "J",
  12: "Q",
  13: "K"
};
var SUIT_COLORS = {
  Q: "oklch(70% 0.3 90)",
  // Gold (90° hue, 70% lightness)
  "\u2660": "oklch(0% 0 0)",
  // Black (0% lightness, 0 chroma for true black)
  "\u2665": "oklch(60% 0.3 25)",
  // Red (25° hue, 60% lightness)
  "\u2666": "oklch(60% 0.3 265)",
  // Blue (265° hue, 60% lightness)
  "\u2663": "oklch(60% 0.3 155)"
  // Green (155° hue, 60% lightness)
};
var GAME_STATES = {
  INITIAL: "initial",
  SELECTING: "selecting",
  REVEALING_SWAP: "revealing_swap",
  SWAPPING: "swapping",
  AWAITING_SWAP: "awaiting_swap",
  FINAL: "final"
};
var HALO_FADE_DURATION_MS = 300;
var SWAP_MOVE_DURATION_MS = 2e3;
var PRE_SWAP_REVEAL_DURATION = HALO_FADE_DURATION_MS;
var SWAP_ANIMATION_DURATION = SWAP_MOVE_DURATION_MS;

// ../games/calpoker/ui/components/components/CardContent.tsx
var import_jsx_runtime = __toESM(require_jsx_runtime());
function CardContent(content) {
  const { card } = content;
  const rankDisplay = RANK_SYMBOLS[card.rank] ?? card.rank;
  const sym = { fontSize: "55cqw", lineHeight: 1 };
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: sym, children: rankDisplay }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { ...sym, marginTop: "5cqw" }, children: card.suit })
  ] });
}
var CardContent_default = CardContent;

// ../games/calpoker/ui/components/components/Card.tsx
var import_jsx_runtime2 = __toESM(require_jsx_runtime());
function Card(props) {
  const {
    id,
    card,
    onClick,
    isBeingSwapped = false,
    hideForSwap = false,
    cardId,
    isInBestHand = false,
    isFinal = false,
    hasHalo = false,
    showDragOutline = false,
    area
  } = props;
  const suitColor = SUIT_COLORS[card.suit] || "#000000";
  const isHidden = isBeingSwapped && hideForSwap;
  const dimmed = isFinal && !isInBestHand;
  const cursor = isBeingSwapped ? "cursor-default" : area === "ai" ? "cursor-not-allowed" : "cursor-pointer";
  const stateClass = isHidden ? "card-hidden" : dimmed ? "card-dimmed" : "";
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "w-full relative", children: [
    showDragOutline && !hasHalo && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "absolute -inset-2 rounded-xl z-0 bg-canvas-bg" }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
      "div",
      {
        className: "absolute -inset-2 rounded-xl z-0 transition-opacity ease-in-out",
        style: {
          backgroundColor: "#9E8A8E",
          opacity: hasHalo ? 1 : 0,
          transitionDuration: `${HALO_FADE_DURATION_MS}ms`
        }
      }
    ),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
      "div",
      {
        id,
        "data-card-id": cardId,
        className: `card-face ${stateClass} relative z-10 w-full aspect-[5/7] rounded-lg flex flex-col items-center justify-center font-bold ${cursor}`,
        style: { "--suit-color": suitColor },
        onClick,
        children: !isHidden && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(CardContent_default, { card })
      }
    )
  ] });
}
var Card_default = Card;

// ../games/calpoker/ui/components/components/MovingCard.tsx
var import_jsx_runtime3 = __toESM(require_jsx_runtime());
function MovingCard(props) {
  const { cardData, showAnimation } = props;
  const { card, startX, startY, endX, endY, width, height } = cardData;
  const suitColor = SUIT_COLORS[card.suit] || "#000000";
  const styleVars = {
    width: `${width}px`,
    height: `${height}px`,
    left: startX,
    top: startY,
    "--suit-color": suitColor,
    zIndex: cardData.zIndex,
    "--start-x": `${startX}px`,
    "--start-y": `${startY}px`,
    "--end-x": `${endX}px`,
    "--end-y": `${endY}px`,
    animationDuration: `${SWAP_MOVE_DURATION_MS}ms`
  };
  return /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
    "div",
    {
      className: `card-face rounded-lg shadow-lg flex flex-col items-center justify-center font-bold absolute pointer-events-none ${showAnimation ? "animate-move" : ""}`,
      style: styleVars,
      children: /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(CardContent_default, { card })
    }
  );
}
var MovingCard_default = MovingCard;

// ../games/calpoker/ui/components/components/HandDisplay.tsx
var import_react = __toESM(require_react());
var import_jsx_runtime4 = __toESM(require_jsx_runtime());
var DRAG_ACTIVATION_THRESHOLD_PX = 4;
var SWITCH_EPSILON_SQ = 20;
var SHIFT_ANIM_DURATION_MS = 460;
var DROP_ANIM_DURATION_MS = 460;
var SHIFT_ANIM_EASING = "cubic-bezier(0.22, 0.8, 0.22, 1)";
var DROP_ANIM_EASING = "cubic-bezier(0.22, 0.8, 0.22, 1)";
function sameCard(a, b) {
  if (a === b) return true;
  if (a.cardId != null && b.cardId != null) return a.cardId === b.cardId;
  return a.rank === b.rank && a.suit === b.suit;
}
function columnsForWidth(px, currentCols) {
  const margin = 20;
  const breakpoints = [
    { cols: 8, min: 580 },
    { cols: 4, min: 290 },
    { cols: 3, min: 220 },
    { cols: 2, min: 140 },
    { cols: 1, min: 0 }
  ];
  let target = 1;
  for (const bp of breakpoints) {
    if (px >= bp.min) {
      target = bp.cols;
      break;
    }
  }
  if (target === currentCols) return currentCols;
  if (target > currentCols) {
    const bp = breakpoints.find((b) => b.cols === target);
    if (bp && px < bp.min + margin) return currentCols;
  } else {
    const bp = breakpoints.find((b) => b.cols === currentCols);
    if (bp && px > bp.min - margin) return currentCols;
  }
  return target;
}
function HandDisplay(props) {
  const {
    cards,
    playerNumber,
    area,
    winner,
    winnerType,
    bestHand,
    onCardClick,
    showSwapAnimation,
    gameState,
    haloCardIds,
    swapHiddenCardIds = [],
    onReorder,
    timeoutBadge
  } = props;
  const [winnerIndicatorOffset, setWinnerIndicatorOffset] = (0, import_react.useState)(0);
  const [cardRightEdgeOffset, setCardRightEdgeOffset] = (0, import_react.useState)(null);
  const [draggingCardId, setDraggingCardId] = (0, import_react.useState)(null);
  const [holeSlots, setHoleSlots] = (0, import_react.useState)(null);
  const [activeDrag, setActiveDrag] = (0, import_react.useState)(null);
  const [shiftAnims, setShiftAnims] = (0, import_react.useState)([]);
  const [dropAnim, setDropAnim] = (0, import_react.useState)(null);
  const [cols, setCols] = (0, import_react.useState)(8);
  const colsRef = (0, import_react.useRef)(8);
  const cardsRef = (0, import_react.useRef)(cards);
  const containerRef = (0, import_react.useRef)(null);
  const groupRef = (0, import_react.useRef)(null);
  const itemRefs = (0, import_react.useRef)([]);
  const slotCentersRef = (0, import_react.useRef)([]);
  const holeSlotsRef = (0, import_react.useRef)(null);
  const homeSlotRef = (0, import_react.useRef)(-1);
  const grabOffsetRef = (0, import_react.useRef)(null);
  const pendingDragRef = (0, import_react.useRef)(null);
  const activeDragRef = (0, import_react.useRef)(null);
  const dragAxisRef = (0, import_react.useRef)(true);
  const bodyUserSelectBeforeDragRef = (0, import_react.useRef)(null);
  const shiftAnimKeyRef = (0, import_react.useRef)(0);
  const shiftAnimsRef = (0, import_react.useRef)([]);
  const shiftTimeoutsRef = (0, import_react.useRef)(/* @__PURE__ */ new Map());
  const shiftRafIdsRef = (0, import_react.useRef)([]);
  const dropAnimKeyRef = (0, import_react.useRef)(0);
  const dropStartRafRef = (0, import_react.useRef)(null);
  const dropTimeoutRef = (0, import_react.useRef)(null);
  const dropAnimRef = (0, import_react.useRef)(null);
  const isDraggingRef = (0, import_react.useRef)(false);
  const lockBodyTextSelection = (0, import_react.useCallback)(() => {
    if (typeof document === "undefined") return;
    if (bodyUserSelectBeforeDragRef.current !== null) return;
    bodyUserSelectBeforeDragRef.current = document.body.style.userSelect;
    document.body.style.userSelect = "none";
  }, []);
  const unlockBodyTextSelection = (0, import_react.useCallback)(() => {
    if (typeof document === "undefined") return;
    if (bodyUserSelectBeforeDragRef.current === null) return;
    document.body.style.userSelect = bodyUserSelectBeforeDragRef.current;
    bodyUserSelectBeforeDragRef.current = null;
  }, []);
  const measureSlotCenters = (0, import_react.useCallback)(() => {
    const centers = new Array(cardsRef.current.length).fill(null);
    for (let i = 0; i < centers.length; i++) {
      const el = itemRefs.current[i];
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      centers[i] = {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2
      };
    }
    slotCentersRef.current = centers;
  }, []);
  const nearestSlotIndex = (0, import_react.useCallback)(
    (centerX, centerY, excludeIndex) => {
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
    },
    []
  );
  (0, import_react.useEffect)(() => {
    cardsRef.current = cards;
  }, [cards]);
  (0, import_react.useEffect)(() => {
    holeSlotsRef.current = holeSlots;
  }, [holeSlots]);
  (0, import_react.useEffect)(() => {
    shiftAnimsRef.current = shiftAnims;
  }, [shiftAnims]);
  (0, import_react.useEffect)(() => {
    dropAnimRef.current = dropAnim;
  }, [dropAnim]);
  (0, import_react.useEffect)(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const w2 = entry.contentRect.width;
      const next = columnsForWidth(w2, colsRef.current);
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
  (0, import_react.useEffect)(() => {
    const raf = requestAnimationFrame(() => {
      measureSlotCenters();
    });
    return () => cancelAnimationFrame(raf);
  }, [cards.length, cols, measureSlotCenters, holeSlots]);
  (0, import_react.useEffect)(() => {
    const updateWinnerPosition = () => {
      if (containerRef.current) {
        const cardElements = containerRef.current.querySelectorAll(`[data-card-id^="${area}-"]`);
        if (cardElements.length > 0) {
          const containerRect = containerRef.current.getBoundingClientRect();
          const lastCardElement = cardElements[cardElements.length - 1];
          const lastCardRect = lastCardElement.getBoundingClientRect();
          const containerCenter = containerRect.left + containerRect.width / 2;
          const cardRightEdge = lastCardRect.right;
          const indicatorWidth = 80;
          const offset = cardRightEdge - containerCenter - indicatorWidth / 2;
          setWinnerIndicatorOffset(offset);
          setCardRightEdgeOffset(cardRightEdge - containerCenter);
        }
      }
      measureSlotCenters();
      setShiftAnims([]);
      setDropAnim(null);
    };
    const timer = setTimeout(updateWinnerPosition, 50);
    window.addEventListener("resize", updateWinnerPosition);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("resize", updateWinnerPosition);
    };
  }, [cards, area, measureSlotCenters]);
  (0, import_react.useEffect)(() => {
    itemRefs.current = itemRefs.current.slice(0, cards.length);
  }, [cards.length]);
  const removeShiftAnimation = (0, import_react.useCallback)((key) => {
    const timeoutId = shiftTimeoutsRef.current.get(key);
    if (timeoutId != null) {
      window.clearTimeout(timeoutId);
      shiftTimeoutsRef.current.delete(key);
    }
    setShiftAnims((prev) => prev.filter((anim) => anim.key !== key));
  }, []);
  const clearShiftAnimations = (0, import_react.useCallback)(() => {
    shiftRafIdsRef.current.forEach((id) => cancelAnimationFrame(id));
    shiftRafIdsRef.current = [];
    shiftTimeoutsRef.current.forEach((timeoutId) => window.clearTimeout(timeoutId));
    shiftTimeoutsRef.current.clear();
    setShiftAnims([]);
  }, []);
  const removeShiftAnimationsForCard = (0, import_react.useCallback)((card) => {
    const keysToRemove = shiftAnimsRef.current.filter((anim) => sameCard(anim.card, card)).map((anim) => anim.key);
    if (keysToRemove.length === 0) return;
    keysToRemove.forEach((key) => {
      const timeoutId = shiftTimeoutsRef.current.get(key);
      if (timeoutId != null) {
        window.clearTimeout(timeoutId);
        shiftTimeoutsRef.current.delete(key);
      }
    });
    setShiftAnims((prev) => prev.filter((anim) => !keysToRemove.includes(anim.key)));
  }, []);
  const clearDropAnimation = (0, import_react.useCallback)((key) => {
    if (dropStartRafRef.current != null) {
      cancelAnimationFrame(dropStartRafRef.current);
      dropStartRafRef.current = null;
    }
    if (dropTimeoutRef.current != null) {
      window.clearTimeout(dropTimeoutRef.current);
      dropTimeoutRef.current = null;
    }
    if (key == null || dropAnimRef.current && dropAnimRef.current.key === key) {
      dropAnimRef.current = null;
    }
    setDropAnim((prev) => {
      if (key == null) return null;
      if (!prev || prev.key !== key) return prev;
      return null;
    });
  }, []);
  const clearDragSession = (0, import_react.useCallback)(() => {
    clearShiftAnimations();
    clearDropAnimation();
    pendingDragRef.current = null;
    activeDragRef.current = null;
    homeSlotRef.current = -1;
    grabOffsetRef.current = null;
    holeSlotsRef.current = null;
    setActiveDrag(null);
    setHoleSlots(null);
    setDraggingCardId(null);
    unlockBodyTextSelection();
    setTimeout(() => {
      isDraggingRef.current = false;
    }, 0);
  }, [clearDropAnimation, clearShiftAnimations, unlockBodyTextSelection]);
  (0, import_react.useEffect)(() => {
    return () => {
      clearShiftAnimations();
      clearDropAnimation();
    };
  }, [clearDropAnimation, clearShiftAnimations]);
  (0, import_react.useEffect)(() => {
    const onResizeClearAnimations = () => {
      clearShiftAnimations();
      clearDropAnimation();
    };
    window.addEventListener("resize", onResizeClearAnimations);
    return () => window.removeEventListener("resize", onResizeClearAnimations);
  }, [clearDropAnimation, clearShiftAnimations]);
  const beginDragSession = (0, import_react.useCallback)(
    (index, pointerX, pointerY) => {
      const groupEl = groupRef.current;
      const itemEl = itemRefs.current[index];
      const cardsNow = cardsRef.current;
      if (!groupEl || !itemEl || !cardsNow[index]) return;
      measureSlotCenters();
      const groupRect = groupEl.getBoundingClientRect();
      const itemRect = itemEl.getBoundingClientRect();
      const card = cardsNow[index];
      const cardCenterX = itemRect.left + itemRect.width / 2;
      const cardCenterY = itemRect.top + itemRect.height / 2;
      const nextHoleSlots = cardsNow.map((c, i) => i === index ? null : c);
      const nextActiveDrag = {
        card,
        originIndex: index,
        width: itemRect.width,
        height: itemRect.height,
        left: itemRect.left - groupRect.left,
        top: itemRect.top - groupRect.top,
        lockLeft: itemRect.left - groupRect.left,
        lockTop: itemRect.top - groupRect.top
      };
      homeSlotRef.current = index;
      grabOffsetRef.current = {
        x: pointerX - cardCenterX,
        y: pointerY - cardCenterY
      };
      holeSlotsRef.current = nextHoleSlots;
      activeDragRef.current = nextActiveDrag;
      isDraggingRef.current = true;
      setDraggingCardId(card.cardId ?? String(index));
      setHoleSlots(nextHoleSlots);
      setActiveDrag(nextActiveDrag);
      pendingDragRef.current = null;
    },
    [measureSlotCenters]
  );
  const updateActiveDragFromPointer = (0, import_react.useCallback)(
    (pointerX, pointerY) => {
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
      if (dragAxisRef.current === "x") nextTop = dragging.lockTop;
      if (dragAxisRef.current === "y") nextLeft = dragging.lockLeft;
      nextLeft = Math.min(maxLeft, Math.max(0, nextLeft));
      nextTop = Math.min(maxTop, Math.max(0, nextTop));
      const nextDrag = {
        ...dragging,
        left: nextLeft,
        top: nextTop
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
      const movingCard = nextSlots[nearest];
      const oldDefaultSlot = defaultSlot;
      const fromEl = itemRefs.current[nearest];
      const fromRect = fromEl?.getBoundingClientRect();
      nextSlots[defaultSlot] = nextSlots[nearest];
      nextSlots[nearest] = null;
      homeSlotRef.current = nearest;
      holeSlotsRef.current = nextSlots;
      if (movingCard && fromRect) {
        const animKey = ++shiftAnimKeyRef.current;
        removeShiftAnimationsForCard(movingCard);
        const groupRect2 = groupRef.current?.getBoundingClientRect();
        const fromLeft = fromRect.left - (groupRect2?.left ?? 0);
        const fromTop = fromRect.top - (groupRect2?.top ?? 0);
        const prelimShift = {
          key: animKey,
          card: movingCard,
          fromLeft,
          fromTop,
          toLeft: fromLeft,
          toTop: fromTop,
          width: fromRect.width,
          height: fromRect.height,
          hideIndex: oldDefaultSlot,
          started: false
        };
        setHoleSlots(nextSlots);
        setShiftAnims((prev) => [...prev, prelimShift]);
        const measureRaf = requestAnimationFrame(() => {
          const latestGroup = groupRef.current;
          const toEl = itemRefs.current[oldDefaultSlot];
          if (!latestGroup || !toEl) return;
          const latestGroupRect = latestGroup.getBoundingClientRect();
          const toRect = toEl.getBoundingClientRect();
          const measuredToLeft = toRect.left - latestGroupRect.left;
          const measuredToTop = toRect.top - latestGroupRect.top;
          const startRaf = requestAnimationFrame(() => {
            setShiftAnims(
              (prev) => prev.map(
                (anim) => anim.key === animKey ? { ...anim, toLeft: measuredToLeft, toTop: measuredToTop, started: true } : anim
              )
            );
          });
          shiftRafIdsRef.current.push(startRaf);
          const timeoutId = window.setTimeout(() => {
            removeShiftAnimation(animKey);
          }, SHIFT_ANIM_DURATION_MS + 80);
          shiftTimeoutsRef.current.set(animKey, timeoutId);
        });
        shiftRafIdsRef.current.push(measureRaf);
      } else {
        setHoleSlots(nextSlots);
      }
      requestAnimationFrame(measureSlotCenters);
    },
    [measureSlotCenters, nearestSlotIndex, removeShiftAnimation, removeShiftAnimationsForCard]
  );
  const commitDropAnimation = (0, import_react.useCallback)(
    (dropKey) => {
      const currentDrop = dropAnimRef.current;
      if (!currentDrop || currentDrop.key !== dropKey) return;
      dropAnimRef.current = null;
      onReorder?.(currentDrop.finalOrder);
      clearDragSession();
    },
    [clearDragSession, onReorder]
  );
  const startDropAnimation = (0, import_react.useCallback)(() => {
    const dragging = activeDragRef.current;
    const currentSlots = holeSlotsRef.current;
    const defaultSlot = homeSlotRef.current;
    const groupEl = groupRef.current;
    const toEl = defaultSlot >= 0 ? itemRefs.current[defaultSlot] : null;
    if (dragging && currentSlots && defaultSlot >= 0 && defaultSlot < currentSlots.length && groupEl && toEl) {
      const finalOrder = currentSlots.slice();
      finalOrder[defaultSlot] = dragging.card;
      const groupRect = groupEl.getBoundingClientRect();
      const toRect = toEl.getBoundingClientRect();
      const dropKey = ++dropAnimKeyRef.current;
      clearDropAnimation();
      const nextDrop = {
        key: dropKey,
        card: dragging.card,
        originIndex: dragging.originIndex,
        fromLeft: dragging.left,
        fromTop: dragging.top,
        toLeft: toRect.left - groupRect.left,
        toTop: toRect.top - groupRect.top,
        width: dragging.width,
        height: dragging.height,
        finalOrder,
        started: false
      };
      activeDragRef.current = null;
      dropAnimRef.current = nextDrop;
      setActiveDrag(null);
      setDropAnim(nextDrop);
      dropStartRafRef.current = requestAnimationFrame(() => {
        setDropAnim((prev) => prev && prev.key === dropKey ? { ...prev, started: true } : prev);
      });
      dropTimeoutRef.current = window.setTimeout(() => {
        commitDropAnimation(dropKey);
      }, DROP_ANIM_DURATION_MS + 100);
      return;
    }
    clearDragSession();
  }, [clearDragSession, clearDropAnimation, commitDropAnimation]);
  (0, import_react.useEffect)(() => {
    const interactionLocked = () => !!dropAnimRef.current || shiftAnimsRef.current.length > 0;
    const onPointerMove = (event) => {
      const pending = pendingDragRef.current;
      if (pending && event.pointerId === pending.pointerId && !activeDragRef.current && !interactionLocked()) {
        const dx = event.clientX - pending.startX;
        const dy = event.clientY - pending.startY;
        if (dx * dx + dy * dy < DRAG_ACTIVATION_THRESHOLD_PX * DRAG_ACTIVATION_THRESHOLD_PX) return;
        beginDragSession(pending.index, event.clientX, event.clientY);
      }
      if (activeDragRef.current) {
        updateActiveDragFromPointer(event.clientX, event.clientY);
      }
    };
    const onPointerUp = (event) => {
      const pending = pendingDragRef.current;
      if (pending && event.pointerId === pending.pointerId && !activeDragRef.current) {
        pendingDragRef.current = null;
        unlockBodyTextSelection();
        return;
      }
      if (activeDragRef.current) {
        clearShiftAnimations();
        startDropAnimation();
      }
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      unlockBodyTextSelection();
    };
  }, [
    beginDragSession,
    clearShiftAnimations,
    startDropAnimation,
    updateActiveDragFromPointer,
    unlockBodyTextSelection
  ]);
  const isWinner = winner === winnerType;
  const handleCardClick = (cardId) => {
    if (isDraggingRef.current) return;
    onCardClick?.(cardId);
  };
  const renderCard = (card, idx, showDragOutline = false) => {
    const cardId = card.cardId ?? String(idx);
    const isPostRevealPhase = gameState === GAME_STATES.FINAL && !!bestHand?.cards?.length;
    const isInBestHand = isPostRevealPhase && bestHand?.cards?.some(
      (bestCard) => bestCard.cardId != null && bestCard.cardId === card.cardId
    );
    const hasHalo = haloCardIds.includes(card.cardId ?? "-1");
    const hideForSwap = swapHiddenCardIds.includes(card.cardId ?? "-1");
    return /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
      Card_default,
      {
        id: `card-${playerNumber}-${idx}`,
        card,
        cardId: `${area}-${cardId}`,
        onClick: () => handleCardClick(cardId),
        isBeingSwapped: showSwapAnimation,
        hideForSwap,
        isInBestHand,
        isFinal: isPostRevealPhase,
        hasHalo,
        showDragOutline: showDragOutline && !hasHalo,
        area
      }
    );
  };
  const EXPECTED_HAND_SIZE = 8;
  const dragEnabled = !!onReorder;
  const effectiveCount = cards.length || EXPECTED_HAND_SIZE;
  const rows = Math.ceil(effectiveCount / cols);
  const dragAxis = rows === 1 ? "x" : cols === 1 ? "y" : true;
  dragAxisRef.current = dragAxis;
  const gapPx = 8;
  const gapAdjust = cols > 1 ? `${(cols - 1) * gapPx / cols}px` : "0px";
  const itemWidth = `calc(${100 / cols}% - ${gapAdjust})`;
  const groupStyle = {
    "--card-w": itemWidth,
    position: "relative",
    opacity: cards.length > 0 ? 1 : 0,
    transition: `opacity ${HALO_FADE_DURATION_MS}ms ease-in-out`
  };
  const placeholderSlots = cards.length === 0 ? new Array(EXPECTED_HAND_SIZE).fill(null) : [];
  const visibleSlots = holeSlots ?? (cards.length > 0 ? cards : placeholderSlots);
  return /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
    "div",
    {
      ref: containerRef,
      className: "w-full max-w-full mx-auto relative text-canvas-text",
      "data-area": area,
      children: /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: "relative", children: [
        gameState === GAME_STATES.FINAL && isWinner && !timeoutBadge && /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
          "div",
          {
            className: "absolute z-[110] -top-5 bg-primary-solid text-primary-on-primary px-4 py-2 rounded-full font-bold text-base shadow-lg",
            style: {
              left: "50%",
              transform: `translateX(calc(-50% + ${winnerIndicatorOffset}px))`
            },
            children: "Winner!"
          }
        ),
        timeoutBadge === "winner" && /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
          "div",
          {
            className: "absolute z-[110] -top-5 bg-primary-solid text-primary-on-primary px-4 py-2 rounded-full font-bold text-base shadow-lg",
            style: {
              left: "50%",
              transform: `translateX(calc(-50% + ${winnerIndicatorOffset}px))`
            },
            children: "Winner!"
          }
        ),
        timeoutBadge === "timeout" && cardRightEdgeOffset !== null && /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
          "div",
          {
            className: "absolute z-[110] -top-5 bg-canvas-solid text-canvas-on-canvas px-4 py-2 rounded-full font-bold text-base shadow-lg",
            style: {
              // Align to the final card rather than the full-width hand
              // container. Wait for the measurement above so it never first
              // paints in the center before snapping into place.
              left: "50%",
              transform: `translateX(calc(-100% + ${cardRightEdgeOffset}px))`
            },
            children: "Timed Out"
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)(
          "div",
          {
            ref: groupRef,
            className: "hand-reorder-group",
            style: { ...groupStyle, pointerEvents: dropAnim ? "none" : "auto" },
            children: [
              visibleSlots.map((slotCard, idx) => {
                const slotCardId = slotCard?.cardId ?? String(idx);
                const isDragging = draggingCardId === slotCardId;
                const hideForShift = !!slotCard && shiftAnims.some(
                  (anim) => anim.hideIndex === idx && (slotCard === anim.card || slotCard.cardId != null && anim.card.cardId != null && slotCard.cardId === anim.card.cardId)
                );
                return /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
                  "div",
                  {
                    className: `relative flex items-center justify-center ${isDragging ? "z-50" : "z-0"}`,
                    ref: (el) => {
                      itemRefs.current[idx] = el;
                    },
                    onPointerDown: (event) => {
                      if (!dragEnabled) return;
                      if (slotCard == null) return;
                      if (activeDragRef.current) return;
                      if (shiftAnimsRef.current.length > 0) return;
                      if (dropAnimRef.current) return;
                      lockBodyTextSelection();
                      pendingDragRef.current = {
                        pointerId: event.pointerId,
                        index: idx,
                        startX: event.clientX,
                        startY: event.clientY
                      };
                    },
                    children: slotCard ? /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
                      "div",
                      {
                        style: {
                          width: "100%",
                          opacity: hideForShift ? 0 : 1,
                          transform: isDragging ? "scale(1.05)" : "scale(1)",
                          transition: isDragging ? "none" : "transform 0.2s ease, opacity 0s"
                        },
                        children: renderCard(slotCard, idx, false)
                      }
                    ) : /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("div", { style: { width: "100%" }, children: /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("div", { className: "w-full aspect-[5/7]" }) })
                  },
                  `slot-${idx}`
                );
              }),
              shiftAnims.map((anim) => /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
                "div",
                {
                  className: "absolute z-40 pointer-events-none",
                  style: {
                    left: anim.fromLeft,
                    top: anim.fromTop,
                    width: anim.width,
                    height: anim.height,
                    transform: anim.started ? `translate(${anim.toLeft - anim.fromLeft}px, ${anim.toTop - anim.fromTop}px)` : "translate(0px, 0px)",
                    transition: `transform ${SHIFT_ANIM_DURATION_MS}ms ${SHIFT_ANIM_EASING}`
                  },
                  onTransitionEnd: () => {
                    removeShiftAnimation(anim.key);
                  },
                  children: /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("div", { style: { width: "100%" }, children: renderCard(anim.card, anim.hideIndex, false) })
                },
                anim.key
              )),
              dropAnim && /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
                "div",
                {
                  className: "absolute z-50 pointer-events-none",
                  style: {
                    left: dropAnim.fromLeft,
                    top: dropAnim.fromTop,
                    width: dropAnim.width,
                    height: dropAnim.height,
                    transform: dropAnim.started ? `translate(${dropAnim.toLeft - dropAnim.fromLeft}px, ${dropAnim.toTop - dropAnim.fromTop}px)` : "translate(0px, 0px)",
                    transition: `transform ${DROP_ANIM_DURATION_MS}ms ${DROP_ANIM_EASING}`,
                    touchAction: "none"
                  },
                  onTransitionEnd: () => {
                    commitDropAnimation(dropAnim.key);
                  },
                  children: /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
                    "div",
                    {
                      style: {
                        width: "100%",
                        transform: "scale(1)",
                        transition: "none"
                      },
                      children: renderCard(dropAnim.card, dropAnim.originIndex, true)
                    }
                  )
                }
              ),
              activeDrag && /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
                "div",
                {
                  className: "absolute z-50 pointer-events-none",
                  style: {
                    left: activeDrag.left,
                    top: activeDrag.top,
                    width: activeDrag.width,
                    touchAction: "none"
                  },
                  children: /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
                    "div",
                    {
                      style: {
                        width: "100%",
                        transform: "scale(1.05)",
                        transition: "none"
                      },
                      children: renderCard(activeDrag.card, activeDrag.originIndex, true)
                    }
                  )
                }
              )
            ]
          }
        )
      ] })
    }
  );
}
var HandDisplay_default = HandDisplay;

// ../games/calpoker/ui/components/components/GameBottomBar.tsx
var import_jsx_runtime5 = __toESM(require_jsx_runtime());
var GameBottomBar = ({ buttonText, isDisabled, doHandleMakeMove }) => {
  return /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(
    "button",
    {
      type: "button",
      onClick: doHandleMakeMove,
      disabled: isDisabled,
      className: "w-auto px-4 py-2 items-center justify-center rounded-lg font-bold transition-all duration-300 ease-out disabled:opacity-50 hover:cursor-pointer disabled:cursor-not-allowed leading-none bg-primary-solid text-primary-on-primary",
      children: buttonText
    }
  );
};
var GameBottomBar_default = GameBottomBar;

// ../games/calpoker/ui/settlement.ts
function isForfeitOutcome(outcome) {
  return outcome === "forfeited_skipped_reveal" || outcome === "forfeited_we_accepted";
}
function settlementByUs(outcome) {
  switch (outcome) {
    case "accept_settlement":
    case "we_accepted":
    case "forfeited_skipped_reveal":
    case "forfeited_we_accepted":
    case "lost":
    case "timed_out_waiting_for_our_move":
    case "attempt_to_move_failed":
    case "slashed_opponent":
      return true;
    case "opponent_timed_out":
    case "opponent_slashed_us":
    case "opponent_cheated":
      return false;
    case "settled_cleanly":
      return null;
  }
}
function calpokerTimeoutBadge(outcome, side, handCompleted = false) {
  if (handCompleted && !isForfeitOutcome(outcome)) {
    return null;
  }
  if (outcome === "accept_settlement" || outcome === "we_accepted" || outcome === "settled_cleanly" || outcome === "lost") {
    return null;
  }
  const byUs = settlementByUs(outcome);
  if (byUs == null) return null;
  if (side === "ours") {
    if (byUs) return isForfeitOutcome(outcome) ? null : "timeout";
    return "winner";
  }
  if (!byUs) return isForfeitOutcome(outcome) ? null : "timeout";
  return "winner";
}
function calpokerSettlementVerb(outcome) {
  if (isForfeitOutcome(outcome)) return "loses";
  if (outcome === "lost") return "loses";
  if (outcome === "attempt_to_move_failed") return "moved too late";
  if (outcome === "accept_settlement" || outcome === "we_accepted" || outcome === "settled_cleanly") {
    return "settled";
  }
  if (outcome === "slashed_opponent") return "slashed opponent";
  if (outcome === "opponent_slashed_us") return "was slashed";
  if (outcome === "opponent_cheated") return "cheated";
  return "timed out";
}

// ../games/calpoker/ui/components/CaliforniaPoker.tsx
var import_jsx_runtime6 = __toESM(require_jsx_runtime());
var SUIT_MAP = {
  0: "Q",
  1: "\u2660",
  2: "\u2665",
  3: "\u2666",
  4: "\u2663"
};
function cvsFromCard(cardId) {
  const { rank, suit } = cardIdToRankSuit(BigInt(cardId));
  return { rank, suit: SUIT_MAP[suit], cardId };
}
var cardsToBigints = (cardIds) => cardIds.map((cardId) => BigInt(cardId));
var CaliforniaPoker = ({
  moveNumber,
  playerNumber,
  playerHand,
  opponentHand,
  cardSelections,
  setCardSelections,
  setHandOrder,
  handleMakeMove,
  outcome,
  onGameLog,
  onSnapshotChange,
  initialSnapshot,
  myName,
  opponentName,
  terminalOutcome,
  frozen = false,
  error
}) => {
  const interactive = !frozen;
  const settlementByUsFlag = terminalOutcome == null ? null : settlementByUs(terminalOutcome);
  const settlementVerb = terminalOutcome ? calpokerSettlementVerb(terminalOutcome) : "timed out";
  const [gameState, setGameState] = (0, import_react2.useState)(GAME_STATES.INITIAL);
  const wrapperRef = (0, import_react2.useRef)(null);
  const [playerCards, setPlayerCards] = (0, import_react2.useState)([]);
  const [opponentCards, setOpponentCards] = (0, import_react2.useState)([]);
  const [rememberedOutcome, setRememberedOutcome] = (0, import_react2.useState)(
    void 0
  );
  const handCompleted = !!(outcome || rememberedOutcome);
  const rememberedCardsRef = (0, import_react2.useRef)([[], []]);
  const [playerDisplayText, setPlayerDisplayText] = (0, import_react2.useState)("");
  const [opponentDisplayText, setOpponentDisplayText] = (0, import_react2.useState)("");
  (0, import_react2.useEffect)(() => {
    if (outcome) {
      setRememberedOutcome(outcome);
    }
    const inAnimation = !!outcome || !!rememberedOutcome || gameState === GAME_STATES.AWAITING_SWAP || gameState === GAME_STATES.REVEALING_SWAP || gameState === GAME_STATES.SWAPPING || gameState === GAME_STATES.FINAL;
    if (!inAnimation) {
      const mappedPlayer = playerHand.map(cvsFromCard);
      const mappedOpponent = opponentHand.map(cvsFromCard);
      setPlayerCards(mappedPlayer);
      setOpponentCards(mappedOpponent);
      if (mappedPlayer.length && mappedOpponent.length) {
        rememberedCardsRef.current = [mappedPlayer, mappedOpponent];
      }
    }
  }, [playerHand, opponentHand, outcome, rememberedOutcome, gameState]);
  const [winner, setWinner] = (0, import_react2.useState)(null);
  const [playerBestHand, setPlayerBestHand] = (0, import_react2.useState)();
  const [aiBestHand, setAiBestHand] = (0, import_react2.useState)();
  const [showSwapAnimation, setShowSwapAnimation] = (0, import_react2.useState)(false);
  const [movingCards, setMovingCards] = (0, import_react2.useState)([]);
  const [playerHaloCardIds, setPlayerHaloCardIds] = (0, import_react2.useState)([]);
  const [opponentHaloCardIds, setOpponentHaloCardIds] = (0, import_react2.useState)([]);
  const [playerSwapHiddenIds, setPlayerSwapHiddenIds] = (0, import_react2.useState)([]);
  const [opponentSwapHiddenIds, setOpponentSwapHiddenIds] = (0, import_react2.useState)([]);
  const saveSnapshot = (0, import_react2.useCallback)(
    (gs, w, pBest, oBest, pHalo, oHalo, pText, oText) => {
      if (!interactive) return;
      const snap = {
        gameState: gs,
        winner: w,
        playerBestHandCardIds: pBest?.cards.map((c) => c.cardId) ?? [],
        opponentBestHandCardIds: oBest?.cards.map((c) => c.cardId) ?? [],
        playerHaloCardIds: pHalo,
        opponentHaloCardIds: oHalo,
        playerDisplayText: pText,
        opponentDisplayText: oText
      };
      onSnapshotChange(snap);
    },
    [interactive, onSnapshotChange]
  );
  const dealCards = (0, import_react2.useCallback)(() => {
    if (!interactive) return;
    setGameState(GAME_STATES.SELECTING);
    setCardSelections([]);
    setWinner(null);
    saveSnapshot(GAME_STATES.SELECTING, null, void 0, void 0, [], [], "", "");
  }, [interactive, saveSnapshot, setCardSelections]);
  const toggleCardSelection = (cardId) => {
    if (!interactive || gameState !== GAME_STATES.SELECTING) return;
    setCardSelections((prev) => {
      if (prev.includes(cardId)) {
        return prev.filter((id) => id !== cardId);
      }
      return [...prev, cardId];
    });
  };
  const handleReorder = (0, import_react2.useCallback)(
    (reordered) => {
      if (!interactive) return;
      setPlayerCards(reordered);
      rememberedCardsRef.current = [reordered, rememberedCardsRef.current[1]];
      setHandOrder(reordered.map((c) => c.cardId));
      const snapshotPlayerHalos = gameState === GAME_STATES.SELECTING ? cardSelections : playerHaloCardIds;
      const snap = {
        gameState,
        winner,
        playerBestHandCardIds: playerBestHand?.cards.map((c) => c.cardId) ?? [],
        opponentBestHandCardIds: aiBestHand?.cards.map((c) => c.cardId) ?? [],
        playerHaloCardIds: snapshotPlayerHalos,
        opponentHaloCardIds,
        playerDisplayText,
        opponentDisplayText
      };
      onSnapshotChange(snap);
    },
    [
      aiBestHand,
      cardSelections,
      gameState,
      interactive,
      onSnapshotChange,
      opponentDisplayText,
      opponentHaloCardIds,
      playerBestHand,
      playerDisplayText,
      playerHaloCardIds,
      setHandOrder,
      winner
    ]
  );
  const playerCardsRef = (0, import_react2.useRef)(playerCards);
  playerCardsRef.current = playerCards;
  (0, import_react2.useEffect)(() => {
    if (!interactive) return;
    const handleKeyDown = (e) => {
      if (gameState !== GAME_STATES.SELECTING) return;
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key >= "1" && e.key <= "8") {
        const index = parseInt(e.key) - 1;
        const cards = playerCardsRef.current;
        if (index < cards.length && cards[index].cardId !== void 0) {
          setCardSelections((prev) => {
            const cardId = cards[index].cardId;
            if (prev.includes(cardId)) {
              return prev.filter((id) => id !== cardId);
            }
            return [...prev, cardId];
          });
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [gameState, interactive, setCardSelections]);
  const isDisabled = !interactive || cardSelections.length !== 4;
  const playerHalos = gameState === GAME_STATES.SELECTING ? cardSelections : playerHaloCardIds;
  const opponentHalos = opponentHaloCardIds;
  const buttonText = cardSelections.length === 4 ? "Play Selected Cards" : `Select 4 cards (${cardSelections.length}/4)`;
  const opponentLabel = opponentName ?? "Opponent";
  const myLabel = myName ?? "You";
  const showFinalHeader = gameState === GAME_STATES.FINAL && !!winner && !showSwapAnimation;
  const opponentResultVerb = winner === "tie" ? "ties" : winner === "ai" ? "wins" : "loses";
  const playerResultVerb = winner === "tie" ? "ties" : winner === "player" ? "wins" : "loses";
  const resultLabel = (label, verb) => {
    if (label === "You") {
      return `You ${verb === "wins" ? "win" : verb === "loses" ? "lose" : "tie"}`;
    }
    return `${label} ${verb}`;
  };
  const possessive = (label) => label === "You" ? "Your" : `${label}'s`;
  const doHandleMakeMove = () => {
    if (!interactive) return;
    if (gameState === GAME_STATES.SELECTING && cardSelections.length > 0) {
      const halos = [...cardSelections];
      setPlayerHaloCardIds(halos);
      setGameState(GAME_STATES.AWAITING_SWAP);
      saveSnapshot(GAME_STATES.AWAITING_SWAP, null, void 0, void 0, halos, [], "", "");
    }
    handleMakeMove();
  };
  const calculateMovingCards = (0, import_react2.useCallback)(
    (playerSwapCardIds, aiSwapCardIds, playerCards2, opponentCards2) => {
      const movingCardData = [];
      const usedPlayerCards = /* @__PURE__ */ new Set();
      const usedAiCards = /* @__PURE__ */ new Set();
      const wrapperRect = wrapperRef.current?.getBoundingClientRect();
      const offsetX = wrapperRect?.left ?? 0;
      const offsetY = wrapperRect?.top ?? 0;
      const myPrefix = "player";
      const oppPrefix = "ai";
      const sortByDomX = (ids, prefix) => [...ids].sort((a, b) => {
        const elA = document.querySelector(`[data-card-id="${prefix}-${a}"]`);
        const elB = document.querySelector(`[data-card-id="${prefix}-${b}"]`);
        if (!elA || !elB) return 0;
        return elA.getBoundingClientRect().left - elB.getBoundingClientRect().left;
      });
      const sortedPlayerSwaps = sortByDomX(playerSwapCardIds, myPrefix);
      const sortedAiSwaps = sortByDomX(aiSwapCardIds, oppPrefix);
      sortedPlayerSwaps.forEach((swapCardId, i) => {
        const aiCardId = sortedAiSwaps[i];
        if (aiCardId === void 0) {
          return;
        }
        usedPlayerCards.add(swapCardId);
        const mySource = document.querySelector(`[data-card-id="${myPrefix}-${swapCardId}"]`);
        const oppTarget = document.querySelector(`[data-card-id="${oppPrefix}-${aiCardId}"]`);
        if (mySource && oppTarget) {
          const myRect = mySource.getBoundingClientRect();
          const oppRect = oppTarget.getBoundingClientRect();
          const card = playerCards2.find((c) => c.cardId === swapCardId);
          if (!card) {
            return;
          }
          movingCardData.push({
            id: `${myPrefix}-to-${oppPrefix}-${swapCardId}`,
            card,
            startX: myRect.left - offsetX,
            startY: myRect.top - offsetY,
            endX: oppRect.left - offsetX,
            endY: oppRect.top - offsetY,
            width: myRect.width,
            height: myRect.height,
            direction: "playerToAi",
            zIndex: 0
          });
        }
      });
      sortedAiSwaps.forEach((swapCardId, i) => {
        const playerCardId = sortedPlayerSwaps[i];
        if (playerCardId === void 0) {
          return;
        }
        usedAiCards.add(swapCardId);
        const oppSource = document.querySelector(`[data-card-id="${oppPrefix}-${swapCardId}"]`);
        const myTarget = document.querySelector(`[data-card-id="${myPrefix}-${playerCardId}"]`);
        if (oppSource && myTarget) {
          const oppRect = oppSource.getBoundingClientRect();
          const myRect = myTarget.getBoundingClientRect();
          const card = opponentCards2.find((c) => c.cardId === swapCardId);
          if (!card) {
            return;
          }
          movingCardData.push({
            id: `${oppPrefix}-to-${myPrefix}-${swapCardId}`,
            card,
            startX: oppRect.left - offsetX,
            startY: oppRect.top - offsetY,
            endX: myRect.left - offsetX,
            endY: myRect.top - offsetY,
            width: oppRect.width,
            height: oppRect.height,
            direction: "aiToPlayer",
            zIndex: 0
          });
        }
      });
      const selfCardAnimate = (myPrefix2, usedCards, card) => {
        if (card.cardId === void 0) {
          return;
        }
        if (usedCards.has(card.cardId)) {
          return;
        }
        const source = document.querySelector(`[data-card-id="${myPrefix2}-${card.cardId}"]`);
        if (source) {
          const myRect = source.getBoundingClientRect();
          movingCardData.push({
            id: `${myPrefix2}-to-${myPrefix2}-${card.cardId}`,
            card,
            startX: myRect.left - offsetX,
            startY: myRect.top - offsetY,
            endX: myRect.left - offsetX,
            endY: myRect.top - offsetY,
            width: myRect.width,
            height: myRect.height,
            direction: "self",
            zIndex: 0
          });
        }
      };
      playerCards2.forEach((card) => selfCardAnimate(myPrefix, usedPlayerCards, card));
      opponentCards2.forEach((card) => selfCardAnimate(oppPrefix, usedAiCards, card));
      const playerSwaps = movingCardData.filter((c) => c.direction === "playerToAi").sort((a, b) => b.startX - a.startX);
      const aiSwaps = movingCardData.filter((c) => c.direction === "aiToPlayer").sort((a, b) => b.startX - a.startX);
      let z = 100;
      for (const c of playerSwaps) {
        c.zIndex = z--;
      }
      for (const c of aiSwaps) {
        c.zIndex = z--;
      }
      for (const c of movingCardData) {
        if (c.direction === "self") c.zIndex = 50;
      }
      return movingCardData;
    },
    []
  );
  const swapCards = (0, import_react2.useCallback)(
    (rememberedOutcome2) => {
      const finalDisplay = projectCalpokerFinalDisplay(rememberedOutcome2);
      const liveWinner = finalDisplay.winner;
      setWinner(liveWinner);
      setGameState(GAME_STATES.REVEALING_SWAP);
      const playerOriginal = rememberedOutcome2.my_cards;
      const opponentOriginal = rememberedOutcome2.their_cards;
      const playerDiscardIds = finalDisplay.playerDiscardIds;
      const opponentDiscardIds = finalDisplay.opponentDiscardIds;
      const playerKeptIds = playerOriginal.filter((id) => !playerDiscardIds.includes(id));
      const opponentKeptIds = opponentOriginal.filter((id) => !opponentDiscardIds.includes(id));
      const resultWord = rememberedOutcome2.my_win_outcome === "win" ? "Win" : rememberedOutcome2.my_win_outcome === "lose" ? "Lose" : "Tie";
      const myOrdered = orderUsedCardsForLog(
        cardsToBigints(rememberedOutcome2.my_used_cards),
        cardsToBigints(rememberedOutcome2.my_hand_value)
      ).map(String);
      const theirOrdered = orderUsedCardsForLog(
        cardsToBigints(rememberedOutcome2.their_used_cards),
        cardsToBigints(rememberedOutcome2.their_hand_value)
      ).map(String);
      onGameLog([
        `${formatCardsForLog(cardsToBigints(playerKeptIds))} give ${formatCardsForLog(cardsToBigints(playerDiscardIds))}`,
        `${formatCardsForLog(cardsToBigints(opponentKeptIds))} give ${formatCardsForLog(cardsToBigints(opponentDiscardIds))}`,
        `${resultWord} ${formatOrderedCardsForLog(cardsToBigints(myOrdered))} vs ${formatOrderedCardsForLog(cardsToBigints(theirOrdered))}`
      ]);
      setPlayerHaloCardIds(playerDiscardIds);
      setOpponentHaloCardIds(opponentDiscardIds);
      setPlayerSwapHiddenIds(playerDiscardIds);
      setOpponentSwapHiddenIds(opponentDiscardIds);
      const myUsedCards = rememberedOutcome2.my_used_cards;
      const oppUsedCards = rememberedOutcome2.their_used_cards;
      const playerBestCards = myUsedCards.map(cvsFromCard);
      const opponentBestCards = oppUsedCards.map(cvsFromCard);
      const pBest = {
        cards: playerBestCards,
        rank: { name: "", score: 0, tiebreakers: [] }
      };
      const oBest = {
        cards: opponentBestCards,
        rank: { name: "", score: 0, tiebreakers: [] }
      };
      const playerSwapCardIds = playerDiscardIds;
      const aiSwapCardIds = opponentDiscardIds;
      setTimeout(() => {
        setGameState(GAME_STATES.SWAPPING);
        const remembered = rememberedCardsRef.current;
        const movingCardData = calculateMovingCards(
          playerSwapCardIds,
          aiSwapCardIds,
          remembered[0],
          remembered[1]
        );
        setMovingCards(movingCardData);
        setShowSwapAnimation(true);
        setTimeout(() => {
          const newPlayer = finalDisplay.playerCards.map(cvsFromCard);
          const newOpponent = finalDisplay.opponentCards.map(cvsFromCard);
          setPlayerCards(newPlayer);
          setOpponentCards(newOpponent);
          rememberedCardsRef.current = [newPlayer, newOpponent];
          setPlayerHaloCardIds(aiSwapCardIds);
          setOpponentHaloCardIds(playerSwapCardIds);
          setPlayerSwapHiddenIds([]);
          setOpponentSwapHiddenIds([]);
          setPlayerBestHand(pBest);
          setAiBestHand(oBest);
          setMovingCards([]);
          setShowSwapAnimation(false);
          setGameState(GAME_STATES.FINAL);
          const pText = finalDisplay.playerDisplayText;
          const oText = finalDisplay.opponentDisplayText;
          setPlayerDisplayText(pText);
          setOpponentDisplayText(oText);
        }, SWAP_ANIMATION_DURATION);
      }, PRE_SWAP_REVEAL_DURATION);
    },
    [calculateMovingCards, onGameLog]
  );
  (0, import_react2.useEffect)(() => {
    const haveOutcome = outcome ? outcome : rememberedOutcome;
    const animationAlreadyStarted = gameState === GAME_STATES.REVEALING_SWAP || gameState === GAME_STATES.SWAPPING || gameState === GAME_STATES.FINAL;
    const hasAnimationSources = rememberedCardsRef.current[0].length > 0 && rememberedCardsRef.current[1].length > 0;
    if (haveOutcome && !animationAlreadyStarted && hasAnimationSources) {
      swapCards(haveOutcome);
    }
  }, [outcome, gameState, rememberedOutcome, swapCards]);
  const initialSetupRef = (0, import_react2.useRef)({
    initialSnapshot,
    moveNumber,
    outcome,
    terminalOutcome,
    dealCards,
    interactive
  });
  (0, import_react2.useEffect)(() => {
    const initial = initialSetupRef.current;
    if (initial.initialSnapshot) {
      const snap = initial.initialSnapshot;
      const restoredGameState = shouldRestoreCalpokerSelection(
        initial.moveNumber,
        !!initial.outcome,
        initial.terminalOutcome != null
      ) ? GAME_STATES.SELECTING : snap.gameState;
      setGameState(restoredGameState);
      setWinner(snap.winner);
      setPlayerHaloCardIds(snap.playerHaloCardIds);
      setOpponentHaloCardIds(snap.opponentHaloCardIds);
      setPlayerDisplayText(snap.playerDisplayText);
      setOpponentDisplayText(snap.opponentDisplayText);
      if (snap.playerBestHandCardIds.length > 0) {
        setPlayerBestHand({
          cards: snap.playerBestHandCardIds.map(cvsFromCard),
          rank: { name: "", score: 0, tiebreakers: [] }
        });
      }
      if (snap.opponentBestHandCardIds.length > 0) {
        setAiBestHand({
          cards: snap.opponentBestHandCardIds.map(cvsFromCard),
          rank: { name: "", score: 0, tiebreakers: [] }
        });
      }
    } else if (initial.interactive) {
      initial.dealCards();
    }
  }, []);
  (0, import_react2.useEffect)(() => {
    if (moveNumber === "0" && !showSwapAnimation && gameState !== GAME_STATES.AWAITING_SWAP && gameState !== GAME_STATES.REVEALING_SWAP && gameState !== GAME_STATES.SWAPPING && gameState !== GAME_STATES.FINAL) {
      setGameState(GAME_STATES.SELECTING);
      rememberedCardsRef.current = [[], []];
      setRememberedOutcome(void 0);
      setWinner(null);
      setMovingCards([]);
      setPlayerBestHand(void 0);
      setAiBestHand(void 0);
      setShowSwapAnimation(false);
      setPlayerDisplayText("");
      setOpponentDisplayText("");
      setPlayerHaloCardIds([]);
      setOpponentHaloCardIds([]);
      setPlayerSwapHiddenIds([]);
      setOpponentSwapHiddenIds([]);
    }
  }, [moveNumber, showSwapAnimation, gameState]);
  return /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)(
    "div",
    {
      ref: wrapperRef,
      "data-calpoker-game-state": gameState,
      "data-calpoker-interaction-mode": frozen ? "terminal" : "live",
      className: "relative flex flex-col w-full text-canvas-text",
      children: [
        error && /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("p", { role: "alert", className: "px-3 py-2 text-center text-sm font-semibold text-red-600", children: error.message }),
        /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("div", { className: "flex flex-col gap-2", children: [
          /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("div", { className: "flex flex-col gap-2", children: [
            /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("div", { className: "flex flex-col py-0 w-full rounded-md", children: [
              /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("div", { className: "w-full h-8 flex items-center justify-center text-base font-semibold text-canvas-text", children: /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("span", { className: "truncate max-w-full", children: showFinalHeader && opponentDisplayText ? `${resultLabel(opponentLabel, opponentResultVerb)} (${opponentDisplayText})` : settlementByUsFlag === true ? resultLabel(opponentLabel, "wins") : settlementByUsFlag === false ? `${opponentLabel} ${settlementVerb}` : `${possessive(opponentLabel)} Hand` }) }),
              /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("div", { className: "flex items-center justify-center p-2", children: /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(
                HandDisplay_default,
                {
                  cards: opponentCards.length ? opponentCards : rememberedCardsRef.current[1],
                  playerNumber: playerNumber == 1 ? 2 : 1,
                  area: "ai",
                  winner,
                  winnerType: "ai",
                  bestHand: aiBestHand,
                  showSwapAnimation,
                  gameState,
                  haloCardIds: opponentHalos,
                  swapHiddenCardIds: opponentSwapHiddenIds,
                  timeoutBadge: terminalOutcome ? calpokerTimeoutBadge(terminalOutcome, "theirs", handCompleted) : null
                }
              ) })
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("div", { className: "flex flex-col py-0 w-full rounded-md", children: [
              /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("div", { className: "w-full h-8 flex items-center justify-center text-base font-semibold text-canvas-text", children: /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("span", { className: "truncate max-w-full", children: showFinalHeader && playerDisplayText ? `${resultLabel(myLabel, playerResultVerb)} (${playerDisplayText})` : settlementByUsFlag === true ? `${myLabel} ${settlementVerb}` : settlementByUsFlag === false ? resultLabel(myLabel, "wins") : `${possessive(myLabel)} Hand` }) }),
              /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("div", { className: "flex items-center justify-center p-2", children: /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(
                HandDisplay_default,
                {
                  cards: playerCards.length ? playerCards : rememberedCardsRef.current[0],
                  playerNumber,
                  area: "player",
                  winner,
                  winnerType: "player",
                  bestHand: playerBestHand,
                  onCardClick: interactive ? toggleCardSelection : void 0,
                  showSwapAnimation,
                  gameState,
                  haloCardIds: playerHalos,
                  swapHiddenCardIds: playerSwapHiddenIds,
                  onReorder: interactive && gameState === GAME_STATES.SELECTING ? handleReorder : void 0,
                  timeoutBadge: terminalOutcome ? calpokerTimeoutBadge(terminalOutcome, "ours", handCompleted) : null
                }
              ) })
            ] })
          ] }),
          (gameState === GAME_STATES.SELECTING || gameState === GAME_STATES.AWAITING_SWAP) && !outcome && terminalOutcome == null && /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)("div", { className: "flex-shrink-0 w-full h-12 relative flex items-center justify-center", children: [
            gameState === GAME_STATES.SELECTING && moveNumber === "1" && /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(
              GameBottomBar_default,
              {
                buttonText,
                isDisabled,
                doHandleMakeMove
              }
            ),
            gameState === GAME_STATES.AWAITING_SWAP && settlementByUsFlag == null && /* @__PURE__ */ (0, import_jsx_runtime6.jsx)("div", { className: "rounded-md bg-canvas-bg px-4 py-2 text-sm font-medium text-canvas-text shadow-md", children: "Waiting for opponent" })
          ] })
        ] }),
        movingCards.map((cardData) => /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(MovingCard_default, { cardData, showAnimation: showSwapAnimation }, cardData.id))
      ]
    }
  );
};
var CaliforniaPoker_default = CaliforniaPoker;

// ../games/calpoker/ui/Calpoker.tsx
var import_jsx_runtime7 = __toESM(require_jsx_runtime());
var Calpoker = ({
  outcome,
  moveNumber,
  playerNumber,
  playerHand,
  opponentHand,
  cardSelections,
  setCardSelections,
  setHandOrder,
  handleMakeMove,
  onGameLog,
  onSnapshotChange,
  initialSnapshot,
  myName,
  opponentName,
  terminalOutcome,
  frozen = false,
  error
}) => {
  return /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("div", { className: "relative flex h-full w-full min-h-0 flex-col", children: /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("div", { className: "flex-1 min-h-0 flex flex-col", children: /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(
    CaliforniaPoker_default,
    {
      playerNumber,
      moveNumber,
      playerHand,
      opponentHand,
      cardSelections,
      setCardSelections,
      setHandOrder,
      handleMakeMove,
      outcome,
      onGameLog,
      onSnapshotChange,
      initialSnapshot,
      myName,
      opponentName,
      terminalOutcome,
      frozen,
      error
    }
  ) }) });
};
var Calpoker_default = Calpoker;
export {
  Calpoker_default as default
};
