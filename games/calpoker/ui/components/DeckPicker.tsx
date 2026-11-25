import { CARD_DECKS, type CardDeck } from './decks';

export function DeckPicker({
  deck,
  onChoose,
}: {
  deck: CardDeck;
  onChoose: (id: string) => void;
}) {
  const credit = deck.art?.credit;
  return (
    <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 px-2 pt-2 text-xs text-canvas-text">
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
          onChange={(event) => onChoose(event.target.value)}
        >
          {CARD_DECKS.map(({ id, name }) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
