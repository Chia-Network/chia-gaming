import { MovingCardProps } from "../../../types/californiaPoker";
import { SUIT_COLORS } from "../constants/constants";
import CardContent from "./CardContent";

function MovingCard(props: MovingCardProps) {
  const { cardData, showAnimation } = props;
  const { card, startX, startY, endX, endY, width, height } = cardData;
  const colorHex = SUIT_COLORS[card.suit] || '#000000';

  const x = {
    width: `${width}px`,
    height: `${height}px`,
    left: startX,
    top: startY,
    color: colorHex,
    '--start-x': `${startX}px`,
    '--start-y': `${startY}px`,
    '--end-x': `${endX}px`,
    '--end-y': `${endY}px`,
  };
  return (
    <div
      className={`border-2 border-gray-300 rounded-lg bg-white shadow-lg flex flex-col items-center justify-center font-bold fixed pointer-events-none z-50 ${showAnimation ? 'animate-move' : ''}`}
      style={x}
    >
      <CardContent card={card} />
    </div>
  );
}

export default MovingCard;