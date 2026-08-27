import { Program } from 'clvm-lib';
import {
  isSettlementOutcome,
  type GameHand,
  type GameHandInitialization,
  type GameUpdate,
  type PersistedGameState,
  type SettlementOutcome,
} from '../../host';
import { spacepokerProposalParameters } from './unitSize';

function isForfeitOutcome(outcome: SettlementOutcome): boolean {
  return outcome === 'forfeited_skipped_reveal' || outcome === 'forfeited_we_accepted';
}

export type SpacepokerDisplayMode = 'xch' | 'mojos' | 'units';
export type SpHandler = 0n | 1n | 2n | 3n | 4n | 5n | 6n;
export interface SpGameState {
  handler: SpHandler;
  myTurn: boolean;
  N: bigint;
}
export interface SpHandEntry {
  player: 'you' | 'opponent';
  action: 'check' | 'raise' | 'call' | 'fold' | 'concede' | 'reveal' | 'failed';
  units?: bigint;
  endsStreet?: boolean;
}
export interface SpOutcome {
  result: bigint;
  playerHandCards: bigint[];
  playerHandEval: bigint[];
  opponentHandCards: bigint[] | null;
  opponentHandEval: bigint[] | null;
}
export type SpTerminalState =
  | 'none'
  | 'settled'
  | 'revealed'
  | 'conceded-by-you'
  | 'conceded-by-opponent'
  | 'folded-by-you'
  | 'folded-by-opponent'
  | 'won-by-opponent-failure';

export interface SpacepokerHandState {
  perPlayerStake: bigint;
  gameState: SpGameState;
  playerHoleCards: [bigint, bigint] | null;
  playerBoost: boolean;
  opponentHoleCards: [bigint, bigint] | null;
  opponentBoost: boolean | null;
  communityCards: (bigint | null)[];
  halfPot: bigint;
  lastRaise: bigint;
  iRaisedLast: boolean;
  handHistory: SpHandEntry[];
  outcome: SpOutcome | null;
  terminalState: SpTerminalState;
  coinTossIOpen: boolean | null;
  unitSizeMojos: bigint;
  settlementOutcome: SettlementOutcome | null;
  displayMode: SpacepokerDisplayMode;
}

export interface SpacepokerHand extends GameHand<SpacepokerHandState> {
  update(reducer: (current: SpacepokerHandState) => SpacepokerHandState): void;
}

/** Test/helper envelope only; persistence treats the state as opaque. */
export const spacepokerStateCodec = {
  gameType: 'spacepoker',
  encode: (state: SpacepokerHandState): PersistedGameState<SpacepokerHandState> => ({
    gameType: 'spacepoker',
    state,
  }),
  decode: (value: unknown): SpacepokerHandState | null =>
    typeof value === 'object' &&
    value !== null &&
    (value as Partial<PersistedGameState>).gameType === 'spacepoker'
      ? ((value as PersistedGameState<SpacepokerHandState>).state ?? null)
      : null,
};

const HANDLERS = new Set([0n, 1n, 2n, 3n, 4n, 5n, 6n]);
const TERMINALS = new Set([
  'none',
  'settled',
  'revealed',
  'conceded-by-you',
  'conceded-by-opponent',
  'folded-by-you',
  'folded-by-opponent',
  'won-by-opponent-failure',
]);
const DISPLAY_MODES = new Set(['xch', 'mojos', 'units']);
const ACTIONS = new Set(['check', 'raise', 'call', 'fold', 'concede', 'reveal', 'failed']);

function isCardPair(value: unknown): value is [bigint, bigint] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every((card) => typeof card === 'bigint' && card >= 0n && card < 52n)
  );
}

function isGameState(value: unknown): value is SpGameState {
  if (typeof value !== 'object' || value === null) return false;
  const state = value as Partial<SpGameState>;
  if (
    typeof state.handler !== 'bigint' ||
    !HANDLERS.has(state.handler) ||
    typeof state.myTurn !== 'boolean' ||
    typeof state.N !== 'bigint'
  ) {
    return false;
  }
  const validN =
    (state.handler <= 1n && state.N === 4n) ||
    ((state.handler === 2n || state.handler === 3n) && state.N >= 1n && state.N <= 4n) ||
    (state.handler === 4n && state.N === 1n) ||
    (state.handler === 5n && (state.N === 0n || state.N === 1n)) ||
    (state.handler === 6n && state.N >= 1n && state.N <= 4n);
  return validN && (!isTerminalHandler(state.handler) || state.myTurn === false);
}

function isTerminalHandler(handler: bigint): boolean {
  return handler === 5n || handler === 6n;
}

function isHistory(value: unknown): value is SpHandEntry[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => {
      if (typeof entry !== 'object' || entry === null) return false;
      const item = entry as Partial<SpHandEntry>;
      const hasUnits = typeof item.units === 'bigint' && item.units > 0n;
      return (
        (item.player === 'you' || item.player === 'opponent') &&
        typeof item.action === 'string' &&
        ACTIONS.has(item.action) &&
        (item.action === 'raise' ? hasUnits : item.units === undefined) &&
        (item.endsStreet === undefined ||
          (item.action === 'check' && typeof item.endsStreet === 'boolean'))
      );
    })
  );
}

function isOutcome(value: unknown): value is SpOutcome {
  if (typeof value !== 'object' || value === null) return false;
  const outcome = value as Partial<SpOutcome>;
  const bigints = (cards: unknown) =>
    Array.isArray(cards) && cards.every((card) => typeof card === 'bigint');
  const cards = (value: unknown) =>
    Array.isArray(value) &&
    value.every((card) => typeof card === 'bigint' && card >= 0n && card < 52n);
  return (
    typeof outcome.result === 'bigint' &&
    cards(outcome.playerHandCards) &&
    bigints(outcome.playerHandEval) &&
    (outcome.opponentHandCards === null || cards(outcome.opponentHandCards)) &&
    (outcome.opponentHandEval === null || bigints(outcome.opponentHandEval)) &&
    (outcome.opponentHandCards === null) === (outcome.opponentHandEval === null)
  );
}

export function isSpacepokerHandState(value: unknown): value is SpacepokerHandState {
  if (typeof value !== 'object' || value === null) return false;
  const state = value as Partial<SpacepokerHandState>;
  if (
    typeof state.perPlayerStake !== 'bigint' ||
    state.perPlayerStake <= 0n ||
    !isGameState(state.gameState) ||
    (state.playerHoleCards !== null && !isCardPair(state.playerHoleCards)) ||
    (state.opponentHoleCards !== null && !isCardPair(state.opponentHoleCards)) ||
    !Array.isArray(state.communityCards) ||
    state.communityCards.length !== 5 ||
    !state.communityCards.every(
      (card) => card === null || (typeof card === 'bigint' && card >= 0n && card < 52n),
    )
  ) {
    return false;
  }
  if (typeof state.terminalState !== 'string' || !TERMINALS.has(state.terminalState)) return false;
  const terminalHandlerMatches =
    state.terminalState === 'none' ||
    (state.terminalState === 'settled' && state.gameState.handler === 6n) ||
    (state.terminalState === 'revealed' && state.gameState.handler === 5n) ||
    ((state.terminalState === 'conceded-by-you' ||
      state.terminalState === 'conceded-by-opponent') &&
      state.gameState.handler === 5n) ||
    ((state.terminalState === 'folded-by-you' || state.terminalState === 'folded-by-opponent') &&
      state.gameState.handler === 6n) ||
    (state.terminalState === 'won-by-opponent-failure' && state.gameState.handler === 6n);
  if (!terminalHandlerMatches) return false;
  if (state.terminalState === 'revealed' && state.outcome === null) return false;
  return (
    typeof state.playerBoost === 'boolean' &&
    (state.opponentBoost === null || typeof state.opponentBoost === 'boolean') &&
    typeof state.halfPot === 'bigint' &&
    state.halfPot >= 0n &&
    typeof state.lastRaise === 'bigint' &&
    state.lastRaise >= 0n &&
    typeof state.iRaisedLast === 'boolean' &&
    isHistory(state.handHistory) &&
    (state.outcome === null || isOutcome(state.outcome)) &&
    (state.coinTossIOpen === null || typeof state.coinTossIOpen === 'boolean') &&
    typeof state.unitSizeMojos === 'bigint' &&
    state.unitSizeMojos > 0n &&
    (state.settlementOutcome === null || isSettlementOutcome(state.settlementOutcome)) &&
    typeof state.displayMode === 'string' &&
    DISPLAY_MODES.has(state.displayMode)
  );
}

function initialState(
  init: GameHandInitialization,
  unitSizeMojos: bigint,
): SpacepokerHandState {
  const member = init.members[0]!;
  if (
    member.playerAContribution <= 0n ||
    member.playerAContribution !== member.playerBContribution
  ) {
    throw new Error('Space Poker requires equal positive approved contributions');
  }
  return {
    perPlayerStake: member.playerAContribution,
    gameState: { handler: 0n, myTurn: member.ourTurn, N: 4n },
    playerHoleCards: null,
    playerBoost: false,
    opponentHoleCards: null,
    opponentBoost: null,
    communityCards: [null, null, null, null, null],
    halfPot: 1n,
    lastRaise: 0n,
    iRaisedLast: false,
    handHistory: [],
    outcome: null,
    terminalState: 'none',
    coinTossIOpen: null,
    unitSizeMojos,
    settlementOutcome: null,
    displayMode: unitSizeMojos >= 1_000_000n ? 'xch' : 'mojos',
  };
}

function parseReadable(readable: Uint8Array): Program[] {
  try {
    return Program.deserialize(readable).toList();
  } catch {
    return [];
  }
}

function tag(items: Program[]): string | null {
  if (items.length === 0) return null;
  try {
    return new TextDecoder().decode(items[0].atom);
  } catch {
    return null;
  }
}

function appendHistory(current: SpacepokerHandState, entry: SpHandEntry): SpacepokerHandState {
  return { ...current, handHistory: [...current.handHistory, entry] };
}

function withLocalConcession(current: SpacepokerHandState): SpacepokerHandState {
  const last = current.handHistory[current.handHistory.length - 1];
  const replacesTerminalAction =
    last?.player === 'you' &&
    (last.action === 'fold' ||
      last.action === 'concede' ||
      last.action === 'reveal' ||
      last.action === 'failed');
  if (last?.player === 'you' && last.action === 'concede') return current;
  return {
    ...current,
    handHistory: replacesTerminalAction
      ? [...current.handHistory.slice(0, -1), { player: 'you', action: 'concede' }]
      : [...current.handHistory, { player: 'you', action: 'concede' }],
  };
}

type SpacepokerReadableEvent =
  | { type: 'opponent-moved'; readable: Uint8Array }
  | { type: 'game-message'; readable: Uint8Array };

function reduceSpacepokerSettlementStateCore(
  current: SpacepokerHandState,
  outcome: SettlementOutcome,
): SpacepokerHandState {
  const voluntary = outcome === 'accept_settlement' || outcome === 'we_accepted';
  if (isForfeitOutcome(outcome) && current.outcome !== null) {
    return withLocalConcession({
      ...current,
      gameState: { handler: 5n, myTurn: false, N: 1n },
      terminalState: 'conceded-by-you',
    });
  }
  if (outcome === 'opponent_timed_out' && current.terminalState === 'none') {
    if (current.outcome !== null && current.outcome.result > 0n) {
      return appendHistory(
        {
          ...current,
          gameState: { handler: 5n, myTurn: false, N: 1n },
          terminalState: 'conceded-by-opponent',
        },
        { player: 'opponent', action: 'concede' },
      );
    }
    return appendHistory(
      {
        ...current,
        gameState: {
          handler: 6n,
          myTurn: false,
          N: current.gameState.N >= 1n ? current.gameState.N : 1n,
        },
        terminalState: 'won-by-opponent-failure',
      },
      { player: 'opponent', action: 'failed' },
    );
  }
  if (current.terminalState === 'revealed' && current.outcome !== null) {
    return {
      ...current,
      gameState: { ...current.gameState, myTurn: false },
    };
  }
  if (voluntary && current.terminalState !== 'none') {
    return {
      ...current,
      gameState: { ...current.gameState, myTurn: false },
    };
  }
  if (voluntary && (current.gameState.handler === 3n || current.gameState.handler === 4n)) {
    const player = outcome === 'we_accepted' || current.gameState.myTurn ? 'you' : 'opponent';
    const action = current.gameState.handler === 3n ? 'fold' : 'concede';
    return appendHistory(
      {
        ...current,
        gameState:
          action === 'fold'
            ? { handler: 6n, myTurn: false, N: current.gameState.N }
            : { handler: 5n, myTurn: false, N: 0n },
        terminalState:
          action === 'fold'
            ? player === 'you'
              ? 'folded-by-you'
              : 'folded-by-opponent'
            : player === 'you'
              ? 'conceded-by-you'
              : 'conceded-by-opponent',
      },
      { player, action },
    );
  }
  return {
    ...current,
    gameState: {
      handler: 6n,
      myTurn: false,
      N: current.gameState.N >= 1n ? current.gameState.N : 1n,
    },
    outcome: null,
    terminalState: 'settled',
  };
}

export function reduceSpacepokerSettlementState(
  current: SpacepokerHandState,
  outcome: SettlementOutcome,
): SpacepokerHandState {
  return reduceSpacepokerSettlementStateCore(current, outcome);
}

function bigints(program: Program): bigint[] {
  try {
    return program.toList().map((item) => item.toBigInt());
  } catch {
    return [];
  }
}

function placeCards(
  current: SpacepokerHandState,
  position: bigint,
  cards: bigint[],
): SpacepokerHandState {
  const communityCards = [...current.communityCards];
  const start = position === 3n ? 0 : position === 2n ? 3 : 4;
  cards.forEach((card, index) => {
    communityCards[start + index] = card;
  });
  return { ...current, communityCards };
}

function outcomeFrom(
  playerCards: Program,
  playerEval: Program,
  opponentCards: Program,
  opponentEval: Program,
  result: Program,
) {
  return {
    result: result.toBigInt(),
    playerHandCards: bigints(playerCards),
    playerHandEval: bigints(playerEval),
    opponentHandCards: bigints(opponentCards),
    opponentHandEval: bigints(opponentEval),
  };
}

export function reduceSpacepokerFeatureState(
  current: SpacepokerHandState,
  event: SpacepokerReadableEvent,
): SpacepokerHandState {
  const items = parseReadable(event.readable);
  const readableTag = tag(items);
  if (!readableTag) {
    return event.type === 'opponent-moved'
      ? { ...current, gameState: { handler: 1n, myTurn: true, N: 4n } }
      : current;
  }

  if (event.type === 'game-message') {
    if (readableTag === 'deal' && items.length >= 4) {
      return {
        ...current,
        playerHoleCards: [items[1].toBigInt(), items[2].toBigInt()],
        playerBoost: items[3].toBigInt() !== 0n,
        coinTossIOpen: items.length >= 5 ? items[4].toBigInt() !== 0n : current.coinTossIOpen,
      };
    }
    if (readableTag === 'cards' && items.length > 1) {
      const cards = items.slice(1).map((item) => item.toBigInt());
      return placeCards(current, current.gameState.N, cards);
    }
    if (readableTag === 'call' && items.length > 3) {
      const nextN = items[2].toBigInt();
      return nextN > 1n
        ? placeCards(
            current,
            nextN - 1n,
            items.slice(3).map((item) => item.toBigInt()),
          )
        : current;
    }
    return current;
  }

  const units = (value: bigint) => value / current.unitSizeMojos;
  if (readableTag === 'deal' || readableTag === 'pong') {
    return {
      ...current,
      playerHoleCards:
        items.length >= 3 ? [items[1].toBigInt(), items[2].toBigInt()] : current.playerHoleCards,
      playerBoost: items.length >= 4 ? items[3].toBigInt() !== 0n : current.playerBoost,
      coinTossIOpen:
        readableTag === 'pong'
          ? true
          : items.length >= 5
            ? items[4].toBigInt() !== 0n
            : current.coinTossIOpen,
      gameState: { handler: 2n, myTurn: true, N: 4n },
    };
  }
  if (readableTag === 'open' || readableTag === 'raise') {
    const raise = units(items[1].toBigInt());
    let next: SpacepokerHandState = {
      ...current,
      halfPot: units(items[2].toBigInt()),
      lastRaise: raise,
      iRaisedLast: false,
      gameState: { handler: 3n, myTurn: true, N: current.gameState.N },
    };
    if (readableTag === 'open' && items.length > 3) {
      if (current.gameState.N === 4n) {
        next = {
          ...next,
          playerHoleCards: [items[3].toBigInt(), items[4].toBigInt()],
          playerBoost: items[5].toBigInt() !== 0n,
        };
      } else {
        next = placeCards(
          next,
          current.gameState.N,
          items.slice(3).map((item) => item.toBigInt()),
        );
      }
    }
    return appendHistory(next, {
      player: 'opponent',
      action: raise > 0n ? 'raise' : 'check',
      ...(raise > 0n ? { units: raise } : {}),
    });
  }
  if (readableTag === 'call') {
    const nextN = items[2].toBigInt();
    const action = current.lastRaise > 0n ? 'call' : 'check';
    let next: SpacepokerHandState = {
      ...current,
      halfPot: units(items[1].toBigInt()),
      lastRaise: 0n,
      gameState:
        nextN === 1n
          ? { handler: 4n, myTurn: true, N: 1n }
          : { handler: 2n, myTurn: true, N: nextN - 1n },
    };
    if (nextN === 1n && items.length >= 12) {
      const playerCards = bigints(items[3]);
      const opponentCards = bigints(items[5]);
      next = {
        ...next,
        opponentHoleCards: [opponentCards[0], opponentCards[1]],
        opponentBoost: items[6].toBigInt() !== 0n,
        communityCards: playerCards.slice(2, 7),
        outcome: outcomeFrom(items[7], items[8], items[9], items[10], items[11]),
      };
    } else if (nextN > 1n && items.length > 3) {
      next = placeCards(
        next,
        nextN - 1n,
        items.slice(3).map((item) => item.toBigInt()),
      );
    }
    return appendHistory(next, {
      player: 'opponent',
      action,
      ...(action === 'check' ? { endsStreet: true } : {}),
    });
  }
  if (readableTag === 'end' && items.length >= 6) {
    return appendHistory(
      {
        ...current,
        gameState: { handler: 5n, myTurn: false, N: 0n },
        opponentHoleCards:
          items.length > 7 ? [items[6].toBigInt(), items[7].toBigInt()] : current.opponentHoleCards,
        opponentBoost: items.length > 8 ? items[8].toBigInt() !== 0n : current.opponentBoost,
        outcome: outcomeFrom(items[1], items[2], items[3], items[4], items[5]),
        terminalState: 'revealed',
      },
      { player: 'opponent', action: 'reveal' },
    );
  }
  return current;
}

export function reduceSpacepokerHandState(
  current: SpacepokerHandState,
  event: GameUpdate,
): SpacepokerHandState {
  if (event.type === 'hand-ended') {
    const settled = event.outcome ? reduceSpacepokerSettlementState(current, event.outcome) : current;
    return {
      ...settled,
      gameState: { ...settled.gameState, myTurn: false },
      settlementOutcome: event.outcome,
    };
  }
  if (event.type !== 'move-readable' && event.type !== 'message-readable') return current;
  const readableEvent = {
    type: event.type === 'move-readable' ? 'opponent-moved' : 'game-message',
    readable: event.readable,
  } as const;
  return reduceSpacepokerFeatureState(current, readableEvent);
}

function spacepokerHandFromState(initial: SpacepokerHandState): SpacepokerHand {
  let state = initial;
  return {
    getState: () => state,
    receive: (update) => {
      state = reduceSpacepokerHandState(state, update);
    },
    update: (reducer) => {
      state = reducer(state);
    },
  };
}

export function createSpacepokerHand(init: GameHandInitialization): SpacepokerHand {
  if (init.members.length !== 1 || init.handProposal.gameType !== 'spacepoker') {
    throw new Error('Space Poker hand requires one game and Space Poker proposal terms');
  }
  const parameters = spacepokerProposalParameters.decode(init.handProposal.parameters);
  if (!parameters) {
    throw new Error('Space Poker hand requires valid proposal parameters');
  }
  return spacepokerHandFromState(initialState(init, parameters.betUnitMojos));
}

export function restoreSpacepokerHand(savedState: unknown): SpacepokerHand {
  if (!isSpacepokerHandState(savedState)) {
    throw new Error('Cannot restore Space Poker hand: saved state is invalid');
  }
  return spacepokerHandFromState(savedState);
}
