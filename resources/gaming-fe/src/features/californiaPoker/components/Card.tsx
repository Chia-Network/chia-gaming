import { CardRenderProps } from "../../../types/californiaPoker";
import { SUIT_COLORS } from "../constants/constants";
import CardContent from "./CardContent";



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
  } = props;

  const getCardStyles = () => {
    if (isBeingSwapped) {
      return {
        border: 'border-gray-300',
        bg: 'bg-gray-200',
        cursor: '',
      };
    }

    if (isInBestHand) {
      return {
        border: 'border-yellow-400',
        bg: 'bg-yellow-50',
        cursor: 'cursor-pointer',
      };
    }

    if (isSelected) {
      return {
        border: 'border-blue-400',
        bg: 'bg-blue-50',
        cursor: 'cursor-pointer',
      };
    }

    return {
      border: 'border-gray-300 hover:border-gray-400',
      bg: 'bg-gray-50',
      cursor: 'cursor-pointer',
    };
  };

  const styles = getCardStyles();
  const colorClass = SUIT_COLORS[card.suit] || '#000000';
 
  return (
    <div
      id={id}
      data-card-id={cardId}
      className={`w-20 h-28 border rounded flex flex-col items-center justify-center font-bold
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