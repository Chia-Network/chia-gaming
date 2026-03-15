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
    hasHalo = false,
    area,
  } = props;

  const cardBorder = isBeingSwapped
    ? (hasHalo ? 'border-transparent' : 'border-canvas-border')
    : isInBestHand
      ? 'border-emerald-500'
      : 'border-canvas-border';

  const cardBg = isBeingSwapped
    ? (hasHalo ? 'bg-transparent' : 'bg-canvas-bg-subtle')
    : isInBestHand
      ? 'bg-emerald-50'
      : 'bg-canvas-bg-subtle';

  const cursor = isBeingSwapped
    ? 'cursor-default'
    : area === 'ai'
      ? 'cursor-not-allowed'
      : 'cursor-pointer';

  const colorClass = SUIT_COLORS[card.suit] || '#000000';

  return (
    <div className='w-full relative'>
      {hasHalo && (
        <div className='absolute -inset-2 rounded-xl bg-amber-700 z-0' />
      )}
      <div
        id={id}
        data-card-id={cardId}
        className={`relative z-10 w-full aspect-[5/7] border-2 rounded-lg flex flex-col items-center justify-center font-bold
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
