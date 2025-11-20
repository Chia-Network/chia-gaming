import { CardContentProps } from '../../../types/californiaPoker';
import { RANK_SYMBOLS } from '../constants/constants';

function CardContent(content: CardContentProps) {
  const { card, textSize = 'text-3xl' } = content;
  const rankDisplay = RANK_SYMBOLS[card.rank] ?? card.rank;
  return (
    <>
      <div className={textSize}>{rankDisplay}</div>
      <div className={`${textSize} -mt-2`}>{card.suit}</div>
    </>
  );
}
export default CardContent;
