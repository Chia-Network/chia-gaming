import { cardIdToRankSuit } from '@/src/types/californiaPoker';

const LOG_RANKS: Record<number, string> = {
  14: 'A', 13: 'K', 12: 'Q', 11: 'J', 10: 'T',
  9: '9', 8: '8', 7: '7', 6: '6', 5: '5', 4: '4', 3: '3', 2: '2',
};

// Bridge order: spades(1) > hearts(2) > diamonds(3) > clubs(4)
const LOG_SUITS: Record<number, string> = { 1: '🪏', 2: '❤️', 3: '💎', 4: '🍀' };
const SUIT_SORT_KEY: Record<number, number> = { 1: 0, 2: 1, 3: 2, 4: 3 };

export function formatCardForLog(cardId: bigint): string {
  const { rank, suit } = cardIdToRankSuit(cardId);
  return `${LOG_RANKS[rank] ?? String(rank)}${LOG_SUITS[suit] ?? '?'}`;
}

function compareCardsDescending(a: bigint, b: bigint): number {
  const aRS = cardIdToRankSuit(a);
  const bRS = cardIdToRankSuit(b);
  if (aRS.rank !== bRS.rank) return bRS.rank - aRS.rank;
  return SUIT_SORT_KEY[aRS.suit] - SUIT_SORT_KEY[bRS.suit];
}

export function sortCardsForLog(cardIds: bigint[]): bigint[] {
  return [...cardIds].sort(compareCardsDescending);
}

export function formatCardsForLog(cardIds: bigint[]): string {
  return sortCardsForLog(cardIds).map(formatCardForLog).join('');
}

export function formatOrderedCardsForLog(cardIds: bigint[]): string {
  return cardIds.map(formatCardForLog).join('');
}

function isFlushOrStraight(handValue: bigint[]): boolean {
  if (handValue.length < 1) return false;
  // straight flush: (5 ...)
  if (handValue[0] === 5n) return true;
  if (handValue.length < 3) return false;
  // flush: (3 1 3 ...) or straight: (3 1 2 ...)
  if (handValue[0] === 3n && handValue[1] === 1n && (handValue[2] === 3n || handValue[2] === 2n)) return true;
  return false;
}

function isWheel(handValue: bigint[]): boolean {
  // straight (3 1 2 high_card) or straight flush (5 high_card) with high_card === 5
  if (handValue[0] === 5n && handValue[1] === 5n) return true;
  if (handValue[0] === 3n && handValue[1] === 1n && handValue[2] === 2n && handValue[3] === 5n) return true;
  return false;
}

export function orderUsedCardsForLog(usedCards: bigint[], handValue: bigint[]): bigint[] {
  if (isFlushOrStraight(handValue)) {
    const sorted = [...usedCards].sort(compareCardsDescending);
    if (isWheel(handValue)) {
      // Move ace(s) to the end — the 5 is the "high card"
      const aces: bigint[] = [];
      const rest: bigint[] = [];
      for (const c of sorted) {
        if (cardIdToRankSuit(c).rank === 14) aces.push(c);
        else rest.push(c);
      }
      return [...rest, ...aces];
    }
    return sorted;
  }

  // Group by rank, sort groups by size desc then rank desc, bridge suit within rank
  const byRank = new Map<number, bigint[]>();
  for (const c of usedCards) {
    const { rank } = cardIdToRankSuit(c);
    if (!byRank.has(rank)) byRank.set(rank, []);
    byRank.get(rank)!.push(c);
  }

  const groups = [...byRank.entries()].map(([rank, cards]) => ({
    rank,
    size: cards.length,
    cards: cards.sort(compareCardsDescending),
  }));

  groups.sort((a, b) => {
    if (a.size !== b.size) return b.size - a.size;
    return b.rank - a.rank;
  });

  return groups.flatMap(g => g.cards);
}
