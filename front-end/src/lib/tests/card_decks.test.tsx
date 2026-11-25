import { act, create, type ReactTestRenderer } from 'react-test-renderer';
// @ts-expect-error Node.js types are not included in the frontend TypeScript configuration.
import { readdirSync, readFileSync } from 'fs';
import CardContent from '@games/calpoker/ui/components/components/CardContent';
import { DeckPicker } from '@games/calpoker/ui/components/DeckPicker';
import {
  CARD_DECKS,
  cardArtUrl,
  cardDeck,
  CardDeckProvider,
} from '@games/calpoker/ui/components/decks';

// @ts-expect-error Node.js globals are not included in the frontend configuration.
const CARDS = `${__dirname}/../../../public/images/cards`;
const SUITS = ['♠', '♥', '♦', '♣'] as const;
const RANKS = Array.from({ length: 13 }, (_, index) => index + 2);
const kingOfHearts = { rank: 13, suit: '♥' as const };

describe('card decks', () => {
  it.each(CARD_DECKS.filter(({ art }) => art))('$name has art for exactly 52 cards', (deck) => {
    const urls = SUITS.flatMap((suit) => RANKS.map((rank) => cardArtUrl(deck, { rank, suit })!));
    expect(urls.map((url) => url.split('/').at(-1)).sort()).toEqual(
      readdirSync(`${CARDS}/${deck.id}`).sort(),
    );
  });

  it('credits every deck that has art, in the app and in CREDITS.md', () => {
    const credits = readFileSync(`${CARDS}/CREDITS.md`, 'utf8');
    for (const deck of CARD_DECKS) {
      let renderer!: ReactTestRenderer;
      act(() => {
        renderer = create(<DeckPicker deck={deck} onChoose={jest.fn()} />);
      });
      const links = renderer.root.findAllByType('a').map((link) => link.props.href);
      if (deck.art) {
        const { artist, url, licenseUrl } = deck.art.credit;
        expect(links).toEqual([url, licenseUrl]);
        expect(credits).toContain(`| \`${deck.id}\` | ${artist} | <${url}> |`);
        expect(credits).toContain(licenseUrl);
      } else {
        expect(links).toEqual([]);
      }
      act(() => renderer.unmount());
    }
  });

  it('falls back to the built-in deck for unknown decks and art that fails to load', () => {
    expect(cardDeck('removed').id).toBe('classic');
    expect(cardDeck(undefined).id).toBe('classic');
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <CardDeckProvider value={cardDeck('traditional')}>
          <CardContent card={kingOfHearts} />
        </CardDeckProvider>,
      );
    });
    const image = renderer.root.findByType('img');
    expect(image.props).toMatchObject({
      src: 'images/cards/traditional/KH.svg',
      alt: 'King of hearts',
    });
    act(() => image.props.onError());
    expect(renderer.root.findAllByType('img')).toEqual([]);
    expect(JSON.stringify(renderer.toJSON())).toContain('K');
    act(() => renderer.unmount());
  });
});
