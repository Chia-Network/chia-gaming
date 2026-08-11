import { defineGameStateCodec } from '../../lib/session/gameStateCodec';

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
export interface PendingSpacepokerTerminalAction {
  action: 'fold' | 'concede' | 'reveal';
  submission: 'make-move' | 'accept-settlement';
  previousTerminalState: SpTerminalState;
  previousGameState: SpGameState;
}

export interface SpacepokerHandState {
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
  terminalState?: SpTerminalState;
  terminalRecovery?: 'concede' | 'reveal' | null;
  pendingTerminalAction: PendingSpacepokerTerminalAction | null;
  coinTossIOpen: boolean | null;
  unitSizeMojos: bigint;
  displayMode: SpacepokerDisplayMode;
}

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

function isPendingTerminalAction(value: unknown): value is PendingSpacepokerTerminalAction {
  if (typeof value !== 'object' || value === null) return false;
  const pending = value as Partial<PendingSpacepokerTerminalAction>;
  return (
    (pending.action === 'fold' || pending.action === 'concede' || pending.action === 'reveal') &&
    (pending.submission === 'make-move' || pending.submission === 'accept-settlement') &&
    typeof pending.previousTerminalState === 'string' &&
    TERMINALS.has(pending.previousTerminalState) &&
    isGameState(pending.previousGameState)
  );
}

function isSpacepokerHandState(value: unknown): value is SpacepokerHandState {
  if (typeof value !== 'object' || value === null) return false;
  const state = value as Partial<SpacepokerHandState>;
  if (
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
  if (
    state.terminalRecovery != null &&
    (state.terminalState !== 'none' || state.gameState.handler !== 4n)
  ) {
    return false;
  }
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
    (state.terminalRecovery === null ||
      state.terminalRecovery === 'concede' ||
      state.terminalRecovery === 'reveal') &&
    (state.pendingTerminalAction === null ||
      isPendingTerminalAction(state.pendingTerminalAction)) &&
    (state.coinTossIOpen === null || typeof state.coinTossIOpen === 'boolean') &&
    typeof state.unitSizeMojos === 'bigint' &&
    state.unitSizeMojos > 0n &&
    typeof state.displayMode === 'string' &&
    DISPLAY_MODES.has(state.displayMode)
  );
}

export const spacepokerStateCodec = defineGameStateCodec<SpacepokerHandState>({
  gameType: 'spacepoker',
  version: 2n,
  canRemountFinished: true,
  isState: isSpacepokerHandState,
});
