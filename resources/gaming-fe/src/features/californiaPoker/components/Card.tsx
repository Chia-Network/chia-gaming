import { CardRenderProps } from "../../../types/californiaPoker";
import { SUIT_COLORS } from "../constants/constants";
import CardContent from "./CardContent";

function Card(props: CardRenderProps) {
  const {
    card,
    isSelected,
    onClick,
    isBeingSwapped = false,
    cardId,
    isInBestHand = false,
  } = props;

  const getCardStyles = () => {
    if (isBeingSwapped) {
      return {
        border: 'border-solid border-gray-300',
        bg: 'bg-gray-50 opacity-50',
        cursor: '',
      };
    }

    if (isInBestHand) {
      return {
        border: 'border-yellow-500',
        bg: 'bg-yellow-100',
        cursor: 'cursor-pointer',
      };
    }

    if (isSelected) {
      return {
        border: 'border-blue-500',
        bg: 'bg-blue-100',
        cursor: 'cursor-pointer',
      };
    }

    return {
      border: 'border-gray-300 hover:border-gray-400',
      bg: 'bg-white',
      cursor: 'cursor-pointer',
    };
  };

  const styles = getCardStyles();
  const colorClass = SUIT_COLORS[card.suit] || '#000000';

  return (
    <div
      data-card-id={cardId}
      className={`min-w-12 w-16 h-24 border-2 rounded-lg flex flex-col items-center justify-center font-bold
        ${styles.border} ${styles.bg} ${styles.cursor}
        ${isInBestHand ? 'shadow-lg' : ''}`}
      style={{ color: colorClass }}
      onClick={onClick}
    >
      {!isBeingSwapped && <CardContent card={card} />}
    </div>
  );
}

export default Card;