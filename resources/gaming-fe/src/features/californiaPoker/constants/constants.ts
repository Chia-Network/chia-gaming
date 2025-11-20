const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const RANK_SYMBOLS: Record<number, string> = {
  14: 'A',
  10: 'T',
  11: 'J',
  12: 'Q',
  13: 'K',
};
const GameColors = {
    win: 'green',
    lose: 'red',
    tie: '#ccc',
    success: '#363',
    warning: '#633',
  };
// OKHSL colors: hue in degrees, saturation 100%, lightness as specified
const SUIT_COLORS = {
  Q: 'oklch(70% 0.3 90)', // Gold (90° hue, 70% lightness)
  '♠': 'oklch(0% 0 0)', // Black (0% lightness, 0 chroma for true black)
  '♥': 'oklch(50% 0.3 25)', // Red (25° hue, 50% lightness)
  '♦': 'oklch(50% 0.3 265)', // Blue (265° hue, 50% lightness)
  '♣': 'oklch(50% 0.3 155)', // Green (155° hue, 50% lightness)
};

const HAND_RANKINGS = {
  STRAIGHT_FLUSH: { score: 8, name: 'Straight Flush' },
  FOUR_OF_A_KIND: { score: 7, name: 'Four of a Kind' },
  FULL_HOUSE: { score: 6, name: 'Full House' },
  FLUSH: { score: 5, name: 'Flush' },
  STRAIGHT: { score: 4, name: 'Straight' },
  THREE_OF_A_KIND: { score: 3, name: 'Three of a Kind' },
  TWO_PAIR: { score: 2, name: 'Two Pair' },
  ONE_PAIR: { score: 1, name: 'One Pair' },
  HIGH_CARD: { score: 0, name: 'High Card' },
};

const GAME_STATES = {
  INITIAL: 'initial',
  SELECTING: 'selecting',
  SWAPPING: 'swapping',
  FINAL: 'final',
};

const ANIMATION_DELAY = 100;
const SWAP_ANIMATION_DURATION = 2500;

// Button styling classes
const BUTTON_BASE = 'font-bold rounded-lg w-full h-full text-center';
const BUTTON_ACTIVE = 'bg-blue-600 text-white hover:bg-blue-700 cursor-pointer';
const BUTTON_DISABLED = 'bg-gray-300 text-gray-500 cursor-default';
export {
  SUITS,
  RANKS,
  SUIT_COLORS,
  HAND_RANKINGS,
  GAME_STATES,
  ANIMATION_DELAY,
  SWAP_ANIMATION_DURATION,
  BUTTON_BASE,
  BUTTON_ACTIVE,
  BUTTON_DISABLED,
  RANK_SYMBOLS,
  GameColors
};

