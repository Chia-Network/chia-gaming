import { CardContentProps } from '../../../../types/californiaPoker';
import { RANK_SYMBOLS } from '../constants/constants';

function CardContent(content: CardContentProps) {
  const { card } = content;
  const rankDisplay = RANK_SYMBOLS[card.rank] ?? card.rank;
  const sym = { fontSize: '55cqw', lineHeight: 1 };
  return (
    <>
      <div style={sym}>{rankDisplay}</div>
      <div style={{ ...sym, marginTop: '5cqw' }}>{card.suit}</div>
    </>
  );
}
export default CardContent;
