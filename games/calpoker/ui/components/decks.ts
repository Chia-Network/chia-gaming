import { createContext, useContext } from 'react';
import type { CardValueSuit } from '../types';

interface Credit {
  artist: string;
  url: string;
  license: string;
  licenseUrl: string;
  changes?: string;
}

export interface CardDeck {
  id: string;
  name: string;
  /** Absent for the built-in deck, which is drawn with text. */
  art?: { extension: 'svg' | 'png'; pixelated?: boolean; credit: Credit };
}

const CC0 = {
  license: 'CC0 1.0',
  licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
};
const KENNARD = { artist: 'Adrian Kennard', url: 'https://www.me.uk/cards/', ...CC0 };

/** Art lives in `front-end/public/images/cards/<id>`; see CREDITS.md there. */
export const CARD_DECKS: readonly [CardDeck, ...CardDeck[]] = [
  { id: 'classic', name: 'Classic' },
  { id: 'traditional', name: 'Traditional', art: { extension: 'svg', credit: KENNARD } },
  { id: 'large-index', name: 'Large index', art: { extension: 'svg', credit: KENNARD } },
  {
    id: 'icons',
    name: 'Bold',
    art: {
      extension: 'svg',
      credit: {
        artist: 'Aussiesim',
        url: 'https://game-icons.net',
        license: 'CC BY 3.0',
        licenseUrl: 'https://creativecommons.org/licenses/by/3.0/',
        changes: 'cropped, stretched and recoloured',
      },
    },
  },
  {
    id: 'pixel',
    name: 'Pixel',
    art: {
      extension: 'png',
      pixelated: true,
      credit: {
        artist: 'Kenney',
        url: 'https://kenney.nl/assets/playing-cards-pack',
        ...CC0,
        changes: 'cropped',
      },
    },
  },
];

/** A saved deck that no longer exists falls back to the built-in deck. */
export function cardDeck(id: string | undefined): CardDeck {
  return CARD_DECKS.find((deck) => deck.id === id) ?? CARD_DECKS[0];
}

const RANKS: Record<number, string> = { 10: 'T', 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
const SUITS: Record<string, string> = { '\u2660': 'S', '\u2665': 'H', '\u2666': 'D', '\u2663': 'C' };

/** Null when the deck is drawn with text. */
export function cardArtUrl(deck: CardDeck, card: CardValueSuit): string | null {
  const suit = SUITS[card.suit];
  if (!deck.art || !suit) return null;
  return `images/cards/${deck.id}/${RANKS[card.rank] ?? card.rank}${suit}.${deck.art.extension}`;
}

const CardDeckContext = createContext<CardDeck>(CARD_DECKS[0]);
export const CardDeckProvider = CardDeckContext.Provider;
export const useCardDeck = (): CardDeck => useContext(CardDeckContext);
