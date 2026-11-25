import { useMemo } from 'react';

export interface CardDeckPreference {
  readonly value: string | undefined;
  set(value: string): void;
}

/** One game's deck, from the saved `cardDecks` preference. */
export function useCardDeckPreference(
  cardDecks: Readonly<Record<string, string>>,
  gameType: string,
  onChoose: (gameType: string, deck: string) => void,
): CardDeckPreference {
  const value = cardDecks[gameType];
  return useMemo(
    () => ({ value, set: (deck: string) => onChoose(gameType, deck) }),
    [value, gameType, onChoose],
  );
}
