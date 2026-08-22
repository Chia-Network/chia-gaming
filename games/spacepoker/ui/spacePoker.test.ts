import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import {
  EMPTY_GAME_TERMINAL_MODEL,
  terminalGameHandSource,
  type GameIntent,
  type GameHandSource,
  type LiveGamePort,
  type PersistedGameState,
} from '../../host';
import SpacePoker from './SpacePoker';
import { reduceSpacepokerDurableState, reduceSpacepokerSettlementState } from './handProposal';
import { spacePokerRankLabel } from './handPresentation';
import {
  spacePokerFooterStatus,
  spacePokerTerminalBanners,
  spacePokerTerminalCommentary,
  spacePokerTransitionCommentary,
} from './statusPresentation';
import { spacepokerStateCodec, type SpacepokerHandState } from './serialize';
import {
  isTerminalSpacepokerHandler,
  SpHandler,
  useSpacepokerHand,
  type UseSpacepokerHandResult,
} from './useSpacepokerHand';

function handState(overrides: Partial<SpacepokerHandState> = {}): SpacepokerHandState {
  return {
    gameState: { handler: SpHandler.MidRound, myTurn: true, N: 3n },
    playerHoleCards: [1n, 2n],
    playerBoost: false,
    opponentHoleCards: null,
    opponentBoost: null,
    communityCards: [3n, 4n, 5n, null, null],
    halfPot: 1n,
    lastRaise: 0n,
    iRaisedLast: false,
    handHistory: [],
    outcome: null,
    terminalState: 'none',
    coinTossIOpen: true,
    unitSizeMojos: 10n,
    displayMode: 'units',
    error: null,
    ...overrides,
  };
}

function liveSource(port: LiveGamePort, state: PersistedGameState): GameHandSource {
  return { interactionMode: 'live', handState: state, port };
}

describe('Space Poker terminal UX', () => {
  it('uses a single-character ten rank and recognizes terminal handlers', () => {
    expect(spacePokerRankLabel(10n)).toBe('T');
    expect(isTerminalSpacepokerHandler(SpHandler.Folded)).toBe(true);
    expect(isTerminalSpacepokerHandler(SpHandler.Showdown)).toBe(true);
    expect(isTerminalSpacepokerHandler(SpHandler.End)).toBe(false);
  });

  it('presents terminal outcomes without stale turn text', () => {
    expect(spacePokerFooterStatus(SpHandler.Showdown, 'Your turn')).toBe('');
    expect(spacePokerTransitionCommentary(SpHandler.End, false)).toBe(
      'Waiting for opponent to finish…',
    );
    expect(spacePokerTerminalCommentary('revealed', 1n, 'settled_cleanly')).toBe(
      'You won at showdown.',
    );
    expect(spacePokerTerminalCommentary('settled', null, 'opponent_timed_out')).toBe(
      'Opponent timed out.',
    );
    expect(spacePokerTerminalBanners('won-by-opponent-failure', null)).toEqual({
      player: 'win',
      opponent: null,
    });
  });

  it('preserves accepted fold and reveal presentation through settlement reduction', () => {
    const folded = handState({
      gameState: { handler: SpHandler.Folded, myTurn: false, N: 3n },
      handHistory: [{ player: 'you', action: 'fold' }],
      terminalState: 'folded-by-you',
    });
    expect(reduceSpacepokerSettlementState(folded, 'we_accepted')).toEqual(folded);

    const revealed = handState({
      gameState: { handler: SpHandler.Showdown, myTurn: false, N: 1n },
      outcome: {
        result: 1n,
        playerHandCards: [],
        playerHandEval: [],
        opponentHandCards: [],
        opponentHandEval: [],
      },
      handHistory: [{ player: 'you', action: 'reveal' }],
      terminalState: 'revealed',
    });
    expect(reduceSpacepokerSettlementState(revealed, 'settled_cleanly')).toEqual(revealed);
  });

  it('reduces current opponent input directly into durable state', () => {
    const current = handState({ gameState: { handler: SpHandler.CommitA, myTurn: false, N: 4n } });
    const next = reduceSpacepokerDurableState(current, {
      type: 'opponent-moved',
      gameId: '7',
      readable: new Uint8Array(),
      moverShare: '0',
      iStarted: false,
    });
    expect(next?.gameState).toEqual({ handler: SpHandler.CommitB, myTurn: true, N: 4n });
  });
});

describe('Space Poker machine-owned hand state', () => {
  let renderer: ReactTestRenderer | null = null;
  const originalWindow = globalThis.window;

  beforeAll(() => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { addEventListener: jest.fn(), removeEventListener: jest.fn() },
    });
  });
  afterEach(() => {
    if (renderer) act(() => renderer?.unmount());
    renderer = null;
  });
  afterAll(() => {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
  });

  it('derives each player stack and maximum opening raise from half the game amount', () => {
    const persisted = spacepokerStateCodec.encode(
      handState({
        gameState: { handler: SpHandler.BeginRound, myTurn: true, N: 4n },
        unitSizeMojos: 1n,
      }),
    );
    const dispatch = jest.fn();
    const port = { isChannelReady: () => true, dispatch } as unknown as LiveGamePort;
    let hand: UseSpacepokerHandResult | undefined;

    function Harness() {
      hand = useSpacepokerHand(
        liveSource(port, persisted),
        '7',
        20n,
        1n,
        EMPTY_GAME_TERMINAL_MODEL,
      );
      return null;
    }

    act(() => {
      renderer = create(React.createElement(Harness));
    });
    expect(hand?.playerStack).toBe(9n);
    expect(hand?.opponentStack).toBe(9n);

    act(() => hand!.handleRaise(hand!.playerStack));
    const intent = dispatch.mock.calls[0][0] as Extract<
      GameIntent<SpacepokerHandState>,
      { type: 'make-move' }
    >;
    expect(intent.readable?.toBigInt()).toBe(9n);
  });

  it('preserves delayed canonical gameplay state and displays the rejection', () => {
    const current = handState();
    const next = reduceSpacepokerDurableState(current, {
      type: 'move-rejected',
      gameId: '7',
      tag: 'ui_protocol_mismatch',
      message: 'Space Poker move was rejected.',
    });
    expect(next).toEqual({
      ...current,
      error: { tag: 'ui_protocol_mismatch', message: 'Space Poker move was rejected.' },
    });

    const port = { isChannelReady: () => true, dispatch: jest.fn() } as LiveGamePort;
    act(() => {
      renderer = create(
        React.createElement(SpacePoker, {
          handSource: liveSource(port, spacepokerStateCodec.encode(next!)),
          gameId: '7',
          betSize: '100',
          unitSizeMojos: '10',
          terminal: EMPTY_GAME_TERMINAL_MODEL,
        }),
      );
    });
    expect(
      renderer!.root.findAll((node) => node.props.children === 'Space Poker move was rejected.'),
    ).toHaveLength(1);
  });

  it('clears rejection feedback in the next valid local move candidate', () => {
    const persisted = spacepokerStateCodec.encode(
      handState({ error: { tag: 'ui_protocol_mismatch', message: 'Rejected.' } }),
    );
    let candidate: SpacepokerHandState | null = null;
    const port = {
      isChannelReady: () => true,
      dispatch: (intent: GameIntent<SpacepokerHandState>) => {
        candidate = intent.state;
      },
    } as LiveGamePort;
    let hand: UseSpacepokerHandResult | undefined;
    function Harness() {
      hand = useSpacepokerHand(
        liveSource(port, persisted),
        '7',
        100n,
        10n,
        EMPTY_GAME_TERMINAL_MODEL,
      );
      return null;
    }

    act(() => {
      renderer = create(React.createElement(Harness));
    });
    act(() => hand!.handleCheck());

    expect(candidate).toMatchObject({ error: null });
  });

  it('leaves render state unchanged when a local command is rejected', () => {
    const persisted = spacepokerStateCodec.encode(handState());
    let rejected: GameIntent<SpacepokerHandState> | null = null;
    const port = {
      isChannelReady: () => true,
      dispatch: (intent: GameIntent<SpacepokerHandState>) => {
        rejected = intent;
        throw new Error('check rejected');
      },
    } as unknown as LiveGamePort;
    let hand: UseSpacepokerHandResult | undefined;

    function Harness() {
      hand = useSpacepokerHand(
        liveSource(port, persisted),
        '7',
        100n,
        10n,
        EMPTY_GAME_TERMINAL_MODEL,
      );
      return null;
    }

    act(() => {
      renderer = create(React.createElement(Harness));
    });
    expect(() => act(() => hand?.handleCheck())).toThrow('check rejected');
    expect(rejected).toMatchObject({
      type: 'make-move',
      gameId: '7',
      state: {
        gameState: { handler: SpHandler.MidRound, myTurn: false, N: 3n },
        handHistory: [{ player: 'you', action: 'check' }],
      },
    });
    act(() => renderer?.update(React.createElement(Harness)));
    expect(hand?.gameState).toEqual({ handler: SpHandler.MidRound, myTurn: true, N: 3n });
    expect(hand?.handHistory).toEqual([]);
  });

  it('commits an accepted codec-valid fold candidate through the live port', () => {
    let persisted = spacepokerStateCodec.encode(handState());
    const committed: GameIntent<SpacepokerHandState>[] = [];
    const port = {
      isChannelReady: () => true,
      dispatch: (intent: GameIntent<SpacepokerHandState>) => {
        committed.push(intent);
        persisted = spacepokerStateCodec.encode(intent.state);
      },
    } as unknown as LiveGamePort;
    let hand: UseSpacepokerHandResult | undefined;

    function Harness() {
      hand = useSpacepokerHand(
        liveSource(port, persisted),
        '7',
        100n,
        10n,
        EMPTY_GAME_TERMINAL_MODEL,
      );
      return null;
    }
    act(() => {
      renderer = create(React.createElement(Harness));
    });
    act(() => hand?.handleFold());

    expect(committed).toHaveLength(1);
    expect(committed[0]).toMatchObject({ type: 'accept-settlement', gameId: '7' });
    expect(spacepokerStateCodec.isState(committed[0].state)).toBe(true);
    expect(committed[0].state).toMatchObject({
      gameState: { handler: SpHandler.Folded, myTurn: false, N: 3n },
      handHistory: [{ player: 'you', action: 'fold' }],
      terminalState: 'folded-by-you',
    });
    act(() => renderer?.update(React.createElement(Harness)));
    expect(hand?.gameState).toEqual({ handler: SpHandler.Folded, myTurn: false, N: 3n });
    expect(hand?.handHistory).toEqual([{ player: 'you', action: 'fold' }]);
    expect(hand?.terminalState).toBe('folded-by-you');
  });

  it('decodes the current hand source again on every render', () => {
    const port = { isChannelReady: () => true, dispatch: jest.fn() } as LiveGamePort;
    let persisted = spacepokerStateCodec.encode(handState());
    let hand: UseSpacepokerHandResult | undefined;

    function Harness() {
      hand = useSpacepokerHand(
        liveSource(port, persisted),
        '7',
        100n,
        10n,
        EMPTY_GAME_TERMINAL_MODEL,
      );
      return null;
    }
    act(() => {
      renderer = create(React.createElement(Harness));
    });
    expect(hand?.lastRaise).toBe(0n);

    persisted = spacepokerStateCodec.encode(
      handState({
        lastRaise: 4n,
        handHistory: [{ player: 'opponent', action: 'raise', units: 4n }],
      }),
    );
    act(() => renderer?.update(React.createElement(Harness)));
    expect(hand?.lastRaise).toBe(4n);
    expect(hand?.handHistory).toEqual([{ player: 'opponent', action: 'raise', units: 4n }]);
  });

  it('does not expose protocol actions from a terminal hand source', () => {
    const source = terminalGameHandSource(spacepokerStateCodec.encode(handState()));
    act(() => {
      renderer = create(
        React.createElement(SpacePoker, {
          handSource: source,
          gameId: '7',
          betSize: '100',
          unitSizeMojos: '10',
          onGameLog: jest.fn(),
          terminal: EMPTY_GAME_TERMINAL_MODEL,
        }),
      );
    });
    const actionButtons = renderer!.root
      .findAllByType('button')
      .filter((button) => ['Check', 'Raise', 'Fold'].includes(String(button.children[0])));
    expect(actionButtons.length).toBeGreaterThan(0);
    expect(actionButtons.every((button) => button.props.disabled)).toBe(true);
  });
});
