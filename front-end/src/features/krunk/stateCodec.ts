import { defineGameStateCodec } from '../../lib/session/gameStateCodec';

export const KrunkHandler = {
  WaitingCommit: 0n,
  AliceWaiting: 1n,
  AliceClue: 2n,
  BobWaiting: 3n,
  BobGuess: 4n,
  Terminal: 5n,
} as const;
export type KrunkHandler = (typeof KrunkHandler)[keyof typeof KrunkHandler];

export type KrunkRole = 'alice' | 'bob';

export interface KrunkGuess {
  word: string;
  clue: [bigint, bigint, bigint, bigint, bigint];
}

export interface KrunkGameState {
  handler: KrunkHandler;
  myTurn: boolean;
  role: KrunkRole;
  guesses: KrunkGuess[];
  secretWord: string | null;
  revealedWord: string | null;
  outcome: 'win' | 'lose' | null;
  moverShare: string | null;
  error: string | null;
}

export interface KrunkHandState {
  games: Record<string, KrunkGameState>;
}

export function initialKrunkGameState(role: KrunkRole): KrunkGameState {
  return {
    handler: role === 'alice' ? KrunkHandler.WaitingCommit : KrunkHandler.BobWaiting,
    myTurn: role === 'alice',
    role,
    guesses: [],
    secretWord: null,
    revealedWord: null,
    outcome: null,
    moverShare: null,
    error: null,
  };
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isWord(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z]{5}$/.test(value);
}

function isAmount(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== 'string') return false;
  try {
    return BigInt(value) >= 0n;
  } catch {
    return false;
  }
}

function isKrunkGameState(value: unknown): value is KrunkGameState {
  if (typeof value !== 'object' || value === null) return false;
  const state = value as Partial<KrunkGameState>;
  if (
    typeof state.handler !== 'bigint' ||
    state.handler < KrunkHandler.WaitingCommit ||
    state.handler > KrunkHandler.Terminal ||
    (state.role !== 'alice' && state.role !== 'bob') ||
    !Array.isArray(state.guesses) ||
    state.guesses.length > 5
  ) {
    return false;
  }
  const validHandlerForRole =
    state.handler === KrunkHandler.Terminal ||
    (state.role === 'alice' &&
      (state.handler === KrunkHandler.WaitingCommit ||
        state.handler === KrunkHandler.AliceWaiting ||
        state.handler === KrunkHandler.AliceClue)) ||
    (state.role === 'bob' &&
      (state.handler === KrunkHandler.BobWaiting || state.handler === KrunkHandler.BobGuess));
  if (!validHandlerForRole) return false;
  const expectedTurn =
    state.handler === KrunkHandler.WaitingCommit || state.handler === KrunkHandler.BobGuess;
  if (
    typeof state.myTurn !== 'boolean' ||
    (state.handler !== KrunkHandler.AliceClue && state.myTurn !== expectedTurn)
  ) {
    return false;
  }
  const pendingGuessIndexes: number[] = [];
  if (
    !state.guesses.every((guess, index) => {
      if (typeof guess !== 'object' || guess === null || !isWord(guess.word)) return false;
      if (!Array.isArray(guess.clue) || guess.clue.length !== 5) return false;
      const pending = guess.clue.every((clue) => clue === -1n);
      if (pending) pendingGuessIndexes.push(index);
      return (
        pending || guess.clue.every((clue) => typeof clue === 'bigint' && clue >= 0n && clue <= 2n)
      );
    })
  ) {
    return false;
  }
  if (
    pendingGuessIndexes.length > 1 ||
    (pendingGuessIndexes.length === 1 &&
      (state.role !== 'bob' || pendingGuessIndexes[0] !== state.guesses.length - 1))
  ) {
    return false;
  }
  if (state.secretWord !== null && !isWord(state.secretWord)) return false;
  if (state.revealedWord !== null && !isWord(state.revealedWord)) return false;
  if (state.role === 'bob' && state.secretWord !== null) return false;
  const terminal = state.handler === KrunkHandler.Terminal;
  if (
    (!terminal &&
      (state.revealedWord !== null || state.outcome !== null || state.moverShare !== null)) ||
    (terminal && state.myTurn)
  ) {
    return false;
  }
  return (
    isNullableString(state.secretWord) &&
    isNullableString(state.revealedWord) &&
    (state.outcome === null || state.outcome === 'win' || state.outcome === 'lose') &&
    isAmount(state.moverShare) &&
    isNullableString(state.error)
  );
}

export function decodeKrunkGameState(value: unknown): KrunkGameState | null {
  return isKrunkGameState(value) ? value : null;
}

function isKrunkHandState(value: unknown): value is KrunkHandState {
  if (typeof value !== 'object' || value === null) return false;
  const games = (value as Partial<KrunkHandState>).games;
  return (
    typeof games === 'object' &&
    games !== null &&
    Object.keys(games).length > 0 &&
    Object.entries(games).every(
      ([gameId, gameState]) => gameId.length > 0 && isKrunkGameState(gameState),
    )
  );
}

export const krunkStateCodec = defineGameStateCodec<KrunkHandState>({
  gameType: 'krunk',
  version: 2n,
  canRemountFinished: false,
  isState: isKrunkHandState,
  gameIds: (state) => Object.keys(state.games),
});

export function krunkGameStateFromPersisted(
  persisted: unknown,
  gameId: string,
  role: KrunkRole,
): KrunkGameState {
  return krunkStateCodec.decode(persisted)?.games[gameId] ?? initialKrunkGameState(role);
}

export function persistedKrunkGameState(
  persisted: unknown,
  gameId: string,
  gameState: KrunkGameState,
) {
  const handState = krunkStateCodec.decode(persisted) ?? { games: {} };
  return krunkStateCodec.encode({
    games: {
      ...handState.games,
      [gameId]: gameState,
    },
  });
}
