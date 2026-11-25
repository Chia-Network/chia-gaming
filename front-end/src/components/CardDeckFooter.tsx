import { useRef, useState } from 'react';
import { InfoIcon } from 'lucide-react';
import type { CardDeckCredit } from '@games/host';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import type { CardDeckPreference } from '../hooks/useCardDeckPreference';
import { isCatalogGameType, packageFor } from '../lib/gameRegistry';

/** Sits at the bottom right of the page, below the game and its controls. */
export function CardDeckFooter({
  gameType,
  preference,
  inert = false,
}: {
  gameType: unknown;
  preference: CardDeckPreference;
  /** Set while a dialog owns the page, like the game area above it. */
  inert?: boolean;
}) {
  const decks = isCatalogGameType(gameType) ? packageFor(gameType).cardDecks : undefined;
  if (!decks) return null;
  const deck = decks.find(({ id }) => id === preference.value) ?? decks[0];
  const credit = deck.credit;
  return (
    <footer
      inert={inert}
      aria-disabled={inert || undefined}
      className="mt-auto flex flex-wrap items-center justify-end gap-x-3 gap-y-1 px-4 py-2 text-xs text-canvas-text sm:px-6 md:px-8"
    >
      <label className="flex items-center gap-1">
        Deck
        <select
          className="rounded-md border border-canvas-border bg-canvas-bg px-2 py-1 text-canvas-text-contrast"
          value={deck.id}
          onChange={(event) => preference.set(event.target.value)}
        >
          {decks.map(({ id, name }) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
      </label>
      {credit && <CreditInfo deckName={deck.name} credit={credit} />}
    </footer>
  );
}

type Credit = CardDeckCredit;

/**
 * Opens on hover with a mouse, and stays open once clicked. Taps and the
 * keyboard toggle it. Hovering never moves focus out of the game.
 */
function CreditInfo({ deckName, credit }: { deckName: string; credit: Credit }) {
  const [open, setOpen] = useState(false);
  const pinned = useRef(false);
  const closing = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hover = (next: boolean) => (event: React.PointerEvent) => {
    if (event.pointerType !== 'mouse') return;
    clearTimeout(closing.current);
    if (next) setOpen(true);
    // A short delay lets the pointer cross into the card to follow a link.
    else if (!pinned.current) closing.current = setTimeout(() => setOpen(false), 150);
  };
  const changeOpen = (next: boolean) => {
    if (!next) pinned.current = false;
    setOpen(next);
  };
  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger
        aria-label={`About the ${deckName} cards`}
        className="rounded-full p-0.5 text-canvas-text hover:text-canvas-text-contrast"
        onPointerEnter={hover(true)}
        onPointerLeave={hover(false)}
        onClick={(event) => {
          // A click on a card that hover opened keeps it open rather than closing it.
          if (open && !pinned.current) {
            event.preventDefault();
            pinned.current = true;
          } else if (!open) {
            pinned.current = true;
          }
        }}
      >
        <InfoIcon className="size-4" />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="top"
        className="w-64 text-xs"
        onOpenAutoFocus={(event) => {
          if (!pinned.current) event.preventDefault();
        }}
        onPointerEnter={hover(true)}
        onPointerLeave={hover(false)}
      >
        <DeckCredit credit={credit} />
      </PopoverContent>
    </Popover>
  );
}

export function DeckCredit({ credit }: { credit: Credit }) {
  return (
    <>
      Cards by{' '}
      <a className="underline" href={credit.url} target="_blank" rel="noopener noreferrer">
        {credit.artist}
      </a>
      , licensed under{' '}
      <a className="underline" href={credit.licenseUrl} target="_blank" rel="noopener noreferrer">
        {credit.license}
      </a>
      .{credit.changes && ` Changes: ${credit.changes}.`}
    </>
  );
}
