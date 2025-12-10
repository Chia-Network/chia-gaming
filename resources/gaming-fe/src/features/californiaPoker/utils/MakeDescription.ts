import { OutcomeHandType } from "@/src/types/ChiaGaming";

const FULL_RANKS: Record<number, string> = {
  14: 'Ace',
  13: 'King',
  12: 'Queen',
  11: 'Jack',
  10: 'Ten',
  9: 'Nine',
  8: 'Eight',
  7: 'Seven',
  6: 'Six',
  5: 'Five',
  4: 'Four',
  3: 'Three',
  2: 'Two',
};

const getRankName = (n: number) => FULL_RANKS[n] ?? n.toString();

export const makeDescription = (desc: OutcomeHandType) => {
  if (!desc || !desc.name) return '';

  const name = desc.name; // e.g., 'Pair', 'Two Pair'
  const values = desc.values.map(getRankName);
  const main = values[0] || '';
  const kickers = values.slice(1);

  switch (name.toLowerCase()) {
    case 'straight flush':
    case 'straight':
      // e.g., "Straight Flush Ten High"
      return `${name} ${main} High`;

    case 'flush':
      // e.g., "Flush, Ace high, Nine, Eight, Four, Three kickers"
      return `${name}, ${main} high${kickers.length ? ', ' + kickers.join(', ') + ' kickers' : ''}`;

    case 'four of a kind':
      // e.g., "Four of a kind, Aces over Fours"
      return kickers.length
        ? `${name}, ${main}s over ${kickers[0]}s`
        : `${name}, ${main}s`;

    case 'full house':
      // e.g., "Full House, Aces over Fours"
      return values.length >= 2 ? `${name}, ${values[0]}s over ${values[1]}s` : name;

    case 'set':
    case 'three of a kind':
      // e.g., "Set, Kings. Eight, Seven kickers"
      return kickers.length
        ? `${name}, ${main}s. ${kickers.join(', ')} kickers`
        : `${name}, ${main}s`;

    case 'two pair':
      // e.g., "Two Pair, Aces over Fours, Queen kicker"
      return values.length >= 2
        ? `${name}, ${values[0]}s over ${values[1]}s${kickers.length ? ', ' + kickers[0] + ' kicker' : ''}`
        : name;

    case 'pair':
      // e.g., "Pair, Twos. Ace, King, Jack kickers"
      return kickers.length
        ? `${name}, ${main}s. ${kickers.join(', ')} kickers`
        : `${name}, ${main}s`;

    case 'high card':
      // e.g., "King high. Ten, Eight, Seven, Two kickers"
      return kickers.length
        ? `${main} high. ${kickers.join(', ')} kickers`
        : `${main} high`;

    default:
      return `${name} ${values.join(', ')}`;
  }
};
