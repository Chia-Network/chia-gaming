# Card decks for California Poker

Checked 2026-11-25. Shipped decks and their credits are in
[`CREDITS.md`](../../front-end/public/images/cards/CREDITS.md).

We take art that is public domain, CC0, or CC BY with its credit shown in the
app. GPL and LGPL art needs more than attribution, and CC BY-SA would apply its
terms to changed art, so those are not included.

| Deck | Licence | Status |
| --- | --- | --- |
| [Adrian Kennard](https://www.me.uk/cards/) | CC0 | Shipped as Traditional and Large index |
| [Kenney Playing Cards](https://opengameart.org/content/playing-cards-pack) | CC0 | Shipped as Pixel |
| [Aussiesim at game-icons.net](https://game-icons.net) | CC BY 3.0 | Shipped as Bold |
| [English pattern, Dmitry Fomin](https://commons.wikimedia.org/wiki/Category:SVG_English_pattern_playing_cards) | CC0 on the two files checked | Good candidate. Wikimedia rate-limited the download |
| [Classic 4-Color, Heratexx](https://opengameart.org/comment/112049) | CC0 | Not shipped, looks derived from Kennard's |
| [@letele/playing-cards](https://unpkg.com/@letele/playing-cards@0.1.0/README.md) | CC0 | Not shipped, Kennard's art as React components |
| [saulspatz/SVGCards](https://github.com/saulspatz/SVGCards) | Public domain per README | Good candidate for an accessible deck. Check each court card's source first |
| [Byron Knoll](https://github.com/notpeter/Vector-Playing-Cards) | Public domain claim | Not shipped, about 8 MB, and a [commenter](https://opengameart.org/content/playing-cards-vector-png) questions the source |
| [Tek Eye](https://tekeye.uk/playing_cards/svg-playing-cards) | Public domain claim | Not shipped, the claim is disputed on its page |
| [Pixel Art Cards](https://opengameart.org/content/pixel-art-cards) | CC BY 3.0 | Not shipped, source files need exporting |
| [C1 Cards](https://github.com/thecheis/C1-Cards) | CC BY-SA 4.0 | Not shipped, share-alike |
| [SVG-cards](https://github.com/htdebeer/SVG-cards) | LGPL-2.1 | Not shipped, copyleft |
| [KDE](https://lxr.kde.org/source/games/libkdegames/src/carddecks), [PySolFC](https://sources.debian.org/copyright/license/pysolfc-cardsets/2.0%2Bdfsg2-2) | Varies, some GPL | Not shipped, each deck needs its own check |

To add a deck, put 52 files named by rank and suit (`KH`, `TS`) in
`front-end/public/images/cards/<id>`, then add it to `CREDITS.md` and
`ui/components/decks.ts`. A test checks all three.
