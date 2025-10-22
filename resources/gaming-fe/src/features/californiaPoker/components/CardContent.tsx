import { CardContentProps } from "../../../types/californiaPoker";

function CardContent(content: CardContentProps) {
  const { card, textSize = 'text-3xl' } = content;
  return (
    <>
      <div className={textSize}>{card.rank}</div>
      <div className={`${textSize} -mt-2`}>{card.suit}</div>
    </>
  );
}
export default CardContent;