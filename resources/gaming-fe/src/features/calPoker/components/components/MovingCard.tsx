import { MovingCardProps } from "../../../../types/californiaPoker";
import { SUIT_COLORS } from "../constants/constants";
import CardContent from "./CardContent";

function MovingCard(props: MovingCardProps) {
  const { cardData, showAnimation } = props;
  const { card, startX, startY, endX, endY, width, height } = cardData;
  const colorHex = SUIT_COLORS[card.suit] || '#000000';

  const styleVars = {
    width: `${width}px`,
    height: `${height}px`,
    left: startX,
    top: startY,
    color: colorHex,
    zIndex: cardData.zIndex,
    '--start-x': `${startX}px`,
    '--start-y': `${startY}px`,
    '--end-x': `${endX}px`,
    '--end-y': `${endY}px`,
  } as React.CSSProperties;

  return (
    <div
      className={`card-face border border-canvas-border rounded-lg bg-white shadow-lg flex flex-col items-center justify-center font-bold absolute pointer-events-none ${showAnimation ? 'animate-move' : ''}`}
      style={styleVars}
    >
      <CardContent card={card} />
    </div>
  );
}

export default MovingCard;
