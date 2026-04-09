import { CardRenderProps } from '../../../../types/californiaPoker';
import { SUIT_COLORS, HALO_FADE_DURATION_MS } from '../constants/constants';
import CardContent from './CardContent';

function Card(props: CardRenderProps) {
  const {
    id,
    card,
    index,
    isSelected,
    onClick,
    isBeingSwapped = false,
    hideForSwap = false,
    cardId,
    isInBestHand = false,
    isFinal = false,
    hasHalo = false,
    showDragOutline = false,
    area,
  } = props;

  const suitColor = SUIT_COLORS[card.suit] || '#000000';
  const isHidden = isBeingSwapped && hideForSwap;
  const dimmed = isFinal && !isInBestHand;

  const cursor = isBeingSwapped
    ? 'cursor-default'
    : area === 'ai'
      ? 'cursor-not-allowed'
      : 'cursor-pointer';

  const stateClass = isHidden ? 'card-hidden' : dimmed ? 'card-dimmed' : '';

  return (
    <div className='w-full relative'>
      {showDragOutline && !hasHalo && (
        <div className='absolute -inset-2 rounded-xl z-0 bg-canvas-bg' />
      )}
      <div
        className='absolute -inset-2 rounded-xl z-0 transition-opacity ease-in-out'
        style={{
          backgroundColor: '#9E8A8E',
          opacity: hasHalo ? 1 : 0,
          transitionDuration: `${HALO_FADE_DURATION_MS}ms`,
        }}
      />
      <div
        id={id}
        data-card-id={cardId}
        className={`card-face ${stateClass} relative z-10 w-full aspect-[5/7] rounded-lg flex flex-col items-center justify-center font-bold ${cursor}`}
        style={{ '--suit-color': suitColor } as React.CSSProperties}
        onClick={onClick}
      >
        {!isHidden && <CardContent card={card} />}
      </div>
    </div>
  );
}

export default Card;
