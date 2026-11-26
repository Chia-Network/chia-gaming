import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { GameRules } from '../../components/GameRules';
import { packageFor, REGISTERED_GAMES } from '../gameRegistry';

describe('game rules', () => {
  it.each(REGISTERED_GAMES)('$displayName explains the goal and how to play', ({ gameType }) => {
    const { rules } = packageFor(gameType);
    expect(rules.map(({ heading }) => heading)).toEqual(
      expect.arrayContaining(['Goal', 'How to play']),
    );
    for (const { items } of rules) expect(items.length).toBeGreaterThan(0);
  });

  it('links the Krunk word list, and draws links in the rules', () => {
    const item = packageFor('krunk')
      .rules.flatMap(({ items }) => items)
      .find((rule) => typeof rule !== 'string');
    expect(item).toMatchObject({
      link: { url: expect.stringMatching(/games\/krunk\/clsp\/krunkwords\.txt$/) },
    });
  });

  it('explains Space Poker boosts and its turn order', () => {
    const headings = packageFor('spacepoker').rules.map(({ heading }) => heading);
    expect(headings).toEqual(
      expect.arrayContaining(['Who goes first', 'Boosted hands', 'Why it works this way']),
    );
  });

  it('offers the rules of the current game', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<GameRules gameType="krunk" />);
    });
    expect(renderer.root.findByType('button').props.children).toBe('Rules?');
    act(() => renderer.unmount());
  });
});
