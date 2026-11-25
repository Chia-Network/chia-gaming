import type { GameRulesSection } from '../../host';

export const spacepokerRules: readonly GameRulesSection[] = [
  {
    heading: 'Goal',
    items: [
      'Win the pot with the best five-card hand, or by getting your opponent to fold.',
    ],
  },
  {
    heading: 'Cards',
    items: [
      'Cards have ranks from 2 to ace and no suits.',
      'Every card is drawn separately, so any rank can come up any number of times.',
    ],
  },
  {
    heading: 'How to play',
    ordered: true,
    items: [
      'Each player puts one bet unit into the pot and is dealt two hole cards. A coin toss decides who bets first.',
      'After a round of betting, three shared cards are dealt. A fourth and a fifth follow, with betting after each.',
      'On your turn you can check or call, raise up to what you have left, or fold. Folding loses what you have put in.',
      'After the last bet is called, the best five of your hole cards and the shared cards are your hand.',
    ],
  },
  {
    heading: 'Hands, best to worst',
    ordered: true,
    items: [
      'Five of a kind',
      'Four of a kind',
      'Straight (an ace is only high)',
      'Full house',
      'Three of a kind',
      'Two pair',
      'Pair',
      'High card',
    ],
  },
  {
    heading: 'Boost',
    items: [
      'About one deal in three is boosted, shown as a + beside the hole cards. A boosted hand beats any unboosted hand of the same kind, whatever the ranks.',
      'Otherwise, hands of the same kind are compared by rank. Equal hands split the pot.',
    ],
  },
];
