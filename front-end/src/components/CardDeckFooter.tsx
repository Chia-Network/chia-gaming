import { CARD_DECKS, cardDeck } from '@games/host/cards/decks';
import type { CardDeckPreference } from '../hooks/useCardDeckPreference';
import { isCatalogGameType, packageFor } from '../lib/gameRegistry';

/** Sits at the bottom right of the page, below the game and its controls. */
export function CardDeckFooter({
  gameType,
  preference,
}: {
  gameType: unknown;
  preference: CardDeckPreference;
}) {
  if (!isCatalogGameType(gameType) || !packageFor(gameType).usesCardDeck) return null;
  const deck = cardDeck(preference.value);
  const credit = deck.art?.credit;
  return (
    <footer className="mt-auto flex flex-wrap items-center justify-end gap-x-3 gap-y-1 px-4 py-2 text-xs text-canvas-text sm:px-6 md:px-8">
      {credit && (
        <span>
          Cards by{' '}
          <a className="underline" href={credit.url} target="_blank" rel="noopener noreferrer">
            {credit.artist}
          </a>
          ,{' '}
          <a
            className="underline"
            href={credit.licenseUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            {credit.license}
          </a>
          {credit.changes && ` (${credit.changes})`}
        </span>
      )}
      <label className="flex items-center gap-1">
        Deck
        <select
          className="rounded-md border border-canvas-border bg-canvas-bg px-2 py-1 text-canvas-text-contrast"
          value={deck.id}
          onChange={(event) => preference.set(event.target.value)}
        >
          {CARD_DECKS.map(({ id, name }) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
      </label>
    </footer>
  );
}
