import { MovingCardProps } from "../../../../types/californiaPoker";
import { SUIT_COLORS, SWAP_MOVE_DURATION_MS } from "../constants/constants";
import CardContent from "./CardContent";

function MovingCard(props: MovingCardProps) {
  const { cardData, showAnimation } = props;
  const { card, startX, startY, endX, endY, width, height } = cardData;
  const suitColor = SUIT_COLORS[card.suit] || '#000000';

  const styleVars = {
    width: `${width}px`,
    height: `${height}px`,
    left: startX,
    top: startY,
    '--suit-color': suitColor,
    zIndex: cardData.zIndex,
    '--start-x': `${startX}px`,
    '--start-y': `${startY}px`,
    '--end-x': `${endX}px`,
    '--end-y': `${endY}px`,
    animationDuration: `${SWAP_MOVE_DURATION_MS}ms`,
  } as React.CSSProperties;

  return (
    <div
      className={`card-face rounded-lg shadow-lg flex flex-col items-center justify-center font-bold absolute pointer-events-none ${showAnimation ? 'animate-move' : ''}`}
      style={styleVars}
    >
      <CardContent card={card} />
    </div>
  );
}

export default MovingCard;
