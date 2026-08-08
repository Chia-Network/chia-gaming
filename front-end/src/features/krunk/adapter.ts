import { Program } from 'clvm-lib';
import {
  equalBaseTerms,
  reduceGameStateSnapshot,
  type DurableGameStateEvent,
  type GameFeatureRegistration,
} from '../../lib/gameAdapter';
import {
  initialKrunkGameState,
  KrunkHandler,
  krunkStateCodec,
  type KrunkGameState,
  type KrunkGuess,
  type KrunkHandState,
} from './stateCodec';

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
  | { type: 'settled'; moverShare: string | null };

export function reduceKrunkFeatureState(
  game: KrunkGameState,
  event: KrunkFeatureEvent,
): KrunkGameState {
  if (event.type === 'settled') {
    return {
      ...game,
      handler: KrunkHandler.Terminal,
      myTurn: false,
      moverShare: event.moverShare,
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
    const games = { ...(current?.games ?? {}) };
    event.groupIds.forEach((id, index) => {
      const proposerIsAlice = index === 0;
      const role = proposerIsAlice === event.iProposedHand ? ('alice' as const) : ('bob' as const);
      games[id] ??= initialKrunkGameState(role);
    });
    return { games };
  }
  if (event.type === 'feature-state') {
    const state = event.state as KrunkGameState;
    return { games: { ...(current?.games ?? {}), [event.id]: state } };
  }
  if (!current?.games[event.id]) return current;
  const game = current.games[event.id];
  let next = game;
  if (event.type === 'local-turn') {
    next = { ...game, myTurn: event.isMyTurn };
  } else if (event.type === 'settled') {
    next = reduceKrunkFeatureState(game, {
      type: 'settled',
      moverShare: event.terminal.myReward,
    });
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

export function isValidKrunkStake(stake: bigint): boolean {
  return stake > 0n && stake % 100n === 0n;
}

export const krunkRegistration: GameFeatureRegistration<'krunk', KrunkHandState> = {
  gameType: 'krunk',
  displayName: 'Krunk',
  stateCodec: krunkStateCodec,
  lifecycle: {
    proposalSenderGoesFirst: (iStarted) => !iStarted,
    initialTurn: (iStarted) => (iStarted ? 'their-turn' : 'my-turn'),
  },
  compose: {
    defaultDraft: () => ({ amount: 100n }),
    draftFromTerms: (terms) => ({ amount: terms.myContribution }),
    updateDraft: (current, update) => ({ ...current, ...update }),
    toTerms(draft, gameTimeout) {
      const terms = {
        gameType: 'krunk' as const,
        myContribution: draft.amount,
        theirContribution: draft.amount,
        gameTimeout,
      };
      return krunkRegistration.validateTerms(terms) ? terms : null;
    },
  },
  decodeProposalTerms: (base) => ({ gameType: 'krunk', ...base }),
  encodeProposalParameters: (terms) => Program.fromBigInt(terms.myContribution),
  validateTerms: (terms) =>
    terms.myContribution === terms.theirContribution &&
    isValidKrunkStake(terms.myContribution) &&
    terms.gameTimeout > 0n,
  termsEqual: equalBaseTerms,
  persistence: {
    encodeExtras: () => ({}),
    decodeExtras: (base) => ({ gameType: 'krunk', ...base }),
  },
  durableState: {
    reduce: reduceGameStateSnapshot,
    reduceEvent: reduceKrunkDurableState,
  },
};
