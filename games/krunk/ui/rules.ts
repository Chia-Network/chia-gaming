import type { GameRulesSection } from '../../host';

/** The dictionary that `rust/mod.rs` compiles into the game. */
const KRUNK_WORD_LIST_URL =
  'https://github.com/Chia-Network/chia-gaming/blob/main/games/krunk/clsp/krunkwords.txt';

export const krunkRules: readonly GameRulesSection[] = [
  {
    heading: 'Goal',
    items: [
      'Guess your opponent\u2019s five-letter word in as few guesses as you can, while they guess yours.',
    ],
  },
  {
    heading: 'How to play',
    ordered: true,
    items: [
      {
        text: 'Each player picks a secret five-letter word from the dictionary.',
        link: { label: 'See the word list', url: KRUNK_WORD_LIST_URL },
      },
      'Both players guess at the same time, with up to five guesses each. Guesses must also be in the dictionary.',
      'After each guess, every letter is marked.',
    ],
  },
  {
    heading: 'Marks',
    items: [
      'Green: the letter is in the word, in this place.',
      'Amber: the letter is in the word, in another place.',
      'Gray: the letter is not in the word, or every copy of it is already marked.',
    ],
  },
  {
    heading: 'Payouts',
    items: [
      'Each player stakes the same amount on their own word. A correct guess wins part of the other player\u2019s stake.',
      'First or second guess: all of it',
      'Third guess: 20%',
      'Fourth guess: 5%',
      'Fifth guess: 1%',
      'The rest goes back to the player who picked the word. If you never find it, they keep it all.',
    ],
  },
];
