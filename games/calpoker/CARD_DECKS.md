# Open card decks for California Poker

Research only, checked 2026-11-25. Nothing here is adopted yet.

## What we have

`Card.tsx` draws a rank and a suit symbol with CSS. It needs no assets and
scales with `cqw` units. It is four-colour and has separate light and dark
styles. Space Poker draws its own table, so a shared deck would serve both.

## What a deck needs

- A licence that fits an Apache-2.0 app we ship as a web bundle and desktop app.
- SVG, readable at small sizes, because a hand shows eight cards at once.
- Four suit colours.
- A small download. The whole deck can be on screen within a few hands.

## Options

| Deck | Artwork licence | Format | Four-colour | Size | Last update |
| --- | --- | --- | --- | --- | --- |
| [Adrian Kennard](https://www.me.uk/cards/) | CC0, no attribution required | SVG, PDF (generator) | Yes, an option | Depends on options | 2018 |
| [@letele/playing-cards](https://unpkg.com/@letele/playing-cards@0.1.0/README.md) | CC0-1.0 (Kennard's art as React components) | React SVG | Not stated | 558 KB unpacked | 2023-08 |
| [saulspatz/SVGCards](https://github.com/saulspatz/SVGCards) | Public domain per README, no licence file detected | SVG, PNG | Yes, plus a higher-contrast Accessible deck | 55 MB repository | 2022-01 |
| [Tek Eye](https://tekeye.uk/playing_cards/svg-playing-cards) | Public domain claim, disputed in a 2025 page comment | SVG, PNG | Not stated | Not stated | 2021-04 |
| [hayeah/playing-cards-assets](https://github.com/hayeah/playing-cards-assets) | MIT repository; art credited as public domain | SVG, PNG | Not stated | Not stated | Not stated |
| [Kenney Playing Cards](https://kenney.nl/assets/playing-cards-pack) | CC0 | Tagged pixel art | Not stated | 270 files | 2020 |
| [Kenney Boardgame Pack](https://kenney.nl/assets/boardgame-pack) | CC0 | Not stated | Not stated | 490 files | 2014 |
| [htdebeer/SVG-cards](https://github.com/htdebeer/SVG-cards) | LGPL-2.1 | SVG, PNG | Not stated | 7.0 MB on npm | 2026-08 |
| [@younestouati/playing-cards-standard-deck](https://www.npmjs.com/package/@younestouati/playing-cards-standard-deck) | LGPL-3.0 | Not checked | Not checked | 2.6 MB | 2020-01 |
| [react-playing-card-set](https://www.npmjs.com/package/react-playing-card-set) | MIT package; art reported as Kennard's CC0 (page returned 403) | React | Not checked | 7.5 MB | 2022-04, React 16 only |
| [alehuo/react-playing-cards](https://github.com/alehuo/react-playing-cards) | MIT repository; artwork source not stated | React | Not stated | Not stated | Not stated |

## Recommendation

Use Adrian Kennard's deck, generated with four-colour and large-index options
and committed as SVG files.

- CC0 is the clearest licence here, and it needs no attribution or notices.
- Generating the files avoids a runtime dependency. The React wrappers are old,
  and one supports React 16 only.
- saulspatz's Accessible deck is the best fallback for legibility, but its court
  cards come from other sets, so each source should be checked first.

Avoid the LGPL decks. Their terms can be met, but a CC0 deck avoids the question.

## If we adopt it

1. Prototype behind the existing `Card` component, so selection, halo, dimming
   and swap animations stay the same.
2. Compare legibility against the current cards at mobile width. The current
   cards fill the face with rank and suit, which is hard to beat when small.
3. Check dark mode. Printed decks assume a white face, while ours change colour.
4. Run the SVGs through SVGO and measure the bundle. Court cards dominate size.

A cheaper alternative is to keep our number cards and adopt only the twelve
court cards.
