import { CardRenderProps } from '../../../../types/californiaPoker';
import { SUIT_COLORS } from '../constants/constants';
import CardContent from './CardContent';

function Card(props: CardRenderProps) {
  const {
    id,
    card,
    index,
    isSelected,
    onClick,
    isBeingSwapped = false,
    cardId,
    isInBestHand = false,
    area,
  } = props;

  const getCardClasses = () => {
    if (isBeingSwapped) {
      return 'border-canvas-border bg-canvas-bg-subtle cursor-default';
    }

    if (isInBestHand || isSelected) {
      return 'border-primary-solid bg-primary-bg cursor-pointer';
    }

    if (area === 'ai') {
      return 'border-canvas-border bg-canvas-bg-subtle cursor-not-allowed';
    }
    return 'border-canvas-border hover:border-primary-solid bg-canvas-bg-hover cursor-pointer';
  };

  const colorClass = SUIT_COLORS[card.suit] || '#000000';

  return (
    <div
      id={id}
      data-card-id={cardId}
      className={`w-20 h-28 lg:w-20 lg:h-28 md:w-24 md:h-32 xl:w-24 xl:h-32 border-2 rounded-lg flex flex-col items-center justify-center font-bold
         ${getCardClasses()}
        ${isInBestHand ? 'shadow-lg' : ''}`}
      style={{ color: colorClass }}
      onClick={onClick}
    >
      {!isBeingSwapped && <CardContent card={card} />}
    </div>
  );
}

export default Card;
