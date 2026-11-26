import type { GameRulesSection } from '../../host';

export const spacepokerRules: readonly GameRulesSection[] = [
  {
    heading: 'Goal',
    items: ['Win the pot with the best five-card hand, or by getting your opponent to fold.'],
  },
  {
    heading: 'Cards',
    items: [
      'Cards have ranks from 2 to ace and no suits.',
      'Every card is drawn separately, as if from an endless deck, so any rank can come up any number of times.',
    ],
  },
  {
    heading: 'How to play',
    ordered: true,
    items: [
      'Each player puts one bet unit into the pot and is dealt two hole cards.',
      'After a round of betting, three shared cards are dealt. A fourth and a fifth follow, with betting after each.',
      'On your turn you can check or call, raise up to what you have left, or fold. Folding loses what you have put in.',
      'After the last bet is called, the best five of your hole cards and the shared cards are your hand.',
    ],
  },
  {
    heading: 'Who goes first',
    items: [
      'A coin toss decides who acts first at the start of the hand.',
      'After that, each round of betting is opened by the player who did not end the previous round by calling.',
      'A check at the start of a round does not end it. The other player still gets to act.',
      'At the showdown, the player who called the last bet reveals first. In regular poker it is the other way around.',
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
    heading: 'Boosted hands',
    items: [
      'Each player has a 1 in 3 chance of being boosted, shown as a + beside their hole cards.',
      'Boost is the first tiebreak after the kind of hand. A boosted hand beats any unboosted hand of the same kind, whatever the ranks.',
      'After that, hands of the same kind are compared by rank. Equal hands split the pot.',
    ],
  },
  {
    heading: 'Why it works this way',
    items: [
      'The endless deck avoids some cryptographic problems with dealing from a shared deck.',
      'Boosting brings back something like suited hole cards, which a deck without suits would lose.',
      'The turn order cuts the number of turns, so a hand played out on chain is less slow.',
    ],
  },
];
