import { act, create, type ReactTestRenderer } from 'react-test-renderer';
// @ts-expect-error Node.js types are not included in the frontend TypeScript configuration.
import { readdirSync, readFileSync } from 'fs';
import CardContent from '@games/calpoker/ui/components/components/CardContent';
import { CARD_DECKS, cardArtUrl, cardDeck, CardDeckProvider } from '@games/calpoker/ui/decks';
import { CardDeckFooter, DeckCredit } from '../../components/CardDeckFooter';

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

  it('credits every deck that has art, behind the info button and in CREDITS.md', () => {
    const credits = readFileSync(`${CARDS}/CREDITS.md`, 'utf8');
    for (const deck of CARD_DECKS) {
      let renderer!: ReactTestRenderer;
      act(() => {
        renderer = create(
          <CardDeckFooter gameType="calpoker" preference={{ value: deck.id, set: jest.fn() }} />,
        );
      });
      const info = renderer.root.findAll(
        (node) =>
          node.type === 'button' && node.props['aria-label'] === `About the ${deck.name} cards`,
      );
      if (deck.credit) {
        expect(info).toHaveLength(1);
        let credit!: ReactTestRenderer;
        act(() => {
          credit = create(<DeckCredit credit={deck.credit!} />);
        });
        const links = credit.root.findAllByType('a').map((link) => link.props.href);
        act(() => credit.unmount());
        const { artist, url, licenseUrl } = deck.credit;
        expect(links).toEqual([url, licenseUrl]);
        expect(credits).toContain(`| \`${deck.id}\` | ${artist} | <${url}> |`);
        expect(credits).toContain(licenseUrl);
      } else {
        expect(info).toEqual([]);
      }
      act(() => renderer.unmount());
    }
  });

  it.each([
    ['calpoker', true],
    ['spacepoker', false],
    ['krunk', false],
  ])('offers the picker in %s: %s', (gameType, offered) => {
    const set = jest.fn();
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <CardDeckFooter gameType={gameType} preference={{ value: 'pixel', set }} />,
      );
    });
    const pickers = renderer.root.findAllByType('select');
    expect(pickers).toHaveLength(offered ? 1 : 0);
    if (offered) {
      expect(pickers[0]!.props.value).toBe('pixel');
      act(() => pickers[0]!.props.onChange({ target: { value: 'icons' } }));
      expect(set).toHaveBeenCalledWith('icons');
    }
    act(() => renderer.unmount());
  });

  it('leaves the picker out of reach while a dialog owns the page', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <CardDeckFooter
          gameType="calpoker"
          preference={{ value: 'pixel', set: jest.fn() }}
          inert
        />,
      );
    });
    expect(renderer.root.findByType('footer').props).toMatchObject({
      inert: true,
      'aria-disabled': true,
    });
    act(() => renderer.unmount());
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
