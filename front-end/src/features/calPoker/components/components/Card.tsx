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
    isFinal = false,
    hasHalo = false,
    area,
  } = props;

  const cardBorder = isBeingSwapped && hasHalo
    ? 'border-transparent'
    : 'border-canvas-border';

  const cardBg = isBeingSwapped && hasHalo
    ? 'bg-transparent'
    : isFinal && !isInBestHand
      ? 'bg-gray-300'
      : 'bg-white';

  const cursor = isBeingSwapped
    ? 'cursor-default'
    : area === 'ai'
      ? 'cursor-not-allowed'
      : 'cursor-pointer';

  const colorClass = SUIT_COLORS[card.suit] || '#000000';

  return (
    <div className='w-full relative'>
      {hasHalo && (
        <div className='absolute -inset-1.5 rounded-xl bg-blue-600 z-0' />
      )}
      <div
        id={id}
        data-card-id={cardId}
        className={`card-face relative z-10 w-full aspect-[5/7] border rounded-lg flex flex-col items-center justify-center font-bold
           ${cardBorder} ${cardBg} ${cursor}`}
        style={{ color: colorClass }}
        onClick={onClick}
      >
        {!isBeingSwapped && <CardContent card={card} />}
      </div>
    </div>
  );
}

export default Card;
