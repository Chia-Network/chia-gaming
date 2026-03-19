import { CardContentProps } from '../../../../types/californiaPoker';
import { RANK_SYMBOLS } from '../constants/constants';

function CardContent(content: CardContentProps) {
  const { card, textSize = 'text-5xl' } = content;
  const rankDisplay = RANK_SYMBOLS[card.rank] ?? card.rank;
  return (
    <>
      <div className={`${textSize} leading-none`}>{rankDisplay}</div>
      <div className={`${textSize} leading-none mt-2`}>{card.suit}</div>
    </>
  );
}
export default CardContent;
