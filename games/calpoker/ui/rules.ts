import type { GameRulesSection } from '../../host';

export const calpokerRules: readonly GameRulesSection[] = [
  {
    heading: 'Goal',
    items: ['Finish with the best five-card poker hand. The winner takes both stakes.'],
  },
  {
    heading: 'How to play',
    ordered: true,
    items: [
      'Each player is dealt eight cards from one 52-card deck. Both hands are face up.',
      'Each player picks four cards to give away, without seeing what the other picked.',
      'The four cards you picked go to your opponent, and their four come to you.',
      'Your best five of your eight cards are your hand. The game picks them for you.',
    ],
  },
  {
    heading: 'Hands, best to worst',
    ordered: true,
    items: [
      'Straight flush',
      'Four of a kind',
      'Full house',
      'Flush',
      'Straight (an ace can be high or low)',
      'Three of a kind',
      'Two pair',
      'Pair',
      'High card',
    ],
  },
  {
    heading: 'Ties',
    items: [
      'Hands of the same kind are compared by card rank. Suits never break a tie.',
      'If the hands are equal, each player gets their stake back.',
    ],
  },
];
