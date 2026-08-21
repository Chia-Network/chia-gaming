import { Program } from 'clvm-lib';
import { defineGameStateCodec, type DurableGameStateEvent } from '../../host';

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
  canRemountFinished: true,
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

function parseReadable(readable: Uint8Array): {
  word: string | null;
  clue: KrunkGuess['clue'] | null;
} {
  const program = Program.deserialize(readable);
  try {
    if (program.atom.length === 0) return { word: null, clue: null };
  } catch {
    // Non-atom readables are the normal clue and reveal list shapes.
  }
  const clueFrom = (value: Program): KrunkGuess['clue'] | null => {
    try {
      const values = value.toList().map((item) => item.toBigInt());
      return values.length === 5 && values.every((item) => item >= 0n && item <= 2n)
        ? (values as KrunkGuess['clue'])
        : null;
    } catch {
      return null;
    }
  };
  const clue = clueFrom(program);
  if (clue) return { word: null, clue };
  const items = program.toList();
  if (items.length !== 2) return { word: null, clue: null };
  return {
    word: new TextDecoder().decode(items[0].atom).toUpperCase(),
    clue: clueFrom(items[1]),
  };
}

function finishedState(
  state: KrunkGameState,
  revealedWord: string | null,
  clue: KrunkGuess['clue'] | null,
  moverShare: string | null,
): KrunkGameState {
  const correct = (value: KrunkGuess['clue']) => value.every((item) => item === 2n);
  const bobWon =
    state.guesses.some((guess) => correct(guess.clue)) || (clue ? correct(clue) : false);
  const aliceWon = !bobWon;
  return {
    ...state,
    handler: KrunkHandler.Terminal,
    myTurn: false,
    revealedWord,
    moverShare,
    outcome:
      (state.role === 'alice' && aliceWon) || (state.role === 'bob' && bobWon) ? 'win' : 'lose',
  };
}

type KrunkFeatureEvent =
  | { type: 'opponent-moved'; readable: Uint8Array; moverShare: string | null }
  | { type: 'settled' };

export function krunkOutcomeFromPlay(game: KrunkGameState): KrunkGameState['outcome'] {
  const bobWon = game.guesses.some((guess) => guess.clue.every((item) => item === 2n));
  const finished = bobWon || game.guesses.length >= 5;
  if (!finished) return null;
  return game.role === 'bob' ? (bobWon ? 'win' : 'lose') : bobWon ? 'lose' : 'win';
}

export function reduceKrunkFeatureState(
  game: KrunkGameState,
  event: KrunkFeatureEvent,
): KrunkGameState {
  if (event.type === 'settled') {
    return {
      ...game,
      handler: KrunkHandler.Terminal,
      myTurn: false,
      outcome: game.outcome ?? krunkOutcomeFromPlay(game),
    };
  }
  const parsed = parseReadable(event.readable);
  if (game.role === 'alice' && parsed.word && parsed.clue) {
    return {
      ...game,
      handler: KrunkHandler.AliceClue,
      myTurn: true,
      guesses: [...game.guesses, { word: parsed.word, clue: parsed.clue }],
      error: null,
    };
  }
  if (game.role === 'bob' && !parsed.word && !parsed.clue) {
    return { ...game, handler: KrunkHandler.BobGuess, myTurn: true, error: null };
  }
  if (game.role === 'bob' && parsed.clue && !parsed.word) {
    const guesses = [...game.guesses];
    const index = guesses.length - 1;
    if (index >= 0 && guesses[index].clue.every((value) => value === -1n)) {
      guesses[index] = { ...guesses[index], clue: parsed.clue };
    }
    const terminalClue = parsed.clue.every((value) => value === 2n) || guesses.length >= 5;
    return {
      ...game,
      handler: terminalClue ? KrunkHandler.BobWaiting : KrunkHandler.BobGuess,
      myTurn: !terminalClue,
      guesses,
      error: null,
    };
  }
  if (game.role === 'bob' && parsed.word && parsed.clue) {
    const guesses = [...game.guesses];
    const index = guesses.length - 1;
    if (index >= 0 && guesses[index].clue.every((value) => value === -1n)) {
      guesses[index] = { ...guesses[index], clue: parsed.clue };
    }
    return finishedState({ ...game, guesses }, parsed.word, parsed.clue, event.moverShare);
  }
  return game;
}

export function reduceKrunkDurableState(
  current: KrunkHandState | null,
  event: DurableGameStateEvent,
): KrunkHandState | null {
  if (event.type === 'abandoned') return null;
  if (event.type === 'remove-group') {
    if (!current) return null;
    const removed = new Set(event.groupIds);
    const games = Object.fromEntries(
      Object.entries(current.games).filter(([id]) => !removed.has(id)),
    );
    return Object.keys(games).length ? { games } : null;
  }
  if (event.type === 'accepted-group') {
    const games = Object.fromEntries(
      event.groupIds.map((id, index) => {
        const proposerIsAlice = index === 0;
        const role =
          proposerIsAlice === (event.origin === 'local') ? ('alice' as const) : ('bob' as const);
        return [id, current?.games[id] ?? initialKrunkGameState(role)];
      }),
    );
    return { games };
  }
  if (event.type === 'feature-state') {
    const state = decodeKrunkGameState(event.state);
    if (state === null) throw new Error('Invalid Krunk feature-state payload');
    return { games: { ...(current?.games ?? {}), [event.id]: state } };
  }
  if (!current?.games[event.id]) return current;
  const game = current.games[event.id];
  let next = game;
  if (event.type === 'local-turn') {
    next = { ...game, myTurn: event.isMyTurn };
  } else if (event.type === 'settled') {
    next = reduceKrunkFeatureState(game, { type: 'settled' });
  } else if (event.type === 'game-status') {
    if (!event.readable) {
      next = { ...game, myTurn: event.status === 'my-turn' };
    } else {
      next = reduceKrunkFeatureState(game, {
        type: 'opponent-moved',
        readable: event.readable,
        moverShare: event.moverShare,
      });
    }
  }
  return { games: { ...current.games, [event.id]: next } };
}
