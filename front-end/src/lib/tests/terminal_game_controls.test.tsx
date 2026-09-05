import { createElement, type ComponentProps } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

jest.mock(
  '@/components/button',
  () => {
    const React = jest.requireActual<typeof import('react')>('react');
    return {
      Button: (props: ComponentProps<'button'>) => React.createElement('button', props),
    };
  },
  { virtual: true },
);
jest.mock('@games/calpoker/ui/components/components', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    HandDisplay: (props: Record<string, unknown>) => React.createElement('div', props),
    MovingCard: (props: Record<string, unknown>) => React.createElement('div', props),
  };
});

import CaliforniaPoker from '@games/calpoker/ui/components/CaliforniaPoker';
import { HandDisplay } from '@games/calpoker/ui/components/components';
import { GAME_STATES } from '@games/calpoker/ui/components/constants/constants';
import Krunk from '@games/krunk/ui/Krunk';
import {
  initialKrunkGameState,
  krunkStateCodec,
  restoreKrunkHand,
} from '@games/krunk/ui/serialize';
import SpacePoker from '@games/spacepoker/ui/SpacePoker';
import { restoreSpacepokerHand, spacepokerStateCodec } from '@games/spacepoker/ui/serialize';
import { UncaughtClientErrorReporter } from '../../components/GameSession';
import { markClientErrorReported } from '../clientError';

describe('terminal game controls', () => {
  let renderer: ReactTestRenderer | null = null;
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const originalWindow = globalThis.window;

  beforeAll(() => {
    globalThis.requestAnimationFrame = () => 0;
    globalThis.cancelAnimationFrame = () => {};
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
      },
    });
  });

  afterEach(() => {
    if (renderer) act(() => renderer?.unmount());
    renderer = null;
  });

  afterAll(() => {
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: originalWindow,
    });
  });

  it('does not initialize or persist a cold terminal Cal Poker mount', () => {
    const protocolMutation = jest.fn(() => {
      throw new Error('terminal protocol callback invoked');
    });

    expect(() => {
      act(() => {
        renderer = create(
          createElement(CaliforniaPoker, {
            moveNumber: '0',
            playerNumber: 1,
            playerHand: [],
            opponentHand: [],
            cardSelections: [],
            setCardSelections: protocolMutation,
            setHandOrder: protocolMutation,
            handleMakeMove: protocolMutation,
            outcome: undefined,
            onGameLog: protocolMutation,
            onSnapshotChange: protocolMutation,
            frozen: true,
          }),
        );
      });
    }).not.toThrow();

    expect(protocolMutation).not.toHaveBeenCalled();
  });

  it('shows unreported browser errors without duplicating session-reported errors', async () => {
    const listeners = new Map<string, EventListenerOrEventListenerObject>();
    (window.addEventListener as jest.Mock).mockImplementation(
      (type: string, listener: EventListenerOrEventListenerObject) => {
        listeners.set(type, listener);
      },
    );
    act(() => {
      renderer = create(createElement(UncaughtClientErrorReporter));
    });
    const emitError = async (error: Error) => {
      const listener = listeners.get('error');
      if (typeof listener !== 'function') throw new Error('error listener was not installed');
      await act(async () => {
        listener({ error, message: error.message } as unknown as Event);
        await Promise.resolve();
      });
    };

    const alreadyReported = new Error('already visible through the session');
    markClientErrorReported(alreadyReported);
    await emitError(alreadyReported);
    expect(renderer!.root.findAllByProps({ role: 'alertdialog' })).toHaveLength(0);

    await emitError(new Error('uncaught browser failure'));
    expect(renderer!.root.findByProps({ role: 'alertdialog' })).toBeDefined();
    expect(renderer!.root.findByType('pre').children.join('')).toContain(
      'uncaught browser failure',
    );
  });

  it('disables Cal Poker selection, reorder, and submit controls', () => {
    act(() => {
      renderer = create(
        createElement(CaliforniaPoker, {
          moveNumber: '1',
          playerNumber: 1,
          playerHand: ['1', '2', '3', '4', '5', '6', '7', '8'],
          opponentHand: [],
          cardSelections: ['1', '2', '3', '4'],
          setCardSelections: () => {
            throw new Error('selection invoked');
          },
          setHandOrder: () => {
            throw new Error('reorder invoked');
          },
          handleMakeMove: () => {
            throw new Error('move invoked');
          },
          outcome: undefined,
          onGameLog: () => {},
          onSnapshotChange: () => {
            throw new Error('snapshot invoked');
          },
          initialSnapshot: {
            gameState: GAME_STATES.SELECTING,
            winner: null,
            playerBestHandCardIds: [],
            opponentBestHandCardIds: [],
            playerHaloCardIds: [],
            opponentHaloCardIds: [],
            playerDisplayText: '',
            opponentDisplayText: '',
          },
          frozen: true,
        }),
      );
    });

    const playerHand = renderer!.root
      .findAllByType(HandDisplay)
      .find((display) => display.props.area === 'player');
    expect(playerHand?.props.onCardClick).toBeUndefined();
    expect(playerHand?.props.onReorder).toBeUndefined();
    expect(renderer!.root.findByType('button').props.disabled).toBe(true);
  });

  it('disables Krunk keyboard and submit controls', () => {
    const handState = krunkStateCodec.encode({
      perPlayerStake: 100n,
      members: [initialKrunkGameState('alice'), initialKrunkGameState('bob')],
    });

    act(() => {
      renderer = create(
        createElement(Krunk, {
          view: {
            frozen: true,
            hand: restoreKrunkHand(krunkStateCodec.decode(handState)!),
          },
          onGameLog: () => {},
        }),
      );
    });

    expect(renderer!.root.findAllByType('button')).not.toHaveLength(0);
    expect(renderer!.root.findAllByType('button').every((button) => button.props.disabled)).toBe(
      true,
    );
  });

  it('freezes Space Poker protocol controls but keeps display toggles usable', () => {
    const handState = spacepokerStateCodec.encode({
      gameId: 'space',
      perPlayerStake: 50n,
      gameState: { handler: 2n, myTurn: true, N: 4n },
      playerHoleCards: [2n, 3n],
      playerBoost: false,
      opponentHoleCards: [4n, 5n],
      opponentBoost: false,
      communityCards: [6n, 7n, 8n, null, null],
      halfPot: 10n,
      lastRaise: 0n,
      iRaisedLast: false,
      handHistory: [{ player: 'you', action: 'raise', units: 2n }],
      outcome: null,
      terminalState: 'none',
      coinTossIOpen: true,
      unitSizeMojos: 10n,
      settlementOutcome: null,
      displayMode: 'mojos',
      error: null,
    });

    act(() => {
      renderer = create(
        createElement(SpacePoker, {
          view: {
            frozen: true,
            hand: restoreSpacepokerHand(spacepokerStateCodec.decode(handState)!),
          },
          onGameLog: () => {},
        }),
      );
    });

    const buttons = renderer!.root.findAllByType('button');
    const displayButtons = buttons.filter((button) =>
      ['XCH', 'mojos', 'units'].includes(button.children[0]),
    );
    const protocolButtons = buttons.filter((button) => !displayButtons.includes(button));
    expect(displayButtons).toHaveLength(3);
    expect(displayButtons.every((button) => !button.props.disabled)).toBe(true);
    expect(protocolButtons).not.toHaveLength(0);
    expect(protocolButtons.every((button) => button.props.disabled)).toBe(true);
    expect(() => act(() => displayButtons[0].props.onClick())).not.toThrow();
  });
});
