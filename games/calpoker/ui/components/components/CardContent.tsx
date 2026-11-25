import { useState } from 'react';
import { CardContentProps } from '../../types';
import { RANK_SYMBOLS } from '../constants/constants';
import { cardArtUrl, useCardDeck } from '../../decks';

const RANK_NAMES: Record<number, string> = { 11: 'Jack', 12: 'Queen', 13: 'King', 14: 'Ace' };
const SUIT_NAMES: Record<string, string> = {
  '\u2660': 'spades',
  '\u2665': 'hearts',
  '\u2666': 'diamonds',
  '\u2663': 'clubs',
};

function CardContent(content: CardContentProps) {
  const { card } = content;
  const deck = useCardDeck();
  const url = cardArtUrl(deck, card);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const rankDisplay = RANK_SYMBOLS[card.rank] ?? card.rank;
  const sym = { fontSize: '55cqw', lineHeight: 1 };
  if (url !== null && url !== failedUrl) {
    return (
      <img
        className="card-art"
        src={url}
        alt={`${RANK_NAMES[card.rank] ?? card.rank} of ${SUIT_NAMES[card.suit]}`}
        draggable={false}
        style={deck.art?.pixelated ? { imageRendering: 'pixelated' } : undefined}
        onError={() => setFailedUrl(url)}
      />
    );
  }
  return (
    <>
      <div style={sym}>{rankDisplay}</div>
      <div style={{ ...sym, marginTop: '5cqw' }}>{card.suit}</div>
    </>
  );
}
export default CardContent;
