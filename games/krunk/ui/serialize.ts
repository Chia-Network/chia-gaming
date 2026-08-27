import { Program } from 'clvm-lib';
import {
  isSettlementOutcome,
  type GameHand,
  type GameHandInitialization,
  type GameUpdate,
  type PersistedGameState,
  type SettlementOutcome,
} from '../../host';

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
  settlementOutcome: SettlementOutcome | null;
  moverShare: bigint | null;
}

export interface KrunkHandState {
  perPlayerStake: bigint;
  members: readonly [KrunkGameState, KrunkGameState];
}

export interface KrunkHand extends GameHand<KrunkHandState> {
  updateGame(memberIndex: number, reducer: (current: KrunkGameState) => KrunkGameState): void;
}

/** Test/helper envelope only; persistence treats the state as opaque. */
export const krunkStateCodec = {
  gameType: 'krunk',
  encode: (state: KrunkHandState): PersistedGameState<KrunkHandState> => ({
    gameType: 'krunk',
    state,
  }),
  decode: (value: unknown): KrunkHandState | null =>
    typeof value === 'object' &&
    value !== null &&
    (value as Partial<PersistedGameState>).gameType === 'krunk'
      ? ((value as PersistedGameState<KrunkHandState>).state ?? null)
      : null,
};

export function initialKrunkGameState(role: KrunkRole): KrunkGameState {
  return {
    handler: role === 'alice' ? KrunkHandler.WaitingCommit : KrunkHandler.BobWaiting,
    myTurn: role === 'alice',
    role,
    guesses: [],
    secretWord: null,
    revealedWord: null,
    outcome: null,
    settlementOutcome: null,
    moverShare: null,
  };
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isWord(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z]{5}$/.test(value);
}

function isAmount(value: unknown): value is bigint | null {
  return value === null || (typeof value === 'bigint' && value >= 0n);
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
      (state.revealedWord !== null ||
        state.outcome !== null ||
        state.settlementOutcome !== null ||
        state.moverShare !== null)) ||
    (terminal && state.myTurn)
  ) {
    return false;
  }
  return (
    isNullableString(state.secretWord) &&
    isNullableString(state.revealedWord) &&
    (state.outcome === null || state.outcome === 'win' || state.outcome === 'lose') &&
    (state.settlementOutcome === null || isSettlementOutcome(state.settlementOutcome)) &&
    isAmount(state.moverShare)
  );
}

export function decodeKrunkGameState(value: unknown): KrunkGameState | null {
  return isKrunkGameState(value) ? value : null;
}

export function isKrunkHandState(value: unknown): value is KrunkHandState {
  if (typeof value !== 'object' || value === null) return false;
  const hand = value as Partial<KrunkHandState>;
  return (
    typeof hand.perPlayerStake === 'bigint' &&
    hand.perPlayerStake > 0n &&
    Array.isArray(hand.members) &&
    hand.members.length === 2 &&
    isKrunkGameState(hand.members[0]) &&
    isKrunkGameState(hand.members[1])
  );
}

export function krunkGameStateFromHand(
  handState: KrunkHandState,
  memberIndex: number,
): KrunkGameState {
  if (!Number.isInteger(memberIndex) || memberIndex < 0) {
    throw new Error(`Krunk member index must be a nonnegative integer: ${memberIndex}`);
  }
  const game = handState.members[memberIndex];
  if (!game) throw new Error(`Krunk hand is missing member ${memberIndex}`);
  return game;
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
  moverShare: bigint | null,
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
  | { type: 'opponent-moved'; readable: Uint8Array; moverShare: bigint | null }
  | { type: 'settled'; outcome: SettlementOutcome | null };

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
      settlementOutcome: event.outcome,
    };
  }
  const parsed = parseReadable(event.readable);
  if (game.role === 'alice' && parsed.word && parsed.clue) {
    return {
      ...game,
      handler: KrunkHandler.AliceClue,
      myTurn: true,
      guesses: [...game.guesses, { word: parsed.word, clue: parsed.clue }],
    };
  }
  if (game.role === 'bob' && !parsed.word && !parsed.clue) {
    return { ...game, handler: KrunkHandler.BobGuess, myTurn: true };
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

export function reduceKrunkHandState(current: KrunkHandState, event: GameUpdate): KrunkHandState {
  const game = current.members[event.memberIndex];
  if (!game) return current;
  let next = game;
  if (event.type === 'hand-ended') {
    next = reduceKrunkFeatureState(game, { type: 'settled', outcome: event.outcome });
  } else if (event.type === 'move-readable') {
    next = reduceKrunkFeatureState(game, {
      type: 'opponent-moved',
      readable: event.readable,
      moverShare: event.moverShare,
    });
  }
  const members = [...current.members] as [KrunkGameState, KrunkGameState];
  members[event.memberIndex] = next;
  return { ...current, members };
}

function krunkHandFromState(initial: KrunkHandState): KrunkHand {
  let state = initial;
  return {
    getState: () => state,
    receive: (update) => {
      state = reduceKrunkHandState(state, update);
    },
    updateGame: (memberIndex, reducer) => {
      const game = krunkGameStateFromHand(state, memberIndex);
      const members = [...state.members] as [KrunkGameState, KrunkGameState];
      members[memberIndex] = reducer(game);
      state = { ...state, members };
    },
  };
}

export function createKrunkHand(init: GameHandInitialization): KrunkHand {
  if (init.members.length !== 2 || init.handProposal.gameType !== 'krunk') {
    throw new Error('Krunk requires two games and Krunk proposal terms');
  }
  if (
    init.members[0]!.playerAContribution <= 0n ||
    init.members[0]!.playerBContribution !== 0n ||
    init.members[1]!.playerAContribution !== 0n ||
    init.members[1]!.playerBContribution !== init.members[0]!.playerAContribution
  ) {
    throw new Error('Krunk requires its approved A and B contributions in separate members');
  }
  return krunkHandFromState({
    perPlayerStake: init.members[0]!.playerAContribution,
    members: [
      initialKrunkGameState(init.members[0]!.ourTurn ? 'alice' : 'bob'),
      initialKrunkGameState(init.members[1]!.ourTurn ? 'alice' : 'bob'),
    ],
  });
}

export function restoreKrunkHand(savedState: unknown): KrunkHand {
  if (!isKrunkHandState(savedState)) {
    throw new Error('Cannot restore Krunk hand: saved state is invalid');
  }
  return krunkHandFromState(savedState);
}
