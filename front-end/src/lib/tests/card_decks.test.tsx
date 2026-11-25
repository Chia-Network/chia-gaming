import { act, create, type ReactTestRenderer } from 'react-test-renderer';
// @ts-expect-error Node.js types are not included in the frontend TypeScript configuration.
import { readdirSync, readFileSync } from 'fs';
import CardContent from '@games/calpoker/ui/components/components/CardContent';
import {
  CARD_DECKS,
  cardArtUrl,
  cardDeck,
  CardDeckProvider,
  rankArtUrl,
} from '@games/host/cards/decks';
import { SpacePokerTable } from '@games/spacepoker/ui/SpacePokerTable';
import { CardDeckFooter, DeckCredit } from '../../components/CardDeckFooter';
import { useCardDeckPreference } from '../../hooks/useCardDeckPreference';

// @ts-expect-error Node.js globals are not included in the frontend configuration.
const CARDS = `${__dirname}/../../../public/images/cards`;
const SUITS = ['♠', '♥', '♦', '♣'] as const;
const RANKS = Array.from({ length: 13 }, (_, index) => index + 2);
const kingOfHearts = { rank: 13, suit: '♥' as const };

describe('card decks', () => {
  it.each(CARD_DECKS.filter(({ art }) => art))(
    '$name has art for exactly 52 cards and 13 ranks',
    (deck) => {
      const files = (urls: string[]) => urls.map((url) => url.split('/').at(-1));
      const cards = SUITS.flatMap((suit) => RANKS.map((rank) => cardArtUrl(deck, { rank, suit })!));
      expect([...files(cards), 'ranks'].sort()).toEqual(readdirSync(`${CARDS}/${deck.id}`).sort());
      const ranks = RANKS.map((rank) => rankArtUrl(deck, rank)!);
      expect(files(ranks).sort()).toEqual(readdirSync(`${CARDS}/${deck.id}/ranks`).sort());
    },
  );

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
      if (deck.art) {
        expect(info).toHaveLength(1);
        let credit!: ReactTestRenderer;
        act(() => {
          credit = create(<DeckCredit credit={deck.art!.credit} />);
        });
        const links = credit.root.findAllByType('a').map((link) => link.props.href);
        act(() => credit.unmount());
        const { artist, url, licenseUrl } = deck.art.credit;
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
    ['spacepoker', true],
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

  it('draws Space Poker cards without suits in the chosen deck', () => {
    const render = (id: string) => {
      let renderer!: ReactTestRenderer;
      act(() => {
        renderer = create(
          <CardDeckProvider value={cardDeck(id)}>
            <SpacePokerTable
              opponentName="Robin"
              playerName="Alex"
              opponentIndicator=""
              playerIndicator=""
              opponentStack={1n}
              playerStack={1n}
              pot={1n}
              opponentHoleCards={null}
              playerHoleCards={[13n, 10n]}
              opponentBoost={null}
              playerBoost={false}
              communityCards={[14n, null, null, null, null]}
              opponentHandDescription=""
              playerHandDescription=""
              opponentBanner={null}
              playerBanner={null}
              outcome={null}
              showPrivateShowdown={false}
              formatBet={String}
            />
          </CardDeckProvider>,
        );
      });
      return renderer;
    };
    const art = render('pixel');
    const images = art.root.findAllByType('img');
    expect(images.map(({ props }) => props.src)).toEqual([
      'images/cards/pixel/ranks/A.png',
      'images/cards/pixel/ranks/K.png',
      'images/cards/pixel/ranks/T.png',
    ]);
    expect(images.map(({ props }) => props.alt)).toEqual(['A', 'K', 'T']);
    act(() => images[0]!.props.onError());
    expect(art.root.findAllByType('img')).toHaveLength(2);
    act(() => art.unmount());

    const classic = render('classic');
    expect(classic.root.findAllByType('img')).toEqual([]);
    expect(classic.root.findAllByType('text')).toHaveLength(3);
    act(() => classic.unmount());
  });
});

describe('useCardDeckPreference', () => {
  const originals = ['window', 'localStorage'].map(
    (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  const stored = new Map<string, string>();
  let storageListeners: Set<(event: { key: string | null }) => void>;
  let blocked: boolean;

  beforeEach(() => {
    stored.clear();
    blocked = false;
    storageListeners = new Set();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => {
          if (blocked) throw new Error('storage is blocked');
          stored.set(key, value);
        },
      },
    });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        addEventListener: (_: string, listener: never) => storageListeners.add(listener),
        removeEventListener: (_: string, listener: never) => storageListeners.delete(listener),
      },
    });
  });
  afterEach(() => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });

  function mount() {
    const seen: { current: ReturnType<typeof useCardDeckPreference> | null } = { current: null };
    function Harness() {
      seen.current = useCardDeckPreference();
      return null;
    }
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<Harness />);
    });
    return { seen, unmount: () => act(() => renderer.unmount()) };
  }

  it('saves the deck in localStorage and shares it between mounted games', () => {
    const first = mount();
    const second = mount();
    expect(first.seen.current!.value).toBeUndefined();
    act(() => first.seen.current!.set('pixel'));
    expect(stored).toEqual(new Map([['chia-gaming:card-deck', 'pixel']]));
    expect(second.seen.current!.value).toBe('pixel');
    first.unmount();
    second.unmount();
    expect(storageListeners.size).toBe(0);

    const reopened = mount();
    expect(reopened.seen.current!.value).toBe('pixel');
    stored.set('chia-gaming:card-deck', 'icons');
    act(() => storageListeners.forEach((notify) => notify({ key: 'chia-gaming:card-deck' })));
    expect(reopened.seen.current!.value).toBe('icons');
    reopened.unmount();
  });

  it('keeps the choice for this page when storage is blocked', () => {
    const game = mount();
    blocked = true;
    act(() => game.seen.current!.set('pixel'));
    expect(game.seen.current!.value).toBe('pixel');
    expect(stored.size).toBe(0);
    blocked = false;
    act(() => game.seen.current!.set('icons'));
    expect(game.seen.current!.value).toBe('icons');
    game.unmount();
  });
});
