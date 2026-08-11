import { createElement, type ComponentProps } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { EMPTY } from 'rxjs';

jest.mock(
  '@/src/components/button',
  () => {
    const React = jest.requireActual<typeof import('react')>('react');
    return {
      Button: (props: ComponentProps<'button'>) => React.createElement('button', props),
    };
  },
  { virtual: true },
);
jest.mock('../../features/calPoker/components/components', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    HandDisplay: (props: Record<string, unknown>) => React.createElement('div', props),
    MovingCard: (props: Record<string, unknown>) => React.createElement('div', props),
  };
});

import CaliforniaPoker from '../../features/calPoker/components/CaliforniaPoker';
import { HandDisplay } from '../../features/calPoker/components/components';
import { GAME_STATES } from '../../features/calPoker/components/constants/constants';
import Krunk from '../../features/krunk/Krunk';
import { initialKrunkGameState, krunkStateCodec } from '../../features/krunk/stateCodec';
import SpacePoker from '../../features/spacePoker/SpacePoker';
import { spacepokerStateCodec } from '../../features/spacePoker/stateCodec';
import { terminalGameHandSource } from '../gameMount';
import type { GameTerminalModel } from '../session/types';

const NO_TERMINAL: GameTerminalModel = {
  type: 'none',
  outcome: null,
  label: null,
  myReward: null,
  rewardCoinHex: null,
};

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
            interactionMode: 'terminal',
          }),
        );
      });
    }).not.toThrow();

    expect(protocolMutation).not.toHaveBeenCalled();
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
          interactionMode: 'terminal',
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
      games: {
        alice: initialKrunkGameState('alice'),
        bob: initialKrunkGameState('bob'),
      },
    });

    act(() => {
      renderer = create(
        createElement(Krunk, {
          handSource: terminalGameHandSource(handState),
          currentHandGameIds: ['alice', 'bob'],
          activeGameIds: [],
          iProposedHand: true,
          gameplayEvent$: EMPTY,
          betSize: 100n,
          onTurnChanged: () => {
            throw new Error('turn change invoked');
          },
          onGameLog: () => {},
          terminalsById: { alice: NO_TERMINAL, bob: NO_TERMINAL },
          amountsById: { alice: '100', bob: '100' },
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
      gameState: { handler: 2n, myTurn: true, N: 4n },
      playerHoleCards: null,
      playerBoost: false,
      opponentHoleCards: null,
      opponentBoost: null,
      communityCards: [null, null, null, null, null],
      halfPot: 10n,
      lastRaise: 0n,
      iRaisedLast: false,
      handHistory: [],
      outcome: null,
      terminalState: 'none',
      terminalRecovery: null,
      pendingTerminalAction: null,
      coinTossIOpen: true,
      unitSizeMojos: 10n,
      displayMode: 'mojos',
    });

    act(() => {
      renderer = create(
        createElement(SpacePoker, {
          handSource: terminalGameHandSource(handState),
          gameId: 'space',
          iStarted: true,
          gameplayEvent$: EMPTY,
          betSize: '100',
          unitSizeMojos: '10',
          onTurnChanged: () => {
            throw new Error('turn change invoked');
          },
          onGameLog: () => {},
          terminal: NO_TERMINAL,
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
